-- Server-authoritative beginning of the current Romanian calendar day.
-- Used by appointment lists so an incorrect phone clock cannot reveal old rows.
create or replace function public.get_server_day_start()
returns timestamptz
language sql
stable
security definer
set search_path=''
as $$
  select date_trunc('day',now() at time zone 'Europe/Bucharest') at time zone 'Europe/Bucharest';
$$;

revoke all on function public.get_server_day_start() from public,anon;
grant execute on function public.get_server_day_start() to authenticated;
