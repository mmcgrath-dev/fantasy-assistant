-- get_game_logs function
-- The data behind the player panel on My Team. You hand it a list of ESPN
-- player IDs (your roster) and it hands back every game each player has played this season, newest first, with:
--   - snaps, PPR points, and the box score: passing, rushing and receiving
--     (the page picks which of those to show based on his position)
--   - where he ranked at his position that week for snaps, touches and points
--     (1 = best at his position that week)
--   - how soft that week's defense is against his position (1 = gives up the most)
--   - vs_def: his points minus what that defense allowed to every OTHER player
--     at his position with a real role (25%+ snaps). +9.8 means he beat what
--     that defense usually gives up by almost 10 points.
--
-- The page turns the ranks into colors: top 10 green, 31+ red, in between shaded.
--
-- Try it after running this file:
--   select * from get_game_logs(
--     (select array_agg(espn_id) from players where full_name ilike '%jeanty%')
--   );

-- Remove the old version first. "create or replace" can't change which columns
-- a function returns, and this version returns more than the first one did.
drop function if exists public.get_game_logs(text[]);

create or replace function public.get_game_logs(espn_ids text[])
returns table (
  espn_id       text,
  week          integer,
  opponent      text,
  pos           text,          -- QB, RB, WR or TE ("position" is a reserved word here)
  softness_rank bigint,
  snap_pct      numeric,
  snap_rank     bigint,
  completions   integer,
  attempts      integer,
  pass_yards    integer,
  pass_tds      integer,
  interceptions integer,
  carries       integer,
  rush_yards    integer,
  rush_tds      integer,
  targets       integer,
  receptions    integer,
  rec_yards     integer,
  rec_tds       integer,
  target_share  numeric,       -- 25 means 25% of his team's targets
  touches       integer,
  touch_rank    bigint,
  ppr_points    numeric,
  points_rank   bigint,
  vs_def        numeric
)
language sql
stable
as $$
  with games as (
    -- every player's game this season: snaps and box score side by side
    select
      w.gsis_id,
      w.game_id,
      w.week,
      w.position,
      s.opponent as defense,
      s.offense_pct,
      w.completions,
      w.attempts,
      w.passing_yards,
      w.passing_tds,
      w.interceptions,
      w.carries,
      w.rushing_yards,
      w.rushing_tds,
      w.targets,
      w.receptions,
      w.receiving_yards,
      w.receiving_tds,
      w.target_share,
      coalesce(w.targets, 0) + coalesce(w.carries, 0) as touches,
      w.fantasy_points_ppr as ppr_points
    from weekly_stats w
    join snap_counts s
      on s.gsis_id = w.gsis_id
     and s.game_id = w.game_id
    where w.season = 2026
      and w.position in ('QB', 'RB', 'WR', 'TE')
  ),
  ranked as (
    -- each game ranked against everyone at his position that week
    select
      g.*,
      rank() over (partition by g.week, g.position order by g.offense_pct desc nulls last) as snap_rank,
      rank() over (partition by g.week, g.position order by g.touches desc) as touch_rank,
      rank() over (partition by g.week, g.position order by g.ppr_points desc nulls last) as points_rank,
      (g.offense_pct >= 0.25 and g.ppr_points is not null) as counted
    from games g
  ),
  defenses as (
    -- what each defense gives up to players with a real role (25%+ snaps)
    select
      g.defense,
      g.position,
      sum(g.ppr_points) as total_allowed,
      count(*) as role_games,
      rank() over (partition by g.position order by avg(g.ppr_points) desc) as softness_rank
    from games g
    where g.offense_pct >= 0.25
      and g.ppr_points is not null
    group by g.defense, g.position
  )
  select
    p.espn_id,
    r.week,
    r.defense,
    r.position,
    d.softness_rank,
    round(r.offense_pct * 100),
    r.snap_rank,
    r.completions,
    r.attempts,
    r.passing_yards,
    r.passing_tds,
    r.interceptions,
    r.carries,
    r.rushing_yards,
    r.rushing_tds,
    r.targets,
    r.receptions,
    r.receiving_yards,
    r.receiving_tds,
    round(r.target_share * 100),
    r.touches,
    r.touch_rank,
    r.ppr_points,
    r.points_rank,
    -- his points minus what that defense allowed to everyone ELSE it faced
    round(
      r.ppr_points
      - (d.total_allowed - case when r.counted then r.ppr_points else 0 end)
        / nullif(d.role_games - case when r.counted then 1 else 0 end, 0)
    , 1)
  from ranked r
  join players p on p.gsis_id = r.gsis_id
  left join defenses d
    on d.defense = r.defense
   and d.position = r.position
  where p.espn_id = any (espn_ids)
  order by p.espn_id, r.week desc;
$$;

-- Same lock as get_snap_trends: only the server's secret key can call this.
revoke execute on function public.get_game_logs(text[]) from public, anon, authenticated;
grant execute on function public.get_game_logs(text[]) to service_role;
