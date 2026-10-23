-- weekly_stats table
-- One row per player per game: the box score and the fantasy points it was worth.
-- This is "what actually happened." The targets, rushes and snap counts tables
-- show how a player is being used; this one shows what that usage turned into.
-- Comparing the two is how the app spots lucky and unlucky players.

create table public.weekly_stats (
  gsis_id          text not null references public.players (gsis_id),
  game_id          text not null,         -- nflverse game ID, like 2026_06_LV_KC
  season           integer not null,
  week             integer not null,
  team             text,
  opponent         text,
  position         text,

  -- passing
  completions      integer,
  attempts         integer,
  passing_yards    integer,
  passing_tds      integer,
  interceptions    integer,
  sacks            integer,

  -- rushing
  carries          integer,
  rushing_yards    integer,
  rushing_tds      integer,

  -- receiving
  targets          integer,
  receptions       integer,
  receiving_yards  integer,
  receiving_tds    integer,
  receiving_air_yards integer,
  target_share     numeric,               -- share of the team's targets, 0.25 means 25%
  air_yards_share  numeric,               -- share of the team's air yards
  wopr             numeric,               -- target share and air yards share combined in one number

  -- other scoring
  two_point_conversions integer,
  fumbles_lost     integer,
  special_teams_tds integer,

  -- kicking
  fg_made          integer,
  fg_att           integer,
  fg_made_40_49    integer,
  fg_made_50_plus  integer,
  fg_missed        integer,
  pat_made         integer,
  pat_missed       integer,

  -- fantasy points
  fantasy_points_ppr numeric,             -- standard PPR scoring, matches ESPN's default

  updated_at       timestamptz not null default now(),

  -- a player can only have one row per game
  primary key (gsis_id, game_id)
);

-- most lookups will be "this player's last few weeks"
create index weekly_stats_player_idx on public.weekly_stats (gsis_id, season, week);
