-- Invited members receive full operational calendar access, every member can
-- see the team, and one normalized Romanian phone can identify one business.
-- Billing, licenses, invitations and member removal remain owner-only.

begin;

create or replace function private.normalize_ro_phone(p_phone text)
returns text language sql immutable set search_path='' as $$
  select case
    when regexp_replace(coalesce(p_phone,''),'[ ()-]','','g') ~ '^07[0-9]{8}$'
      then '+40'||substr(regexp_replace(p_phone,'[ ()-]','','g'),2)
    when regexp_replace(coalesce(p_phone,''),'[ ()-]','','g') ~ '^\+407[0-9]{8}$'
      then regexp_replace(p_phone,'[ ()-]','','g')
    else null
  end
$$;
revoke all on function private.normalize_ro_phone(text) from public,anon,authenticated;

update public.businesses set phone=private.normalize_ro_phone(phone)
  where private.normalize_ro_phone(phone) is not null and phone<>private.normalize_ro_phone(phone);
update private.enrollment_requests set phone=private.normalize_ro_phone(phone)
  where private.normalize_ro_phone(phone) is not null and phone<>private.normalize_ro_phone(phone);

do $$
begin
  if exists(select 1 from public.businesses where private.normalize_ro_phone(phone) is not null
    group by private.normalize_ro_phone(phone) having count(*)>1) then
    raise exception 'Există deja afaceri cu același număr de telefon. Corectează duplicatele înainte de migrarea 020.';
  end if;
end;
$$;

update private.enrollment_requests r set status='superseded'
where r.status='pending' and exists(select 1 from public.businesses b
  where private.normalize_ro_phone(b.phone)=private.normalize_ro_phone(r.phone));

with ranked as (
  select id,row_number() over(partition by private.normalize_ro_phone(phone) order by created_at desc,id desc) position
  from private.enrollment_requests
  where status='pending' and private.normalize_ro_phone(phone) is not null
)
update private.enrollment_requests r set status='superseded'
from ranked d where r.id=d.id and d.position>1;

create unique index if not exists businesses_normalized_phone_unique
  on public.businesses((private.normalize_ro_phone(phone)))
  where private.normalize_ro_phone(phone) is not null;
create unique index if not exists enrollment_pending_normalized_phone_unique
  on private.enrollment_requests((private.normalize_ro_phone(phone)))
  where status='pending' and private.normalize_ro_phone(phone) is not null;

