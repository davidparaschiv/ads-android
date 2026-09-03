-- Store each BV member's calendar reminder setting in the existing preferences
-- table. -1 means disabled; 0 means at appointment time.

begin;

alter table public.business_notification_preferences
  add column if not exists user_id uuid references public.profiles(id) on delete cascade;

create temporary table business_notification_preferences_snapshot on commit drop as
select distinct p.calendar_id,m.user_id,p.minutes_before,p.updated_at
from public.business_notification_preferences p
join public.resources r on r.id=p.calendar_id
join public.business_members m on m.business_id=r.business_id;

truncate table public.business_notification_preferences;
alter table public.business_notification_preferences
  drop constraint if exists calendar_notification_preferences_pkey;
alter table public.business_notification_preferences
  drop constraint if exists business_notification_preferences_pkey;
alter table public.business_notification_preferences
  drop constraint if exists calendar_notification_preferences_minutes_before_check;
alter table public.business_notification_preferences
  drop constraint if exists business_notification_preferences_minutes_before_check;
alter table public.business_notification_preferences alter column user_id set not null;
alter table public.business_notification_preferences
  add constraint business_notification_preferences_pkey primary key(calendar_id,user_id);
alter table public.business_notification_preferences
  add constraint business_notification_preferences_minutes_before_check
  check(minutes_before=-1 or minutes_before between 0 and 30);

insert into public.business_notification_preferences(calendar_id,user_id,minutes_before,updated_at)
select calendar_id,user_id,minutes_before,updated_at
from business_notification_preferences_snapshot
on conflict(calendar_id,user_id) do nothing;

drop policy if exists business_notification_preferences_read
  on public.business_notification_preferences;
create policy business_notification_preferences_read
  on public.business_notification_preferences for select to authenticated
  using(user_id=auth.uid() and public.can_read_calendar(calendar_id));

create or replace function public.get_calendar_notification_minutes(p_calendar_id uuid)
returns integer language plpgsql stable security definer set search_path='' as $$
begin
  if auth.uid() is null or not public.can_read_calendar(p_calendar_id) then
    raise exception 'Acces interzis';
  end if;
  return coalesce((select p.minutes_before
    from public.business_notification_preferences p
    where p.calendar_id=p_calendar_id and p.user_id=auth.uid()),15);
end;
$$;
revoke all on function public.get_calendar_notification_minutes(uuid) from public,anon;
grant execute on function public.get_calendar_notification_minutes(uuid) to authenticated;

create or replace function public.notification_recipient_allowed(p_booking uuid,p_user uuid)
returns boolean language sql stable security definer set search_path='' as $$
  select exists(
    select 1 from public.bookings b
    left join public.client_notification_preferences client_pref
      on client_pref.user_id=p_user and b.customer_id=p_user
    left join public.business_notification_preferences business_pref
      on business_pref.calendar_id=b.resource_id and business_pref.user_id=p_user
    where b.id=p_booking and b.status='confirmed' and b.start_at>now()
      and (
        (b.customer_id=p_user and coalesce(client_pref.push_enabled,true))
        or (private.business_has_team_features(b.business_id)
          and exists(select 1 from public.business_members m
            where m.business_id=b.business_id and m.user_id=p_user)
          and coalesce(business_pref.minutes_before,15)<>-1)
      )
  );
$$;
revoke all on function public.notification_recipient_allowed(uuid,uuid)
  from public,anon,authenticated;
grant execute on function public.notification_recipient_allowed(uuid,uuid) to service_role;

drop function if exists private.reschedule_business_reminders_after_save(uuid,integer);
create or replace function private.reschedule_business_reminders_after_save(
  p_calendar uuid,p_user uuid,p_minutes integer
) returns void language plpgsql security definer set search_path='' as $$
declare v_now timestamptz:=now();
begin
  if p_minutes=-1 then
    update public.notification_jobs j set status='cancelled',last_error=null
    from public.bookings b
    where j.booking_id=b.id and b.resource_id=p_calendar
      and j.user_id=p_user and j.kind='reminder' and j.type='business'
      and b.start_at>v_now;
    return;
  end if;

  update public.notification_jobs j set status='cancelled',last_error=null
  from public.bookings b
  where j.booking_id=b.id and b.resource_id=p_calendar
    and j.user_id=p_user and j.kind='reminder' and j.type='business'
    and (b.status<>'confirmed' or b.start_at<=v_now
      or b.start_at-make_interval(mins=>p_minutes)<=v_now+interval '2 minutes');

  insert into public.notification_jobs(
    booking_id,user_id,send_at,title,body,kind,target_route,type
  )
  select b.id,p_user,b.start_at-make_interval(mins=>p_minutes),
    'Programarea începe în '||p_minutes||' minute',b.customer_name,
    'reminder','/business/notifications','business'
  from public.bookings b
  where b.resource_id=p_calendar and b.status='confirmed' and b.start_at>v_now
    and b.start_at-make_interval(mins=>p_minutes)>v_now+interval '2 minutes'
    and private.business_has_team_features(b.business_id)
    and exists(select 1 from public.business_members m
      where m.business_id=b.business_id and m.user_id=p_user)
  on conflict(booking_id,user_id,type) where kind='reminder' do update set
    send_at=excluded.send_at,title=excluded.title,body=excluded.body,
    target_route=excluded.target_route,type='business',
    status='pending'::public.notification_status,attempts=0,last_error=null;
