-- Durable, non-blocking UI database action logging with database-configured
-- retention. Apply after 023.

begin;

create type public.logger_status as enum ('ok','error');

create type public.logger_action_type as enum (
  'BV_SIGN_IN',
  'CV_SIGN_IN',
  'BV_CHECK_ACCESS',
  'BV_ACTIVATE_LICENSE',
  'BV_VIEW_MY_BUSINESSES',
  'BV_VIEW_CALENDARS',
  'BV_CREATE_CALENDAR',
  'BV_DELETE_CALENDAR',
  'BV_VIEW_TEAM',
  'BV_INVITE_TEAM_MEMBER',
  'BV_ACCEPT_TEAM_INVITATION',
  'BV_CANCEL_TEAM_INVITATION',
  'BV_UPDATE_TEAM_MEMBER_ACCESS',
  'BV_REMOVE_TEAM_MEMBER',
  'BV_DELETE_INVITEE_ACCOUNT',
  'CV_SEARCH_BUSINESS',
  'CV_VIEW_BUSINESS_DETAILS',
  'BV_COMPLETE_INITIAL_SETUP',
  'BV_VIEW_CALENDAR_APPOINTMENTS',
  'BV_VIEW_PENDING_APPOINTMENTS',
  'BV_VIEW_CALENDAR_SERVICES',
  'BV_CREATE_SERVICE',
  'BV_VIEW_SERVICE_SETTINGS',
  'BV_UPDATE_SERVICE_SCHEDULE',
  'BV_VIEW_CALENDAR_REMINDER',
  'BV_UPDATE_CALENDAR_REMINDER',
  'BV_VIEW_REPORTS',
  'CV_VIEW_REMINDER',
  'CV_UPDATE_REMINDER',
  'CV_VIEW_AVAILABLE_APPOINTMENT_TIMES',
  'CV_MAKE_APPOINTMENT',
  'CV_VIEW_MY_APPOINTMENTS',
  'CV_VIEW_PROFILE',
  'CV_COMPLETE_PROFILE',
  'CV_VIEW_APPOINTMENT_QR',
  'BV_SCAN_APPOINTMENT_QR',
  'BV_APPROVE_APPOINTMENT',
  'BV_REJECT_APPOINTMENT',
  'BV_VIEW_ENROLLMENT_STATUS',
  'BV_CHECK_ADMIN_ACCESS',
  'BV_VIEW_ENROLLMENT_REQUEST',
  'BV_SUBMIT_BUSINESS_ENROLLMENT',
  'BV_RESEND_ENROLLMENT_EMAIL',
  'BV_SEND_PHONE_VERIFICATION_CODE',
  'BV_CONFIRM_PHONE_VERIFICATION_CODE',
  'BV_CONFIRM_ENROLLMENT_EMAIL',
  'BV_APPROVE_BUSINESS_ENROLLMENT',
  'BV_REJECT_BUSINESS_ENROLLMENT',
  'BV_ENABLE_PUSH_NOTIFICATIONS',
  'CV_ENABLE_PUSH_NOTIFICATIONS',
  'BV_DISABLE_PUSH_NOTIFICATIONS',
  'CV_DISABLE_PUSH_NOTIFICATIONS',
  'BV_REFRESH_SUBSCRIPTION'
);

create table public.logger_engine (
  id uuid primary key default gen_random_uuid(),
  logged_at timestamptz not null default now(),
  message jsonb not null default '{}'::jsonb,
  user_id uuid not null,
  status public.logger_status not null,
  action_type public.logger_action_type not null,
  check(jsonb_typeof(message)='object'),
  check(octet_length(message::text)<=12000)
);

create index logger_engine_logged_at_idx on public.logger_engine(logged_at);
create index logger_engine_user_logged_at_idx on public.logger_engine(user_id,logged_at desc);
create index logger_engine_action_status_logged_at_idx on public.logger_engine(action_type,status,logged_at desc);

alter table public.logger_engine enable row level security;
revoke all on public.logger_engine from public,anon,authenticated;

create table public.config_purge (
  target_table text primary key check(target_table='logger_engine'),
  retention_days smallint not null check(retention_days between 1 and 3650),
  updated_at timestamptz not null default now()
);

insert into public.config_purge(target_table,retention_days)
values('logger_engine',4)
on conflict(target_table) do nothing;

alter table public.config_purge enable row level security;
revoke all on public.config_purge from public,anon,authenticated;

create or replace function public.write_logger_event(
  p_action_type public.logger_action_type,
  p_status public.logger_status,
  p_message jsonb default '{}'::jsonb
) returns boolean language plpgsql security definer set search_path='' as $$
begin
  if auth.uid() is null then return false; end if;
  if jsonb_typeof(coalesce(p_message,'{}'::jsonb))<>'object' then return false; end if;
  if octet_length(coalesce(p_message,'{}'::jsonb)::text)>12000 then return false; end if;
  insert into public.logger_engine(message,user_id,status,action_type)
    values(coalesce(p_message,'{}'::jsonb),auth.uid(),p_status,p_action_type);
  return true;
exception when others then
  -- Logging must never become a failure path for the application action.
  return false;
end;
$$;
revoke all on function public.write_logger_event(public.logger_action_type,public.logger_status,jsonb)
  from public,anon;
grant execute on function public.write_logger_event(public.logger_action_type,public.logger_status,jsonb)
  to authenticated;

create or replace function private.purge_expired_logger_engine_rows()
returns bigint language plpgsql security definer set search_path='' as $$
declare v_days integer; v_deleted bigint:=0;
begin
  select retention_days into v_days from public.config_purge where target_table='logger_engine';
  if v_days is null then return 0; end if;
  delete from public.logger_engine
    where logged_at < now()-make_interval(days=>v_days);
  get diagnostics v_deleted=row_count;
  return v_deleted;
end;
$$;
revoke all on function private.purge_expired_logger_engine_rows()
  from public,anon,authenticated;

do $scheduler$
begin
  if not exists(select 1 from cron.job where jobname='rezerva-logger-engine-purge') then
    perform cron.schedule(
      'rezerva-logger-engine-purge',
      '17 2 * * *',
      $job$select private.purge_expired_logger_engine_rows();$job$
    );
  end if;
end
$scheduler$;

commit;
