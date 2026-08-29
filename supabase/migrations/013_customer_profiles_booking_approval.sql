-- Customer identity, business approval for bookings, durable notification routes,
-- unique active CUI enrollment, and removal of user-controlled calendar archival.
-- Apply after 012, which commits the new booking enum value separately.

begin;

alter table public.profiles
  add column if not exists first_name text,
  add column if not exists last_name text,
  add column if not exists customer_profile_completed_at timestamptz;

alter table public.notification_jobs
  add column if not exists kind text not null default 'reminder'
    check (kind in ('reminder','booking_request','status_update')),
  add column if not exists target_route text not null default '/customer/notifications'
    check (target_route in ('/customer/notifications','/business/notifications'));

create or replace function public.get_customer_profile()
returns jsonb language sql stable security definer set search_path='' as $$
  select jsonb_build_object(
    'firstName',coalesce(first_name,''),
    'lastName',coalesce(last_name,''),
    'completed',customer_profile_completed_at is not null
  ) from public.profiles where id=auth.uid()
$$;

create or replace function public.complete_customer_profile(p_first_name text,p_last_name text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_profile public.profiles%rowtype; v_first text; v_last text;
begin
  if auth.uid() is null then raise exception 'Autentificare necesară'; end if;
  select * into v_profile from public.profiles where id=auth.uid() for update;
  if not found then raise exception 'Profil indisponibil'; end if;
  if v_profile.customer_profile_completed_at is not null then
    return jsonb_build_object('firstName',v_profile.first_name,'lastName',v_profile.last_name,'completed',true);
  end if;
  v_first:=btrim(coalesce(p_first_name,'')); v_last:=btrim(coalesce(p_last_name,''));
  if length(v_first) not between 2 and 50 or length(v_last) not between 2 and 50
    or v_first ~ '[[:cntrl:][:digit:]]' or v_last ~ '[[:cntrl:][:digit:]]' then
    raise exception 'Completează corect prenumele și numele';
  end if;
  update public.profiles set first_name=v_first,last_name=v_last,
    display_name=v_first||' '||v_last,customer_profile_completed_at=now(),updated_at=now()
    where id=auth.uid();
  return jsonb_build_object('firstName',v_first,'lastName',v_last,'completed',true);
end;
$$;
revoke all on function public.get_customer_profile(),public.complete_customer_profile(text,text) from public,anon;
grant execute on function public.get_customer_profile(),public.complete_customer_profile(text,text) to authenticated;

-- Keep one current request per normalized CUI. Existing duplicates are superseded
-- deterministically before the partial unique index is installed.
with ranked as (
  select id,row_number() over(partition by cui order by created_at desc,id desc) position
  from private.enrollment_requests where status='pending'
)
update private.enrollment_requests r set status='superseded'
from ranked d where r.id=d.id and d.position>1;
create unique index if not exists enrollment_pending_cui_unique
  on private.enrollment_requests(cui) where status='pending';

create or replace function public.start_enrollment(p_name text,p_category text,p_address text,p_cui text,p_email text,p_phone text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_id uuid; v_phone text; v_cui text; v_email text;
begin
  if private.verified_google_email() is null then raise exception 'Cont Google verificat necesar'; end if;
  if not private.take_attempt('enrollment_start',3) then return jsonb_build_object('ok',false,'message','Prea multe cereri. Reîncearcă peste 15 minute.'); end if;
  perform 1 from auth.users where id=auth.uid() for update;
  if exists(select 1 from public.businesses where owner_id=auth.uid()) then raise exception 'Ai deja o afacere'; end if;
  v_phone:=regexp_replace(coalesce(p_phone,''),'[ ()-]','','g');
  if v_phone ~ '^07[0-9]{8}$' then v_phone:='+40'||substr(v_phone,2); end if;
  v_cui:=regexp_replace(upper(btrim(coalesce(p_cui,''))),'^RO[ ]*','');
  v_email:=lower(btrim(coalesce(p_email,'')));
  if coalesce(length(btrim(p_name)),0) not between 2 and 80 or coalesce(length(btrim(p_category)),0) not between 2 and 80
    or coalesce(length(btrim(p_address)),0) not between 2 and 160 or v_phone !~ '^\+407[0-9]{8}$'
    or v_cui !~ '^[1-9][0-9]{1,9}$' or length(v_email)>254 or v_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
    then raise exception 'Completează corect CUI, adresa de e-mail și un număr mobil românesc'; end if;
  update private.enrollment_requests set status='superseded' where owner_id=auth.uid() and status='pending';
  if exists(select 1 from public.businesses where cui=v_cui)
    or exists(select 1 from private.enrollment_requests where cui=v_cui and status='pending') then
    raise exception 'Există deja o afacere sau o cerere activă cu acest CUI';
  end if;
  begin
    insert into private.enrollment_requests(owner_id,name,category,address,cui,contact_email,phone)
      values(auth.uid(),btrim(p_name),btrim(p_category),btrim(p_address),v_cui,v_email,v_phone) returning id into v_id;
  exception when unique_violation then
    raise exception 'Există deja o afacere sau o cerere activă cu acest CUI';
  end;
  return jsonb_build_object('ok',true,'id',v_id);
end;
$$;

-- Calendar archival is no longer a product action. Previously archived calendars
-- are restored; if this exceeds the current plan, the owner must upgrade rather
-- than choosing calendars to archive.
alter table public.resources disable trigger enforce_calendar_count;
update public.resources set is_active=true,archived_at=null,archive_reason=null where not is_active;
alter table public.resources enable trigger enforce_calendar_count;
revoke all on function public.set_calendar_active(uuid,boolean) from public,anon,authenticated;
drop function public.set_calendar_active(uuid,boolean);

create or replace function public.create_booking(
  p_business_id uuid,p_event_type_id uuid,p_resource_id uuid,p_start_at timestamptz,
  p_customer_name text,p_reminder_minutes integer default 60
) returns uuid language plpgsql security definer set search_path='' as $$
declare
  v_id uuid; v_duration integer; v_end timestamptz; v_email text; v_name text; v_zone text;
  v_limit integer; v_local timestamp; v_local_end timestamp; v_customer_name text;
begin
  v_email:=private.verified_google_email();
  if v_email is null then raise exception 'Cont Google verificat necesar'; end if;
  select btrim(first_name)||' '||btrim(last_name) into v_customer_name from public.profiles
    where id=auth.uid() and customer_profile_completed_at is not null;
  if v_customer_name is null then raise exception 'Completează prenumele și numele înainte de programare'; end if;
  if p_start_at<=now() or p_start_at>now()+interval '1 year' then raise exception 'Dată invalidă'; end if;
  if p_reminder_minutes not between 5 and 10080 then raise exception 'Interval notificare invalid'; end if;
  v_limit:=private.require_business_access(p_business_id);
  if (select count(*) from public.resources where business_id=p_business_id and is_active)>v_limit then
    raise exception 'Planul afacerii nu acoperă toate calendarele. Proprietarul trebuie să activeze planul Complete.';
  end if;
  select duration_minutes into v_duration from public.event_types
    where id=p_event_type_id and business_id=p_business_id and is_active;
  if v_duration is null or not exists(select 1 from public.resources
    where id=p_resource_id and business_id=p_business_id and is_active) then raise exception 'Serviciu sau calendar invalid'; end if;
  select name,timezone into v_name,v_zone from public.businesses where id=p_business_id and is_active;
  if v_name is null then raise exception 'Afacere indisponibilă'; end if;
  v_end:=p_start_at+make_interval(mins=>v_duration);
  v_local:=p_start_at at time zone v_zone; v_local_end:=v_end at time zone v_zone;
  if v_local::date<>v_local_end::date or not exists(select 1 from public.availability_rules a
    where a.resource_id=p_resource_id and a.business_id=p_business_id
      and a.weekday=extract(isodow from v_local) and a.start_time<=v_local::time and a.end_time>=v_local_end::time
      and (a.valid_from is null or a.valid_from<=v_local::date) and (a.valid_until is null or a.valid_until>=v_local::date))
    then raise exception 'Ora este în afara programului'; end if;
  if exists(select 1 from public.blocked_periods b where b.resource_id=p_resource_id
    and tstzrange(b.start_at,b.end_at,'[)') && tstzrange(p_start_at,v_end,'[)')) then raise exception 'Interval blocat'; end if;
  insert into public.bookings(business_id,customer_id,event_type_id,resource_id,start_at,end_at,
    customer_name,customer_email_snapshot,status)
    values(p_business_id,auth.uid(),p_event_type_id,p_resource_id,p_start_at,v_end,
      v_customer_name,v_email,'pending') returning id into v_id;
  insert into public.notification_preferences(user_id,default_minutes)
    values(auth.uid(),p_reminder_minutes)
    on conflict(user_id) do update set default_minutes=excluded.default_minutes,updated_at=now();
  insert into public.notification_jobs(booking_id,user_id,send_at,title,body,kind,target_route)
    values(v_id,auth.uid(),p_start_at-make_interval(mins=>p_reminder_minutes),
      'Programarea ta se apropie',v_name||' · Verifică detaliile în aplicație.','reminder','/customer/notifications');
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
declare v_booking public.bookings%rowtype; v_business_name text; v_zone text;
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

create or replace function public.notification_job_recipient_allowed(p_job uuid)
returns boolean language sql stable security definer set search_path='' as $$
  select exists(
    select 1 from public.notification_jobs j join public.bookings b on b.id=j.booking_id
    left join public.notification_preferences pref on pref.user_id=j.user_id
    where j.id=p_job and j.status='processing' and coalesce(pref.push_enabled,true)
      and (
        (j.kind='booking_request' and b.status='pending' and b.start_at>now()
          and exists(select 1 from public.business_members m where m.business_id=b.business_id and m.user_id=j.user_id))
        or (j.kind='status_update' and b.customer_id=j.user_id and b.status in ('confirmed','rejected'))
        or (j.kind='reminder' and public.notification_recipient_allowed(b.id,j.user_id))
      )
  )
$$;
revoke all on function public.notification_job_recipient_allowed(uuid) from public,anon,authenticated;
grant execute on function public.notification_job_recipient_allowed(uuid) to service_role;

create or replace function private.filter_plan_reminder()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if new.kind='booking_request' then
    if not exists(select 1 from public.bookings b join public.business_members m on m.business_id=b.business_id
      left join public.notification_preferences pref on pref.user_id=new.user_id
      where b.id=new.booking_id and b.status='pending' and b.start_at>now()
        and m.user_id=new.user_id and coalesce(pref.push_enabled,true)) then return null; end if;
  elsif new.kind='status_update' then
    if not exists(select 1 from public.bookings b left join public.notification_preferences pref on pref.user_id=new.user_id
      where b.id=new.booking_id and b.customer_id=new.user_id and coalesce(pref.push_enabled,true)) then return null; end if;
  elsif not public.notification_recipient_allowed(new.booking_id,new.user_id) then return null;
  end if;
  return new;
end;
$$;

commit;
