-- receiving_advanced and rushing_advanced tables
-- One row per player per week, combining two free sources:
--   Next Gen Stats (NFL player tracking chips): separation, cushion, YAC over expected,
--     rush yards over expected, stacked boxes. Only covers players who got enough
--     targets or carries that week to qualify, so lots of backups won't have these.
--   Pro Football Reference: drops, broken tackles, yards before and after contact.
--     Covers pretty much everyone who touched the ball.
-- Every percent here is stored as a decimal (0.25 means 25%), same as weekly_stats.

create table public.receiving_advanced (
  gsis_id                  text not null references public.players (gsis_id),
  season                   integer not null,
  week                     integer not null,
  game_id                  text,
  team                     text,
  opponent                 text,

  -- Next Gen Stats
  avg_cushion              numeric,       -- yards between him and the nearest defender at the snap
  avg_separation           numeric,       -- yards between him and the nearest defender when the ball arrives
  avg_intended_air_yards   numeric,       -- average depth of the throws to him (aDOT)
  share_of_team_air_yards  numeric,       -- share of the team's intended air yards
  catch_rate               numeric,
  avg_yac                  numeric,       -- yards after catch per catch
  avg_expected_yac         numeric,       -- what an average receiver gets after the catch on those same throws
  yac_over_expected        numeric,       -- positive = making more happen after the catch than expected

  -- Pro Football Reference
  drops                    integer,
  drop_rate                numeric,       -- drops per target
  broken_tackles           integer,
  passer_rating_when_targeted numeric,

  updated_at               timestamptz not null default now(),

  -- one row per player per week
  primary key (gsis_id, season, week)
);

create table public.rushing_advanced (
  gsis_id                  text not null references public.players (gsis_id),
  season                   integer not null,
  week                     integer not null,
  game_id                  text,
  team                     text,
  opponent                 text,

  -- Next Gen Stats
  efficiency               numeric,       -- distance run per yard gained, lower = more north-south
  pct_vs_eight_plus_box    numeric,       -- share of carries with 8 or more defenders in the box
  avg_time_to_los          numeric,       -- seconds to reach the line of scrimmage
  expected_rush_yards      numeric,       -- what an average back gains on those same carries
  rush_yards_over_expected numeric,       -- positive = the back is creating yards, not just the blocking
  ryoe_per_carry           numeric,
  pct_carries_over_expected numeric,      -- share of carries where he beat expected yards

  -- Pro Football Reference
  carries                  integer,
  yards_before_contact     integer,       -- mostly a sign of the blocking
  yards_before_contact_avg numeric,
  yards_after_contact      integer,       -- mostly a sign of the runner
  yards_after_contact_avg  numeric,
  broken_tackles           integer,

  updated_at               timestamptz not null default now(),

  -- one row per player per week
  primary key (gsis_id, season, week)
);
