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
-- The app turns these numbers into the actual sell / buy / hold call and the
-- sentences (src/trades.js), the same way why.js does for the Why box.
--
-- Players with fewer than 4 games aren't returned: not enough to compare.
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
  snaps_last3      numeric,   -- snap %, 74 means 74%
  snaps_prior      numeric,
  red_zone_last3   numeric,   -- carries + targets inside the 20, per game
  red_zone_prior   numeric,
  tds              integer,   -- rushing + receiving TDs this season
  expected_tds     numeric,   -- what his carries and targets "should" have scored
  td_luck          numeric,   -- tds - expected_tds. +2 = two more than expected
  last_game_week   integer,
  last_game_ppr    numeric,
  avg_before_last  numeric    -- his average before that last game
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
      100 * sn.offense_pct                              as snaps,
      row_number() over (partition by w.gsis_id order by w.week desc) as game_num
    from weekly_stats w
    join roster ro on ro.gsis_id = w.gsis_id
    left join snap_counts sn on sn.gsis_id = w.gsis_id and sn.game_id = w.game_id
    where w.season = 2026
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

  summary as (
    select
      g.gsis_id,
      count(*)                                                     as games,
      avg(g.ppr)                                                   as ppr_per_game,
      avg(g.ppr)      filter (where g.game_num <= 3)               as ppr_last3,
      avg(g.ppr)      filter (where g.game_num > 3)                as ppr_prior,
      avg(g.touches)  filter (where g.game_num <= 3)               as touches_last3,
      avg(g.touches)  filter (where g.game_num > 3)                as touches_prior,
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
    round(s.snaps_last3, 0),
    round(s.snaps_prior, 0),
    round(s.red_zone_last3, 1),
    round(s.red_zone_prior, 1),
    coalesce(t.tds, 0)::integer,
    round(coalesce(t.expected_tds, 0), 1),
    round(coalesce(t.tds, 0) - coalesce(t.expected_tds, 0), 1),
    s.last_game_week,
    round(s.last_game_ppr, 1),
    round(s.avg_before_last, 1)
  from roster ro
  join summary s on s.gsis_id = ro.gsis_id
  left join his_tds t on t.gsis_id = ro.gsis_id
  where s.games >= 4;
$$;

-- Same lockdown as the other functions: only the app's secret keys can call it.
revoke execute on function public.get_trade_signals(text[]) from public, anon, authenticated;
grant execute on function public.get_trade_signals(text[]) to service_role;
