-- get_backfield_share function
-- How a running back's job is going compared to the OTHER backs on his team.
-- His own numbers can look fine while a teammate quietly takes over, and a
-- back coming back from injury can come back to a job that's gone.
--
-- For each RB you hand it, using his NFL team's games (not his own):
--
--   1. Backfield share: his carries + targets as a % of everything his team's
--      running backs got. Team's last 3 games vs the games before that.
--      A back who sat out those games gets 0% for them, which is the point:
--      while he was out, someone else had the job.
--
--   2. Games played in his team's last 3 (any offensive snaps), and the last
--      week he played.
--
--   3. The teammate with the biggest share lately, and how that teammate's
--      share moved. That's the "Rico Dowdle is eating into Warren" and
--      "Swift took over while Monangai was out" signal.
--
-- Try it after running this file:
--   select * from get_backfield_share(
--     (select array_agg(espn_id) from players where full_name in ('Jaylen Warren', 'Kyle Monangai'))
--   );

drop function if exists public.get_backfield_share(text[]);

create or replace function public.get_backfield_share(espn_ids text[])
returns table (
  espn_id           text,
  team              text,
  played_last3      integer,   -- of his team's last 3 games, how many he played in
  last_week_played  integer,
  share_last3       numeric,   -- % of his team's RB touches, last 3 team games. 62 means 62%
  share_prior       numeric,   -- same, the team's games before that
  mate_name         text,      -- the teammate with the biggest share lately
  mate_share_last3  numeric,
  mate_share_prior  numeric
)
language sql
stable
as $$
  with
  wanted as (
    select p.gsis_id, p.espn_id, p.team
    from players p
    where p.espn_id = any(espn_ids) and p.position = 'RB'
  ),
  -- every finished game, once per team, newest = 1
  team_games as (
    select s.game_id, s.week, s.home_team as team
    from schedule s
    where s.season = 2026 and s.game_type = 'REG' and s.home_score is not null
    union all
    select s.game_id, s.week, s.away_team
    from schedule s
    where s.season = 2026 and s.game_type = 'REG' and s.away_score is not null
  ),
  numbered as (
    select tg.*, row_number() over (partition by tg.team order by tg.week desc) as game_num
    from team_games tg
    where tg.team in (select w.team from wanted w)
  ),
  -- carries + targets for every RB on those teams, per game
  touches as (
    select x.game_id, x.team, x.gsis_id, count(*) as n
    from (
      select r.game_id, r.team, r.rusher_id as gsis_id
      from rushes r
      where r.season = 2026 and coalesce(r.qb_scramble, false) = false
      union all
      select t.game_id, t.team, t.receiver_id
      from targets t
      where t.season = 2026
    ) x
    join players pl on pl.gsis_id = x.gsis_id and pl.position = 'RB'
    where x.team in (select w.team from wanted w)
    group by x.game_id, x.team, x.gsis_id
  ),
  -- each RB's share of his team's RB touches, last 3 vs before
  shares as (
    select
      t.team,
      t.gsis_id,
      sum(t.n) filter (where n2.game_num <= 3) as mine_last3,
      sum(t.n) filter (where n2.game_num > 3)  as mine_prior
    from touches t
    join numbered n2 on n2.game_id = t.game_id and n2.team = t.team
    group by t.team, t.gsis_id
  ),
  team_totals as (
    select
      n2.team,
      sum(t.n) filter (where n2.game_num <= 3) as team_last3,
      sum(t.n) filter (where n2.game_num > 3)  as team_prior
    from touches t
    join numbered n2 on n2.game_id = t.game_id and n2.team = t.team
    group by n2.team
  ),
  pct as (
    select
      sh.team,
      sh.gsis_id,
      round(100.0 * coalesce(sh.mine_last3, 0) / nullif(tt.team_last3, 0)) as share_last3,
      round(100.0 * coalesce(sh.mine_prior, 0) / nullif(tt.team_prior, 0)) as share_prior
    from shares sh
    join team_totals tt on tt.team = sh.team
  ),
  -- did he play (any offensive snaps) in each of his team's last 3 games
  played as (
    select w.gsis_id, count(*)::integer as games
    from wanted w
    join numbered n2 on n2.team = w.team and n2.game_num <= 3
    join snap_counts sc on sc.gsis_id = w.gsis_id and sc.game_id = n2.game_id and coalesce(sc.offense_snaps, 0) > 0
    group by w.gsis_id
  ),
  last_played as (
    select w.gsis_id, max(sc.week)::integer as week
    from wanted w
    join snap_counts sc on sc.gsis_id = w.gsis_id and sc.season = 2026 and coalesce(sc.offense_snaps, 0) > 0
    group by w.gsis_id
  ),
  -- the teammate with the biggest share lately
  top_mate as (
    select distinct on (w.gsis_id) w.gsis_id, pl.full_name, pc.share_last3, pc.share_prior
    from wanted w
    join pct pc on pc.team = w.team and pc.gsis_id <> w.gsis_id
    join players pl on pl.gsis_id = pc.gsis_id
    order by w.gsis_id, pc.share_last3 desc nulls last
  )

  select
    w.espn_id,
    w.team,
    coalesce(pl.games, 0),
    lp.week,
    coalesce(me.share_last3, 0),
    me.share_prior,
    tm.full_name,
    tm.share_last3,
    tm.share_prior
  from wanted w
  left join pct me on me.gsis_id = w.gsis_id and me.team = w.team
  left join played pl on pl.gsis_id = w.gsis_id
  left join last_played lp on lp.gsis_id = w.gsis_id
  left join top_mate tm on tm.gsis_id = w.gsis_id;
$$;

-- Same lockdown as the other functions: only the app's secret keys can call it.
revoke execute on function public.get_backfield_share(text[]) from public, anon, authenticated;
grant execute on function public.get_backfield_share(text[]) to service_role;
