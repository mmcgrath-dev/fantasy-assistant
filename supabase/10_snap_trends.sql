-- get_snap_trends function
-- Saves the snap trend query inside the database so the app can call it by name.
-- You hand it a list of ESPN player IDs (your roster) and it hands back,
-- for each of those players: snap % in his last 2 games, snap % in the 2 games
-- before that, the change between them, and a simple up / down / steady label.
--
-- Only QBs, RBs, WRs and TEs get a trend. Kickers show up in the snap counts
-- file with 0 offensive snaps (they only play special teams), which would
-- always read 0 / 0 / steady, so they're left out along with defenses.
--
-- Players with fewer than 4 games this season are left out, since there
-- isn't enough to compare yet. The app shows a dash for them.
--
-- Try it after running this file:
--   select * from get_snap_trends(
--     (select array_agg(espn_id) from players where full_name ilike '%jeanty%')
--   );

create or replace function public.get_snap_trends(espn_ids text[])
returns table (
  espn_id   text,
  full_name text,
  last_2    numeric,
  prior_2   numeric,
  change    numeric,
  trend     text
)
language sql
stable
as $$
  with recent as (
    -- number each player's games newest first: 1 = most recent game
    select
      s.gsis_id,
      s.offense_pct,
      row_number() over (partition by s.gsis_id order by s.week desc) as game_num
    from snap_counts s
    join players p on p.gsis_id = s.gsis_id
    where s.season = 2026
      and p.espn_id = any (espn_ids)
      and p.position in ('QB', 'RB', 'WR', 'TE')
  ),
  averages as (
    -- squish each player's last 4 games into one row
    select
      r.gsis_id,
      avg(r.offense_pct) filter (where r.game_num <= 2)      as last_2,
      avg(r.offense_pct) filter (where r.game_num in (3, 4)) as prior_2
    from recent r
    where r.game_num <= 4
    group by r.gsis_id
    having count(*) = 4
  )
  select
    p.espn_id,
    p.full_name,
    round(a.last_2 * 100)                 as last_2,
    round(a.prior_2 * 100)                as prior_2,
    round((a.last_2 - a.prior_2) * 100)   as change,
    -- 10 points either way counts as a real move; anything smaller is normal week-to-week noise
    case
      when (a.last_2 - a.prior_2) * 100 >= 10  then 'up'
      when (a.last_2 - a.prior_2) * 100 <= -10 then 'down'
      else 'steady'
    end                                   as trend
  from averages a
  join players p on p.gsis_id = a.gsis_id;
$$;

-- Only the server (your Netlify functions, using the secret key) can call this.
-- Supabase lets anyone with the public key call new functions by default,
-- so we turn that off and allow just the secret key's role.
revoke execute on function public.get_snap_trends(text[]) from public, anon, authenticated;
grant execute on function public.get_snap_trends(text[]) to service_role;