end;
$$;
revoke all on function private.reschedule_business_reminders_after_save(uuid,uuid,integer)
  from public,anon,authenticated;

create or replace function public.set_calendar_notification_minutes(
  p_calendar_id uuid,p_minutes integer
) returns void language plpgsql security definer set search_path='' as $$
declare v_business uuid;
begin
  if auth.uid() is null or not public.can_manage_calendar(p_calendar_id) then
    raise exception 'Acces interzis';
  end if;
  if p_minutes<>-1 and p_minutes not between 0 and 30 then
    raise exception 'Minute invalide';
  end if;
  select business_id into v_business
  from public.resources where id=p_calendar_id and is_active;
  if v_business is null or not private.business_has_team_features(v_business) then
    raise exception 'Notificările business sunt disponibile doar cu planul Complete activ';
  end if;
  if not exists(select 1 from public.business_members m
    where m.business_id=v_business and m.user_id=auth.uid()) then
    raise exception 'Acces interzis';
  end if;

  insert into public.business_notification_preferences(calendar_id,user_id,minutes_before)
    values(p_calendar_id,auth.uid(),p_minutes)
    on conflict(calendar_id,user_id) do update
      set minutes_before=excluded.minutes_before,updated_at=now();
  perform private.reschedule_business_reminders_after_save(
    p_calendar_id,auth.uid(),p_minutes
  );
end;
$$;
revoke all on function public.set_calendar_notification_minutes(uuid,integer) from public,anon;
grant execute on function public.set_calendar_notification_minutes(uuid,integer) to authenticated;

create or replace function public.set_booking_status(
  p_booking_id uuid,p_status public.booking_status
) returns void language plpgsql security definer set search_path='' as $$
declare v_booking public.bookings%rowtype; v_business_name text; v_calendar_name text;
  v_zone text;
begin
  select * into v_booking from public.bookings where id=p_booking_id for update;
  if not found or auth.uid() is null then raise exception 'Acces interzis'; end if;
  if v_booking.customer_id=auth.uid() and p_status='cancelled'
    and v_booking.status in ('pending','confirmed') then null;
  elsif public.can_manage_calendar(v_booking.resource_id)
    and ((v_booking.status='pending' and p_status in ('confirmed','rejected'))
      or (v_booking.status='confirmed' and p_status in ('cancelled','completed','no_show'))) then
    perform private.require_business_access(v_booking.business_id);
  else raise exception 'Acces interzis'; end if;

  update public.bookings set status=p_status,updated_at=now() where id=p_booking_id;
  if p_status='confirmed' then
    update public.notification_jobs set status='cancelled'
      where booking_id=p_booking_id and status='pending'
        and kind='booking_request' and type='business';
    insert into public.notification_jobs(
      booking_id,user_id,send_at,title,body,kind,target_route,type
    )
    select v_booking.id,m.user_id,
      v_booking.start_at-make_interval(mins=>coalesce(pref.minutes_before,15)),
      'Programarea începe în '||coalesce(pref.minutes_before,15)||' minute',
      v_booking.customer_name,'reminder','/business/notifications','business'
    from public.business_members m
    left join public.business_notification_preferences pref
      on pref.calendar_id=v_booking.resource_id and pref.user_id=m.user_id
    where m.business_id=v_booking.business_id
      and private.business_has_team_features(v_booking.business_id)
      and coalesce(pref.minutes_before,15)<>-1
      and v_booking.start_at-make_interval(mins=>coalesce(pref.minutes_before,15))>now()
    on conflict(booking_id,user_id,type) where kind='reminder' do update set
      send_at=excluded.send_at,title=excluded.title,body=excluded.body,
      target_route=excluded.target_route,type='business',
      status='pending',attempts=0,last_error=null;
  else
    update public.notification_jobs set status='cancelled'
      where booking_id=p_booking_id and status='pending';
  end if;

  if p_status in ('confirmed','rejected') then
    select company.name,company.timezone,calendar.name
      into v_business_name,v_zone,v_calendar_name
    from public.businesses company
    join public.resources calendar on calendar.id=v_booking.resource_id
    where company.id=v_booking.business_id;
    insert into public.notification_jobs(
      booking_id,user_id,send_at,title,body,kind,target_route,type
    ) values(
      v_booking.id,v_booking.customer_id,now(),
      case when p_status='confirmed' then 'Programare confirmată'
        else 'Programare respinsă' end,
      v_business_name||' · '||to_char(
        v_booking.start_at at time zone v_zone,'DD.MM.YYYY HH24:MI'
      )||' · Serviciu: '||v_calendar_name,
      'status_update','/customer/notifications','client'
    );
  end if;
end;
$$;
revoke all on function public.set_booking_status(uuid,public.booking_status) from public,anon;
grant execute on function public.set_booking_status(uuid,public.booking_status) to authenticated;

drop table if exists public.business_notification_opt_outs;

commit;
