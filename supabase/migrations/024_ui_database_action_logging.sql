-- Durable, non-blocking UI database action logging with database-configured
-- retention. Apply after 023.

begin;

create type public.logger_status as enum ('ok','error');

create type public.logger_action_type as enum (
  'BV_RESOLVE_CURRENT_ACCOUNT_TYPE_AFTER_GOOGLE_AUTHENTICATION',
  'CV_RESOLVE_CURRENT_ACCOUNT_TYPE_AFTER_GOOGLE_AUTHENTICATION',
  'BV_READ_CURRENT_BUSINESS_ACCESS_ENTITLEMENT',
  'BV_REDEEM_COMPLETE_BUSINESS_LICENSE_KEY',
  'BV_LIST_ACCESSIBLE_BUSINESS_WORKSPACES',
  'BV_LIST_BUSINESS_CALENDARS',
  'BV_CREATE_NEW_BUSINESS_CALENDAR',
  'BV_DELETE_EMPTY_BUSINESS_CALENDAR',
  'BV_READ_BUSINESS_TEAM_MEMBERS_AND_PENDING_INVITATIONS',
  'BV_SEND_NEW_BUSINESS_TEAM_MEMBER_EMAIL_INVITATION',
  'BV_ACCEPT_BUSINESS_TEAM_MEMBER_EMAIL_INVITATION',
  'BV_REVOKE_PENDING_BUSINESS_TEAM_MEMBER_INVITATION',
  'BV_UPDATE_BUSINESS_TEAM_MEMBER_OPERATIONAL_ACCESS',
  'BV_REMOVE_BUSINESS_TEAM_MEMBER_FROM_TEAM',
  'CV_SEARCH_ACTIVE_BUSINESSES_BY_NAME',
  'CV_READ_SELECTED_BUSINESS_DETAILS_SERVICES_AND_CALENDARS',
  'BV_INITIALIZE_BUSINESS_PRIMARY_CALENDAR_AND_SERVICE',
  'BV_READ_APPROVED_BUSINESS_BOOKINGS_FOR_CALENDAR_VIEW',
  'BV_READ_PENDING_BUSINESS_BOOKING_REQUESTS',
  'BV_READ_ACTIVE_BUSINESS_SERVICES_FOR_CALENDAR',
  'BV_CREATE_NEW_BUSINESS_SERVICE_AND_AVAILABILITY',
  'BV_READ_BUSINESS_CALENDAR_SERVICE_SETTINGS',
  'BV_UPDATE_BUSINESS_CALENDAR_SERVICE_SETTINGS',
  'BV_READ_BUSINESS_CALENDAR_NOTIFICATION_PREFERENCES',
  'BV_UPDATE_BUSINESS_CALENDAR_NOTIFICATION_PREFERENCES',
  'BV_READ_APPROVED_BUSINESS_BOOKING_REPORT',
  'CV_READ_CLIENT_NOTIFICATION_PREFERENCES',
  'CV_UPDATE_CLIENT_NOTIFICATION_PREFERENCES',
  'CV_READ_AVAILABLE_BOOKING_SLOTS_FOR_SELECTED_SERVICE',
  'CV_CREATE_NEW_BOOKING_REQUEST',
  'CV_READ_CURRENT_CLIENT_BOOKINGS',
  'CV_READ_CURRENT_CLIENT_PROFILE',
  'CV_COMPLETE_CURRENT_CLIENT_PROFILE',
  'CV_GENERATE_QR_FOR_CURRENT_CLIENT_RESERVATION',
  'BV_RESOLVE_SCANNED_CLIENT_RESERVATION_QR',
  'BV_APPROVE_PENDING_CLIENT_BOOKING_REQUEST',
  'BV_REJECT_PENDING_CLIENT_BOOKING_REQUEST',
  'BV_READ_BUSINESS_ENROLLMENT_STATUS',
  'BV_CHECK_CURRENT_ACCOUNT_PLATFORM_OWNER_PERMISSION',
  'BV_READ_BUSINESS_ENROLLMENT_LINK_DETAILS',
  'BV_START_NEW_BUSINESS_ENROLLMENT_REQUEST',
  'BV_RESEND_BUSINESS_ENROLLMENT_EMAIL_VERIFICATION_CODE',
  'BV_SEND_BUSINESS_ENROLLMENT_PHONE_VERIFICATION_SMS',
  'BV_VERIFY_BUSINESS_ENROLLMENT_PHONE_SMS_CODE',
  'BV_CONFIRM_BUSINESS_ENROLLMENT_EMAIL_VERIFICATION_LINK',
  'BV_APPROVE_BUSINESS_ENROLLMENT_REQUEST_BY_PLATFORM_OWNER',
  'BV_REJECT_BUSINESS_ENROLLMENT_REQUEST_BY_PLATFORM_OWNER',
  'BV_REGISTER_BUSINESS_ANDROID_PUSH_DEVICE_TOKEN',
  'CV_REGISTER_CLIENT_ANDROID_PUSH_DEVICE_TOKEN',
  'BV_REMOVE_BUSINESS_ANDROID_PUSH_DEVICE_TOKEN_ON_SIGN_OUT',
  'CV_REMOVE_CLIENT_ANDROID_PUSH_DEVICE_TOKEN_ON_SIGN_OUT',
  'BV_SYNCHRONIZE_GOOGLE_PLAY_SUBSCRIPTION_ENTITLEMENT'
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
values('logger_engine',13)
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
