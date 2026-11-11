-- get_trade_signals function
-- The numbers behind sell-high and buy-low calls on the Trades page. You hand
-- it a list of ESPN player IDs (every rostered player in your league) and for
-- each RB, WR and TE it compares what he's SCORED to what his USAGE says he
-- should be scoring.
--
-- Three signals:
--
--   1. Usage vs points (his last 3 games vs his games before that)
--      Touches (carries + targets) and snap % going up while points haven't
--      caught up = buy before the breakout. Points up without the usage to
--      back it = sell while he looks good.
--
--   2. TD luck
--      Every carry and target gets an "expected TD" value from where it
--      happened on the field: a carry from the 1-yard line scores far more
--      often than one from midfield. The rates come from every carry and
--      target in the league this season. Add them up and you get how many TDs
--      a player "should" have. Way more TDs than expected = he's been lucky
--      and it usually cools off (sell). Way fewer = unlucky, likely to bounce
--      back (buy).
--
--   3. Boom week
--      His last game vs his average before it. A big game that his usage
--      doesn't explain is the best time to sell, because the other manager
--      just watched it happen.
--
--   4. Efficiency (is he doing anything with the ball?)
--      Volume alone can fool you. A back getting more carries at 2.6 yards a
--      carry usually loses that work. So: yards per carry and yards per target
--      vs the league average at his position, plus rush yards over expected
--      (Next Gen Stats) when it's available.
--
--   5. Goal-line role (inside the 5)
--      His share of his team's carries and targets inside the 5, last 3 games
--      vs before, and which teammate got the most of them lately. "He's due
--      for TDs" only holds if he's still the one getting the ball near the
--      goal line. If a teammate is taking those, it's his role, not bad luck.
--
-- The app turns these numbers into the actual sell / buy / hold call and the
-- sentences (src/trades.js), the same way why.js does for the Why box.
--
-- Shortened games (he got hurt and left early, see 23_shortened_games.sql)
-- are left out of everything here except last_game_week, the same way missed
-- games are: a 2-point day on 10 snaps says nothing about what he does when
-- healthy. last_game_week still uses every game, so the app can tell how many
-- games he's missed. shortened_weeks lists them so the app can say so.
--
-- Players need 4+ games played (shortened ones count toward that) and at least
-- 3 full games, or there isn't enough to compare.
--
-- Try it after running this file:
--   select * from get_trade_signals(
--     (select array_agg(espn_id) from players where full_name in ('Ashton Jeanty', 'Jonathan Taylor'))
--   );

drop function if exists public.get_trade_signals(text[]);

