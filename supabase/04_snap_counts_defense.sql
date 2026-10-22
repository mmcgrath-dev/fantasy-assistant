-- Add defensive snaps to snap_counts.
-- Now that players includes every position, this lets the app see which
-- defenders actually played each game (for "their CB1 is out" type matchups).

alter table public.snap_counts
  add column defense_snaps integer,
  add column defense_pct   numeric;   -- share of team defensive snaps, 0.95 means 95%
