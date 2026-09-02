-- Separate client/business notification preferences and keep reminder jobs in
-- sync whenever their preference changes.

begin;

do $migration$
begin
  if to_regclass('public.business_notification_preferences') is null
    and to_regclass('public.calendar_notification_preferences') is not null then
    alter table public.calendar_notification_preferences
      rename to business_notification_preferences;
  end if;

  if to_regclass('public.client_notification_preferences') is null
    and to_regclass('public.notification_preferences') is not null then
    alter table public.notification_preferences
      rename to client_notification_preferences;
  end if;
end
$migration$;

drop policy if exists calendar_notification_read on public.business_notification_preferences;
drop policy if exists business_notification_preferences_read on public.business_notification_preferences;
create policy business_notification_preferences_read
  on public.business_notification_preferences for select to authenticated
  using(public.can_read_calendar(calendar_id));

drop policy if exists preferences_self on public.client_notification_preferences;
drop policy if exists client_notification_preferences_self on public.client_notification_preferences;
create policy client_notification_preferences_self
  on public.client_notification_preferences for all to authenticated
  using(user_id=auth.uid()) with check(user_id=auth.uid());
revoke all on public.client_notification_preferences from public,anon,authenticated;
grant select on public.client_notification_preferences to authenticated;

alter table public.notification_jobs add column if not exists type text;

update public.notification_jobs j
set type=case
  when j.kind='booking_request' then 'business'
  when j.kind='status_update' then 'client'
  when exists(select 1 from public.bookings b where b.id=j.booking_id and b.customer_id=j.user_id) then 'client'
  else 'business'
end
where j.type is null or j.type not in ('client','business');

-- Keep one reminder schedule for each booking, recipient and recipient type.
with ranked as (
  select id,row_number() over(
    partition by booking_id,user_id,type
    order by
      case status when 'processing' then 1 when 'sent' then 2 when 'pending' then 3 else 4 end,
      created_at desc,id desc
  ) as position
  from public.notification_jobs
  where kind='reminder'
)
delete from public.notification_jobs j using ranked r
where j.id=r.id and r.position>1;

alter table public.notification_jobs alter column type set not null;
alter table public.notification_jobs drop constraint if exists notification_jobs_type_check;
alter table public.notification_jobs add constraint notification_jobs_type_check
  check(type in ('client','business'));

create unique index if not exists notification_jobs_reminder_recipient_type_unique
  on public.notification_jobs(booking_id,user_id,type) where kind='reminder';
create index if not exists notification_jobs_type_due_idx
  on public.notification_jobs(type,status,send_at) where status='pending';

create or replace function private.sync_client_reminder_jobs(p_user uuid)
returns void language plpgsql security definer set search_path='' as $$
declare v_minutes integer:=60; v_enabled boolean:=true;
begin
  select p.default_minutes,p.push_enabled into v_minutes,v_enabled
  from public.client_notification_preferences p where p.user_id=p_user;
  if not found then v_minutes:=60; v_enabled:=true; end if;

  update public.notification_jobs j set status='cancelled'
  from public.bookings b
  where j.booking_id=b.id and j.user_id=p_user and j.type='client' and j.kind='reminder'
    and j.status in ('pending','failed')
    and (not v_enabled or b.status<>'confirmed' or b.start_at<=now());

  if v_enabled then
    insert into public.notification_jobs(
      booking_id,user_id,send_at,title,body,kind,target_route,type
    )
    select b.id,b.customer_id,
      greatest(now()+interval '1 second',b.start_at-make_interval(mins=>v_minutes)),
      'Programarea ta se apropie',company.name||' · Verifică detaliile în aplicație.',
      'reminder','/customer/notifications','client'
    from public.bookings b
    join public.businesses company on company.id=b.business_id
    where b.customer_id=p_user and b.status='confirmed' and b.start_at>now()
    on conflict(booking_id,user_id,type) where kind='reminder' do update set
      send_at=excluded.send_at,title=excluded.title,body=excluded.body,
      target_route=excluded.target_route,type='client',
      status=case
        when public.notification_jobs.status in ('sent','processing') then public.notification_jobs.status
        else 'pending'::public.notification_status
      end,
      attempts=case when public.notification_jobs.status in ('sent','processing')
        then public.notification_jobs.attempts else 0 end,
      last_error=case when public.notification_jobs.status in ('sent','processing')
        then public.notification_jobs.last_error else null end;
  end if;
