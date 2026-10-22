-- targets table
-- One row per pass thrown to a player (a "target").
-- This is where we learn HOW a player is being used, not just that he's on the field:
-- how deep the throws are (air yards), which side of the field (left/middle/right),
-- and whether it happened in the red zone.

create table public.targets (
  game_id        text not null,           -- nflverse game ID, like 2026_06_LV_KC
  play_id        integer not null,        -- play number inside that game
  season         integer not null,
  week           integer not null,
  team           text,                    -- offense throwing the ball
  opponent       text,                    -- defense on the field
  receiver_id    text not null references public.players (gsis_id),
  passer_id      text,                    -- QB who threw it
  down           integer,
  ydstogo        integer,
  yardline_100   integer,                 -- yards from the end zone, 20 or less = red zone
  air_yards      integer,                 -- how far past the line the ball was thrown
  pass_length    text,                    -- 'short' or 'deep'
  pass_location  text,                    -- 'left', 'middle' or 'right'
  complete       boolean,
  receiving_yards integer,
  yards_after_catch integer,
  touchdown      boolean,
  interception   boolean,
  epa            numeric,                 -- expected points added, how much the play helped
  updated_at     timestamptz not null default now(),

  -- a play only happens once
  primary key (game_id, play_id)
);

-- the app will almost always look up "all targets for this player",
-- so an index on receiver_id keeps those lookups fast
create index targets_receiver_idx on public.targets (receiver_id, season, week);
