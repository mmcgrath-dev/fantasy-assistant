-- snap_counts table
-- One row per player per game: how many offensive snaps they played
-- and what share of the team's snaps that was.
-- Week to week, this is what shows a player's role growing or shrinking.

create table public.snap_counts (
  gsis_id       text not null references public.players (gsis_id),
  game_id       text not null,           -- nflverse game ID, like 2026_06_LV_KC
  season        integer not null,
  week          integer not null,
  team          text,
  opponent      text,
  offense_snaps integer,
  offense_pct   numeric,                 -- share of team snaps, 0.74 means 74%
  updated_at    timestamptz not null default now(),

  -- a player can only have one row per game
  primary key (gsis_id, game_id)
);
