-- rushes table
-- One row per carry. Tells us where a player runs (left/middle/right and
-- which gap), how often he gets the ball near the goal line, and whether
-- a QB run was planned or a scramble.

create table public.rushes (
  game_id        text not null,           -- nflverse game ID, like 2026_06_LV_KC
  play_id        integer not null,        -- play number inside that game
  season         integer not null,
  week           integer not null,
  team           text,                    -- offense running the ball
  opponent       text,                    -- defense on the field
  rusher_id      text not null references public.players (gsis_id),
  down           integer,
  ydstogo        integer,
  yardline_100   integer,                 -- yards from the end zone, 20 or less = red zone, 5 or less = goal line
  run_location   text,                    -- 'left', 'middle' or 'right'
  run_gap        text,                    -- 'end', 'tackle' or 'guard' (blank on runs up the middle)
  rushing_yards  integer,
  first_down     boolean,
  touchdown      boolean,
  fumble_lost    boolean,
  qb_scramble    boolean,                 -- true = QB ran because the pass broke down, not a designed run
  epa            numeric,                 -- expected points added, how much the play helped
  updated_at     timestamptz not null default now(),

  -- a play only happens once
  primary key (game_id, play_id)
);

-- the app will mostly look up "all carries for this player",
-- so an index on rusher_id keeps those lookups fast
create index rushes_rusher_idx on public.rushes (rusher_id, season, week);