create or replace function public.get_trade_signals(espn_ids text[])
returns table (
  espn_id          text,
  pos              text,      -- RB, WR or TE
  games            integer,
  ppr_per_game     numeric,   -- season average
  ppr_last3        numeric,   -- average over his last 3 games
  ppr_prior        numeric,   -- average over his games before those 3
  touches_last3    numeric,   -- carries + targets per game
  touches_prior    numeric,
  targets_last3    numeric,   -- targets per game (for backs: how big his passing-game role is)
  targets_prior    numeric,
  snaps_last3      numeric,   -- snap %, 74 means 74%
  snaps_prior      numeric,
  red_zone_last3   numeric,   -- carries + targets inside the 20, per game
  red_zone_prior   numeric,
  tds              integer,   -- rushing + receiving TDs this season
  expected_tds     numeric,   -- what his carries and targets "should" have scored
  td_luck          numeric,   -- tds - expected_tds. +2 = two more than expected
  last_game_week   integer,
  last_game_ppr    numeric,
  avg_before_last  numeric,   -- his average before that last game
  ypc_last3        numeric,   -- yards per designed carry (no QB scrambles)
  ypc_season       numeric,
  league_rb_ypc    numeric,   -- every RB in the league, for comparison
  ryoe_per_carry   numeric,   -- rush yards over expected per carry (Next Gen Stats, starter-level games only)
  ypt_last3        numeric,   -- receiving yards per target
  ypt_season       numeric,
  league_ypt       numeric,   -- every player at his position, for comparison
  gl_share_last3   numeric,   -- % of his team's plays inside the 5 that went to him
  gl_share_prior   numeric,
  gl_team_last3    integer,   -- how many plays inside the 5 his team ran in those games
  gl_mate_name     text,      -- the teammate with the most touches inside the 5 lately
  gl_mate_count    integer,
  shortened_weeks  integer[]  -- games he left early hurt, not counted above
)
language sql
stable
as $$
  with roster as materialized (
    select p.gsis_id, p.espn_id, p.position
    from players p
    where p.espn_id = any (espn_ids)
      and p.position in ('RB', 'WR', 'TE')
  ),

  -- ---------- expected TDs ----------

  -- Field position buckets: yards from the end zone.
  -- The closer to the goal line, the more likely a TD.
  plays as materialized (
    select 'run' as kind, x.rusher_id as gsis_id, x.yardline_100, coalesce(x.touchdown, false) as td
    from rushes x
    where x.season = 2026 and x.yardline_100 is not null
    union all
    select 'target', t.receiver_id, t.yardline_100, coalesce(t.touchdown, false)
    from targets t
    where t.season = 2026 and t.yardline_100 is not null
  ),

  bucketed as materialized (
    select
      kind,
      gsis_id,
      td,
      case
        when yardline_100 <= 2  then '1-2'
        when yardline_100 <= 5  then '3-5'
        when yardline_100 <= 10 then '6-10'
        when yardline_100 <= 20 then '11-20'
        when yardline_100 <= 40 then '21-40'
        else '41+'
      end as bucket
    from plays
  ),

  td_rates as materialized (
    -- the league's TD rate for each kind of play from each bucket,
    -- like "a carry from the 1 or 2 scores about half the time"
    select kind, bucket, avg(case when td then 1.0 else 0.0 end) as rate
    from bucketed
    group by kind, bucket
  ),

  his_tds as (
    select
      b.gsis_id,
      sum(case when b.td then 1 else 0 end) as tds,
      sum(r.rate)                           as expected_tds
    from bucketed b
    join roster ro on ro.gsis_id = b.gsis_id
    join td_rates r on r.kind = b.kind and r.bucket = b.bucket
    group by b.gsis_id
  ),

  -- ---------- games: points, touches, snaps, red zone ----------

  his_games as materialized (
    -- one row per game he played, newest first (game_num 1 = his last game)
    select
      w.gsis_id,
      w.week,
      w.fantasy_points_ppr                              as ppr,
      coalesce(w.carries, 0) + coalesce(w.targets, 0)   as touches,
      coalesce(w.targets, 0)                            as targets,
      100 * sn.offense_pct                              as snaps,
      row_number() over (partition by w.gsis_id order by w.week desc) as game_num
    from weekly_stats w
    join roster ro on ro.gsis_id = w.gsis_id
    left join snap_counts sn on sn.gsis_id = w.gsis_id and sn.game_id = w.game_id
    left join shortened_games sg on sg.gsis_id = w.gsis_id and sg.game_id = w.game_id
    where w.season = 2026
      and sg.gsis_id is null   -- leave out games he got hurt in and left early
  ),

  his_last_game as (
    -- the last game he actually played, shortened or not (for counting missed games)
    select w.gsis_id, max(w.week) as week
    from weekly_stats w
    join roster ro on ro.gsis_id = w.gsis_id
    where w.season = 2026
    group by w.gsis_id
  ),

  his_shortened as (
    select sg.gsis_id, array_agg(sg.week order by sg.week) as weeks
    from shortened_games sg
    join roster ro on ro.gsis_id = sg.gsis_id
    where sg.season = 2026
    group by sg.gsis_id
  ),

  his_red_zone as materialized (
    -- carries + targets inside the 20, by week
    select z.gsis_id, z.week, count(*) as rz
    from (
      select x.rusher_id as gsis_id, x.week from rushes x
      where x.season = 2026 and x.yardline_100 <= 20
      union all
      select t.receiver_id, t.week from targets t
      where t.season = 2026 and t.yardline_100 <= 20
    ) z
    join roster ro on ro.gsis_id = z.gsis_id
    group by z.gsis_id, z.week
  ),

  -- ---------- efficiency ----------

  his_last3_weeks as materialized (
    select gsis_id, week, game_num from his_games
  ),

  carry_eff as (
    -- yards per designed carry, his last 3 games and the season
    select
      x.rusher_id as gsis_id,
      sum(x.rushing_yards)::numeric / nullif(count(*), 0)                              as ypc_season,
      sum(x.rushing_yards) filter (where w.game_num <= 3)::numeric
        / nullif(count(*) filter (where w.game_num <= 3), 0)                             as ypc_last3
    from rushes x
    join his_last3_weeks w on w.gsis_id = x.rusher_id and w.week = x.week
    where x.season = 2026 and coalesce(x.qb_scramble, false) = false
    group by x.rusher_id
  ),

  league_ypc as (
    select sum(x.rushing_yards)::numeric / nullif(count(*), 0) as ypc
    from rushes x
    join players p on p.gsis_id = x.rusher_id
    where x.season = 2026 and p.position = 'RB' and coalesce(x.qb_scramble, false) = false
  ),

  ryoe as (
    -- Next Gen Stats only has starter-level games, so this can be missing
    select a.gsis_id,
           sum(a.rush_yards_over_expected) / nullif(sum(a.carries), 0) as ryoe_per_carry
    from rushing_advanced a
    join roster ro on ro.gsis_id = a.gsis_id
    where a.season = 2026 and a.week > 0
    group by a.gsis_id
  ),

  target_eff as (
    select
      t.receiver_id as gsis_id,
      sum(coalesce(t.receiving_yards, 0))::numeric / nullif(count(*), 0)                as ypt_season,
      sum(coalesce(t.receiving_yards, 0)) filter (where w.game_num <= 3)::numeric
        / nullif(count(*) filter (where w.game_num <= 3), 0)                             as ypt_last3
    from targets t
    join his_last3_weeks w on w.gsis_id = t.receiver_id and w.week = t.week
    where t.season = 2026
    group by t.receiver_id
  ),

  league_ypt as (
    select p.position, sum(coalesce(t.receiving_yards, 0))::numeric / nullif(count(*), 0) as ypt
    from targets t
    join players p on p.gsis_id = t.receiver_id
    where t.season = 2026 and p.position in ('RB', 'WR', 'TE')
    group by p.position
  ),

  -- ---------- goal-line role (inside the 5) ----------

  gl_plays as materialized (
    -- every carry and target inside the 5, with the offense and who got it
    select x.team, x.week, x.rusher_id as gsis_id from rushes x
    where x.season = 2026 and x.yardline_100 <= 5 and coalesce(x.qb_scramble, false) = false
    union all
    select t.team, t.week, t.receiver_id from targets t
    where t.season = 2026 and t.yardline_100 <= 5
  ),

  his_gl_games as materialized (
    -- for each of his games: his team's plays inside the 5 and how many were his
    select
      g.gsis_id,
      g.game_num,
      count(gp.*)                                                   as team_plays,
      count(gp.*) filter (where gp.gsis_id = g.gsis_id)             as his_plays
    from his_games g
    join weekly_stats w on w.gsis_id = g.gsis_id and w.season = 2026 and w.week = g.week
    left join gl_plays gp on gp.team = w.team and gp.week = g.week
    group by g.gsis_id, g.game_num
  ),

  gl_share as (
    select
      gsis_id,
      100.0 * sum(his_plays) filter (where game_num <= 3) / nullif(sum(team_plays) filter (where game_num <= 3), 0) as last3,
      100.0 * sum(his_plays) filter (where game_num > 3)  / nullif(sum(team_plays) filter (where game_num > 3), 0)  as prior,
      sum(team_plays) filter (where game_num <= 3)                                                                as team_last3
    from his_gl_games
    group by gsis_id
  ),

  gl_mates as (
    -- teammates' touches inside the 5 during his last 3 games; keep the top one
    select distinct on (g.gsis_id)
      g.gsis_id,
      mp.full_name   as mate_name,
      count(*)       as mate_count
    from his_games g
    join weekly_stats w on w.gsis_id = g.gsis_id and w.season = 2026 and w.week = g.week
    join gl_plays gp on gp.team = w.team and gp.week = g.week and gp.gsis_id <> g.gsis_id
    join players mp on mp.gsis_id = gp.gsis_id and mp.position in ('RB', 'WR', 'TE')
    where g.game_num <= 3
    group by g.gsis_id, mp.full_name
    order by g.gsis_id, count(*) desc
  ),

  summary as (
    select
      g.gsis_id,
      count(*)                                                     as games,
      avg(g.ppr)                                                   as ppr_per_game,
      avg(g.ppr)      filter (where g.game_num <= 3)               as ppr_last3,
      avg(g.ppr)      filter (where g.game_num > 3)                as ppr_prior,
      avg(g.touches)  filter (where g.game_num <= 3)               as touches_last3,
      avg(g.touches)  filter (where g.game_num > 3)                as touches_prior,
      avg(g.targets)  filter (where g.game_num <= 3)               as targets_last3,
      avg(g.targets)  filter (where g.game_num > 3)                as targets_prior,
      avg(g.snaps)    filter (where g.game_num <= 3)               as snaps_last3,
      avg(g.snaps)    filter (where g.game_num > 3)                as snaps_prior,
      avg(coalesce(z.rz, 0)) filter (where g.game_num <= 3)        as red_zone_last3,
      avg(coalesce(z.rz, 0)) filter (where g.game_num > 3)         as red_zone_prior,
      max(g.week)     filter (where g.game_num = 1)                as last_game_week,
      max(g.ppr)      filter (where g.game_num = 1)                as last_game_ppr,
      avg(g.ppr)      filter (where g.game_num > 1)                as avg_before_last
    from his_games g
    left join his_red_zone z on z.gsis_id = g.gsis_id and z.week = g.week
    group by g.gsis_id
  )

  select
    ro.espn_id,
    ro.position,
    s.games::integer,
    round(s.ppr_per_game, 1),
    round(s.ppr_last3, 1),
    round(s.ppr_prior, 1),
    round(s.touches_last3, 1),
    round(s.touches_prior, 1),
    round(s.targets_last3, 1),
    round(s.targets_prior, 1),
    round(s.snaps_last3, 0),
    round(s.snaps_prior, 0),
    round(s.red_zone_last3, 1),
    round(s.red_zone_prior, 1),
    coalesce(t.tds, 0)::integer,
    round(coalesce(t.expected_tds, 0), 1),
    round(coalesce(t.tds, 0) - coalesce(t.expected_tds, 0), 1),
    coalesce(lg.week, s.last_game_week),
    round(s.last_game_ppr, 1),
    round(s.avg_before_last, 1),
    round(ce.ypc_last3, 1),
    round(ce.ypc_season, 1),
    round((select ypc from league_ypc), 1),
    round(ry.ryoe_per_carry, 2),
    round(te.ypt_last3, 1),
    round(te.ypt_season, 1),
    round(ly.ypt, 1),
    round(gs.last3, 0),
    round(gs.prior, 0),
    gs.team_last3::integer,
    gm.mate_name,
    gm.mate_count::integer,
    hs.weeks
  from roster ro
  join summary s on s.gsis_id = ro.gsis_id
  left join his_tds t     on t.gsis_id  = ro.gsis_id
  left join carry_eff ce  on ce.gsis_id = ro.gsis_id
  left join ryoe ry       on ry.gsis_id = ro.gsis_id
  left join target_eff te on te.gsis_id = ro.gsis_id
  left join league_ypt ly on ly.position = ro.position
  left join gl_share gs   on gs.gsis_id = ro.gsis_id
  left join gl_mates gm   on gm.gsis_id = ro.gsis_id
  left join his_last_game lg on lg.gsis_id = ro.gsis_id
  left join his_shortened hs on hs.gsis_id = ro.gsis_id
  -- 4+ games played (a shortened one still counts toward that), and at least
  -- 3 full games to build his numbers from. Otherwise a rookie who got hurt in
  -- Week 1 would vanish from the Trades page.
  where s.games + coalesce(array_length(hs.weeks, 1), 0) >= 4
    and s.games >= 3;
$$;

-- Same lockdown as the other functions: only the app's secret keys can call it.
revoke execute on function public.get_trade_signals(text[]) from public, anon, authenticated;
grant execute on function public.get_trade_signals(text[]) to service_role;