end;
$$;
revoke all on function private.sync_client_reminder_jobs(uuid) from public,anon,authenticated;

create or replace function private.sync_business_reminder_jobs(p_calendar uuid)
returns void language plpgsql security definer set search_path='' as $$
declare v_minutes integer:=15;
begin
  select coalesce(p.minutes_before,15) into v_minutes
  from public.business_notification_preferences p where p.calendar_id=p_calendar;
  if not found then v_minutes:=15; end if;

  update public.notification_jobs j set status='cancelled'
  from public.bookings b
  where j.booking_id=b.id and b.resource_id=p_calendar
    and j.type='business' and j.kind='reminder' and j.status in ('pending','failed')
    and (b.status<>'confirmed' or b.start_at<=now()
      or b.start_at-make_interval(mins=>v_minutes)<=now()
      or not private.business_has_team_features(b.business_id)
      or not exists(select 1 from public.business_members m
        where m.business_id=b.business_id and m.user_id=j.user_id));

  insert into public.notification_jobs(
    booking_id,user_id,send_at,title,body,kind,target_route,type
  )
  select b.id,m.user_id,b.start_at-make_interval(mins=>v_minutes),
    'Programarea începe în '||v_minutes||' minute',b.customer_name,
    'reminder','/business/notifications','business'
  from public.bookings b
  join public.business_members m on m.business_id=b.business_id
  where b.resource_id=p_calendar and b.status='confirmed' and b.start_at>now()
    and b.start_at-make_interval(mins=>v_minutes)>now()
    and private.business_has_team_features(b.business_id)
  on conflict(booking_id,user_id,type) where kind='reminder' do update set
    send_at=excluded.send_at,title=excluded.title,body=excluded.body,
    target_route=excluded.target_route,type='business',
    status=case
      when public.notification_jobs.status in ('sent','processing') then public.notification_jobs.status
      else 'pending'::public.notification_status
    end,
    attempts=case when public.notification_jobs.status in ('sent','processing')
      then public.notification_jobs.attempts else 0 end,
    last_error=case when public.notification_jobs.status in ('sent','processing')
      then public.notification_jobs.last_error else null end;
end;
$$;
revoke all on function private.sync_business_reminder_jobs(uuid) from public,anon,authenticated;

create or replace function private.sync_client_preferences_after_write()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  perform private.sync_client_reminder_jobs(new.user_id);
  return new;
end;
$$;
revoke all on function private.sync_client_preferences_after_write() from public,anon,authenticated;
drop trigger if exists sync_client_preferences_after_write on public.client_notification_preferences;
create trigger sync_client_preferences_after_write
  after insert or update of default_minutes,push_enabled on public.client_notification_preferences
  for each row execute function private.sync_client_preferences_after_write();

create or replace function private.sync_business_preferences_after_write()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  perform private.sync_business_reminder_jobs(new.calendar_id);
  return new;
end;
$$;
revoke all on function private.sync_business_preferences_after_write() from public,anon,authenticated;
drop trigger if exists sync_business_preferences_after_write on public.business_notification_preferences;
create trigger sync_business_preferences_after_write
  after insert or update of minutes_before on public.business_notification_preferences
  for each row execute function private.sync_business_preferences_after_write();

create or replace function public.set_client_notification_preferences(p_minutes integer,p_enabled boolean)
returns void language plpgsql security definer set search_path='' as $$
begin
  if auth.uid() is null then raise exception 'Autentificare necesară'; end if;
  if p_minutes not between 5 and 10080 then raise exception 'Interval notificare invalid'; end if;
  insert into public.client_notification_preferences(user_id,default_minutes,push_enabled)
    values(auth.uid(),p_minutes,coalesce(p_enabled,true))
    on conflict(user_id) do update set default_minutes=excluded.default_minutes,
      push_enabled=excluded.push_enabled,updated_at=now();
