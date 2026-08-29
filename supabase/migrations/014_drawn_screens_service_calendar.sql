-- Data model required by the hand-drawn BV/CV screens.
begin;

alter table public.event_types add column if not exists resource_id uuid references public.resources(id) on delete cascade;
update public.event_types e set resource_id=(
  select r.id from public.resources r where r.business_id=e.business_id order by r.created_at,r.id limit 1
) where e.resource_id is null;
create unique index if not exists event_types_business_name_unique
  on public.event_types(business_id,lower(btrim(name))) where is_active;

alter table public.availability_rules add column if not exists event_type_id uuid references public.event_types(id) on delete cascade;

-- A pending request reserves the interval immediately. This prevents two clients
-- from requesting the same time on the same calendar while approval is pending.
alter table public.bookings drop constraint if exists no_resource_booking_overlap;
alter table public.bookings add constraint no_resource_booking_overlap exclude using gist (
  resource_id with =, tstzrange(start_at,end_at,'[)') with &&
) where (status in ('pending','confirmed'));

create table if not exists public.calendar_notification_preferences (
  calendar_id uuid primary key references public.resources(id) on delete cascade,
  minutes_before smallint not null default 15 check(minutes_before between 2 and 30),
  updated_at timestamptz not null default now()
);
alter table public.calendar_notification_preferences enable row level security;
revoke all on public.calendar_notification_preferences from public,anon,authenticated;
grant select on public.calendar_notification_preferences to authenticated;
drop policy if exists calendar_notification_read on public.calendar_notification_preferences;
create policy calendar_notification_read on public.calendar_notification_preferences for select to authenticated
  using(public.can_read_calendar(calendar_id));

create or replace function public.set_calendar_notification_minutes(p_calendar_id uuid,p_minutes integer)
returns void language plpgsql security definer set search_path='' as $$
begin
  if not public.can_manage_calendar(p_calendar_id) then raise exception 'Acces interzis'; end if;
  if p_minutes not between 2 and 30 then raise exception 'Minute invalide'; end if;
  insert into public.calendar_notification_preferences(calendar_id,minutes_before)
    values(p_calendar_id,p_minutes)
    on conflict(calendar_id) do update set minutes_before=excluded.minutes_before,updated_at=now();
end;
$$;
revoke all on function public.set_calendar_notification_minutes(uuid,integer) from public,anon;
grant execute on function public.set_calendar_notification_minutes(uuid,integer) to authenticated;

create or replace function public.add_business_event(
  p_business_id uuid,p_resource_id uuid,p_name text,p_weekdays smallint[],p_start_time time,p_duration_minutes integer
) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_event uuid; v_day smallint; v_end time;
begin
  if not public.can_manage_calendar(p_resource_id)
    or not exists(select 1 from public.resources where id=p_resource_id and business_id=p_business_id and is_active)
    then raise exception 'Acces interzis'; end if;
  perform private.require_business_access(p_business_id);
  if length(btrim(coalesce(p_name,''))) not between 2 and 80 then raise exception 'Nume serviciu invalid'; end if;
  if exists(select 1 from public.event_types where business_id=p_business_id and is_active and lower(btrim(name))=lower(btrim(p_name)))
    then raise exception 'Serviciul există deja'; end if;
  if coalesce(array_length(p_weekdays,1),0)=0 or exists(select 1 from unnest(p_weekdays) d where d not between 1 and 7)
    then raise exception 'Selectează cel puțin o zi'; end if;
  if p_duration_minutes not in (10,20,30,40,50,60,120,180,240,300,360) then raise exception 'Durată invalidă'; end if;
  v_end:=p_start_time+make_interval(mins=>p_duration_minutes);
  if v_end<=p_start_time then raise exception 'Interval invalid'; end if;
  insert into public.event_types(business_id,resource_id,name,duration_minutes,price_cents)
    values(p_business_id,p_resource_id,btrim(p_name),p_duration_minutes,0) returning id into v_event;
  foreach v_day in array p_weekdays loop
    insert into public.availability_rules(business_id,resource_id,event_type_id,weekday,start_time,end_time)
      values(p_business_id,p_resource_id,v_event,v_day,p_start_time,v_end);
  end loop;
  return jsonb_build_object('id',v_event,'name',btrim(p_name),'resourceId',p_resource_id,'durationMinutes',p_duration_minutes);
exception when unique_violation then raise exception 'Serviciul există deja';
end;
$$;
revoke all on function public.add_business_event(uuid,uuid,text,smallint[],time,integer) from public,anon;
grant execute on function public.add_business_event(uuid,uuid,text,smallint[],time,integer) to authenticated;

