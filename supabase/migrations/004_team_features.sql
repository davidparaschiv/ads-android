-- Small: one calendar, no business reports/reminders. Complete: five calendars + both.
-- Apply after 003. No subscription or booking history is removed.
begin;

create function private.business_has_team_features(p_business uuid)
returns boolean language sql stable security definer set search_path='' as $$
  select coalesce((select (a->>'active')::boolean and a->>'planId'='large'
    from public.businesses b cross join lateral private.owner_access(b.owner_id) a
    where b.id=p_business),false);
$$;
revoke all on function private.business_has_team_features(uuid) from public,anon,authenticated;

create or replace function public.get_access(p_business_id uuid default null)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_owner uuid; v_access jsonb; v_count integer; v_team boolean;
begin
  if auth.uid() is null then raise exception 'Autentificare necesară'; end if;
  if p_business_id is null then v_owner:=auth.uid();
  else
    if not public.is_business_member(p_business_id) then raise exception 'Acces interzis'; end if;
    select owner_id into v_owner from public.businesses where id=p_business_id;
  end if;
  v_access:=private.owner_access(v_owner);
  v_team:=coalesce((v_access->>'active')::boolean and v_access->>'planId'='large',false);
  select count(*) into v_count from public.resources r join public.businesses b on b.id=r.business_id
    where b.owner_id=v_owner and r.is_active;
  return v_access || jsonb_build_object('activeCalendars',v_count,'isOwner',v_owner=auth.uid(),
    'overLimit',v_count > (v_access->>'calendarLimit')::integer,
    'features',jsonb_build_object('reports',v_team,'businessNotifications',v_team));
end;
$$;

-- Separate report API: entitlement checked on EVERY page, with calendar permissions.
-- Ordinary calendar rows remain readable under existing RLS on Small.
create function public.get_business_report(
  p_business_id uuid,p_from date,p_until date,p_calendar_id uuid default null,p_offset integer default 0
) returns table(id uuid,resource_id uuid,start_at timestamptz,status public.booking_status,
  customer_name text,customer_email_snapshot text,service_name text)
language plpgsql stable security definer set search_path='' as $$
declare v_zone text;
begin
  if auth.uid() is null or not public.is_business_member(p_business_id) then raise exception 'Acces interzis'; end if;
  if not private.business_has_team_features(p_business_id) then
    raise exception 'Rapoartele sunt disponibile doar cu planul Complete activ.';
  end if;
  if p_from is null or p_until is null or p_until<p_from or p_until-p_from>366
    or p_offset is null or p_offset<0 then raise exception 'Perioadă invalidă'; end if;
  if p_calendar_id is not null and not exists(select 1 from public.resources r
    where r.id=p_calendar_id and r.business_id=p_business_id and public.can_read_calendar(r.id))
    then raise exception 'Acces interzis'; end if;
  select timezone into v_zone from public.businesses where businesses.id=p_business_id;
  return query select b.id,b.resource_id,b.start_at,b.status,b.customer_name,b.customer_email_snapshot,e.name
    from public.bookings b join public.event_types e on e.id=b.event_type_id
    where b.business_id=p_business_id and public.can_read_calendar(b.resource_id)
      and (p_calendar_id is null or b.resource_id=p_calendar_id)
      and b.start_at >= (p_from::timestamp at time zone v_zone)
      and b.start_at < ((p_until+1)::timestamp at time zone v_zone)
    order by b.start_at,b.id limit 500 offset p_offset;
end;
$$;
revoke all on function public.get_business_report(uuid,date,date,uuid,integer) from public,anon,authenticated;
grant execute on function public.get_business_report(uuid,date,date,uuid,integer) to authenticated;

-- Worker already calls this immediately before delivery. A downgrade/expiry blocks
-- business reminders even when they were queued while Complete was active.
-- The booking customer's own reminder is independent of the business plan.
create or replace function public.notification_recipient_allowed(p_booking uuid,p_user uuid)
returns boolean language sql stable security definer set search_path='' as $$
  select exists(select 1 from public.bookings b join public.businesses owner on owner.id=b.business_id
    left join public.notification_preferences pref on pref.user_id=p_user
    where b.id=p_booking and b.status in ('pending','confirmed') and b.start_at>now()
      and coalesce(pref.push_enabled,true)
      and (b.customer_id=p_user or (private.business_has_team_features(b.business_id)
        and (owner.owner_id=p_user or exists(select 1 from public.calendar_members m
          where m.calendar_id=b.resource_id and m.user_id=p_user)))));
$$;
revoke all on function public.notification_recipient_allowed(uuid,uuid) from public,anon,authenticated;
grant execute on function public.notification_recipient_allowed(uuid,uuid) to service_role;

-- Filter at enqueue too, including existing create_booking callers/older APKs.
create function private.filter_plan_reminder()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if not public.notification_recipient_allowed(new.booking_id,new.user_id) then return null; end if;
  return new;
end;
$$;
revoke all on function private.filter_plan_reminder() from public,anon,authenticated;
create trigger filter_plan_reminder before insert on public.notification_jobs
  for each row execute function private.filter_plan_reminder();

update public.notification_jobs j set status='cancelled'
  from public.bookings b where b.id=j.booking_id and j.status='pending'
    and j.user_id<>b.customer_id and not private.business_has_team_features(b.business_id);

commit;
