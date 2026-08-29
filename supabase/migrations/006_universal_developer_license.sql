-- The development key is intentionally universal. Standard licenses remain email-bound.
-- All rejected license keys use the same neutral response to avoid account disclosure.
begin;

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
  if v_expiry is not null and ((v_base->>'calendarLimit')::integer<5
    or coalesce((v_base->>'expiresAt')::timestamptz,'-infinity')<v_expiry) then
    return jsonb_build_object('active',true,'source','developer','planId','large',
      'calendarLimit',5,'expiresAt',v_expiry,'serverTime',now());
  end if;
  return v_base;
end;
$$;

create or replace function public.redeem_standard_license(p_key text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_email text; v_key text; v_row private.license_keys%rowtype;
begin
  v_email:=private.verified_google_email();
  if v_email is null then return jsonb_build_object('ok',false,'message','Autentificare necesară.'); end if;
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
revoke all on function public.redeem_standard_license(text) from public,anon,authenticated;

create or replace function public.redeem_license(p_key text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare s private.platform_settings%rowtype; v_expiry timestamptz;
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
  if not s.developer_bypass_enabled then
    return jsonb_build_object('ok',false,'message','Licență invalidă.');
  end if;
  v_expiry:=now()+interval '30 days';
  insert into private.developer_grants(user_id,expires_at) values(auth.uid(),v_expiry)
    on conflict(user_id) do update set expires_at=excluded.expires_at;
  return jsonb_build_object('ok',true,'scheduled',false,'startsAt',now(),'expiresAt',v_expiry,
    'calendarLimit',5,'access',private.owner_access(auth.uid()));
end;
$$;
revoke all on function public.redeem_license(text) from public,anon,authenticated;
grant execute on function public.redeem_license(text) to authenticated;

commit;
