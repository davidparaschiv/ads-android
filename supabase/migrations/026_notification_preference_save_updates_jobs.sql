-- Saving CV or BV reminder preferences explicitly updates eligible future
-- notification jobs in the same backend transaction. No sync trigger is used.

begin;

-- Saving from the app calls the public setters below. Keep the flow explicit:
-- preference write -> reminder-job sync, in the same backend transaction.
drop trigger if exists sync_client_preferences_after_write on public.client_notification_preferences;
drop trigger if exists sync_business_preferences_after_write on public.business_notification_preferences;
drop function if exists private.sync_client_preferences_after_write();
drop function if exists private.sync_business_preferences_after_write();

create or replace function private.reschedule_client_reminders_after_save(
  p_user uuid,p_minutes integer,p_enabled boolean
) returns void language plpgsql security definer set search_path='' as $$
declare v_now timestamptz:=now();
begin
  update public.notification_jobs j set status='cancelled',last_error=null
  from public.bookings b
  where j.booking_id=b.id and j.user_id=p_user
    and j.kind='reminder' and j.type='client'
    and b.customer_id=p_user and b.status='confirmed' and b.start_at>v_now
    and (not p_enabled
      or b.start_at-make_interval(mins=>p_minutes)<=v_now+interval '2 minutes');

  if p_enabled then
    insert into public.notification_jobs(
      booking_id,user_id,send_at,title,body,kind,target_route,type
    )
    select b.id,b.customer_id,b.start_at-make_interval(mins=>p_minutes),
      'Programarea ta se apropie',company.name||' · Verifică detaliile în aplicație.',
      'reminder','/customer/notifications','client'
    from public.bookings b
    join public.businesses company on company.id=b.business_id
    where b.customer_id=p_user and b.status='confirmed' and b.start_at>v_now
      and b.start_at-make_interval(mins=>p_minutes)>v_now+interval '2 minutes'
    on conflict(booking_id,user_id,type) where kind='reminder' do update set
      send_at=excluded.send_at,title=excluded.title,body=excluded.body,
      target_route=excluded.target_route,type='client',
      status='pending'::public.notification_status,attempts=0,last_error=null;
  end if;
end;
$$;
revoke all on function private.reschedule_client_reminders_after_save(uuid,integer,boolean)
  from public,anon,authenticated;

create or replace function private.reschedule_business_reminders_after_save(
  p_calendar uuid,p_minutes integer
) returns void language plpgsql security definer set search_path='' as $$
declare v_now timestamptz:=now();
begin
  update public.notification_jobs j set status='cancelled',last_error=null
  from public.bookings b
  where j.booking_id=b.id and b.resource_id=p_calendar
    and j.kind='reminder' and j.type='business'
    and (b.status<>'confirmed' or b.start_at<=v_now
      or b.start_at-make_interval(mins=>p_minutes)<=v_now+interval '2 minutes'
      or not exists(select 1 from public.business_members m
        where m.business_id=b.business_id and m.user_id=j.user_id));

  insert into public.notification_jobs(
    booking_id,user_id,send_at,title,body,kind,target_route,type
  )
  select b.id,m.user_id,b.start_at-make_interval(mins=>p_minutes),
    'Programarea începe în '||p_minutes||' minute',b.customer_name,
    'reminder','/business/notifications','business'
  from public.bookings b
  join public.business_members m on m.business_id=b.business_id
  where b.resource_id=p_calendar and b.status='confirmed' and b.start_at>v_now
    and b.start_at-make_interval(mins=>p_minutes)>v_now+interval '2 minutes'
    and private.business_has_team_features(b.business_id)
  on conflict(booking_id,user_id,type) where kind='reminder' do update set
    send_at=excluded.send_at,title=excluded.title,body=excluded.body,
    target_route=excluded.target_route,type='business',
    status='pending'::public.notification_status,attempts=0,last_error=null;
end;
$$;
revoke all on function private.reschedule_business_reminders_after_save(uuid,integer)
  from public,anon,authenticated;

create or replace function public.set_client_notification_preferences(p_minutes integer,p_enabled boolean)
returns void language plpgsql security definer set search_path='' as $$
begin
  if auth.uid() is null then raise exception 'Autentificare necesară'; end if;
  if p_minutes not between 5 and 10080 then raise exception 'Interval notificare invalid'; end if;
  insert into public.client_notification_preferences(user_id,default_minutes,push_enabled)
    values(auth.uid(),p_minutes,coalesce(p_enabled,true))
    on conflict(user_id) do update set default_minutes=excluded.default_minutes,
      push_enabled=excluded.push_enabled,updated_at=now();
  perform private.reschedule_client_reminders_after_save(auth.uid(),p_minutes,coalesce(p_enabled,true));
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
  perform private.reschedule_business_reminders_after_save(p_calendar_id,p_minutes);
end;
$$;
revoke all on function public.set_calendar_notification_minutes(uuid,integer) from public,anon;
grant execute on function public.set_calendar_notification_minutes(uuid,integer) to authenticated;

commit;
