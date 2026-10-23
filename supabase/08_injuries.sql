-- injuries table
-- One row per player per week they showed up on their team's official injury report.
-- Game status (Out, Doubtful, Questionable) plus how much they practiced.
-- This powers the O-line and defense injury edges, vacated targets,
-- and flagging your own players before kickoff.

create table public.injuries (
  gsis_id          text not null references public.players (gsis_id),
  season           integer not null,
  week             integer not null,
  team             text,
  position         text,
  game_status      text,                  -- 'Out', 'Doubtful', 'Questionable', or blank if expected to play
  injury           text,                  -- main injury, like 'Hamstring'
  injury_secondary text,                  -- second injury if there is one
  practice_status  text,                  -- 'Full', 'Limited' or 'DNP' (did not participate)
  practice_note    text,                  -- reason for missing practice, like 'Not injury related - resting player'
  updated_at       timestamptz not null default now(),

  -- a player is on one injury report per week
  primary key (gsis_id, season, week)
);

-- the app will look up "who's hurt on this team this week" a lot
create index injuries_team_week_idx on public.injuries (team, season, week);
