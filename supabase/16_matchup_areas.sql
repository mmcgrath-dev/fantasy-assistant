-- get_matchup_areas function
-- The matchup part of Start/Sit. You hand it a list of ESPN player IDs (your
-- roster) and a week, and for each WR, TE and RB it answers:
--
--   "Where does he get the ball, and how does this week's defense do against
--    plays going to those same spots?"
--
-- Two kinds of rows:
--   kind = 'target'  where his targets go: the 6 areas (short/deep x
--                    left/middle/right), lined up with defense_vs_target_area
--   kind = 'run'     where his carries go: the 5 lanes (left end, left inside,
--                    middle, right inside, right end), lined up with
--                    defense_vs_run_direction. Running backs only.
--
-- One row per player per area or lane he's had the ball in this season.
-- The edge columns are the same on every row for a player, so the app can
-- read them off any row:
--
--   edge_targets_per_game: from where his targets go, about how many more (+)
--                          or fewer (-) PPR points than vs an average defense
--   edge_runs_per_game:    the same from where his carries go (0 for non-RBs)
--   edge_per_game:         the two added together
--
-- Small samples are already toned down in the two views (vs_league_adj).
-- Run lanes are judged on yards per carry, not TDs (see 17_defense_vs_run_direction.sql).
--
-- It uses his team's next game that hasn't been played yet: the week you ask
-- for, or the week after if that game is already over (or he's on bye).
-- Players with no unplayed game in those two weeks aren't returned.
--
-- Needs 15_defense_vs_target_area.sql and 17_defense_vs_run_direction.sql run first.
--
-- Try it after running this file (use the current week):
--   select * from get_matchup_areas(
--     (select array_agg(espn_id) from players where full_name ilike '%jeanty%'),
--     10
--   );

drop function if exists public.get_matchup_areas(text[], integer);

create or replace function public.get_matchup_areas(espn_ids text[], for_week integer)
returns table (
  espn_id               text,
  week                  integer,   -- the week of the game being looked at
  opponent              text,
  kind                  text,      -- 'target' or 'run'
  area                  text,      -- like 'deep right' (targets) or 'left inside' (runs)
  his_count             integer,   -- his targets or carries there this season
  his_share             numeric,   -- % of his targets (or carries) that went there
  def_count             integer,   -- targets or RB carries this defense has faced there
  def_rank              integer,   -- 1 = easiest of the 32 defenses there, 32 = toughest
  def_per_play          numeric,   -- targets: PPR per target. runs: yards per carry
  league_per_play       numeric,   -- the same for the average defense
  vs_league             numeric,   -- PPR per play vs an average defense, small samples toned down
  edge_targets_per_game numeric,
  edge_runs_per_game    numeric,
  edge_per_game         numeric
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

  -- This week's opponents' numbers, built ONCE up front. "materialized" tells
  -- the database to work this out a single time and reuse it, instead of
  -- rebuilding the whole defense view for every row (that made it take
  -- seconds instead of a fraction of a second).
  def_targets as materialized (
    select d.defense, d.position, d.area, d.targets, d.rank_per_target,
           d.ppr_per_target, d.league_ppr_per_target, d.vs_league_adj
    from defense_vs_target_area d
    where d.season = 2026
      and d.defense in (select opponent from opponents)
  ),

  def_runs as materialized (
    select d.defense, d.lane, d.carries, d.rank_per_carry,
           d.yards_per_carry, d.league_yards_per_carry, d.vs_league_adj
    from defense_vs_run_direction d
    where d.season = 2026
      and d.defense in (select opponent from opponents)
  ),

  -- ---------- targets ----------

  his_target_areas as (
    -- his targets this season, split by area
    select
      t.receiver_id                       as gsis_id,
      t.pass_length || ' ' || t.pass_location as area,
      count(*)                            as plays
    from targets t
    join roster r on r.gsis_id = t.receiver_id
    where t.season = 2026
      and t.pass_length is not null
      and t.pass_location is not null
    group by t.receiver_id, t.pass_length, t.pass_location
  ),

  his_target_totals as (
    -- his total targets and games, for shares and per-game numbers
    select
      t.receiver_id                       as gsis_id,
      count(*)                            as plays,
      count(distinct t.game_id)           as games
    from targets t
    join roster r on r.gsis_id = t.receiver_id
    where t.season = 2026
      and t.pass_length is not null
      and t.pass_location is not null
    group by t.receiver_id
  ),

  target_rows as (
    -- each of his target areas next to what this week's defense allows there
    select
      r.espn_id,
      o.week,
      o.opponent,
      'target'                            as kind,
      h.area,
      h.plays                             as his_count,
      100.0 * h.plays / ht.plays          as his_share,
      ht.plays::numeric / ht.games        as his_per_game,
      d.targets                           as def_count,
      d.rank_per_target                   as def_rank,
      d.ppr_per_target                    as def_per_play,
      d.league_ppr_per_target             as league_per_play,
      coalesce(d.vs_league_adj, 0)        as vs_league
    from roster r
    join opponents o          on o.gsis_id  = r.gsis_id
    join his_target_areas h   on h.gsis_id  = r.gsis_id
    join his_target_totals ht on ht.gsis_id = r.gsis_id
    left join def_targets d
      on  d.defense  = o.opponent
      and d.position = r.position
      and d.area     = h.area
  ),

  -- ---------- runs (RBs only) ----------

  his_carries as materialized (
    -- every designed carry he's had this season, tagged with its lane
    -- (same lanes as the run view)
    select
      x.rusher_id                         as gsis_id,
      x.game_id,
      case
        when x.run_location = 'middle'                         then 'middle'
        when x.run_location = 'left'  and x.run_gap = 'end'    then 'left end'
        when x.run_location = 'left'                           then 'left inside'
        when x.run_location = 'right' and x.run_gap = 'end'    then 'right end'
        when x.run_location = 'right'                          then 'right inside'
      end                                 as lane
    from rushes x
    join roster r on r.gsis_id = x.rusher_id
    where r.position = 'RB'
      and x.season = 2026
      and coalesce(x.qb_scramble, false) = false
      and x.run_location is not null
  ),

  his_run_totals as (
    select gsis_id, count(*) as plays, count(distinct game_id) as games
    from his_carries
    group by gsis_id
  ),

  run_rows as (
    -- each of his lanes next to what this week's defense allows there
    select
      r.espn_id,
      o.week,
      o.opponent,
      'run'                               as kind,
      c.lane                              as area,
      count(*)                            as his_count,
      100.0 * count(*) / max(rt.plays)    as his_share,
      max(rt.plays)::numeric / max(rt.games) as his_per_game,
      max(d.carries)                      as def_count,
      max(d.rank_per_carry)               as def_rank,
      max(d.yards_per_carry)              as def_per_play,
      max(d.league_yards_per_carry)       as league_per_play,
      coalesce(max(d.vs_league_adj), 0)   as vs_league
    from roster r
    join opponents o       on o.gsis_id  = r.gsis_id
    join his_carries c     on c.gsis_id  = r.gsis_id
    join his_run_totals rt on rt.gsis_id = r.gsis_id
    left join def_runs d
      on  d.defense = o.opponent
      and d.lane    = c.lane
    group by r.espn_id, o.week, o.opponent, c.lane
  ),

  all_rows as (
    select * from target_rows
    union all
    select * from run_rows
  ),

  edges as (
    -- per player: share-weighted "vs league" for each kind, times how often
    -- he gets the ball that way per game, so it's in real points
    select
      espn_id,
      coalesce(sum(his_share / 100 * vs_league) filter (where kind = 'target')
               * max(his_per_game) filter (where kind = 'target'), 0) as targets_edge,
      coalesce(sum(his_share / 100 * vs_league) filter (where kind = 'run')
               * max(his_per_game) filter (where kind = 'run'), 0)    as runs_edge
    from all_rows
    group by espn_id
  )

  select
    a.espn_id,
    a.week,
    a.opponent,
    a.kind,
    a.area,
    a.his_count::integer,
    round(a.his_share, 0),
    a.def_count::integer,
    a.def_rank::integer,
    a.def_per_play,
    a.league_per_play,
    round(a.vs_league, 2),
    round(e.targets_edge, 1),
    round(e.runs_edge, 1),
    round(e.targets_edge + e.runs_edge, 1)
  from all_rows a
  join edges e on e.espn_id = a.espn_id
  order by a.espn_id, a.kind desc, a.his_count desc;   -- targets first, then runs
$$;

-- Same lockdown as the other functions: only the app's secret keys can call it.
revoke execute on function public.get_matchup_areas(text[], integer) from public, anon, authenticated;
grant execute on function public.get_matchup_areas(text[], integer) to service_role;
