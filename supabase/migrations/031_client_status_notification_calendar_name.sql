-- Include the booked calendar name in CV approval/rejection notifications.

begin;

create or replace function public.set_booking_status(p_booking_id uuid,p_status public.booking_status)
returns void language plpgsql security definer set search_path='' as $$
declare v_booking public.bookings%rowtype; v_business_name text; v_calendar_name text;
  v_zone text; v_minutes integer;
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
    select company.name,company.timezone,calendar.name
      into v_business_name,v_zone,v_calendar_name
    from public.businesses company
    join public.resources calendar on calendar.id=v_booking.resource_id
    where company.id=v_booking.business_id;
    insert into public.notification_jobs(booking_id,user_id,send_at,title,body,kind,target_route,type)
      values(v_booking.id,v_booking.customer_id,now(),
        case when p_status='confirmed' then 'Programare confirmată' else 'Programare respinsă' end,
        v_business_name||' · '||to_char(v_booking.start_at at time zone v_zone,'DD.MM.YYYY HH24:MI')
          ||' · Serviciu: '||v_calendar_name,
        'status_update','/customer/notifications','client');
  end if;
end;
$$;

revoke all on function public.set_booking_status(uuid,public.booking_status) from public,anon;
grant execute on function public.set_booking_status(uuid,public.booking_status) to authenticated;

commit;
