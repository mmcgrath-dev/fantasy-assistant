-- get_injury_history function
-- Every injury report entry this season for the players you ask about,
-- newest week first. The page uses it to show his current report and to
-- compare how he played in games while he was on the report vs the rest.
--
-- Where this comes from: the official NFL injury reports teams have to file
-- each week, loaded from nflverse into the injuries table by
-- scripts/load-injuries.js. One row per player per week, with his game status
-- (Out, Doubtful, Questionable) and his last practice of the week.
--
-- Try it after running this file:
--   select * from get_injury_history(
--     (select array_agg(espn_id) from players where full_name ilike '%jeanty%')
--   );

drop function if exists public.get_injury_history(text[]);

create or replace function public.get_injury_history(espn_ids text[])
returns table (
  espn_id          text,
  week             integer,
  game_status      text,   -- Out, Doubtful, Questionable, or blank if expected to play
  injury           text,   -- like Ankle
  injury_secondary text,
  practice_status  text,   -- Full, Limited or DNP (did not participate)
  practice_note    text    -- like 'Not injury related - resting player'
)
language sql
stable
as $$
  select
    p.espn_id,
    i.week,
    i.game_status,
    i.injury,
    i.injury_secondary,
    i.practice_status,
    i.practice_note
  from injuries i
  join players p on p.gsis_id = i.gsis_id
  where i.season = 2026
    and p.espn_id = any (espn_ids)
  order by p.espn_id, i.week desc;
$$;

-- Same lock as the other functions: only the server's secret key can call this.
revoke execute on function public.get_injury_history(text[]) from public, anon, authenticated;
grant execute on function public.get_injury_history(text[]) to service_role;