create or replace function public.available_slots(p_business_id uuid,p_resource_id uuid,p_event_type_id uuid,p_date date)
returns table(start_at timestamptz,end_at timestamptz)
language plpgsql stable security definer set search_path='' as $$
declare v_minutes integer; v_zone text; v_owner uuid; v_access jsonb;
begin
  if auth.uid() is null or p_date is null or p_date<current_date-1 or p_date>current_date+366 then return; end if;
  select timezone,owner_id into v_zone,v_owner from public.businesses where id=p_business_id and is_active;
  if v_zone is null then return; end if;
  v_access:=private.owner_access(v_owner);
  if not (v_access->>'active')::boolean or
    (select count(*) from public.resources where business_id=p_business_id and is_active)>(v_access->>'calendarLimit')::integer then return; end if;
  select duration_minutes into v_minutes from public.event_types
    where id=p_event_type_id and business_id=p_business_id and resource_id=p_resource_id and is_active;
  if v_minutes is null then return; end if;
  return query select distinct s.t,s.t+make_interval(mins=>v_minutes)
    from public.availability_rules a cross join lateral generate_series(
      (p_date+a.start_time) at time zone v_zone,
      ((p_date+a.end_time) at time zone v_zone)-make_interval(mins=>v_minutes),interval '15 minutes') s(t)
    where a.business_id=p_business_id and a.resource_id=p_resource_id
      and (a.event_type_id=p_event_type_id or a.event_type_id is null)
      and a.weekday=extract(isodow from p_date)
      and (a.valid_from is null or a.valid_from<=p_date) and (a.valid_until is null or a.valid_until>=p_date)
      and s.t>now()
      and not exists(select 1 from public.bookings b where b.resource_id=p_resource_id and b.status in ('pending','confirmed')
        and tstzrange(b.start_at,b.end_at,'[)') && tstzrange(s.t,s.t+make_interval(mins=>v_minutes),'[)'))
      and not exists(select 1 from public.blocked_periods b where b.resource_id=p_resource_id
        and tstzrange(b.start_at,b.end_at,'[)') && tstzrange(s.t,s.t+make_interval(mins=>v_minutes),'[)'))
    order by s.t;
end;
$$;

-- Existing installations get an explicit link when setup_business creates the first pair.
create or replace function public.setup_business(
  p_business_id uuid,p_service_name text,p_duration_minutes integer,p_price_cents integer,
  p_resource_name text,p_open_time time,p_close_time time,p_weekdays smallint[]
) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_location uuid; v_resource uuid; v_event uuid; v_day smallint; v_address text;
begin
  if not public.is_business_admin(p_business_id) then raise exception 'Acces interzis'; end if;
  perform private.require_business_access(p_business_id);
  if exists(select 1 from public.resources where business_id=p_business_id) then raise exception 'Configurarea inițială există deja'; end if;
  if p_open_time>=p_close_time or coalesce(array_length(p_weekdays,1),0)=0 then raise exception 'Program invalid'; end if;
  select address into v_address from public.businesses where id=p_business_id;
  insert into public.locations(business_id,name,address) values(p_business_id,'Locația principală',v_address) returning id into v_location;
  insert into public.resources(business_id,location_id,name) values(p_business_id,v_location,p_resource_name) returning id into v_resource;
  insert into public.event_types(business_id,resource_id,name,duration_minutes,price_cents)
    values(p_business_id,v_resource,p_service_name,p_duration_minutes,p_price_cents) returning id into v_event;
  foreach v_day in array p_weekdays loop
    insert into public.availability_rules(business_id,resource_id,event_type_id,weekday,start_time,end_time)
      values(p_business_id,v_resource,v_event,v_day,p_open_time,p_close_time);
  end loop;
  return jsonb_build_object('resource_id',v_resource,'event_type_id',v_event);
end;
$$;

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
  insert into public.notification_jobs(booking_id,user_id,send_at,title,body,kind,target_route)
    select v_id,m.user_id,now(),'Cerere nouă de programare',
      v_customer_name||' · '||to_char(p_start_at at time zone v_zone,'DD.MM.YYYY HH24:MI'),
      'booking_request','/business/notifications'
    from public.business_members m left join public.notification_preferences pref on pref.user_id=m.user_id
    where m.business_id=p_business_id and coalesce(pref.push_enabled,true);
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
      where booking_id=p_booking_id and status='pending' and kind='booking_request';
    select coalesce((select minutes_before from public.calendar_notification_preferences
      where calendar_id=v_booking.resource_id),15) into v_minutes;
    insert into public.notification_jobs(booking_id,user_id,send_at,title,body,kind,target_route)
      select v_booking.id,m.user_id,v_booking.start_at-make_interval(mins=>v_minutes),
        'Programarea începe în '||v_minutes||' minute',v_booking.customer_name,
        'reminder','/business/notifications'
      from public.business_members m left join public.notification_preferences pref on pref.user_id=m.user_id
      where m.business_id=v_booking.business_id and coalesce(pref.push_enabled,true)
        and v_booking.start_at-make_interval(mins=>v_minutes)>now()
      on conflict(booking_id,user_id,send_at) do nothing;
  else
    update public.notification_jobs set status='cancelled' where booking_id=p_booking_id and status='pending';
  end if;
  if p_status in ('confirmed','rejected') then
    select name,timezone into v_business_name,v_zone from public.businesses where id=v_booking.business_id;
    insert into public.notification_jobs(booking_id,user_id,send_at,title,body,kind,target_route)
      values(v_booking.id,v_booking.customer_id,now(),
        case when p_status='confirmed' then 'Programare confirmată' else 'Programare respinsă' end,
        v_business_name||' · '||to_char(v_booking.start_at at time zone v_zone,'DD.MM.YYYY HH24:MI'),
        'status_update','/customer/notifications');
  end if;
end;
$$;

commit;
