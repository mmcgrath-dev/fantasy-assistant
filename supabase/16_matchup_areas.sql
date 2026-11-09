-- get_matchup_areas function
-- The matchup part of Start/Sit. You hand it a list of ESPN player IDs (your
-- roster) and a week, and for each WR, TE and RB it answers:
--
--   "Where on the field does he get his targets, and how does this week's
--    defense do against throws to those same spots?"
--
-- It finds his opponent that week in the schedule table, splits his targets
-- this season into the 6 areas (short/deep x left/middle/right), and lines
-- each area up with that defense's numbers from the defense_vs_target_area view.
--
-- One row per player per area he's been targeted in. The edge columns are
-- the same on every row for a player, so the app can read them off any row:
--
--   edge_per_target: on a typical throw to him, how many more (or fewer) PPR
--                    points this defense gives up than an average defense,
--                    weighted by how often he's targeted in each area
--   edge_per_game:   that times his targets per game, so it's in real points.
--                    +1.5 means about 1.5 more PPR than against an average defense.
--
-- Small samples get toned down. Some defenses have only seen a handful of deep
-- throws to TEs, and one long TD would make them look terrible. So each
-- area's "vs league" number is shrunk toward 0 based on how many targets the
-- defense has faced there: 20 targets counts half, 60 counts 75%, and so on.
-- That's a common trick (called shrinkage) for not overreacting to tiny samples.
-- The shrinking happens in the defense_vs_target_area view (vs_league_adj),
-- so run 15_defense_vs_target_area.sql again before this file.
--
-- It uses his team's next game that hasn't been played yet: the week you ask
-- for, or the week after if that game is already over (or he's on bye).
-- Players with no unplayed game in those two weeks aren't returned.
--
-- Try it after running this file (use the current week):
--   select * from get_matchup_areas(
--     (select array_agg(espn_id) from players where full_name ilike '%wilson%' and position = 'WR'),
--     10
--   );

drop function if exists public.get_matchup_areas(text[], integer);

create or replace function public.get_matchup_areas(espn_ids text[], for_week integer)
returns table (
  espn_id             text,
  week                integer,   -- the week of the game being looked at
  opponent            text,
  area                text,      -- like 'deep right'
  his_targets         integer,   -- his targets to this area this season
  his_share           numeric,   -- % of his targets that went here
  def_targets         integer,   -- targets this defense has faced here (at his position)
  def_rank            integer,   -- 1 = gives up the most per throw here, 32 = the least (small samples toned down)
  def_ppr_per_target  numeric,   -- PPR this defense gives up per throw here
  league_ppr_per_target numeric, -- the average defense
  vs_league           numeric,   -- the difference, after shrinking small samples
  edge_per_target     numeric,   -- see notes at the top
  edge_per_game       numeric
)
language sql
stable
as $$
  with roster as materialized (
    select p.gsis_id, p.espn_id, p.team, p.position
    from players p
    where p.espn_id = any (espn_ids)
      and p.position in ('WR', 'TE', 'RB')
  ),

  opponents as materialized (
    -- his team's next game that hasn't been played yet, starting from for_week.
    -- ESPN keeps calling it "Week 9" until Monday night is over, but by Monday
    -- most teams have already played, so for them this looks ahead to Week 10.
    -- If his team is on bye that week, it also lands on the game after.
    -- Only looks one week ahead, so nothing too far out.
    select distinct on (r.gsis_id)
      r.gsis_id,
      s.week,
      case when s.home_team = r.team then s.away_team else s.home_team end as opponent
    from roster r
    join schedule s
      on  s.season = 2026
      and s.week between for_week and for_week + 1
      and s.home_score is null              -- not played yet
      and r.team in (s.home_team, s.away_team)
    order by r.gsis_id, s.week
  ),

  defense as materialized (
    -- this week's opponents' numbers, built ONCE up front. "materialized" tells
    -- the database to work this out a single time and reuse it, instead of
    -- rebuilding the whole defense view for every row (that made it take
    -- seconds instead of a fraction of a second)
    select d.defense, d.position, d.area, d.targets, d.rank_per_target,
           d.ppr_per_target, d.league_ppr_per_target, d.vs_league_adj
    from defense_vs_target_area d
    where d.season = 2026
      and d.defense in (select opponent from opponents)
  ),

  his_areas as (
    -- his targets this season, split by area
    select
      t.receiver_id                       as gsis_id,
      t.pass_length || ' ' || t.pass_location as area,
      count(*)                            as targets
    from targets t
    join roster r on r.gsis_id = t.receiver_id
    where t.season = 2026
      and t.pass_length is not null
      and t.pass_location is not null
    group by t.receiver_id, t.pass_length, t.pass_location
  ),

  his_totals as (
    -- his total targets and games, for shares and per-game numbers
    select
      t.receiver_id                       as gsis_id,
      count(*)                            as targets,
      count(distinct t.game_id)           as games
    from targets t
    join roster r on r.gsis_id = t.receiver_id
    where t.season = 2026
      and t.pass_length is not null
      and t.pass_location is not null
    group by t.receiver_id
  ),

  lined_up as (
    -- each of his areas next to what this week's defense allows there
    select
      r.espn_id,
      o.week,
      o.opponent,
      h.area,
      h.targets                           as his_targets,
      100.0 * h.targets / ht.targets      as his_share,
      ht.targets::numeric / ht.games      as his_targets_per_game,
      d.targets                           as def_targets,
      d.rank_per_target                   as def_rank,
      d.ppr_per_target                    as def_ppr_per_target,
      d.league_ppr_per_target,
      -- already toned down for small samples in the view
      coalesce(d.vs_league_adj, 0)        as vs_league
    from roster r
    join opponents o  on o.gsis_id  = r.gsis_id
    join his_areas h  on h.gsis_id  = r.gsis_id
    join his_totals ht on ht.gsis_id = r.gsis_id
    left join defense d
      on  d.defense  = o.opponent
      and d.position = r.position
      and d.area     = h.area
  )

  select
    espn_id,
    week,                                 -- the week of the game it found
    opponent,
    area,
    his_targets::integer,
    round(his_share, 0),
    def_targets::integer,
    def_rank::integer,
    def_ppr_per_target,
    league_ppr_per_target,
    round(vs_league, 2),
    -- weighted by how often he's targeted in each area
    round(sum(his_share / 100 * vs_league) over (partition by espn_id), 2)                         as edge_per_target,
    round(sum(his_share / 100 * vs_league) over (partition by espn_id) * his_targets_per_game, 1) as edge_per_game
  from lined_up
  order by espn_id, his_targets desc;
$$;

-- Same lockdown as the other functions: only the app's secret keys can call it.
revoke execute on function public.get_matchup_areas(text[], integer) from public, anon, authenticated;
grant execute on function public.get_matchup_areas(text[], integer) to service_role;