end;
$$;
revoke all on function public.set_client_notification_preferences(integer,boolean) from public,anon;
grant execute on function public.set_client_notification_preferences(integer,boolean) to authenticated;

create or replace function public.set_calendar_notification_minutes(p_calendar_id uuid,p_minutes integer)
returns void language plpgsql security definer set search_path='' as $$
declare v_business uuid;
begin
  if not public.can_manage_calendar(p_calendar_id) then raise exception 'Acces interzis'; end if;
  if p_minutes not between 2 and 30 then raise exception 'Minute invalide'; end if;
  select business_id into v_business from public.resources where id=p_calendar_id and is_active;
  if v_business is null or not private.business_has_team_features(v_business) then
    raise exception 'Notificările business sunt disponibile doar cu planul Complete activ';
  end if;
  insert into public.business_notification_preferences(calendar_id,minutes_before)
    values(p_calendar_id,p_minutes)
    on conflict(calendar_id) do update set minutes_before=excluded.minutes_before,updated_at=now();
end;
$$;
revoke all on function public.set_calendar_notification_minutes(uuid,integer) from public,anon;
grant execute on function public.set_calendar_notification_minutes(uuid,integer) to authenticated;

create or replace function public.create_booking(
  p_business_id uuid,p_event_type_id uuid,p_resource_id uuid,p_start_at timestamptz,
  p_customer_name text,p_reminder_minutes integer default 60
) returns uuid language plpgsql security definer set search_path='' as $$
declare v_id uuid; v_duration integer; v_end timestamptz; v_email text; v_name text; v_zone text;
  v_limit integer; v_local timestamp; v_local_end timestamp; v_customer_name text;
begin
  v_email:=private.verified_google_email();
  if v_email is null then raise exception 'Cont Google verificat necesar'; end if;
  select btrim(first_name)||' '||btrim(last_name) into v_customer_name from public.profiles
    where id=auth.uid() and customer_profile_completed_at is not null;
  if v_customer_name is null then raise exception 'Completează prenumele și numele înainte de programare'; end if;
  if p_start_at<=now() or p_start_at>now()+interval '1 year' then raise exception 'Dată invalidă'; end if;
  v_limit:=private.require_business_access(p_business_id);
  if (select count(*) from public.resources where business_id=p_business_id and is_active)>v_limit then
    raise exception 'Planul afacerii nu acoperă toate calendarele.'; end if;
  select duration_minutes into v_duration from public.event_types
    where id=p_event_type_id and business_id=p_business_id and resource_id=p_resource_id and is_active;
  if v_duration is null or not exists(select 1 from public.resources
    where id=p_resource_id and business_id=p_business_id and is_active) then raise exception 'Serviciu invalid'; end if;
  select name,timezone into v_name,v_zone from public.businesses where id=p_business_id and is_active;
  if v_name is null then raise exception 'Afacere indisponibilă'; end if;
  v_end:=p_start_at+make_interval(mins=>v_duration);
  v_local:=p_start_at at time zone v_zone; v_local_end:=v_end at time zone v_zone;
  if v_local::date<>v_local_end::date or not exists(select 1 from public.availability_rules a
    where a.resource_id=p_resource_id and a.business_id=p_business_id
      and (a.event_type_id=p_event_type_id or a.event_type_id is null)
      and a.weekday=extract(isodow from v_local) and a.start_time<=v_local::time and a.end_time>=v_local_end::time
      and (a.valid_from is null or a.valid_from<=v_local::date) and (a.valid_until is null or a.valid_until>=v_local::date))
    then raise exception 'Ora este în afara programului'; end if;
  if exists(select 1 from public.blocked_periods b where b.resource_id=p_resource_id
    and tstzrange(b.start_at,b.end_at,'[)') && tstzrange(p_start_at,v_end,'[)')) then raise exception 'Interval blocat'; end if;
  if exists(select 1 from public.bookings b where b.resource_id=p_resource_id
    and b.status in ('pending','confirmed')
    and tstzrange(b.start_at,b.end_at,'[)') && tstzrange(p_start_at,v_end,'[)'))
    then raise exception 'Intervalul nu mai este disponibil'; end if;
  begin
    insert into public.bookings(business_id,customer_id,event_type_id,resource_id,start_at,end_at,
      customer_name,customer_email_snapshot,status)
      values(p_business_id,auth.uid(),p_event_type_id,p_resource_id,p_start_at,v_end,
        v_customer_name,v_email,'pending') returning id into v_id;
  exception when exclusion_violation then
    raise exception 'Intervalul nu mai este disponibil';
  end;
  insert into public.notification_jobs(booking_id,user_id,send_at,title,body,kind,target_route,type)
    select v_id,m.user_id,now(),'Cerere nouă de programare',
      v_customer_name||' · '||to_char(p_start_at at time zone v_zone,'DD.MM.YYYY HH24:MI'),
      'booking_request','/business/notifications','business'
    from public.business_members m
    where m.business_id=p_business_id and private.business_has_team_features(p_business_id);
  return v_id;
