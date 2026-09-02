-- The business owner can remove an invitee's application persona completely.
-- The Auth identity stays intact so the same Google account can start again as
-- a client, invitee or business. A reset event forces active app sessions out.

begin;

do $logger_type$
begin
  if to_regtype('public.logger_action_type') is not null then
    alter type public.logger_action_type add value if not exists 'BV_DELETE_INVITEE_ACCOUNT';
  end if;
end
$logger_type$;

create table if not exists public.account_reset_events (
  user_id uuid primary key,
  reset_at timestamptz not null default now(),
  reset_by uuid not null,
  reason text not null check(reason in ('invitee_deleted'))
);

alter table public.account_reset_events replica identity full;
alter table public.account_reset_events enable row level security;
revoke all on public.account_reset_events from public,anon,authenticated;
grant select on public.account_reset_events to authenticated;

drop policy if exists account_reset_events_self_read on public.account_reset_events;
create policy account_reset_events_self_read
  on public.account_reset_events for select to authenticated
  using(user_id=auth.uid());

do $realtime$
begin
  if exists(select 1 from pg_publication where pubname='supabase_realtime')
    and not exists(
      select 1 from pg_publication_tables
      where pubname='supabase_realtime'
        and schemaname='public'
        and tablename='account_reset_events'
    ) then
    alter publication supabase_realtime add table public.account_reset_events;
  end if;
end
$realtime$;

create or replace function public.delete_invitee_account(
  p_business_id uuid,
  p_user_id uuid
) returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_owner uuid;
  v_role public.member_role;
  v_email text;
begin
  if auth.uid() is null then raise exception 'Autentificare necesară'; end if;

  select owner_id into v_owner
  from public.businesses
  where id=p_business_id
  for update;

  if v_owner is null or v_owner<>auth.uid() then
    raise exception 'Doar proprietarul afacerii poate șterge un invitat';
  end if;
  if p_user_id=auth.uid() then raise exception 'Proprietarul nu poate fi șters'; end if;

  select role into v_role
  from public.business_members
  where business_id=p_business_id and user_id=p_user_id
  for update;

  if v_role is null or v_role='owner' then raise exception 'Invitat indisponibil'; end if;
  if exists(select 1 from public.businesses where owner_id=p_user_id)
    or exists(select 1 from public.business_members where user_id=p_user_id and business_id<>p_business_id) then
    raise exception 'Contul nu poate fi resetat deoarece este asociat altei afaceri';
  end if;

  select lower(btrim(email)) into v_email from auth.users where id=p_user_id;

  delete from private.enrollment_links
  where request_id in(select id from private.enrollment_requests where owner_id=p_user_id);
  delete from private.enrollment_requests where owner_id=p_user_id;
  delete from private.request_limits where user_id=p_user_id;
  delete from private.calendar_invitations
  where business_id=p_business_id
    and (accepted_by=p_user_id or lower(btrim(invited_email))=v_email);

  delete from public.device_tokens where user_id=p_user_id;
  delete from public.notification_jobs where user_id=p_user_id;
  delete from public.notification_log where user_id=p_user_id;
  delete from public.client_notification_preferences where user_id=p_user_id;
  if to_regclass('public.logger_engine') is not null then
    execute 'delete from public.logger_engine where user_id=$1' using p_user_id;
  end if;
  delete from public.business_members where business_id=p_business_id and user_id=p_user_id;

  update public.profiles
  set display_name='',first_name=null,last_name=null,
    customer_profile_completed_at=null,updated_at=now()
  where id=p_user_id;

  insert into public.account_reset_events(user_id,reset_at,reset_by,reason)
  values(p_user_id,clock_timestamp(),auth.uid(),'invitee_deleted')
  on conflict(user_id) do update set
    reset_at=excluded.reset_at,
    reset_by=excluded.reset_by,
    reason=excluded.reason;

  return jsonb_build_object('ok',true);
end;
$$;

revoke all on function public.delete_invitee_account(uuid,uuid) from public,anon;
grant execute on function public.delete_invitee_account(uuid,uuid) to authenticated;

commit;
