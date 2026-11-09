-- schedule table
-- One row per NFL game this season, all 18 weeks, including games that
-- haven't been played yet. Loaded from nflverse by scripts/load-schedule.js.
--
-- What it's for:
--   - BYE weeks: any week a team has no game
--   - Missed games: his team played but he has no stats that week
--   - Future opponents, for the upcoming rows and projections
--   - Final scores, to tell if a team was trailing (passes more) or leading (runs more)
--   - Vegas lines: spread and total points, which projections use

create table public.schedule (
  game_id      text primary key,        -- same ID as snap_counts and weekly_stats, like 2026_06_LV_KC
  season       integer not null,
  week         integer not null,
  game_type    text,                    -- REG for regular season (playoff games come later)
  gameday      date,
  gametime     text,                    -- kickoff, Eastern time, like 13:00
  away_team    text not null,
  home_team    text not null,
  away_score   integer,                 -- blank until the game is played
  home_score   integer,
  spread_line  numeric,                 -- points the HOME team is favored by. 3.5 = home by 3.5, -3.5 = away by 3.5
  total_line   numeric,                 -- Vegas over/under for total points in the game
  roof         text,                    -- outdoors, dome, closed or open
  temp         integer,                 -- degrees F at kickoff (blank for domes)
  wind         integer,                 -- mph at kickoff (blank for domes)
  div_game     boolean,                 -- true if it's a division game
  updated_at   timestamptz not null default now()
);

-- the app looks up "every game for this team this season" a lot
create index schedule_season_week_idx on public.schedule (season, week);