end;
$$;

create or replace function public.set_booking_status(p_booking_id uuid,p_status public.booking_status)
returns void language plpgsql security definer set search_path='' as $$
declare v_booking public.bookings%rowtype; v_business_name text; v_zone text; v_minutes integer;
begin
  select * into v_booking from public.bookings where id=p_booking_id for update;
  if not found or auth.uid() is null then raise exception 'Acces interzis'; end if;
  if v_booking.customer_id=auth.uid() and p_status='cancelled' and v_booking.status in ('pending','confirmed') then null;
  elsif public.can_manage_calendar(v_booking.resource_id)
    and ((v_booking.status='pending' and p_status in ('confirmed','rejected'))
      or (v_booking.status='confirmed' and p_status in ('cancelled','completed','no_show'))) then
    perform private.require_business_access(v_booking.business_id);
  else raise exception 'Acces interzis'; end if;
  update public.bookings set status=p_status,updated_at=now() where id=p_booking_id;
  if p_status='confirmed' then
    update public.notification_jobs set status='cancelled'
      where booking_id=p_booking_id and status='pending' and kind='booking_request' and type='business';
    select coalesce((select minutes_before from public.business_notification_preferences
      where calendar_id=v_booking.resource_id),15) into v_minutes;
    insert into public.notification_jobs(booking_id,user_id,send_at,title,body,kind,target_route,type)
      select v_booking.id,m.user_id,v_booking.start_at-make_interval(mins=>v_minutes),
        'Programarea începe în '||v_minutes||' minute',v_booking.customer_name,
        'reminder','/business/notifications','business'
      from public.business_members m
      where m.business_id=v_booking.business_id and private.business_has_team_features(v_booking.business_id)
        and v_booking.start_at-make_interval(mins=>v_minutes)>now()
      on conflict(booking_id,user_id,type) where kind='reminder' do update set
        send_at=excluded.send_at,title=excluded.title,body=excluded.body,
        target_route=excluded.target_route,type='business',status='pending',attempts=0,last_error=null;
  else
    update public.notification_jobs set status='cancelled'
      where booking_id=p_booking_id and status='pending';
  end if;
  if p_status in ('confirmed','rejected') then
    select name,timezone into v_business_name,v_zone from public.businesses where id=v_booking.business_id;
    insert into public.notification_jobs(booking_id,user_id,send_at,title,body,kind,target_route,type)
      values(v_booking.id,v_booking.customer_id,now(),
        case when p_status='confirmed' then 'Programare confirmată' else 'Programare respinsă' end,
        v_business_name||' · '||to_char(v_booking.start_at at time zone v_zone,'DD.MM.YYYY HH24:MI'),
        'status_update','/customer/notifications','client');
  end if;
end;
$$;