create or replace function public.start_enrollment(p_name text,p_category text,p_address text,p_cui text,p_phone text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_id uuid; v_phone text; v_cui text; v_email text;
begin
  v_email:=private.verified_google_email();
  if v_email is null then raise exception 'Cont Google verificat necesar'; end if;
  if not private.take_attempt('enrollment_start',3) then return jsonb_build_object('ok',false,'message','Prea multe cereri. Reîncearcă peste 15 minute.'); end if;
  perform 1 from auth.users where id=auth.uid() for update;
  if exists(select 1 from public.businesses where owner_id=auth.uid()) then raise exception 'Ai deja o afacere'; end if;
  v_phone:=private.normalize_ro_phone(p_phone);
  v_cui:=regexp_replace(upper(btrim(coalesce(p_cui,''))),'^RO[ ]*','');
  v_email:=lower(btrim(v_email));
  if coalesce(length(btrim(p_name)),0) not between 2 and 80 or coalesce(length(btrim(p_category)),0) not between 2 and 80
    or coalesce(length(btrim(p_address)),0) not between 2 and 160 or v_phone is null
    or v_cui !~ '^[1-9][0-9]{1,9}$' or length(v_email)>254
    then raise exception 'Completează corect CUI și un număr mobil românesc'; end if;
  update private.enrollment_requests set status='superseded' where owner_id=auth.uid() and status='pending';
  if exists(select 1 from public.businesses where cui=v_cui)
    or exists(select 1 from private.enrollment_requests where cui=v_cui and status='pending') then
    raise exception 'Există deja o afacere sau o cerere activă cu acest CUI';
  end if;
  if exists(select 1 from public.businesses where private.normalize_ro_phone(phone)=v_phone)
    or exists(select 1 from private.enrollment_requests where status='pending'
      and private.normalize_ro_phone(phone)=v_phone) then
    raise exception 'Numărul de telefon este deja folosit pentru o afacere sau o cerere activă';
  end if;
  begin
    insert into private.enrollment_requests(owner_id,name,category,address,cui,contact_email,phone)
      values(auth.uid(),btrim(p_name),btrim(p_category),btrim(p_address),v_cui,v_email,v_phone) returning id into v_id;
  exception when unique_violation then
    if exists(select 1 from public.businesses where cui=v_cui)
      or exists(select 1 from private.enrollment_requests where cui=v_cui and status='pending') then
      raise exception 'Există deja o afacere sau o cerere activă cu acest CUI';
    end if;
    raise exception 'Numărul de telefon este deja folosit pentru o afacere sau o cerere activă';
  end;
  return jsonb_build_object('ok',true,'id',v_id);
end;
$$;

update public.calendar_members set permission='manager' where permission<>'manager';
update private.calendar_invitations set permission='manager' where permission<>'manager' and status in ('pending','sent');

create or replace function public.can_manage_calendar(p_calendar uuid)
returns boolean language sql stable security definer set search_path='' as $$
  select exists(select 1 from public.resources r join public.businesses b on b.id=r.business_id
    cross join lateral private.owner_access(b.owner_id) a
    where r.id=p_calendar and (a->>'active')::boolean and (
      b.owner_id=auth.uid() or (a->>'planId'='large' and exists(select 1 from public.calendar_members m
        where m.calendar_id=r.id and m.user_id=auth.uid()))))
$$;

create or replace function public.list_team(p_business_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_owner boolean;
begin
  if not public.is_business_member(p_business_id) or not public.business_has_active_access(p_business_id)
    then raise exception 'Acces interzis'; end if;
  select owner_id=auth.uid() into v_owner from public.businesses where id=p_business_id;
  return jsonb_build_object(
    'members',coalesce((select jsonb_agg(jsonb_build_object('userId',m.user_id,'email',u.email,'role',m.role,
      'permission','manager') order by case when m.role='owner' then 0 else 1 end,u.email)
      from public.business_members m join auth.users u on u.id=m.user_id where m.business_id=p_business_id),'[]'::jsonb),
    'invitations',case when v_owner then coalesce((select jsonb_agg(jsonb_build_object('id',i.id,'email',i.invited_email,
      'permission','manager','status',i.status,'expiresAt',i.expires_at) order by i.created_at desc)
      from private.calendar_invitations i where i.business_id=p_business_id),'[]'::jsonb) else '[]'::jsonb end);
end;
$$;

create or replace function public.add_calendar(p_business_id uuid,p_name text)
returns public.resources language plpgsql security definer set search_path='' as $$
declare v_resource public.resources%rowtype; v_location uuid;
begin
  if not public.is_business_member(p_business_id) then raise exception 'Acces interzis'; end if;
  if length(btrim(p_name)) not between 2 and 80 then raise exception 'Nume invalid'; end if;
  perform private.require_business_access(p_business_id);
  select id into v_location from public.locations where business_id=p_business_id order by created_at limit 1;
  insert into public.resources(business_id,location_id,name) values(p_business_id,v_location,btrim(p_name))
    returning * into v_resource;
  insert into public.availability_rules(business_id,resource_id,weekday,start_time,end_time)
    select p_business_id,v_resource.id,a.weekday,a.start_time,a.end_time
    from public.availability_rules a where a.resource_id=(
      select r.id from public.resources r where r.business_id=p_business_id and r.id<>v_resource.id order by r.created_at limit 1);
  return v_resource;
end;
$$;

create or replace function public.delete_calendar(p_business_id uuid,p_calendar_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_resource public.resources%rowtype;
begin
  if auth.uid() is null or not public.is_business_member(p_business_id)
    then raise exception 'Acces interzis'; end if;
  perform private.require_business_access(p_business_id);
  select * into v_resource from public.resources
    where id=p_calendar_id and business_id=p_business_id for update;
  if not found then raise exception 'Calendar indisponibil'; end if;
  if exists(select 1 from public.bookings where resource_id=p_calendar_id) then
    raise exception 'Calendarul nu poate fi șters deoarece are programări';
  end if;
  delete from public.resources where id=p_calendar_id;
  return jsonb_build_object('ok',true);
end;
$$;

revoke all on function public.start_enrollment(text,text,text,text,text),
  public.can_manage_calendar(uuid),public.list_team(uuid),public.add_calendar(uuid,text),
  public.delete_calendar(uuid,uuid) from public,anon;
grant execute on function public.start_enrollment(text,text,text,text,text),
  public.list_team(uuid),public.add_calendar(uuid,text),public.delete_calendar(uuid,uuid) to authenticated;

commit;
