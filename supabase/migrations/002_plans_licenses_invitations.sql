-- Apply AFTER 001. All client flags are presentation-only. PostgreSQL is the authority.
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
revoke all on all tables in schema private from public, anon, authenticated;
alter default privileges in schema private revoke execute on functions from public;
alter default privileges in schema private revoke all on tables from public, anon, authenticated;

-- Intentionally one owning business per Google account. Resolve any old duplicates
-- before applying this migration; do NOT delete customer records to satisfy it.
create unique index businesses_one_per_owner on public.businesses(owner_id);
alter table public.resources add column archived_at timestamptz;
alter table public.resources add column archive_reason text;

create table private.server_settings (
  singleton boolean primary key default true check(singleton),
  allow_sandbox_payments boolean not null default false
);
insert into private.server_settings default values;

create table private.license_keys (
  id uuid primary key default gen_random_uuid(),
  key_hash text not null unique check(key_hash ~ '^[0-9a-f]{64}$'),
  bound_email text not null check(bound_email = lower(btrim(bound_email)) and length(bound_email) between 3 and 254),
  starts_at timestamptz not null,
  duration_months integer not null check(duration_months between 1 and 120),
  -- UTC calendar months, NOT months after redemption; end-of-month clamps naturally.
  expires_at timestamptz generated always as
    (((starts_at at time zone 'UTC') + make_interval(months => duration_months)) at time zone 'UTC') stored,
  redeemed_by uuid references auth.users(id) on delete restrict,
  redeemed_at timestamptz,
  revoked_at timestamptz,
  note text,
  created_at timestamptz not null default now(),
  check((redeemed_by is null) = (redeemed_at is null))
);
create index licenses_owner_idx on private.license_keys(redeemed_by);
alter table private.license_keys enable row level security;
-- No client policy or grants. Only SQL Editor/database administrator issues keys.

create table private.request_limits (
  user_id uuid not null references auth.users(id) on delete cascade,
  scope text not null,
  window_start timestamptz not null,
  attempts integer not null default 0,
  primary key(user_id, scope, window_start)
);
alter table private.request_limits enable row level security;

create function private.verified_google_email()
returns text language sql stable security definer set search_path = '' as $$
  select lower(btrim(u.email)) from auth.users u
  where u.id = auth.uid() and u.email_confirmed_at is not null
    and exists(select 1 from auth.identities i where i.user_id=u.id and i.provider='google');
$$;

create function private.take_attempt(p_scope text, p_limit integer)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_attempts integer;
begin
  if auth.uid() is null then return false; end if;
  insert into private.request_limits(user_id, scope, window_start, attempts)
  values(auth.uid(), p_scope, date_bin('15 minutes', now(), '2000-01-01'::timestamptz), 1)
  on conflict(user_id, scope, window_start)
  do update set attempts = private.request_limits.attempts + 1
  returning attempts into v_attempts;
  return v_attempts <= p_limit;
end;
$$;

