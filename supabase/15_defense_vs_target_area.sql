-- defense_vs_target_area view  (file 15: runs after 13_injury_history and 14_schedule)
-- What every defense gives up, split by WHERE the ball was thrown.
--
-- The field gets cut into 6 areas: short or deep (deep = 15+ air yards),
-- then left, middle or right. For each defense, each area, and each receiver
-- position (WR, TE, RB), it shows how many targets they've faced there and
-- how many PPR points those targets turned into.
--
-- This is the "where does he get his targets vs what this defense allows there"
-- part of Start/Sit. Example: if a receiver lives on deep right throws and this
-- week's defense ranks 3rd worst at stopping deep right throws to WRs, that's a
-- real reason to start him, not just "bad pass defense."
--
-- It's a VIEW, not a regular table. A view is a saved query that acts like a
-- table: you select from it the same way, but it builds itself from the targets
-- table every time you ask. So there's no loader script to write, and it's
-- always up to date after the Tuesday/Saturday refresh with no extra steps.
--
-- Points are PPR from the receiving side only: 1 per catch, 0.1 per yard,
-- 6 per TD. (Fumbles aren't in the targets table, and they're rare enough
-- not to matter here.)
--
-- Heads up on small samples: deep throws to TEs and RBs don't happen much, so
-- some rows will only have 2 or 3 targets. The targets column is there so the
-- app can ignore rows that are too small to mean anything.
--
-- Rerunning this file is safe: it drops the old view and rebuilds it.
--
-- Try it after running this file. The 5 defenses that give up the most
-- points per game on deep right throws to WRs:
--   select defense, targets, ppr_per_game, ppr_per_target, rank
--   from defense_vs_target_area
--   where position = 'WR' and area = 'deep right'
--   order by rank
--   limit 5;

drop view if exists public.defense_vs_target_area;

create view public.defense_vs_target_area
with (security_invoker = true)   -- runs with the permissions of whoever asks, so it can't be used to sneak around table permissions
as
with tagged as (
  -- every target, tagged with the receiver's position and the area it went to
  select
    t.season,
    t.opponent                            as defense,
    t.game_id,
    p.position,
    t.pass_length                         as depth,      -- 'short' or 'deep'
    t.pass_location                       as side,       -- 'left', 'middle' or 'right'
    coalesce(t.complete, false)           as complete,
    coalesce(t.receiving_yards, 0)        as yards,
    coalesce(t.touchdown, false)          as touchdown,
    -- PPR points this one target was worth
    (case when t.complete then 1 else 0 end)
      + coalesce(t.receiving_yards, 0) * 0.1
      + (case when t.touchdown then 6 else 0 end)  as ppr
  from targets t
  join players p on p.gsis_id = t.receiver_id
  where p.position in ('WR', 'TE', 'RB')
    and t.opponent is not null
    and t.pass_length is not null      -- a few plays are missing where the ball went;
    and t.pass_location is not null    -- those can't go in an area, so they're left out
),

defense_games as (
  -- how many games each defense has played, to turn totals into per-game numbers
  select season, defense, count(distinct game_id) as games
  from tagged
  group by season, defense
),

by_area as (
  -- the main totals: one row per defense, position and area
  select
    season,
    defense,
    position,
    depth,
    side,
    count(*)                              as targets,
    sum(case when complete then 1 else 0 end) as catches,
    sum(yards)                            as yards,
    sum(case when touchdown then 1 else 0 end) as tds,
    sum(ppr)                              as ppr
  from tagged
  group by season, defense, position, depth, side
),

league as (
  -- the league average for each position and area, so every defense has
  -- something to be compared against
  select
    season,
    position,
    depth,
    side,
    sum(ppr) / nullif(sum(targets), 0)    as ppr_per_target
  from by_area
  group by season, position, depth, side
)

select
  a.season,
  a.defense,
  a.position,
  a.depth || ' ' || a.side                as area,      -- like 'deep right'
  a.depth,
  a.side,
  g.games,
  a.targets,
  round(a.targets::numeric / g.games, 1)  as targets_per_game,
  round(100.0 * a.catches / a.targets, 0) as catch_pct,
  round(a.yards::numeric / a.targets, 1)  as yards_per_target,
  a.tds,
  round(a.ppr / g.games, 1)               as ppr_per_game,       -- points given up here per game
  round(a.ppr / a.targets, 2)             as ppr_per_target,     -- points given up per throw here
  round(l.ppr_per_target, 2)              as league_ppr_per_target,
  round(a.ppr / a.targets - l.ppr_per_target, 2) as vs_league,  -- positive = worse than average defense
  -- vs_league toned down for small samples: 20 targets counts half, 60 counts 75%,
  -- so a defense that's seen 3 deep throws can't look like the worst in the league
  round((a.ppr / a.targets - l.ppr_per_target) * a.targets / (a.targets + 20.0), 2) as vs_league_adj,
  -- 1 = gives up the most points per game in this area to this position
  -- (counts volume too: how often teams throw there AND how much it gives up)
  rank() over (
    partition by a.season, a.position, a.depth, a.side
    order by a.ppr / g.games desc
  )                                       as rank,
  -- 1 = gives up the most per throw here, after toning down small samples.
  -- This is the one for matchups: his role decides how often he's targeted
  -- there, the defense decides how much each of those targets is worth.
  rank() over (
    partition by a.season, a.position, a.depth, a.side
    order by (a.ppr / a.targets - l.ppr_per_target) * a.targets / (a.targets + 20.0) desc
  )                                       as rank_per_target
from by_area a
join defense_games g on g.season = a.season and g.defense = a.defense
join league l
  on  l.season   = a.season
  and l.position = a.position
  and l.depth    = a.depth
  and l.side     = a.side;

-- Same lockdown as the database functions: only the app's secret keys can read it,
-- not the public key that ships with a website.
revoke all on public.defense_vs_target_area from public, anon, authenticated;
grant select on public.defense_vs_target_area to service_role;
