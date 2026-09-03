-- A BV account can opt out of reminders for one calendar without changing the
-- calendar-wide reminder interval for the other business members.

begin;

create table public.business_notification_opt_outs (
  calendar_id uuid not null,
  user_id uuid not null,
  updated_at timestamptz not null default now(),
  primary key(calendar_id,user_id),
  foreign key(calendar_id,user_id)
    references public.calendar_members(calendar_id,user_id) on delete cascade
);

alter table public.business_notification_opt_outs enable row level security;
revoke all on public.business_notification_opt_outs from public,anon,authenticated;

create or replace function public.get_calendar_notification_minutes(p_calendar_id uuid)
returns integer language plpgsql stable security definer set search_path='' as $$
begin
  if auth.uid() is null or not public.can_read_calendar(p_calendar_id) then
    raise exception 'Acces interzis';
  end if;
  if exists(select 1 from public.business_notification_opt_outs o
    where o.calendar_id=p_calendar_id and o.user_id=auth.uid()) then
    return 0;
  end if;
  return coalesce((select p.minutes_before
    from public.business_notification_preferences p
    where p.calendar_id=p_calendar_id),15);
end;
$$;
revoke all on function public.get_calendar_notification_minutes(uuid) from public,anon;
grant execute on function public.get_calendar_notification_minutes(uuid) to authenticated;

create or replace function public.notification_recipient_allowed(p_booking uuid,p_user uuid)
returns boolean language sql stable security definer set search_path='' as $$
  select exists(
    select 1 from public.bookings b
    left join public.client_notification_preferences pref
      on pref.user_id=p_user and b.customer_id=p_user
    where b.id=p_booking and b.status='confirmed' and b.start_at>now()
      and (
        (b.customer_id=p_user and coalesce(pref.push_enabled,true))
        or (private.business_has_team_features(b.business_id)
          and exists(select 1 from public.business_members m
            where m.business_id=b.business_id and m.user_id=p_user)
          and not exists(select 1 from public.business_notification_opt_outs o
            where o.calendar_id=b.resource_id and o.user_id=p_user))
      )
  );
$$;
revoke all on function public.notification_recipient_allowed(uuid,uuid) from public,anon,authenticated;
grant execute on function public.notification_recipient_allowed(uuid,uuid) to service_role;

create or replace function private.set_business_reminder_body()
returns trigger language plpgsql security definer set search_path='' as $$
declare v_customer text; v_calendar text;
begin
  if new.kind='reminder' and new.type='business' then
    select b.customer_name,r.name into v_customer,v_calendar
    from public.bookings b
    join public.resources r on r.id=b.resource_id
    where b.id=new.booking_id;
    if found then
      new.body:=v_customer||' · Serviciu: '||v_calendar;
    end if;
  end if;
  return new;
end;
$$;
revoke all on function private.set_business_reminder_body() from public,anon,authenticated;
drop trigger if exists set_business_reminder_body on public.notification_jobs;
create trigger set_business_reminder_body
  before insert on public.notification_jobs
  for each row execute function private.set_business_reminder_body();

update public.notification_jobs j
set body=b.customer_name||' · Serviciu: '||r.name
from public.bookings b
join public.resources r on r.id=b.resource_id
where j.booking_id=b.id and j.kind='reminder' and j.type='business';

create or replace function public.set_calendar_notification_minutes(p_calendar_id uuid,p_minutes integer)
returns void language plpgsql security definer set search_path='' as $$
declare v_business uuid;
begin
  if not public.can_manage_calendar(p_calendar_id) then raise exception 'Acces interzis'; end if;
  if p_minutes<>0 and p_minutes not between 2 and 30 then raise exception 'Minute invalide'; end if;
  select business_id into v_business from public.resources where id=p_calendar_id and is_active;
  if v_business is null or not private.business_has_team_features(v_business) then
    raise exception 'Notificările business sunt disponibile doar cu planul Complete activ';
  end if;

  if p_minutes=0 then
    insert into public.business_notification_opt_outs(calendar_id,user_id)
      values(p_calendar_id,auth.uid())
      on conflict(calendar_id,user_id) do update set updated_at=now();
    delete from public.notification_jobs j using public.bookings b
      where j.booking_id=b.id and b.resource_id=p_calendar_id
        and j.user_id=auth.uid() and j.kind='reminder' and j.type='business';
    return;
  end if;

  delete from public.business_notification_opt_outs
    where calendar_id=p_calendar_id and user_id=auth.uid();
  insert into public.business_notification_preferences(calendar_id,minutes_before)
    values(p_calendar_id,p_minutes)
    on conflict(calendar_id) do update set minutes_before=excluded.minutes_before,updated_at=now();
  perform private.reschedule_business_reminders_after_save(p_calendar_id,p_minutes);
end;
$$;
revoke all on function public.set_calendar_notification_minutes(uuid,integer) from public,anon;
grant execute on function public.set_calendar_notification_minutes(uuid,integer) to authenticated;

commit;
