-- get_role_context function
-- The numbers behind the "why" lines in the player panel. You hand it a list of
-- ESPN player IDs (your roster) and for each player it compares his team's last
-- 2 games ("last") to the 2 games before that ("prior"):
--
--   Team volume:  plays per game and run % (designed runs vs passes thrown at someone)
--   His usage:    snap %, carries and targets per game
--   His share:    % of his position group's carries, and % of his team's targets
--   Teammate:     the teammate at his position whose snap % went up the most, if any
--   Injury:       his most recent injury report entry from the last 3 weeks, if any
--
-- "Last 2 games" means his TEAM's last 2 games, so if he sat one out, that game
-- counts as 0 for him. That's on purpose: it shows the real drop, and the injury
-- line explains it.
--
-- Try it after running this file:
--   select * from get_role_context(
--     (select array_agg(espn_id) from players where full_name ilike '%jeanty%')
--   );

drop function if exists public.get_role_context(text[]);

create or replace function public.get_role_context(espn_ids text[])
returns table (
  espn_id              text,
  team                 text,
  pos                  text,
  plays_last           numeric,   -- team offensive plays per game
  plays_prior          numeric,
  run_pct_last         numeric,   -- 35 means 35% of plays were designed runs
  run_pct_prior        numeric,
  snaps_last           numeric,   -- his snap %
  snaps_prior          numeric,
  carries_last         numeric,   -- per game
  carries_prior        numeric,
  targets_last         numeric,   -- per game
  targets_prior        numeric,
  carry_share_last     numeric,   -- his % of carries by players at his position on his team
  carry_share_prior    numeric,
  target_share_last    numeric,   -- his % of all passes his team threw at someone
  target_share_prior   numeric,
  mate_name            text,      -- teammate at his position who gained the most snap %
  mate_snaps_change    numeric,
  mate_carries_change  numeric,
  mate_targets_change  numeric,
  injury_week          integer,
  injury_status        text,      -- Out, Doubtful, Questionable, or blank
  injury_type          text,      -- like Ankle
  practice_status      text       -- Full, Limited or DNP
)
language sql
stable
as $$
  with roster as (
    -- the players we were asked about
    select p.gsis_id, p.espn_id, p.team, p.position
    from players p
    where p.espn_id = any (espn_ids)
      and p.position in ('QB', 'RB', 'WR', 'TE')
  ),
  team_games as (
    -- number each team's games newest first (1 = most recent). Byes don't count.
    select
      t.team,
      t.game_id,
      dense_rank() over (partition by t.team order by t.week desc) as team_game
    from (select distinct s.team, s.game_id, s.week from snap_counts s where s.season = 2026) t
  ),
  windows as (
    -- tag each team's 4 most recent games: 'last' = games 1-2, 'prior' = games 3-4
    select
      tg.team,
      tg.game_id,
      case when tg.team_game <= 2 then 'last' else 'prior' end as win
    from team_games tg
    where tg.team_game <= 4
  ),
  team_volume as (
    -- team totals in each window: games, plays, designed runs, passes thrown at someone
    select
      w.team,
      w.win,
      count(*) as games,
      sum(pl.plays) as plays,
      sum(ru.runs) as runs,
      sum(pa.passes) as passes
    from windows w
    left join (
      -- QBs and linemen play basically every snap, so the most snaps on the team = total plays
      select s.team, s.game_id, max(s.offense_snaps) as plays
      from snap_counts s
      where s.season = 2026
      group by s.team, s.game_id
    ) pl on pl.team = w.team and pl.game_id = w.game_id
    left join (
      -- scrambles are broken pass plays, not runs the coach called
      select r.team, r.game_id, count(*) filter (where not coalesce(r.qb_scramble, false)) as runs
      from rushes r
      where r.season = 2026
      group by r.team, r.game_id
    ) ru on ru.team = w.team and ru.game_id = w.game_id
    left join (
      select t.team, t.game_id, count(*) as passes
      from targets t
      where t.season = 2026
      group by t.team, t.game_id
    ) pa on pa.team = w.team and pa.game_id = w.game_id
    group by w.team, w.win
  ),
  player_windows as (
    -- every player's totals in each window (snap % adds up, divided by games later)
    select
      s.gsis_id,
      s.team,
      p.position,
      w.win,
      sum(coalesce(s.offense_pct, 0)) as snaps,
      sum(coalesce(ws.carries, 0)) as carries,
      sum(coalesce(ws.targets, 0)) as targets
    from snap_counts s
    join windows w on w.team = s.team and w.game_id = s.game_id
    join players p on p.gsis_id = s.gsis_id
    left join weekly_stats ws on ws.gsis_id = s.gsis_id and ws.game_id = s.game_id
    where p.position in ('QB', 'RB', 'WR', 'TE')
    group by s.gsis_id, s.team, p.position, w.win
  ),
  group_windows as (
    -- carries by everyone at a position on a team, per window (for his share)
    select pw.team, pw.position, pw.win, sum(pw.carries) as carries
    from player_windows pw
    group by pw.team, pw.position, pw.win
  ),
  changes as (
    -- each player's per-game change from prior to last. A missing window counts as 0.
    select
      pw.gsis_id,
      pw.team,
      pw.position,
      coalesce(sum(pw.snaps / tv.games) filter (where pw.win = 'last'), 0)
        - coalesce(sum(pw.snaps / tv.games) filter (where pw.win = 'prior'), 0) as snap_change,
      coalesce(sum(pw.carries::numeric / tv.games) filter (where pw.win = 'last'), 0)
        - coalesce(sum(pw.carries::numeric / tv.games) filter (where pw.win = 'prior'), 0) as carries_change,
      coalesce(sum(pw.targets::numeric / tv.games) filter (where pw.win = 'last'), 0)
        - coalesce(sum(pw.targets::numeric / tv.games) filter (where pw.win = 'prior'), 0) as targets_change
    from player_windows pw
    join team_volume tv on tv.team = pw.team and tv.win = pw.win
    group by pw.gsis_id, pw.team, pw.position
  ),
  top_mate as (
    -- for each roster player, the teammate at his position with the biggest snap gain.
    -- "distinct on" keeps just the first row per roster player, and the order by
    -- puts the biggest gain first.
    select distinct on (r.gsis_id)
      r.gsis_id as roster_id,
      p.full_name,
      c.snap_change,
      c.carries_change,
      c.targets_change
    from roster r
    join changes c
      on c.team = r.team
     and c.position = r.position
     and c.gsis_id <> r.gsis_id
    join players p on p.gsis_id = c.gsis_id
    where c.snap_change > 0
    order by r.gsis_id, c.snap_change desc
  ),
  latest_injury as (
    -- his most recent injury report entry from the last 3 weeks of reports
    select distinct on (i.gsis_id)
      i.gsis_id,
      i.week,
      i.game_status,
      i.injury,
      i.practice_status
    from injuries i
    join roster r on r.gsis_id = i.gsis_id
    where i.season = 2026
      and i.week >= (select max(week) from injuries where season = 2026) - 2
    order by i.gsis_id, i.week desc
  )
  select
    r.espn_id,
    r.team,
    r.position,
    round(tl.plays::numeric / tl.games, 1),
    round(tp.plays::numeric / tp.games, 1),
    round(100.0 * tl.runs / nullif(tl.runs + tl.passes, 0)),
    round(100.0 * tp.runs / nullif(tp.runs + tp.passes, 0)),
    round(100 * coalesce(pl.snaps, 0) / tl.games),
    round(100 * coalesce(pp.snaps, 0) / tp.games),
    round(coalesce(pl.carries, 0)::numeric / tl.games, 1),
    round(coalesce(pp.carries, 0)::numeric / tp.games, 1),
    round(coalesce(pl.targets, 0)::numeric / tl.games, 1),
    round(coalesce(pp.targets, 0)::numeric / tp.games, 1),
    round(100.0 * coalesce(pl.carries, 0) / nullif(gl.carries, 0)),
    round(100.0 * coalesce(pp.carries, 0) / nullif(gp.carries, 0)),
    round(100.0 * coalesce(pl.targets, 0) / nullif(tl.passes, 0)),
    round(100.0 * coalesce(pp.targets, 0) / nullif(tp.passes, 0)),
    m.full_name,
    round(m.snap_change * 100),
    round(m.carries_change, 1),
    round(m.targets_change, 1),
    li.week,
    li.game_status,
    li.injury,
    li.practice_status
  from roster r
  -- inner joins: a team needs both windows (4+ games) to compare at all
  join team_volume tl on tl.team = r.team and tl.win = 'last'
  join team_volume tp on tp.team = r.team and tp.win = 'prior'
  left join player_windows pl on pl.gsis_id = r.gsis_id and pl.team = r.team and pl.win = 'last'
  left join player_windows pp on pp.gsis_id = r.gsis_id and pp.team = r.team and pp.win = 'prior'
  left join group_windows gl on gl.team = r.team and gl.position = r.position and gl.win = 'last'
  left join group_windows gp on gp.team = r.team and gp.position = r.position and gp.win = 'prior'
  left join top_mate m on m.roster_id = r.gsis_id
  left join latest_injury li on li.gsis_id = r.gsis_id;
$$;

-- Same lock as the other functions: only the server's secret key can call this.
revoke execute on function public.get_role_context(text[]) from public, anon, authenticated;
grant execute on function public.get_role_context(text[]) to service_role;
