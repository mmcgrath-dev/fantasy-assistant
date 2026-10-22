-- Add Pro Football Reference IDs to the players table.
-- The nflverse snap counts file identifies players by pfr_id instead of gsis_id,
-- so we store it here to translate between the two.

alter table public.players
  add column pfr_id text unique;
