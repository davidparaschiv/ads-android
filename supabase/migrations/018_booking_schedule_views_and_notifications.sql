-- Booking duration drives slot spacing; business views show approved bookings only;
-- calendars with pending/approved bookings cannot change their scheduling rules.
begin;

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
      ((p_date+a.end_time) at time zone v_zone)-make_interval(mins=>v_minutes),
      make_interval(mins=>v_minutes)) s(t)
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

create or replace function public.get_business_report(
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
    where b.business_id=p_business_id and b.status='confirmed' and public.can_read_calendar(b.resource_id)
      and (p_calendar_id is null or b.resource_id=p_calendar_id)
      and b.start_at >= (p_from::timestamp at time zone v_zone)
      and b.start_at < ((p_until+1)::timestamp at time zone v_zone)
    order by b.start_at,b.id limit 500 offset p_offset;
end;
$$;

create or replace function public.save_calendar_service_settings(
  p_business_id uuid,p_calendar_id uuid,p_weekdays smallint[],
  p_start_time time,p_end_time time,p_duration_minutes integer
) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_resource public.resources%rowtype; v_event uuid; v_day smallint;
begin
  if not public.can_manage_calendar(p_calendar_id) then raise exception 'Acces interzis'; end if;
  perform private.require_business_access(p_business_id);
  select * into v_resource from public.resources
    where id=p_calendar_id and business_id=p_business_id and is_active for update;
  if not found then raise exception 'Calendar indisponibil'; end if;
  if exists(select 1 from public.bookings where resource_id=p_calendar_id and status in ('pending','confirmed')) then
    raise exception 'Calendarul nu poate fi modificat deoarece are programări în așteptare sau aprobate.';
  end if;
  if p_start_time>=p_end_time then raise exception 'Ora de final trebuie să fie după ora de început'; end if;
  if coalesce(array_length(p_weekdays,1),0)=0
    or exists(select 1 from unnest(p_weekdays) d where d not between 1 and 7)
    then raise exception 'Selectează cel puțin o zi'; end if;
  if p_duration_minutes not in (10,20,30,40,50,60,120,180,240,300,360)
    then raise exception 'Durată invalidă'; end if;
  if p_start_time+make_interval(mins=>p_duration_minutes)>p_end_time
    then raise exception 'Intervalul trebuie să includă cel puțin o programare completă'; end if;

  select id into v_event from public.event_types
    where resource_id=p_calendar_id and is_active order by created_at,id limit 1 for update;
  if v_event is null then
    insert into public.event_types(business_id,resource_id,name,duration_minutes,price_cents)
      values(p_business_id,p_calendar_id,v_resource.name,p_duration_minutes,0)
      returning id into v_event;
  else
    update public.event_types set name=v_resource.name,duration_minutes=p_duration_minutes where id=v_event;
    update public.event_types set is_active=false where resource_id=p_calendar_id and id<>v_event and is_active;
  end if;
  delete from public.availability_rules where resource_id=p_calendar_id;
  foreach v_day in array p_weekdays loop
    insert into public.availability_rules(business_id,resource_id,event_type_id,weekday,start_time,end_time)
      values(p_business_id,p_calendar_id,v_event,v_day,p_start_time,p_end_time);
  end loop;
  return public.get_calendar_service_settings(p_calendar_id);
end;
$$;

revoke all on function public.available_slots(uuid,uuid,uuid,date),
  public.get_business_report(uuid,date,date,uuid,integer),
  public.save_calendar_service_settings(uuid,uuid,smallint[],time,time,integer) from public,anon;
grant execute on function public.available_slots(uuid,uuid,uuid,date),
  public.get_business_report(uuid,date,date,uuid,integer),
  public.save_calendar_service_settings(uuid,uuid,smallint[],time,time,integer) to authenticated;

commit;
