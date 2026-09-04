-- Make the BV Oprit -> activ transition symmetrical and explicit.
-- -1 disables the current member on the selected calendar. Any non-negative
-- configured interval recreates or resets that member's future reminder jobs.

begin;

alter table public.business_notification_preferences
  drop constraint if exists business_notification_preferences_minutes_before_check;
alter table public.business_notification_preferences
  add constraint business_notification_preferences_minutes_before_check
  check(minutes_before=-1 or minutes_before between 0 and 30);

create or replace function private.reschedule_business_reminders_after_save(
  p_calendar uuid,p_user uuid,p_minutes integer
) returns void language plpgsql security definer set search_path='' as $$
declare v_now timestamptz:=now();
begin
  if p_minutes=-1 then
    update public.notification_jobs j set status='cancelled'
    from public.bookings b
    where j.booking_id=b.id and b.resource_id=p_calendar
      and j.user_id=p_user and j.kind='reminder' and j.type='business';
    return;
  end if;

  update public.notification_jobs j set status='cancelled'
  from public.bookings b
  where j.booking_id=b.id and b.resource_id=p_calendar
    and j.user_id=p_user and j.kind='reminder' and j.type='business'
    and (b.status<>'confirmed' or b.start_at<=v_now);

  insert into public.notification_jobs(
    booking_id,user_id,send_at,title,body,kind,target_route,type,status,attempts,last_error
  )
  select b.id,p_user,b.start_at-make_interval(mins=>p_minutes),
    'Programarea începe în '||p_minutes||' minute',
    b.customer_name||' · Serviciu: '||calendar.name,
    'reminder','/business/notifications','business','pending',0,null
  from public.bookings b
  join public.resources calendar on calendar.id=b.resource_id
  where b.resource_id=p_calendar and b.status='confirmed' and b.start_at>v_now
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

commit;
