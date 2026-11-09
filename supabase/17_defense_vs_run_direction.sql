-- defense_vs_run_direction view
-- What every defense gives up to running backs, split by WHERE the run went.
-- It's the running version of defense_vs_target_area.
--
-- Every RB carry gets put in one of 5 lanes, using the direction and gap
-- the play-by-play records:
--
--   left end      outside, around the left tackle
--   left inside   between the left tackle and center (tackle or guard gap)
--   middle        straight up the middle
--   right inside  between the center and right tackle
--   right end     outside, around the right tackle
--
-- For each defense and each lane it shows how many RB carries it has faced
-- there, yards per carry, TDs, and the PPR points those carries were worth.
-- The comparison to the league and the rank use yards per carry (see the
-- note on vs_league below for why TDs are left out of that part).
--
-- Points are PPR from the running side only: 0.1 per yard, 6 per TD,
-- minus 2 for a lost fumble (ESPN's default).
--
-- Only RB carries count. QB scrambles and receiver jet sweeps are left out,
-- since those don't tell you much about how a defense handles running backs.
--
-- Like the target view, it's a VIEW, so it updates itself after every data
-- refresh, and small samples are toned down in vs_league_adj and
-- rank_per_carry (20 carries counts half, 60 counts 75%).
--
-- Rerunning this file is safe: it drops the old view and rebuilds it.
--
-- Try it after running this file. The 5 defenses easiest to run on outside left:
--   select defense, carries, yards_per_carry, ppr_per_carry, vs_league_adj, rank_per_carry
--   from defense_vs_run_direction
--   where lane = 'left end'
--   order by rank_per_carry
--   limit 5;

drop view if exists public.defense_vs_run_direction;

create view public.defense_vs_run_direction
with (security_invoker = true)   -- runs with the permissions of whoever asks
as
-- Each step is "materialized" (worked out once and reused), same as the
-- target view, so lookups stay fast.
with tagged as materialized (
  -- every RB carry, tagged with its lane
  select
    r.season,
    r.opponent                            as defense,
    r.game_id,
    case
      when r.run_location = 'middle'                         then 'middle'
      when r.run_location = 'left'  and r.run_gap = 'end'    then 'left end'
      when r.run_location = 'left'                           then 'left inside'
      when r.run_location = 'right' and r.run_gap = 'end'    then 'right end'
      when r.run_location = 'right'                          then 'right inside'
    end                                   as lane,
    coalesce(r.rushing_yards, 0)          as yards,
    coalesce(r.touchdown, false)          as touchdown,
    -- PPR points this one carry was worth
    coalesce(r.rushing_yards, 0) * 0.1
      + (case when r.touchdown then 6 else 0 end)
      - (case when r.fumble_lost then 2 else 0 end) as ppr
  from rushes r
  join players p on p.gsis_id = r.rusher_id
  where p.position = 'RB'
    and coalesce(r.qb_scramble, false) = false
    and r.opponent is not null
    and r.run_location is not null       -- a few carries are missing a direction;
                                         -- those can't go in a lane, so they're left out
),

defense_games as materialized (
  -- how many games each defense has played, for per-game numbers
  select season, defense, count(distinct game_id) as games
  from tagged
  group by season, defense
),

by_lane as materialized (
  -- the main totals: one row per defense and lane
  select
    season,
    defense,
    lane,
    count(*)                              as carries,
    sum(yards)                            as yards,
    sum(case when touchdown then 1 else 0 end) as tds,
    sum(ppr)                              as ppr
  from tagged
  group by season, defense, lane
),

league as materialized (
  -- the league average for each lane
  select
    season,
    lane,
    sum(yards)::numeric / nullif(sum(carries), 0) as yards_per_carry,
    sum(ppr) / nullif(sum(carries), 0)            as ppr_per_carry
  from by_lane
  group by season, lane
)

select
  b.season,
  b.defense,
  b.lane,
  g.games,
  b.carries,
  round(b.carries::numeric / g.games, 1)  as carries_per_game,
  round(b.yards::numeric / b.carries, 1)  as yards_per_carry,
  round(l.yards_per_carry, 1)             as league_yards_per_carry,
  b.tds,
  round(b.ppr / g.games, 1)               as ppr_per_game,
  round(b.ppr / b.carries, 2)             as ppr_per_carry,
  round(l.ppr_per_carry, 2)               as league_ppr_per_carry,
  -- How much easier (+) or harder (-) than an average defense, in PPR per carry,
  -- from YARDS only: 0.1 x (his yards per carry - the league's).
  -- TDs are left out of this on purpose. Inside-run TDs mostly come from
  -- goal-line carries, so they say more about who got the ball near the end
  -- zone than about how good the defense is. One defense ranked "easiest"
  -- on 3.8 yards a carry just from 4 short TDs. Yards are much steadier.
  round(0.1 * (b.yards::numeric / b.carries - l.yards_per_carry), 2) as vs_league,
  -- vs_league toned down for small samples (20 carries counts half, 60 counts 75%)
  round(0.1 * (b.yards::numeric / b.carries - l.yards_per_carry) * b.carries / (b.carries + 20.0), 2) as vs_league_adj,
  -- 1 = gives up the most yards per carry in this lane, after toning down small samples
  rank() over (
    partition by b.season, b.lane
    order by (b.yards::numeric / b.carries - l.yards_per_carry) * b.carries / (b.carries + 20.0) desc
  )                                       as rank_per_carry
from by_lane b
join defense_games g on g.season = b.season and g.defense = b.defense
join league l on l.season = b.season and l.lane = b.lane;

-- Same lockdown as the target view: only the app's secret keys can read it.
revoke all on public.defense_vs_run_direction from public, anon, authenticated;
grant select on public.defense_vs_run_direction to service_role;
