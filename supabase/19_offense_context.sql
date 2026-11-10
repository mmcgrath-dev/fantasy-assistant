-- get_offense_context function
-- How every NFL offense is playing, so the Trades page can tell "he's been
-- lucky" apart from "his offense is just really good right now."
--
-- One row per team with:
--
--   1. Points per game: last 3 games vs the games before, from final scores
--      in the schedule table.
--
--   2. EPA per play (expected points added): how much the average pass or
--      run helped the offense. 0 is about league average, +0.10 is very good,
--      -0.10 is bad. Split into passing and running. Built from every target
--      and carry in the database (sacks aren't stored, so passing EPA runs a
--      little high for every team, the same amount for everyone).
--
--   3. Red zone plays per game: passes and runs from inside the 20. More of
--      them = more chances for TDs.
--
--   4. Plays per game: passes plus runs. A faster, busier offense gives
--      everyone more chances.
--
--   5. Who's at QB: the passer who threw the most targets in the team's most
--      recent game, and who threw the most over the whole season. If those
--      are different people, qb_changed is true and the old numbers may not
--      mean much anymore.
--
--   6. Bye week: the regular-season week the team has no game. Used by the
--      trade finder so two players on the same bye count as a real cost.
--
--   7. What Vegas expects going forward: each upcoming game's over/under and
--      spread turned into the points this team is expected to score.
--        home team = total / 2 + spread / 2
--        away team = total / 2 - spread / 2
--      (spread_line is how many points the HOME team is favored by.)
--      Averaged over the next 3 games that have a line. Vegas already prices
--      in the QB, injuries and how the offense has looked, so this is the best
--      single "how good will they be" number. Lines usually only exist about a
--      week out, so this is often 1 game, not 3, and null if none are posted.
--
-- "Last 3" means the team's last 3 games played, so bye weeks don't count.
--
-- Try it after running this file:
--   select * from get_offense_context() order by ppg_last3 desc;

drop function if exists public.get_offense_context();

