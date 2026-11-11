-- shortened_games view and get_shortened_games function
-- Games where a player got hurt and left early (or played hurt on a pitch
-- count), so his points that day don't show what he really does.
--
-- Why: a guy who gets hurt on his 10th snap scores 2 points, and that 2 sits
-- in his average all season, making him look worse than he is. Missed games
-- were already handled (they just don't count). Shortened games weren't.
--
-- A game counts as shortened when ALL of these are true:
--   1. He played less than half his usual snap share that game
--      (usual = his median snap share this season)
--   2. He normally has a real role: usual snap share of 40% or more
--      (a backup's snaps bounce around for no injury reason at all)
--   3. He was on the injury report the week of that game or the week after,
--      for an actual injury (not "not injury related" rest days)
-- Number 3 is what keeps benchings and blowouts out: a starter pulled late in
-- a 35-point game isn't on the next week's injury report.
--
-- After running this file, run 18_trade_signals.sql and 21_player_weeks.sql
-- again: both now leave these games out of averages, recent form and
-- floor/ceiling.
--
-- Try it after running this file:
--   select p.full_name, sg.* from shortened_games sg
--   join players p on p.gsis_id = sg.gsis_id
--   where sg.season = 2026 order by sg.week;

drop view if exists public.shortened_games cascade;

create view public.shortened_games as
with usual as (
  -- each player's typical snap share this season (median, so one weird game doesn't move it)
  select
    s.gsis_id,
    s.season,
    percentile_cont(0.5) within group (order by s.offense_pct) as usual_pct,
    count(*) as games
  from snap_counts s
  where s.offense_pct is not null and s.offense_snaps > 0
  group by s.gsis_id, s.season
)
select
  s.gsis_id,
  s.game_id,
  s.season,
  s.week,
  round(100 * s.offense_pct, 0)   as snap_pct,     -- 18 means 18%
  round(100 * u.usual_pct::numeric, 0) as usual_pct
from snap_counts s
join usual u on u.gsis_id = s.gsis_id and u.season = s.season
where u.games >= 3
  and u.usual_pct >= 0.4
  and s.offense_pct < 0.5 * u.usual_pct
  and exists (
    select 1
    from injuries i
    where i.gsis_id = s.gsis_id
      and i.season = s.season
      and i.week in (s.week, s.week + 1)
      and coalesce(i.injury, '') !~* 'not injury related'
      and coalesce(i.injury, '') <> ''
  );

-- The view would otherwise be readable through the public API. Only the app's
-- secret keys (and the functions below) need it.
revoke all on public.shortened_games from public, anon, authenticated;
grant select on public.shortened_games to service_role;


-- get_shortened_games: which of these players' games were shortened, so the
-- My Team game log can mark them and leave them out of the season average.
drop function if exists public.get_shortened_games(text[]);

create or replace function public.get_shortened_games(espn_ids text[])
returns table (
  espn_id   text,
  week      integer,
  snap_pct  numeric,
  usual_pct numeric
)
language sql
stable
as $$
  select p.espn_id, sg.week, sg.snap_pct, sg.usual_pct
  from shortened_games sg
  join players p on p.gsis_id = sg.gsis_id
  where p.espn_id = any(espn_ids) and sg.season = 2026
  order by p.espn_id, sg.week;
$$;

revoke execute on function public.get_shortened_games(text[]) from public, anon, authenticated;
grant execute on function public.get_shortened_games(text[]) to service_role;