create function private.owner_access(p_owner uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  with candidates as (
    select 'license'::text source, 5 calendar_limit, 'large'::text plan_id, l.expires_at
    from private.license_keys l join auth.users u on u.id=l.redeemed_by
    where l.redeemed_by=p_owner and l.revoked_at is null
      and l.bound_email=lower(btrim(u.email)) and u.email_confirmed_at is not null
      and l.starts_at <= now() and now() < l.expires_at
    union all
    select 'google_play', case s.plan_id when 'small' then 1 when 'large' then 5 else 0 end,
      s.plan_id, s.expires_at
    from public.subscriptions s
    where s.owner_id=p_owner and s.status in ('active','grace','cancelled')
      and s.expires_at > now()
      and (s.environment='production' or
        (s.environment='sandbox' and (select allow_sandbox_payments from private.server_settings)))
  )
  select coalesce(
    (select jsonb_build_object('active',true,'source',source,'planId',plan_id,
      'calendarLimit',calendar_limit,'expiresAt',expires_at,'serverTime',now())
     from candidates where calendar_limit > 0 order by calendar_limit desc, expires_at desc limit 1),
    jsonb_build_object('active',false,'source','none','planId',null,'calendarLimit',0,
      'expiresAt',null,'serverTime',now())
  );
$$;

create or replace function public.is_business_admin(target_business_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  -- Only the actual owner administers billing, invitations, and permissions.
  select exists(select 1 from public.businesses b where b.id=target_business_id and b.owner_id=auth.uid());
$$;

create function public.get_access(p_business_id uuid default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_owner uuid; v_access jsonb; v_count integer;
begin
  if auth.uid() is null then raise exception 'Autentificare necesară'; end if;
  if p_business_id is null then v_owner:=auth.uid();
  else
    if not public.is_business_member(p_business_id) then raise exception 'Acces interzis'; end if;
    select owner_id into v_owner from public.businesses where id=p_business_id;
  end if;
  v_access:=private.owner_access(v_owner);
  select count(*) into v_count from public.resources r join public.businesses b on b.id=r.business_id
    where b.owner_id=v_owner and r.is_active;
  return v_access || jsonb_build_object('activeCalendars',v_count,'isOwner',v_owner=auth.uid(),
    'overLimit',v_count > (v_access->>'calendarLimit')::integer);
end;
$$;

create function public.redeem_license(p_key text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_email text; v_key text; v_row private.license_keys%rowtype;
begin
  v_email:=private.verified_google_email();
  if v_email is null then return jsonb_build_object('ok',false,'message','Autentifică-te cu un cont Google verificat.'); end if;
  if not private.take_attempt('license',5) then
    return jsonb_build_object('ok',false,'message','Prea multe încercări. Reîncearcă peste 15 minute.');
  end if;
  v_key:=upper(btrim(p_key));
  if length(v_key) <> 75 or v_key !~ '^RZL-([A-F0-9]{8}-){7}[A-F0-9]{8}$' then
    return jsonb_build_object('ok',false,'message','Licență invalidă.');
  end if;
  select * into v_row from private.license_keys
    where key_hash=encode(sha256(convert_to(replace(substr(v_key,5),'-',''),'UTF8')),'hex') for update;
  if not found or v_row.bound_email<>v_email or v_row.revoked_at is not null or now()>=v_row.expires_at
    or (v_row.redeemed_by is not null and v_row.redeemed_by<>auth.uid()) then
    return jsonb_build_object('ok',false,'message','Licență invalidă.');
  end if;
  update private.license_keys set redeemed_by=auth.uid(), redeemed_at=coalesce(redeemed_at,now()) where id=v_row.id;
  return jsonb_build_object('ok',true,'startsAt',v_row.starts_at,'expiresAt',v_row.expires_at,
    'scheduled',now()<v_row.starts_at,'calendarLimit',5,'access',private.owner_access(auth.uid()));
end;
$$;

create table public.calendar_members (
  calendar_id uuid not null,
  business_id uuid not null,
  user_id uuid not null,
  permission text not null check(permission in ('viewer','manager')),
  created_at timestamptz not null default now(),
  primary key(calendar_id,user_id),
  foreign key(calendar_id,business_id) references public.resources(id,business_id) on delete cascade,
  foreign key(business_id,user_id) references public.business_members(business_id,user_id) on delete cascade
);
alter table public.calendar_members enable row level security;
create index calendar_members_user_idx on public.calendar_members(user_id,business_id);

create table private.calendar_invitations (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  invited_email text not null,
  calendar_ids uuid[] not null,
  permission text not null check(permission in ('viewer','manager')),
  token_hash text not null unique,
  expires_at timestamptz not null default now()+interval '48 hours',
  status text not null default 'pending' check(status in ('pending','sent','delivery_failed','revoked','accepted')),
  invited_by uuid not null references auth.users(id),
  accepted_by uuid references auth.users(id),
  accepted_at timestamptz,
  created_at timestamptz not null default now()
);
alter table private.calendar_invitations enable row level security;
create index invites_business_idx on private.calendar_invitations(business_id,created_at);

create function public.can_read_calendar(p_calendar uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists(select 1 from public.resources r where r.id=p_calendar and (
    public.is_business_admin(r.business_id) or exists(
      select 1 from public.calendar_members m where m.calendar_id=r.id and m.user_id=auth.uid())));
$$;
create function public.can_manage_calendar(p_calendar uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists(select 1 from public.resources r where r.id=p_calendar and (
    public.is_business_admin(r.business_id) or exists(
      select 1 from public.calendar_members m where m.calendar_id=r.id and m.user_id=auth.uid() and m.permission='manager')));
$$;

create function public.list_my_calendars(p_business_id uuid)
returns setof public.resources language sql stable security definer set search_path = '' as $$
  select r.* from public.resources r where r.business_id=p_business_id and public.can_read_calendar(r.id)
  order by r.created_at,r.id;
$$;

create function public.issue_calendar_invitation(p_business_id uuid,p_email text,p_calendar_ids uuid[],p_permission text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_token text; v_id uuid; v_email text; v_business text;
begin
  if not public.is_business_admin(p_business_id) or private.verified_google_email() is null then raise exception 'Acces interzis'; end if;
  if not private.take_attempt('invite_send',10) then return jsonb_build_object('ok',false,'message','Prea multe invitații. Reîncearcă peste 15 minute.'); end if;
  perform private.require_business_access(p_business_id);
  v_email:=lower(btrim(p_email));
  p_calendar_ids:=array(select distinct c from unnest(p_calendar_ids) c);
  if length(v_email)>254 or v_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' or p_permission not in ('viewer','manager')
    or coalesce(array_length(p_calendar_ids,1),0) not between 1 and 5 then raise exception 'Invitație invalidă'; end if;
  if v_email=private.verified_google_email() then raise exception 'Ai deja acces ca proprietar'; end if;
  if exists(select 1 from unnest(p_calendar_ids) c where not exists(
    select 1 from public.resources r where r.id=c and r.business_id=p_business_id and r.is_active)) then raise exception 'Calendar invalid'; end if;
  update private.calendar_invitations set status='revoked'
    where business_id=p_business_id and invited_email=v_email and status in ('pending','sent');
  v_token:='RZI-'||upper(replace(gen_random_uuid()::text||gen_random_uuid()::text,'-',''));
  insert into private.calendar_invitations(business_id,invited_email,calendar_ids,permission,token_hash,invited_by)
    values(p_business_id,v_email,p_calendar_ids,p_permission,encode(sha256(convert_to(v_token,'UTF8')),'hex'),auth.uid())
    returning id into v_id;
  select name into v_business from public.businesses where id=p_business_id;
  return jsonb_build_object('ok',true,'id',v_id,'token',v_token,'email',v_email,'businessName',v_business);
end;
$$;

create function public.mark_invitation_delivery(p_id uuid,p_sent boolean)
returns void language plpgsql security definer set search_path = '' as $$
begin
  -- Service-role only; never exposes the private table to the REST API.
  update private.calendar_invitations set status=case when p_sent then 'sent' else 'delivery_failed' end
    where id=p_id and status='pending';
end;
$$;

create function public.accept_calendar_invitation(p_token text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_email text; v_inv private.calendar_invitations%rowtype; v_business uuid;
begin
  v_email:=private.verified_google_email();
  if v_email is null then return jsonb_build_object('ok',false,'message','Autentifică-te cu adresa Google invitată.'); end if;
  if not private.take_attempt('invite_accept',5) then return jsonb_build_object('ok',false,'message','Prea multe încercări. Reîncearcă peste 15 minute.'); end if;
  if length(btrim(p_token))<>68 or upper(btrim(p_token)) !~ '^RZI-[A-F0-9]{64}$' then
    return jsonb_build_object('ok',false,'message','Invitație indisponibilă pentru acest cont.');
  end if;
  -- Lock business before invitation, same order as issuing/resending/removing access.
  select business_id into v_business from private.calendar_invitations
    where token_hash=encode(sha256(convert_to(upper(btrim(p_token)),'UTF8')),'hex');
  perform 1 from public.businesses where id=v_business for update;
  select * into v_inv from private.calendar_invitations
    where token_hash=encode(sha256(convert_to(upper(btrim(p_token)),'UTF8')),'hex') for update;
  if not found or v_inv.invited_email<>v_email or v_inv.expires_at<=now() or v_inv.status not in ('pending','sent') then
    return jsonb_build_object('ok',false,'message','Invitație indisponibilă pentru acest cont.');
  end if;
  if not (private.owner_access((select owner_id from public.businesses where id=v_inv.business_id))->>'active')::boolean then
    return jsonb_build_object('ok',false,'message','Proprietarul trebuie să activeze abonamentul.');
  end if;
  if exists(select 1 from unnest(v_inv.calendar_ids) c where not exists(
    select 1 from public.resources r where r.id=c and r.business_id=v_inv.business_id and r.is_active)) then
    return jsonb_build_object('ok',false,'message','Calendarele invitației s-au schimbat. Cere o invitație nouă.');
  end if;
  insert into public.business_members(business_id,user_id,role) values(v_inv.business_id,auth.uid(),'staff')
    on conflict(business_id,user_id) do nothing;
  insert into public.calendar_members(calendar_id,business_id,user_id,permission)
    select c,v_inv.business_id,auth.uid(),v_inv.permission from unnest(v_inv.calendar_ids) c
    on conflict(calendar_id,user_id) do update set permission=excluded.permission;
  update private.calendar_invitations set status='accepted',accepted_by=auth.uid(),accepted_at=now() where id=v_inv.id;
  return jsonb_build_object('ok',true,'businessId',v_inv.business_id);
end;
$$;

create function public.list_team(p_business_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_business_admin(p_business_id) then raise exception 'Acces interzis'; end if;
  return jsonb_build_object(
    'members',coalesce((select jsonb_agg(jsonb_build_object('userId',m.user_id,'email',u.email,'role',m.role,
      'calendars',coalesce((select jsonb_agg(jsonb_build_object('id',c.calendar_id,'permission',c.permission))
        from public.calendar_members c where c.business_id=p_business_id and c.user_id=m.user_id),'[]'::jsonb)))
      from public.business_members m join auth.users u on u.id=m.user_id where m.business_id=p_business_id),'[]'::jsonb),
    'invitations',coalesce((select jsonb_agg(jsonb_build_object('id',i.id,'email',i.invited_email,
      'calendarIds',i.calendar_ids,'permission',i.permission,'status',i.status,'expiresAt',i.expires_at))
      from private.calendar_invitations i where i.business_id=p_business_id),'[]'::jsonb));
end;
$$;

create function public.revoke_invitation(p_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v_business uuid;
begin
  select business_id into v_business from private.calendar_invitations where id=p_id;
  if not public.is_business_admin(v_business) then raise exception 'Acces interzis'; end if;
  perform 1 from public.businesses where id=v_business for update;
  update private.calendar_invitations set status='revoked' where id=p_id and status in ('pending','sent','delivery_failed');
end;
$$;

create function public.set_member_access(p_business_id uuid,p_user_id uuid,p_calendar_ids uuid[],p_permission text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_business_admin(p_business_id) or p_user_id=auth.uid() then raise exception 'Acces interzis'; end if;
  perform 1 from public.businesses where id=p_business_id for update;
  p_calendar_ids:=array(select distinct c from unnest(p_calendar_ids) c);
  if not exists(select 1 from public.business_members where business_id=p_business_id and user_id=p_user_id)
    or p_permission not in ('viewer','manager') or coalesce(array_length(p_calendar_ids,1),0)>5 then raise exception 'Acces invalid'; end if;
  if coalesce(array_length(p_calendar_ids,1),0)>0 then perform private.require_business_access(p_business_id); end if;
  if exists(select 1 from unnest(p_calendar_ids) c where not exists(
    select 1 from public.resources r where r.id=c and r.business_id=p_business_id)) then raise exception 'Calendar invalid'; end if;
  delete from public.calendar_members where business_id=p_business_id and user_id=p_user_id;
  if coalesce(array_length(p_calendar_ids,1),0)=0 then
    -- Also revoke outstanding links so a removed member cannot reaccept an old invitation.
    update private.calendar_invitations set status='revoked' where business_id=p_business_id
      and invited_email=(select lower(btrim(email)) from auth.users where id=p_user_id) and status in ('pending','sent');
    delete from public.business_members where business_id=p_business_id and user_id=p_user_id;
  else
    insert into public.calendar_members(calendar_id,business_id,user_id,permission)
      select c,p_business_id,p_user_id,p_permission from unnest(p_calendar_ids) c;
  end if;
  update public.notification_jobs j set status='cancelled' from public.bookings b
    where j.booking_id=b.id and j.user_id=p_user_id and b.business_id=p_business_id and j.status='pending'
      and not exists(select 1 from public.calendar_members m where m.calendar_id=b.resource_id and m.user_id=p_user_id);
end;
$$;

create function public.get_my_workspaces()
returns table(id uuid, name text, category text, address text, owner_id uuid, is_owner boolean)
language sql stable security definer set search_path = '' as $$
  select b.id,b.name,b.category,b.address,b.owner_id,b.owner_id=auth.uid()
  from public.businesses b join public.business_members m on m.business_id=b.id
  where m.user_id=auth.uid() order by b.created_at;
$$;

create function public.create_business(p_name text,p_category text,p_address text,p_phone text default '')
returns public.businesses language plpgsql security definer set search_path = '' as $$
declare v_business public.businesses%rowtype;
begin
  if private.verified_google_email() is null then raise exception 'Cont Google verificat necesar'; end if;
  select * into v_business from public.businesses where owner_id=auth.uid();
  if found then return v_business; end if;
  insert into public.businesses(owner_id,name,category,address,phone)
    values(auth.uid(),btrim(p_name),p_category,p_address,p_phone) returning * into v_business;
  return v_business;
end;
$$;

create function private.require_business_access(p_business uuid)
returns integer language plpgsql security definer set search_path = '' as $$
declare v_owner uuid; v_access jsonb;
begin
  -- Serializes calendar creates, reactivations and plan-limit reconciliation.
  select owner_id into v_owner from public.businesses where id=p_business for update;
  if not found then raise exception 'Afacere inexistentă'; end if;
  v_access:=private.owner_access(v_owner);
  if not (v_access->>'active')::boolean then raise exception 'Abonamentul a expirat. Activează un plan.'; end if;
  return (v_access->>'calendarLimit')::integer;
end;
$$;

create function private.enforce_resource_limit()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_limit integer; v_count integer;
begin
  if tg_op='UPDATE' and (new.id<>old.id or new.business_id<>old.business_id) then raise exception 'Calendarul nu poate fi transferat'; end if;
  if new.is_active then
    v_limit:=private.require_business_access(new.business_id);
    select count(*) into v_count from public.resources where business_id=new.business_id and is_active and id<>new.id;
    if v_count>=v_limit then raise exception 'Limita planului este de % calendare.',v_limit; end if;
    new.archived_at:=null; new.archive_reason:=null;
  else
    new.archived_at:=coalesce(new.archived_at,now());
  end if;
  return new;
end;
$$;
create trigger enforce_calendar_count before insert or update on public.resources
  for each row execute function private.enforce_resource_limit();

create function public.set_calendar_active(p_calendar_id uuid,p_active boolean)
returns void language plpgsql security definer set search_path = '' as $$
declare v_business uuid;
begin
  select business_id into v_business from public.resources where id=p_calendar_id;
  if not public.is_business_admin(v_business) then raise exception 'Acces interzis'; end if;
  -- Archiving remains available after expiry to allow a safe downgrade; history is retained.
  perform 1 from public.businesses where id=v_business for update;
  update public.resources set is_active=p_active,
    archive_reason=case when p_active then null else 'owner' end where id=p_calendar_id;
end;
$$;

create function public.add_calendar(p_business_id uuid,p_name text)
returns public.resources language plpgsql security definer set search_path = '' as $$
declare v_resource public.resources%rowtype; v_location uuid;
begin
  if not public.is_business_admin(p_business_id) then raise exception 'Acces interzis'; end if;
  if length(btrim(p_name)) not between 2 and 80 then raise exception 'Nume invalid'; end if;
  perform private.require_business_access(p_business_id);
  select id into v_location from public.locations where business_id=p_business_id order by created_at limit 1;
  insert into public.resources(business_id,location_id,name) values(p_business_id,v_location,btrim(p_name))
    returning * into v_resource;
  -- New calendars inherit the first calendar's weekly availability, editable later.
  insert into public.availability_rules(business_id,resource_id,weekday,start_time,end_time)
    select p_business_id,v_resource.id,a.weekday,a.start_time,a.end_time
    from public.availability_rules a where a.resource_id=(
      select r.id from public.resources r where r.business_id=p_business_id and r.id<>v_resource.id order by r.created_at limit 1);
  return v_resource;
end;
$$;

create or replace function public.setup_business(
  p_business_id uuid,p_service_name text,p_duration_minutes integer,p_price_cents integer,
  p_resource_name text,p_open_time time,p_close_time time,p_weekdays smallint[]
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_location uuid; v_resource uuid; v_event uuid; v_day smallint; v_address text;
begin
  if not public.is_business_admin(p_business_id) then raise exception 'Acces interzis'; end if;
  perform private.require_business_access(p_business_id);
  if exists(select 1 from public.resources where business_id=p_business_id) then raise exception 'Configurarea inițială există deja'; end if;
  if p_open_time>=p_close_time or coalesce(array_length(p_weekdays,1),0)=0 then raise exception 'Program invalid'; end if;
  select address into v_address from public.businesses where id=p_business_id;
  insert into public.locations(business_id,name,address) values(p_business_id,'Locația principală',v_address) returning id into v_location;
  insert into public.resources(business_id,location_id,name) values(p_business_id,v_location,p_resource_name) returning id into v_resource;
  insert into public.event_types(business_id,name,duration_minutes,price_cents)
    values(p_business_id,p_service_name,p_duration_minutes,p_price_cents) returning id into v_event;
  foreach v_day in array p_weekdays loop
    insert into public.availability_rules(business_id,resource_id,weekday,start_time,end_time)
      values(p_business_id,v_resource,v_day,p_open_time,p_close_time);
  end loop;
  return jsonb_build_object('resource_id',v_resource,'event_type_id',v_event);
end;
$$;

create or replace function public.create_booking(
  p_business_id uuid,p_event_type_id uuid,p_resource_id uuid,p_start_at timestamptz,
  p_customer_name text,p_reminder_minutes integer default 60
) returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid; v_duration integer; v_end timestamptz; v_email text; v_name text; v_zone text;
  v_limit integer; v_local timestamp; v_local_end timestamp;
begin
  v_email:=private.verified_google_email();
  if v_email is null then raise exception 'Cont Google verificat necesar'; end if;
  if p_start_at<=now() or p_start_at>now()+interval '1 year' then raise exception 'Dată invalidă'; end if;
  if p_reminder_minutes not between 5 and 10080 then raise exception 'Interval notificare invalid'; end if;
  v_limit:=private.require_business_access(p_business_id);
  if (select count(*) from public.resources where business_id=p_business_id and is_active)>v_limit then
    raise exception 'Afacerea trebuie să selecteze calendarele active pentru planul curent.';
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
  insert into public.bookings(business_id,customer_id,event_type_id,resource_id,start_at,end_at,customer_name,customer_email_snapshot)
    values(p_business_id,auth.uid(),p_event_type_id,p_resource_id,p_start_at,v_end,btrim(p_customer_name),v_email)
    returning id into v_id;
  -- Notifications are scoped by assignment, preferences, and revalidated before delivery.
  insert into public.notification_jobs(booking_id,user_id,send_at,title,body)
    select v_id,recipients.user_id,p_start_at-make_interval(mins=>case when recipients.user_id=auth.uid()
      then p_reminder_minutes else coalesce(p.default_minutes,60) end),
      'Programarea se apropie',v_name || ' · Verifică detaliile în aplicație.'
    from (
      select auth.uid() user_id union select owner_id from public.businesses where id=p_business_id
      union select user_id from public.calendar_members where calendar_id=p_resource_id
    ) recipients left join public.notification_preferences p on p.user_id=recipients.user_id
    where coalesce(p.push_enabled,true);
  return v_id;
end;
$$;

create function public.set_booking_status(p_booking_id uuid,p_status public.booking_status)
returns void language plpgsql security definer set search_path = '' as $$
declare v_booking public.bookings%rowtype;
begin
  select * into v_booking from public.bookings where id=p_booking_id for update;
  if not found or auth.uid() is null then raise exception 'Acces interzis'; end if;
  if v_booking.customer_id=auth.uid() and p_status='cancelled' then null;
  elsif public.can_manage_calendar(v_booking.resource_id) and p_status in ('cancelled','completed','no_show') then
    if p_status<>'cancelled' then perform private.require_business_access(v_booking.business_id); end if;
  else raise exception 'Acces interzis'; end if;
  update public.bookings set status=p_status,updated_at=now() where id=p_booking_id;
  update public.notification_jobs set status='cancelled' where booking_id=p_booking_id and status='pending';
end;
$$;

-- Drop old broad policies; they would otherwise OR with the new calendar-scoped policies.
do $$
declare p record;
begin
  for p in select tablename,policyname from pg_policies where schemaname='public' and tablename in
    ('businesses','business_members','resources','locations','event_types','availability_rules','blocked_periods','bookings','profiles','calendar_members')
  loop execute format('drop policy %I on public.%I',p.policyname,p.tablename); end loop;
end $$;

revoke all on public.businesses,public.business_members,public.resources,public.locations,public.event_types,
  public.availability_rules,public.blocked_periods,public.bookings,public.profiles,public.calendar_members,
  public.subscriptions,public.notification_jobs,public.notification_log from anon,authenticated;
grant select on public.businesses,public.business_members,public.resources,public.locations,public.event_types,
  public.availability_rules,public.blocked_periods,public.bookings,public.profiles,public.calendar_members,
  public.subscriptions,public.notification_jobs,public.notification_log to authenticated;
grant update(display_name) on public.profiles to authenticated;
grant update(name,category,address,phone) on public.businesses to authenticated;
grant update(read_at) on public.notification_log to authenticated;

create policy profiles_self_select_v2 on public.profiles for select to authenticated using(id=auth.uid());
create policy profiles_self_update_v2 on public.profiles for update to authenticated using(id=auth.uid()) with check(id=auth.uid());
create policy business_read_v2 on public.businesses for select to authenticated using(is_active or public.is_business_member(id));
create policy business_update_v2 on public.businesses for update to authenticated using(public.is_business_admin(id)) with check(public.is_business_admin(id));
create policy members_read_v2 on public.business_members for select to authenticated using(user_id=auth.uid() or public.is_business_admin(business_id));
create policy calendar_members_read_v2 on public.calendar_members for select to authenticated using(user_id=auth.uid() or public.is_business_admin(business_id));
create policy resource_metadata_v2 on public.resources for select to authenticated using(is_active or public.can_read_calendar(id));
create policy locations_read_v2 on public.locations for select to authenticated using(is_active or public.is_business_admin(business_id));
create policy events_read_v2 on public.event_types for select to authenticated using(is_active or public.is_business_member(business_id));
create policy availability_read_v2 on public.availability_rules for select to authenticated using(
  exists(select 1 from public.resources r where r.id=resource_id and (r.is_active or public.can_read_calendar(r.id))));
create policy blocks_read_v2 on public.blocked_periods for select to authenticated using(public.can_read_calendar(resource_id));
create policy bookings_read_v2 on public.bookings for select to authenticated using(
  customer_id=auth.uid() or public.can_read_calendar(resource_id));

-- Public functions are allowlisted; no client can mint keys, edit grants, or mark payment active.
revoke all on all functions in schema private from public,anon,authenticated;
do $$
declare f record;
begin
  for f in select p.oid::regprocedure signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname in (
      'get_access','redeem_license','get_my_workspaces','create_business','set_calendar_active','add_calendar',
      'setup_business','create_booking','list_my_calendars','issue_calendar_invitation','mark_invitation_delivery',
      'accept_calendar_invitation','list_team','revoke_invitation','set_member_access','set_booking_status',
      'can_read_calendar','can_manage_calendar','is_business_admin','is_business_member','handle_new_user','add_owner_membership')
  loop execute format('revoke all on function %s from public, anon, authenticated',f.signature); end loop;
end $$;
grant execute on function public.get_access(uuid), public.redeem_license(text),public.get_my_workspaces(),
  public.create_business(text,text,text,text),public.set_calendar_active(uuid,boolean),public.add_calendar(uuid,text),
  public.setup_business(uuid,text,integer,integer,text,time,time,smallint[]),
  public.create_booking(uuid,uuid,uuid,timestamptz,text,integer),public.list_my_calendars(uuid),
  public.issue_calendar_invitation(uuid,text,uuid[],text),public.accept_calendar_invitation(text),
  public.list_team(uuid),public.revoke_invitation(uuid),public.set_member_access(uuid,uuid,uuid[],text),
  public.set_booking_status(uuid,public.booking_status),public.can_read_calendar(uuid),public.can_manage_calendar(uuid),
  public.is_business_admin(uuid),public.is_business_member(uuid) to authenticated;
grant execute on function public.mark_invitation_delivery(uuid,boolean) to service_role;

-- The exposed schema must never be writable by application roles.
revoke create on schema public from public,anon,authenticated;

-- Called only by the authenticated server-side reminder worker, immediately before sending.
create function public.notification_recipient_allowed(p_booking uuid,p_user uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists(select 1 from public.bookings b join public.businesses owner on owner.id=b.business_id
    left join public.notification_preferences pref on pref.user_id=p_user
    where b.id=p_booking and b.status in ('pending','confirmed') and b.start_at>now()
      and coalesce(pref.push_enabled,true)
      and (b.customer_id=p_user or owner.owner_id=p_user or exists(
        select 1 from public.calendar_members m where m.calendar_id=b.resource_id and m.user_id=p_user)));
$$;
revoke all on function public.notification_recipient_allowed(uuid,uuid) from public,anon,authenticated;
grant execute on function public.notification_recipient_allowed(uuid,uuid) to service_role;

-- Availability reveals times only, never another customer's name or email.
create function public.available_slots(p_business_id uuid,p_resource_id uuid,p_event_type_id uuid,p_date date)
returns table(start_at timestamptz,end_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
declare v_minutes integer; v_zone text; v_owner uuid; v_access jsonb;
begin
  if auth.uid() is null or p_date is null or p_date<current_date-1 or p_date>current_date+366 then return; end if;
  select timezone,owner_id into v_zone,v_owner from public.businesses where id=p_business_id and is_active;
  if v_zone is null then return; end if;
  v_access:=private.owner_access(v_owner);
  if not (v_access->>'active')::boolean or
    (select count(*) from public.resources where business_id=p_business_id and is_active)>(v_access->>'calendarLimit')::integer then return; end if;
  if not exists(select 1 from public.resources where id=p_resource_id and business_id=p_business_id and is_active) then return; end if;
  select duration_minutes into v_minutes from public.event_types where id=p_event_type_id and business_id=p_business_id and is_active;
  if v_minutes is null then return; end if;
  return query
    select distinct s.t,s.t+make_interval(mins=>v_minutes)
    from public.availability_rules a cross join lateral generate_series(
      (p_date+a.start_time) at time zone v_zone,
      ((p_date+a.end_time) at time zone v_zone)-make_interval(mins=>v_minutes), interval '15 minutes') s(t)
    where a.business_id=p_business_id and a.resource_id=p_resource_id and a.weekday=extract(isodow from p_date)
      and (a.valid_from is null or a.valid_from<=p_date) and (a.valid_until is null or a.valid_until>=p_date)
      and s.t>now()
      and not exists(select 1 from public.bookings b where b.resource_id=p_resource_id and b.status in ('pending','confirmed')
        and tstzrange(b.start_at,b.end_at,'[)') && tstzrange(s.t,s.t+make_interval(mins=>v_minutes),'[)'))
      and not exists(select 1 from public.blocked_periods b where b.resource_id=p_resource_id
        and tstzrange(b.start_at,b.end_at,'[)') && tstzrange(s.t,s.t+make_interval(mins=>v_minutes),'[)'))
    order by s.t;
end;
$$;
revoke all on function public.available_slots(uuid,uuid,uuid,date) from public,anon,authenticated;
grant execute on function public.available_slots(uuid,uuid,uuid,date) to authenticated;
