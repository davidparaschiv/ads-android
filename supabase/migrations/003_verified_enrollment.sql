-- Apply after 001 and 002. No client can create a business before enrollment approval.
create table private.platform_settings (
  singleton boolean primary key default true check(singleton),
  owner_email text not null default 'davidnicolaparaschiv@gmail.com'
    check(owner_email='davidnicolaparaschiv@gmail.com'),
  owner_user_id uuid references auth.users(id),
  developer_bypass_enabled boolean not null default true,
  developer_key_hash text not null default encode(sha256(convert_to('dev112233','UTF8')),'hex'),
  sms_daily_limit integer not null default 100 check(sms_daily_limit between 1 and 10000)
);
insert into private.platform_settings default values;
alter table private.platform_settings enable row level security;

create function private.is_platform_owner()
returns boolean language sql stable security definer set search_path='' as $$
  select exists(select 1 from private.platform_settings s
    where s.owner_email=private.verified_google_email()
      and (s.owner_user_id is null or s.owner_user_id=auth.uid()));
$$;

create table private.developer_grants (
  user_id uuid primary key references auth.users(id),
  expires_at timestamptz not null
);
alter table private.developer_grants enable row level security;
alter function private.owner_access(uuid) rename to owner_access_base;
create function private.owner_access(p_owner uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_expiry timestamptz; v_base jsonb;
begin
  v_base:=private.owner_access_base(p_owner);
  select g.expires_at into v_expiry from private.developer_grants g
    join private.platform_settings s on s.owner_user_id=g.user_id
    join auth.users u on u.id=g.user_id
    where g.user_id=p_owner and s.developer_bypass_enabled and g.expires_at>now()
      and lower(btrim(u.email))=s.owner_email and u.email_confirmed_at is not null
      and exists(select 1 from auth.identities i where i.user_id=u.id and i.provider='google');
  if v_expiry is not null and ((v_base->>'calendarLimit')::integer<5 or coalesce((v_base->>'expiresAt')::timestamptz,'-infinity')<v_expiry) then
    return jsonb_build_object('active',true,'source','developer','planId','large','calendarLimit',5,'expiresAt',v_expiry,'serverTime',now());
  end if;
  return v_base;
end;
$$;

alter function public.redeem_license(text) rename to redeem_standard_license;
revoke all on function public.redeem_standard_license(text) from public,anon,authenticated;
create function public.redeem_license(p_key text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare s private.platform_settings%rowtype; v_expiry timestamptz;
begin
  select * into s from private.platform_settings where singleton;
  if encode(sha256(convert_to(btrim(p_key),'UTF8')),'hex') is distinct from s.developer_key_hash then
    return public.redeem_standard_license(p_key);
  end if;
  if not private.take_attempt('license',5) then return jsonb_build_object('ok',false,'message','Prea multe încercări. Reîncearcă peste 15 minute.'); end if;
  select * into s from private.platform_settings where singleton for update;
  if not s.developer_bypass_enabled or not private.is_platform_owner() then
    return jsonb_build_object('ok',false,'message','Licență invalidă.');
  end if;
  update private.platform_settings set owner_user_id=auth.uid() where singleton and owner_user_id is null;
  v_expiry:=now()+interval '30 days';
  insert into private.developer_grants(user_id,expires_at) values(auth.uid(),v_expiry)
    on conflict(user_id) do update set expires_at=excluded.expires_at;
  return jsonb_build_object('ok',true,'scheduled',false,'startsAt',now(),'expiresAt',v_expiry,'calendarLimit',5,'access',private.owner_access(auth.uid()));
end;
$$;
revoke all on function public.redeem_license(text) from public,anon,authenticated;
grant execute on function public.redeem_license(text) to authenticated;

alter table public.businesses add column cui text;
alter table public.businesses add column contact_email text;
alter table public.businesses add column contact_email_verified_at timestamptz;
alter table public.businesses add column phone_verified_at timestamptz;
alter table public.businesses add column approved_at timestamptz;
alter table public.businesses add column approved_by uuid references auth.users(id);
create unique index businesses_cui_unique on public.businesses(cui) where cui is not null;
-- Existing businesses are retained, not silently declared verified. New rows use the approval function only.
revoke update(phone) on public.businesses from authenticated;

create table private.enrollment_requests (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id),
  name text not null, category text not null, address text not null,
  cui text not null, contact_email text not null, phone text not null,
  email_verified_at timestamptz, phone_verified_at timestamptz,
  sms_sid text, sms_last_sent_at timestamptz,
  status text not null default 'pending' check(status in ('pending','approved','rejected','superseded')),
  business_id uuid references public.businesses(id),
  created_at timestamptz not null default now(), expires_at timestamptz not null default now()+interval '7 days'
);
alter table private.enrollment_requests enable row level security;
create index enrollment_owner_idx on private.enrollment_requests(owner_id,created_at desc);
create table private.enrollment_links (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references private.enrollment_requests(id) on delete cascade,
  kind text not null check(kind in ('email','approval')),
  token_hash text not null unique, expires_at timestamptz not null default now()+interval '24 hours',
  used_at timestamptz
);
alter table private.enrollment_links enable row level security;
create table private.sms_budgets (
  bucket text not null, day date not null default current_date, attempts integer not null,
  primary key(bucket,day)
);
alter table private.sms_budgets enable row level security;

-- The old create endpoint must not remain a bypass, even in an old installed APK.
create or replace function public.create_business(p_name text,p_category text,p_address text,p_phone text default '')
returns public.businesses language plpgsql security definer set search_path='' as $$
begin raise exception 'Înscrierea necesită verificare e-mail, SMS și aprobarea administratorului.'; end;
$$;

create function public.start_enrollment(p_name text,p_category text,p_address text,p_cui text,p_email text,p_phone text)
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
  if exists(select 1 from public.businesses where cui=v_cui) then raise exception 'CUI deja înregistrat'; end if;
  update private.enrollment_requests set status='superseded' where owner_id=auth.uid() and status='pending';
  insert into private.enrollment_requests(owner_id,name,category,address,cui,contact_email,phone)
    values(auth.uid(),btrim(p_name),btrim(p_category),btrim(p_address),v_cui,v_email,v_phone) returning id into v_id;
  return jsonb_build_object('ok',true,'id',v_id);
end;
$$;

create function public.get_enrollment_status()
returns jsonb language sql stable security definer set search_path='' as $$
  select jsonb_build_object('id',r.id,'name',r.name,'cui',r.cui,'email',r.contact_email,'phone',r.phone,
    'emailVerified',r.email_verified_at is not null,'phoneVerified',r.phone_verified_at is not null,
    'status',case when r.status='pending' and r.expires_at<=now() then 'expired' else r.status end,
    'businessId',r.business_id,'expiresAt',r.expires_at)
    from private.enrollment_requests r where r.owner_id=auth.uid() order by r.created_at desc,r.id limit 1;
$$;

create function public.enrollment_sms_context(p_request_id uuid,p_check boolean)
returns jsonb language plpgsql security definer set search_path='' as $$
declare r private.enrollment_requests%rowtype; v_count integer; v_limit integer;
begin
  if private.verified_google_email() is null then raise exception 'Cont Google verificat necesar'; end if;
  if not private.take_attempt(case when p_check then 'sms_check' else 'sms_send' end,case when p_check then 8 else 3 end) then
    return jsonb_build_object('ok',false,'message','Prea multe încercări. Reîncearcă peste 15 minute.'); end if;
  select * into r from private.enrollment_requests where id=p_request_id and owner_id=auth.uid() for update;
  if not found or r.status<>'pending' or r.expires_at<=now() then raise exception 'Cerere indisponibilă'; end if;
  if r.email_verified_at is null then raise exception 'Confirmă mai întâi adresa de e-mail'; end if;
  if r.phone_verified_at is not null then return jsonb_build_object('ok',true,'verified',true); end if;
  if not p_check then
    if r.sms_last_sent_at>now()-interval '60 seconds' then return jsonb_build_object('ok',false,'message','Așteaptă 60 de secunde înainte de retrimitere.'); end if;
    select sms_daily_limit into v_limit from private.platform_settings where singleton;
    insert into private.sms_budgets(bucket,attempts) values('global',1) on conflict(bucket,day) do update set attempts=private.sms_budgets.attempts+1 returning attempts into v_count;
    if v_count>v_limit then return jsonb_build_object('ok',false,'message','Limita zilnică SMS a fost atinsă.'); end if;
    insert into private.sms_budgets(bucket,attempts) values(encode(sha256(convert_to(r.phone,'UTF8')),'hex'),1)
      on conflict(bucket,day) do update set attempts=private.sms_budgets.attempts+1 returning attempts into v_count;
    if v_count>5 then return jsonb_build_object('ok',false,'message','Limita zilnică pentru acest telefon a fost atinsă.'); end if;
    update private.enrollment_requests set sms_last_sent_at=now(),sms_sid=null where id=r.id;
  end if;
  return jsonb_build_object('ok',true,'phone',r.phone,'sid',r.sms_sid);
end;
$$;

create function public.enrollment_record_sms(p_request_id uuid,p_owner uuid,p_sid text,p_verified boolean)
returns boolean language plpgsql security definer set search_path='' as $$
begin
  if p_sid is null or p_sid !~ '^VE[0-9a-fA-F]{32}$' then return false; end if;
  if p_verified then
    update private.enrollment_requests set phone_verified_at=now() where id=p_request_id and owner_id=p_owner
      and status='pending' and expires_at>now() and sms_sid=p_sid;
  else
    update private.enrollment_requests set sms_sid=p_sid where id=p_request_id and owner_id=p_owner
      and status='pending' and expires_at>now() and phone_verified_at is null;
  end if;
  return found;
end;
$$;

-- Service role issues and emails these tokens; the mobile client cannot override recipients.
create function public.issue_enrollment_link(p_request_id uuid,p_owner uuid,p_kind text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare r private.enrollment_requests%rowtype; v_token text; v_email text; v_count integer;
begin
  select * into r from private.enrollment_requests where id=p_request_id and owner_id=p_owner for update;
  if not found or r.status<>'pending' or r.expires_at<=now() then return jsonb_build_object('ok',false); end if;
  select count(*) into v_count from private.enrollment_links where request_id=r.id and kind=p_kind and expires_at>now()+interval '23 hours';
  if v_count>=3 then return jsonb_build_object('ok',false,'message','Prea multe linkuri. Reîncearcă într-o oră.'); end if;
  if p_kind='approval' then
    if r.email_verified_at is null or r.phone_verified_at is null then return jsonb_build_object('ok',false); end if;
    select owner_email into v_email from private.platform_settings where singleton;
  elsif p_kind='email' and r.email_verified_at is null then v_email:=r.contact_email;
  else return jsonb_build_object('ok',false); end if;
  update private.enrollment_links set used_at=now() where request_id=r.id and kind=p_kind and used_at is null;
  v_token:=case when p_kind='email' then 'RZE-' else 'RZA-' end||upper(replace(gen_random_uuid()::text||gen_random_uuid()::text,'-',''));
  insert into private.enrollment_links(request_id,kind,token_hash)
    values(r.id,p_kind,encode(sha256(convert_to(v_token,'UTF8')),'hex'));
  return jsonb_build_object('ok',true,'token',v_token,'recipient',v_email,'name',r.name,
    'category',r.category,'address',r.address,'cui',r.cui,'phone',r.phone,'email',r.contact_email);
end;
$$;

create function public.enrollment_link_details(p_token text)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare r private.enrollment_requests%rowtype; l private.enrollment_links%rowtype;
begin
  if p_token is null or p_token !~ '^RZ[EA]-[A-F0-9]{64}$' then raise exception 'Link indisponibil'; end if;
  select * into l from private.enrollment_links where token_hash=encode(sha256(convert_to(p_token,'UTF8')),'hex');
  if not found or l.used_at is not null or l.expires_at<=now() then raise exception 'Link indisponibil sau expirat'; end if;
  select * into r from private.enrollment_requests where id=l.request_id;
  if r.status<>'pending' or r.expires_at<=now() or private.verified_google_email() is null
    or (l.kind='email' and r.owner_id<>auth.uid()) or (l.kind='approval' and not private.is_platform_owner()) then raise exception 'Acces interzis'; end if;
  return jsonb_build_object('id',r.id,'kind',l.kind,'name',r.name,'cui',r.cui,'phone',r.phone,'email',r.contact_email,'address',r.address);
end;
$$;

create function public.confirm_enrollment_link(p_token text,p_approve boolean default true)
returns jsonb language plpgsql security definer set search_path='' as $$
declare l private.enrollment_links%rowtype; r private.enrollment_requests%rowtype; v_business uuid; v_owner uuid;
begin
  if not private.take_attempt('enrollment_confirm',8) then return jsonb_build_object('ok',false,'message','Prea multe încercări. Reîncearcă peste 15 minute.'); end if;
  begin
  -- Resolve token first, then lock the account and request consistently with start_enrollment.
  select * into l from private.enrollment_links where token_hash=encode(sha256(convert_to(p_token,'UTF8')),'hex');
  select owner_id into v_owner from private.enrollment_requests where id=l.request_id;
  perform 1 from auth.users where id=v_owner for update;
  select * into r from private.enrollment_requests where id=l.request_id for update;
  select * into l from private.enrollment_links where id=l.id for update;
  perform public.enrollment_link_details(p_token);
  if l.kind='email' then
    update private.enrollment_requests set email_verified_at=now() where id=r.id;
  else
    perform 1 from private.platform_settings where singleton for update;
    if not private.is_platform_owner() or r.email_verified_at is null or r.phone_verified_at is null then raise exception 'Verificări incomplete'; end if;
    update private.platform_settings set owner_user_id=auth.uid() where singleton and owner_user_id is null;
    if not p_approve then
      update private.enrollment_requests set status='rejected' where id=r.id;
    else
      insert into public.businesses(owner_id,name,category,address,phone,cui,contact_email,contact_email_verified_at,phone_verified_at,approved_at,approved_by)
        values(r.owner_id,r.name,r.category,r.address,r.phone,r.cui,r.contact_email,r.email_verified_at,r.phone_verified_at,now(),auth.uid()) returning id into v_business;
      update private.enrollment_requests set status='approved',business_id=v_business where id=r.id;
    end if;
  end if;
  update private.enrollment_links set used_at=now() where id=l.id;
  return jsonb_build_object('ok',true,'kind',l.kind,'requestId',r.id,'businessId',v_business,'approved',p_approve);
  exception when others then
    -- Keep the attempt counter outside this rollback scope; never disclose another request.
    return jsonb_build_object('ok',false,'message','Link indisponibil pentru acest cont, verificări incomplete sau date deja înregistrate.');
  end;
end;
$$;

-- Explicit allowlist: no public/service helper can be called anonymously.
revoke all on all tables in schema private from public,anon,authenticated;
revoke all on all functions in schema private from public,anon,authenticated;
revoke all on function public.start_enrollment(text,text,text,text,text,text),public.get_enrollment_status(),
  public.enrollment_sms_context(uuid,boolean),public.enrollment_record_sms(uuid,uuid,text,boolean),
  public.issue_enrollment_link(uuid,uuid,text),public.enrollment_link_details(text),public.confirm_enrollment_link(text,boolean)
  from public,anon,authenticated;
grant execute on function public.start_enrollment(text,text,text,text,text,text),public.get_enrollment_status(),
  public.enrollment_sms_context(uuid,boolean),public.enrollment_link_details(text),public.confirm_enrollment_link(text,boolean) to authenticated;
grant execute on function public.enrollment_record_sms(uuid,uuid,text,boolean),public.issue_enrollment_link(uuid,uuid,text) to service_role;