create or replace function public.get_offense_context()
returns table (
  team               text,
  games              integer,
  ppg_season         numeric,   -- points per game, whole season
  ppg_last3          numeric,   -- points per game, last 3 games
  ppg_prior          numeric,   -- points per game, games before those 3
  league_ppg         numeric,   -- the average team, for comparison
  epa_last3          numeric,   -- EPA per play, last 3
  epa_prior          numeric,   -- EPA per play, before
  pass_epa_last3     numeric,
  rush_epa_last3     numeric,   -- designed runs only, no QB scrambles
  league_epa         numeric,   -- the average team's EPA per play this season
  rz_plays_last3     numeric,   -- plays inside the 20 per game
  rz_plays_prior     numeric,
  plays_last3        numeric,   -- passes + runs per game
  plays_prior        numeric,
  qb_now             text,      -- most targets thrown in their latest game
  qb_season          text,      -- most targets thrown this season
  qb_changed         boolean,
  qb_now_games       integer,   -- games this season where qb_now threw the most
  vegas_next         numeric,   -- expected points per game, upcoming games with a line
  vegas_games        integer,   -- how many games that's based on (0 to 3)
  next_opponents     text,      -- like "@PIT, BAL, @CLE"
  bye_week           integer    -- the week they don't play (null if the schedule isn't loaded that far)
)
language sql
stable
as $$
  with
  -- every finished game, once per team
  team_games as (
    select s.game_id, s.season, s.week, s.home_team as team, s.home_score as pts
    from schedule s
    where s.season = 2026 and s.game_type = 'REG' and s.home_score is not null
    union all
    select s.game_id, s.season, s.week, s.away_team, s.away_score
    from schedule s
    where s.season = 2026 and s.game_type = 'REG' and s.away_score is not null
  ),
  -- number each team's games, newest = 1
  numbered as (
    select tg.*, row_number() over (partition by tg.team order by tg.week desc) as game_num
    from team_games tg
  ),

  -- ---------- points ----------
  points as (
    select
      n.team,
      count(*)::integer                                   as games,
      avg(n.pts)                                          as season,
      avg(n.pts) filter (where n.game_num <= 3)           as last3,
      avg(n.pts) filter (where n.game_num > 3)            as prior
    from numbered n
    group by n.team
  ),

  -- ---------- every play (targets + designed runs + scrambles) ----------
  plays as (
    select t.game_id, t.team, 'pass' as kind, t.epa, t.yardline_100
    from targets t
    where t.season = 2026
    union all
    select r.game_id, r.team,
           case when coalesce(r.qb_scramble, false) then 'pass' else 'run' end,
           r.epa, r.yardline_100
    from rushes r
    where r.season = 2026
  ),
  play_stats as (
    select
      n.team,
      avg(p.epa) filter (where n.game_num <= 3)                                   as epa_last3,
      avg(p.epa) filter (where n.game_num > 3)                                    as epa_prior,
      avg(p.epa) filter (where n.game_num <= 3 and p.kind = 'pass')               as pass_epa_last3,
      avg(p.epa) filter (where n.game_num <= 3 and p.kind = 'run')                as rush_epa_last3,
      count(*) filter (where n.game_num <= 3)                                     as plays_l3,
      count(*) filter (where n.game_num > 3)                                      as plays_pr,
      count(*) filter (where n.game_num <= 3 and p.yardline_100 <= 20)            as rz_l3,
      count(*) filter (where n.game_num > 3 and p.yardline_100 <= 20)             as rz_pr,
      count(distinct n.game_id) filter (where n.game_num <= 3)                    as games_l3,
      count(distinct n.game_id) filter (where n.game_num > 3)                     as games_pr
    from numbered n
    join plays p on p.game_id = n.game_id and p.team = n.team
    group by n.team
  ),

  -- ---------- who's throwing ----------
  passer_games as (
    -- targets thrown by each passer in each game
    select t.team, t.game_id, t.passer_id, count(*) as thrown
    from targets t
    where t.season = 2026 and t.passer_id is not null
    group by t.team, t.game_id, t.passer_id
  ),
  game_starter as (
    -- the passer with the most targets in each game
    select distinct on (pg.team, pg.game_id) pg.team, pg.game_id, pg.passer_id
    from passer_games pg
    order by pg.team, pg.game_id, pg.thrown desc
  ),
  qb_latest as (
    select distinct on (gs.team) gs.team, gs.passer_id
    from game_starter gs
    join numbered n on n.game_id = gs.game_id and n.team = gs.team
    order by gs.team, n.game_num
  ),
  qb_most as (
    select distinct on (pg.team) pg.team, pg.passer_id
    from passer_games pg
    group by pg.team, pg.passer_id
    order by pg.team, sum(pg.thrown) desc
  ),
  qb_starts as (
    select gs.team, gs.passer_id, count(*)::integer as starts
    from game_starter gs
    group by gs.team, gs.passer_id
  ),

  -- ---------- Vegas, upcoming games ----------
  upcoming as (
    select s.home_team as team, s.week, s.away_team as opp, false as away,
           s.total_line / 2 + s.spread_line / 2 as implied, s.total_line
    from schedule s
    where s.season = 2026 and s.game_type = 'REG' and s.home_score is null
    union all
    select s.away_team, s.week, s.home_team, true,
           s.total_line / 2 - s.spread_line / 2, s.total_line
    from schedule s
    where s.season = 2026 and s.game_type = 'REG' and s.away_score is null
  ),
  next3 as (
    select u.*, row_number() over (partition by u.team order by u.week) as k
    from upcoming u
  ),
  vegas as (
    select
      x.team,
      avg(x.implied) filter (where x.total_line is not null and x.implied is not null) as implied,
      count(*) filter (where x.total_line is not null and x.implied is not null)::integer as lined,
      string_agg(case when x.away then '@' else '' end || x.opp, ', ' order by x.week) as opps
    from next3 x
    where x.k <= 3
    group by x.team
  ),

  -- ---------- bye weeks ----------
  every_week as (
    select generate_series(1, (select max(s.week) from schedule s where s.season = 2026 and s.game_type = 'REG')) as week
  ),
  team_weeks as (
    select s.home_team as team, s.week from schedule s where s.season = 2026 and s.game_type = 'REG'
    union
    select s.away_team, s.week from schedule s where s.season = 2026 and s.game_type = 'REG'
  ),
  byes as (
    select t.team, min(w.week)::integer as bye_week
    from (select distinct team from team_weeks) t
    cross join every_week w
    where not exists (select 1 from team_weeks tw where tw.team = t.team and tw.week = w.week)
    group by t.team
  ),

  league as (
    select avg(n.pts) as ppg, (select avg(p.epa) from plays p) as epa
    from numbered n
  )

  select
    pts.team,
    pts.games,
    round(pts.season, 1),
    round(pts.last3, 1),
    round(pts.prior, 1),
    round(lg.ppg, 1),
    round(ps.epa_last3, 3),
    round(ps.epa_prior, 3),
    round(ps.pass_epa_last3, 3),
    round(ps.rush_epa_last3, 3),
    round(lg.epa, 3),
    round(ps.rz_l3::numeric / nullif(ps.games_l3, 0), 1),
    round(ps.rz_pr::numeric / nullif(ps.games_pr, 0), 1),
    round(ps.plays_l3::numeric / nullif(ps.games_l3, 0), 1),
    round(ps.plays_pr::numeric / nullif(ps.games_pr, 0), 1),
    pnow.full_name,
    pmost.full_name,
    ql.passer_id is distinct from qm.passer_id,
    coalesce(qs.starts, 0),
    round(v.implied, 1),
    coalesce(v.lined, 0),
    v.opps,
    b.bye_week
  from points pts
  cross join league lg
  left join play_stats ps on ps.team = pts.team
  left join qb_latest ql on ql.team = pts.team
  left join qb_most qm on qm.team = pts.team
  left join qb_starts qs on qs.team = pts.team and qs.passer_id = ql.passer_id
  left join players pnow on pnow.gsis_id = ql.passer_id
  left join players pmost on pmost.gsis_id = qm.passer_id
  left join vegas v on v.team = pts.team
  left join byes b on b.team = pts.team;
$$;

-- Same lockdown as the other functions: only the app's secret keys can call it.
revoke execute on function public.get_offense_context() from public, anon, authenticated;
grant execute on function public.get_offense_context() to service_role;
