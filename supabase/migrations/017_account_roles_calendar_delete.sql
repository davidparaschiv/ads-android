-- One account role, server-owned enrollment email, and safe calendar deletion.
begin;

-- Existing dual-role accounts become business-only without deleting their
-- technical profile or historical bookings.
update public.profiles p
set first_name=null,last_name=null,customer_profile_completed_at=null,updated_at=now()
where exists(select 1 from public.business_members m where m.user_id=p.id)
  and (p.first_name is not null or p.last_name is not null or p.customer_profile_completed_at is not null);

create or replace function private.make_account_business_only()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  update public.profiles
    set first_name=null,last_name=null,customer_profile_completed_at=null,updated_at=now()
    where id=new.user_id;
  return new;
end;
$$;
drop trigger if exists business_members_make_account_business_only on public.business_members;
create trigger business_members_make_account_business_only
after insert or update of user_id on public.business_members
for each row execute function private.make_account_business_only();

create or replace function public.get_account_role()
returns text language sql stable security definer set search_path='' as $$
  select case
    when exists(select 1 from public.business_members m where m.user_id=auth.uid()) then 'business'
    when exists(select 1 from public.profiles p where p.id=auth.uid() and p.customer_profile_completed_at is not null) then 'customer'
    else 'unassigned'
  end
$$;

create or replace function public.complete_customer_profile(p_first_name text,p_last_name text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_profile public.profiles%rowtype; v_first text; v_last text;
begin
  if auth.uid() is null then raise exception 'Autentificare necesară'; end if;
  if exists(select 1 from public.business_members where user_id=auth.uid()) then
    raise exception 'Acest cont este asociat unei afaceri și nu poate fi folosit ca profil de client';
  end if;
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

create or replace function private.prevent_business_customer_booking()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if exists(select 1 from public.business_members where user_id=new.customer_id) then
    raise exception 'Conturile de afacere nu pot crea programări ca client';
  end if;
  return new;
end;
$$;
drop trigger if exists bookings_require_customer_only_account on public.bookings;
create trigger bookings_require_customer_only_account
before insert on public.bookings for each row execute function private.prevent_business_customer_booking();

-- Pending requests also follow the authenticated Google address. Any old,
-- unused confirmation code for a different address is invalidated.
update private.enrollment_links l set used_at=coalesce(l.used_at,now())
from private.enrollment_requests r join auth.users u on u.id=r.owner_id
where l.request_id=r.id and l.kind='email' and l.used_at is null and r.status='pending'
  and u.email_confirmed_at is not null
  and exists(select 1 from auth.identities i where i.user_id=u.id and i.provider='google')
  and lower(btrim(r.contact_email)) is distinct from lower(btrim(u.email));

update private.enrollment_requests r
set contact_email=lower(btrim(u.email)),email_verified_at=null
from auth.users u
where u.id=r.owner_id and r.status='pending' and u.email_confirmed_at is not null
  and exists(select 1 from auth.identities i where i.user_id=u.id and i.provider='google')
  and lower(btrim(r.contact_email)) is distinct from lower(btrim(u.email));

create function public.start_enrollment(p_name text,p_category text,p_address text,p_cui text,p_phone text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_id uuid; v_phone text; v_cui text; v_email text;
begin
  v_email:=private.verified_google_email();
  if v_email is null then raise exception 'Cont Google verificat necesar'; end if;
  if not private.take_attempt('enrollment_start',3) then return jsonb_build_object('ok',false,'message','Prea multe cereri. Reîncearcă peste 15 minute.'); end if;
  perform 1 from auth.users where id=auth.uid() for update;
  if exists(select 1 from public.businesses where owner_id=auth.uid()) then raise exception 'Ai deja o afacere'; end if;
  v_phone:=regexp_replace(coalesce(p_phone,''),'[ ()-]','','g');
  if v_phone ~ '^07[0-9]{8}$' then v_phone:='+40'||substr(v_phone,2); end if;
  v_cui:=regexp_replace(upper(btrim(coalesce(p_cui,''))),'^RO[ ]*','');
  v_email:=lower(btrim(v_email));
  if coalesce(length(btrim(p_name)),0) not between 2 and 80 or coalesce(length(btrim(p_category)),0) not between 2 and 80
    or coalesce(length(btrim(p_address)),0) not between 2 and 160 or v_phone !~ '^\+407[0-9]{8}$'
    or v_cui !~ '^[1-9][0-9]{1,9}$' or length(v_email)>254
    then raise exception 'Completează corect CUI și un număr mobil românesc'; end if;
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

revoke all on function public.start_enrollment(text,text,text,text,text,text) from public,anon,authenticated;
drop function public.start_enrollment(text,text,text,text,text,text);
revoke all on function public.get_account_role(),public.complete_customer_profile(text,text),
  public.start_enrollment(text,text,text,text,text) from public,anon;
grant execute on function public.get_account_role(),public.complete_customer_profile(text,text),
  public.start_enrollment(text,text,text,text,text) to authenticated;

create function public.delete_calendar(p_business_id uuid,p_calendar_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_resource public.resources%rowtype;
begin
  if auth.uid() is null or not exists(
    select 1 from public.businesses b where b.id=p_business_id and b.owner_id=auth.uid()
  ) then raise exception 'Doar proprietarul afacerii poate șterge calendare'; end if;
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
revoke all on function public.delete_calendar(uuid,uuid) from public,anon;
grant execute on function public.delete_calendar(uuid,uuid) to authenticated;

commit;
