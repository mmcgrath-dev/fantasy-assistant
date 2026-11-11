-- get_player_weeks function
-- Every remaining game for each player you hand it, through week 17 (the
-- fantasy season): the week, the opponent, and how generous that defense has
-- been to his position. The app turns this into a Sleeper-style week-by-week
-- projection, and the trade math scores every future week with it instead of
-- using one flat number.
--
-- One row per player, with every game packed into one JSON list, so the
-- answer stays small (Supabase cuts any answer off at 1000 rows, and one row
-- per game blew past that and made missing games look like byes).
--
-- A week with no entry is the player's bye (or the season is over).
--
-- For each game:
--
--   - def_allowed: PPR points per game that defense gives up to his position
--     (all its games this season, every player who recorded stats).
--   - league_allowed: what the average defense gives up to that position, so
--     def_allowed / league_allowed says how soft the matchup is. 1.15 = about
--     15% more points than average flow to his position there.
--   - implied: the points Vegas expects his TEAM to score that week, when a
--     line is posted (usually only about a week out). Null otherwise.
--
-- Try it after running this file:
--   select * from get_player_weeks(
--     (select array_agg(espn_id) from players where full_name in ('Tee Higgins'))
--   ) order by week;

drop function if exists public.get_player_weeks(text[]);

create or replace function public.get_player_weeks(espn_ids text[])
returns table (
  espn_id text,
  weeks   jsonb   -- [{week, opponent, is_home, def_allowed, league_allowed, implied}, ...]
)
language sql
stable
as $$
  with
  wanted as (
    select p.gsis_id, p.espn_id, p.team, p.position
    from players p
    where p.espn_id = any(espn_ids) and p.position in ('QB', 'RB', 'WR', 'TE')
  ),
  -- points each defense has allowed to each position, per game
  pos_games as (
    select w.opponent as defense, w.position, w.game_id, sum(w.fantasy_points_ppr) as pts
    from weekly_stats w
    where w.season = 2026 and w.fantasy_points_ppr is not null and w.opponent is not null
    group by w.opponent, w.position, w.game_id
  ),
  def_pos as (
    select pg.defense, pg.position, avg(pg.pts) as allowed
    from pos_games pg
    group by pg.defense, pg.position
  ),
  league as (
    select dp.position, avg(dp.allowed) as allowed
    from def_pos dp
    group by dp.position
  ),
  -- every remaining game through week 17, once per team
  remaining as (
    select s.week, s.home_team as team, s.away_team as opp, true as is_home,
           s.total_line / 2 + s.spread_line / 2 as implied
    from schedule s
    where s.season = 2026 and s.game_type = 'REG' and s.home_score is null and s.week <= 17
    union all
    select s.week, s.away_team, s.home_team, false,
           s.total_line / 2 - s.spread_line / 2
    from schedule s
    where s.season = 2026 and s.game_type = 'REG' and s.away_score is null and s.week <= 17
  )

  select
    w.espn_id,
    jsonb_agg(
      jsonb_build_object(
        'week', r.week,
        'opponent', r.opp,
        'is_home', r.is_home,
        'def_allowed', round(dp.allowed, 1),
        'league_allowed', round(lg.allowed, 1),
        'implied', round(r.implied, 1)
      )
      order by r.week
    )
  from wanted w
  join remaining r on r.team = w.team
  left join def_pos dp on dp.defense = r.opp and dp.position = w.position
  left join league lg on lg.position = w.position
  group by w.espn_id;
$$;

-- Same lockdown as the other functions: only the app's secret keys can call it.
revoke execute on function public.get_player_weeks(text[]) from public, anon, authenticated;
grant execute on function public.get_player_weeks(text[]) to service_role;


-- get_consistency function
-- Floor vs ceiling: how steady each player's weekly scores have been.
--
--   - stdev: how far a typical week lands from his average. 5 = steady,
--     9+ = boom-or-bust.
--   - floor / ceiling: his average minus / plus one stdev. Roughly his bad
--     week and his good week.
--   - bust_pct: % of his games under HALF his average. The weeks that lose
--     you a playoff game.
--   - boom_pct: % of his games 50%+ over his average.

drop function if exists public.get_consistency(text[]);

create or replace function public.get_consistency(espn_ids text[])
returns table (
  espn_id   text,
  games     integer,
  avg_ppr   numeric,
  stdev     numeric,
  floor_ppr numeric,
  ceil_ppr  numeric,
  best_week numeric,
  worst_week numeric,
  bust_pct  integer,
  boom_pct  integer
)
language sql
stable
as $$
  with
  wanted as (
    select p.gsis_id, p.espn_id
    from players p
    where p.espn_id = any(espn_ids)
  ),
  games as (
    -- every full game: games he got hurt in and left early don't count
    -- (23_shortened_games.sql), or one 2-point day would drag his floor down
    select w.gsis_id, ws.fantasy_points_ppr as pts
    from wanted w
    join weekly_stats ws on ws.gsis_id = w.gsis_id and ws.season = 2026
    left join shortened_games sg on sg.gsis_id = ws.gsis_id and sg.game_id = ws.game_id
    where ws.fantasy_points_ppr is not null
      and sg.gsis_id is null
  ),
  stats as (
    select
      g.gsis_id,
      count(*)::integer as n,
      avg(g.pts) as avg_pts,
      stddev_samp(g.pts) as sd,
      max(g.pts) as best,
      min(g.pts) as worst
    from games g
    group by g.gsis_id
  ),
  swings as (
    select
      g.gsis_id,
      count(*) filter (where g.pts < 0.5 * st.avg_pts) as busts,
      count(*) filter (where g.pts > 1.5 * st.avg_pts) as booms
    from games g
    join stats st on st.gsis_id = g.gsis_id
    group by g.gsis_id
  )
  select
    w.espn_id,
    st.n,
    round(st.avg_pts, 1),
    round(st.sd, 1),
    round(greatest(st.avg_pts - st.sd, 0), 1),
    round(st.avg_pts + st.sd, 1),
    round(st.best, 1),
    round(st.worst, 1),
    (100 * sw.busts / st.n)::integer,
    (100 * sw.booms / st.n)::integer
  from wanted w
  join stats st on st.gsis_id = w.gsis_id
  left join swings sw on sw.gsis_id = w.gsis_id
  where st.n >= 4;
$$;

revoke execute on function public.get_consistency(text[]) from public, anon, authenticated;
grant execute on function public.get_consistency(text[]) to service_role;
