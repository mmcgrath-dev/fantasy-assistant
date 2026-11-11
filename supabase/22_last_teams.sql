-- get_last_teams function
-- The NFL team each player played for in his most recent game this season.
--
-- The app compares this to the team ESPN lists him on right now. If they're
-- different, he just changed teams (traded or signed) and hasn't played for
-- his new team yet. That's how the app spots deadline deals like Keenan Allen
-- going to the 49ers the day they happen, and warns his new teammates' pages
-- that their numbers came before he got there.
--
-- Once he plays a game for his new team, this answer updates on the next data
-- load and the warning goes away on its own.
--
-- Try it after running this file:
--   select * from get_last_teams(
--     (select array_agg(espn_id) from players where full_name in ('Keenan Allen', 'Mike Evans'))
--   );

drop function if exists public.get_last_teams(text[]);

create or replace function public.get_last_teams(espn_ids text[])
returns table (
  espn_id   text,
  last_team text,      -- nflverse team code, like SF or WAS
  last_week integer
)
language sql
stable
as $$
  -- distinct on keeps one row per player: the first one in the order below,
  -- which is his latest week.
  select distinct on (p.espn_id) p.espn_id, ws.team, ws.week
  from players p
  join weekly_stats ws on ws.gsis_id = p.gsis_id and ws.season = 2026
  where p.espn_id = any(espn_ids) and ws.team is not null
  order by p.espn_id, ws.week desc;
$$;

-- Same lockdown as the other functions: only the app's secret keys can call it.
revoke execute on function public.get_last_teams(text[]) from public, anon, authenticated;
grant execute on function public.get_last_teams(text[]) to service_role;