create or replace function public.notification_recipient_allowed(p_booking uuid,p_user uuid)
returns boolean language sql stable security definer set search_path='' as $$
  select exists(
    select 1 from public.bookings b
    join public.businesses owner on owner.id=b.business_id
    left join public.client_notification_preferences pref
      on pref.user_id=p_user and b.customer_id=p_user
    where b.id=p_booking and b.status='confirmed' and b.start_at>now()
      and (
        (b.customer_id=p_user and coalesce(pref.push_enabled,true))
        or (private.business_has_team_features(b.business_id)
          and exists(select 1 from public.business_members m
            where m.business_id=b.business_id and m.user_id=p_user))
      )
  );
$$;
revoke all on function public.notification_recipient_allowed(uuid,uuid) from public,anon,authenticated;
grant execute on function public.notification_recipient_allowed(uuid,uuid) to service_role;

create or replace function public.notification_job_recipient_allowed(p_job uuid)
returns boolean language sql stable security definer set search_path='' as $$
  select exists(
    select 1 from public.notification_jobs j
    join public.bookings b on b.id=j.booking_id
    left join public.client_notification_preferences pref
      on pref.user_id=j.user_id and j.type='client'
    where j.id=p_job and j.status='processing'
      and (
        (j.kind='booking_request' and j.type='business' and b.status='pending' and b.start_at>now()
          and private.business_has_team_features(b.business_id)
          and exists(select 1 from public.business_members m
            where m.business_id=b.business_id and m.user_id=j.user_id))
        or (j.kind='status_update' and j.type='client' and b.customer_id=j.user_id
          and b.status in ('confirmed','rejected') and coalesce(pref.push_enabled,true))
        or (j.kind='reminder' and (
          (j.type='client' and b.customer_id=j.user_id)
          or (j.type='business' and exists(select 1 from public.business_members m
            where m.business_id=b.business_id and m.user_id=j.user_id))
        ) and public.notification_recipient_allowed(b.id,j.user_id))
      )
  );
$$;
revoke all on function public.notification_job_recipient_allowed(uuid) from public,anon,authenticated;
grant execute on function public.notification_job_recipient_allowed(uuid) to service_role;

create or replace function private.filter_plan_reminder()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if new.kind='booking_request' then
    if new.type<>'business' or not exists(
      select 1 from public.bookings b join public.business_members m on m.business_id=b.business_id
      where b.id=new.booking_id and b.status='pending' and b.start_at>now()
        and m.user_id=new.user_id and private.business_has_team_features(b.business_id)
    ) then return null; end if;
  elsif new.kind='status_update' then
    if new.type<>'client' or not exists(
      select 1 from public.bookings b
      left join public.client_notification_preferences pref on pref.user_id=new.user_id
      where b.id=new.booking_id and b.customer_id=new.user_id
        and b.status in ('confirmed','rejected') and coalesce(pref.push_enabled,true)
    ) then return null; end if;
  elsif new.kind='reminder' then
    if not ((new.type='client' and exists(select 1 from public.bookings b
        where b.id=new.booking_id and b.customer_id=new.user_id))
      or (new.type='business' and exists(select 1 from public.bookings b
        join public.business_members m on m.business_id=b.business_id
        where b.id=new.booking_id and m.user_id=new.user_id)))
      or not public.notification_recipient_allowed(new.booking_id,new.user_id)
    then return null; end if;
  end if;
  return new;
end;
$$;

create or replace function private.queue_customer_reminder_on_confirmation()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if new.status='confirmed' and old.status<>'confirmed' and new.start_at>now() then
    perform private.sync_client_reminder_jobs(new.customer_id);
  end if;
  return new;
end;
$$;

-- Normalize all existing reminder schedules after the schema change.
do $sync$
declare v_user uuid; v_calendar uuid;
begin
  for v_user in select distinct customer_id from public.bookings loop
    perform private.sync_client_reminder_jobs(v_user);
  end loop;
  for v_calendar in select id from public.resources loop
    perform private.sync_business_reminder_jobs(v_calendar);
  end loop;
end
$sync$;

commit;
