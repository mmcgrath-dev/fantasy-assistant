-- players table
-- One row per NFL player. Every other table (snap counts, targets, weekly stats)
-- links back to this one using gsis_id.

create table public.players (
  gsis_id    text primary key,          -- nflverse's player ID, like 00-0033873
  espn_id    text unique,               -- ESPN's player ID, used to match your fantasy roster
  full_name  text not null,
  position   text,                      -- QB, RB, WR, TE
  team       text,                      -- current NFL team, like PHI
  updated_at timestamptz not null default now()
);
