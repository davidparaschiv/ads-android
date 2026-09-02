-- Complete now grants 10 active calendars. half_complete licenses grant 5.
-- A separate defense-in-depth limit caps all stored calendars per business at 15.
begin;

do $$
begin
  create type private.license_type as enum ('Complete','half_complete');
exception when duplicate_object then null;
end
$$;

alter table private.license_keys
  add column if not exists type private.license_type;
update private.license_keys set type='Complete' where type is null;
alter table private.license_keys
  alter column type set default 'Complete',
  alter column type set not null;

create or replace function private.owner_access_base(p_owner uuid)
returns jsonb language sql stable security definer set search_path='' as $$
  with candidates as (
    select 'license'::text source,
      case l.type when 'Complete' then 10 when 'half_complete' then 5 end calendar_limit,
      'large'::text plan_id,l.expires_at,l.type::text license_type
    from private.license_keys l join auth.users u on u.id=l.redeemed_by
    where l.redeemed_by=p_owner and l.revoked_at is null
      and l.bound_email=lower(btrim(u.email)) and u.email_confirmed_at is not null
      and l.starts_at<=now() and now()<l.expires_at
    union all
    select 'google_play',case s.plan_id when 'small' then 1 when 'large' then 10 else 0 end,
      s.plan_id,s.expires_at,null::text
    from public.subscriptions s
    where s.owner_id=p_owner and s.status in ('active','grace') and s.expires_at>now()
      and (s.environment='production' or
        (s.environment='sandbox' and (select allow_sandbox_payments from private.server_settings)))
  )
  select coalesce(
    (select jsonb_build_object('active',true,'source',source,'planId',plan_id,
      'calendarLimit',calendar_limit,'licenseType',license_type,
      'expiresAt',expires_at,'serverTime',now())
     from candidates where calendar_limit>0 order by calendar_limit desc,expires_at desc limit 1),
    jsonb_build_object('active',false,'source','none','planId',null,'calendarLimit',0,
      'licenseType',null,'expiresAt',null,'serverTime',now())
  )
$$;

create or replace function private.owner_access(p_owner uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_expiry timestamptz; v_base jsonb;
begin
  v_base:=private.owner_access_base(p_owner);
  select g.expires_at into v_expiry
    from private.developer_grants g
    join auth.users u on u.id=g.user_id
    where g.user_id=p_owner and g.expires_at>now()
      and exists(select 1 from private.platform_settings s where s.singleton and s.developer_bypass_enabled)
      and u.email_confirmed_at is not null
      and exists(select 1 from auth.identities i where i.user_id=u.id and i.provider='google');
  if v_expiry is not null and ((v_base->>'calendarLimit')::integer<10
    or coalesce((v_base->>'expiresAt')::timestamptz,'-infinity')<v_expiry) then
    return jsonb_build_object('active',true,'source','developer','planId','large',
      'calendarLimit',10,'licenseType','Complete','expiresAt',v_expiry,'serverTime',now());
  end if;
  return v_base;
end;
$$;

create or replace function public.redeem_standard_license(p_key text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_email text; v_key text; v_row private.license_keys%rowtype; v_calendar_limit integer;
begin
  v_email:=private.verified_google_email();
  if v_email is null then return jsonb_build_object('ok',false,'message','Autentificare necesară.'); end if;
  if not private.take_attempt('license',5) then
    return jsonb_build_object('ok',false,'message','Prea multe încercări. Reîncearcă peste 15 minute.');
  end if;
  v_key:=upper(btrim(p_key));
  if length(v_key)<>75 or v_key!~'^RZL-([A-F0-9]{8}-){7}[A-F0-9]{8}$' then
    return jsonb_build_object('ok',false,'message','Licență invalidă.');
  end if;
  select * into v_row from private.license_keys
    where key_hash=encode(sha256(convert_to(replace(substr(v_key,5),'-',''),'UTF8')),'hex') for update;
  if not found or v_row.bound_email<>v_email or v_row.revoked_at is not null or now()>=v_row.expires_at
    or (v_row.redeemed_by is not null and v_row.redeemed_by<>auth.uid()) then
    return jsonb_build_object('ok',false,'message','Licență invalidă.');
  end if;
  v_calendar_limit:=case v_row.type when 'Complete' then 10 when 'half_complete' then 5 end;
  update private.license_keys set redeemed_by=auth.uid(),redeemed_at=coalesce(redeemed_at,now()) where id=v_row.id;
  return jsonb_build_object('ok',true,'startsAt',v_row.starts_at,'expiresAt',v_row.expires_at,
    'scheduled',now()<v_row.starts_at,'calendarLimit',v_calendar_limit,
    'licenseType',v_row.type::text,'access',private.owner_access(auth.uid()));
end;
$$;
revoke all on function public.redeem_standard_license(text) from public,anon,authenticated;

create or replace function public.redeem_license(p_key text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare s private.platform_settings%rowtype; v_expiry timestamptz:='infinity'::timestamptz;
begin
  select * into s from private.platform_settings where singleton;
  if encode(sha256(convert_to(btrim(p_key),'UTF8')),'hex') is distinct from s.developer_key_hash then
    return public.redeem_standard_license(p_key);
  end if;
  if private.verified_google_email() is null then
    return jsonb_build_object('ok',false,'message','Autentificare necesară.');
  end if;
  if not private.take_attempt('license',5) then
    return jsonb_build_object('ok',false,'message','Prea multe încercări. Reîncearcă peste 15 minute.');
  end if;
  select * into s from private.platform_settings where singleton for update;
  if not s.developer_bypass_enabled then return jsonb_build_object('ok',false,'message','Licență invalidă.'); end if;
  insert into private.developer_grants(user_id,expires_at) values(auth.uid(),v_expiry)
    on conflict(user_id) do update set expires_at=excluded.expires_at;
  return jsonb_build_object('ok',true,'scheduled',false,'startsAt',now(),'expiresAt',v_expiry,
    'calendarLimit',10,'licenseType','Complete','access',private.owner_access(auth.uid()));
end;
$$;
revoke all on function public.redeem_license(text) from public,anon,authenticated;
grant execute on function public.redeem_license(text) to authenticated;

create or replace function private.enforce_resource_absolute_limit()
returns trigger language plpgsql security definer set search_path='' as $$
declare v_count integer;
begin
  if tg_op='INSERT' then
    select count(*) into v_count from public.resources where business_id=new.business_id;
    if v_count>=15 then raise exception 'Afacerea poate avea maximum 15 calendare în baza de date.'; end if;
  end if;
  return new;
end;
$$;
revoke all on function private.enforce_resource_absolute_limit() from public,anon,authenticated;
drop trigger if exists enforce_resource_absolute_limit on public.resources;
create trigger enforce_resource_absolute_limit before insert on public.resources
  for each row execute function private.enforce_resource_absolute_limit();

commit;
