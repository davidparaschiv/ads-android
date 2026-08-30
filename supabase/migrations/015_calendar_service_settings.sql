-- One calendar is one service. Owners/managers edit its availability and duration.
begin;

with ranked as (
  select id,row_number() over(partition by resource_id order by created_at,id) position
  from public.event_types where is_active and resource_id is not null
)
update public.event_types e set is_active=false
from ranked r where e.id=r.id and r.position>1;

create unique index if not exists event_types_active_resource_unique
  on public.event_types(resource_id) where is_active and resource_id is not null;

create or replace function public.get_calendar_service_settings(p_calendar_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_resource public.resources%rowtype; v_event public.event_types%rowtype;
  v_days smallint[]; v_start time; v_end time;
begin
  if not public.can_read_calendar(p_calendar_id) then raise exception 'Acces interzis'; end if;
  select * into v_resource from public.resources where id=p_calendar_id and is_active;
  if not found then raise exception 'Calendar indisponibil'; end if;
  select * into v_event from public.event_types
    where resource_id=p_calendar_id and is_active order by created_at,id limit 1;
  select array_agg(distinct weekday order by weekday),min(start_time),max(end_time)
    into v_days,v_start,v_end from public.availability_rules
    where resource_id=p_calendar_id and (v_event.id is null or event_type_id=v_event.id or event_type_id is null);
  return jsonb_build_object(
    'calendarId',v_resource.id,'name',v_resource.name,'serviceId',v_event.id,
    'durationMinutes',coalesce(v_event.duration_minutes,30),
    'weekdays',coalesce(v_days,array[]::smallint[]),
    'startTime',coalesce(v_start,'09:00'::time),'endTime',coalesce(v_end,'18:00'::time)
  );
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
    update public.event_types set name=v_resource.name,duration_minutes=p_duration_minutes
      where id=v_event;
    update public.event_types set is_active=false
      where resource_id=p_calendar_id and id<>v_event and is_active;
  end if;

  delete from public.availability_rules where resource_id=p_calendar_id;
  foreach v_day in array p_weekdays loop
    insert into public.availability_rules(business_id,resource_id,event_type_id,weekday,start_time,end_time)
      values(p_business_id,p_calendar_id,v_event,v_day,p_start_time,p_end_time);
  end loop;
  return public.get_calendar_service_settings(p_calendar_id);
end;
$$;

revoke all on function public.get_calendar_service_settings(uuid),
  public.save_calendar_service_settings(uuid,uuid,smallint[],time,time,integer) from public,anon;
grant execute on function public.get_calendar_service_settings(uuid),
  public.save_calendar_service_settings(uuid,uuid,smallint[],time,time,integer) to authenticated;

commit;
