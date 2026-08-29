-- Block business operations after paid/license expiry, keep dev112233 permanent,
-- Normal licenses continue to use their database-generated expires_at timestamp.
begin;

update private.developer_grants set expires_at='infinity'::timestamptz;

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
    'calendarLimit',5,'access',private.owner_access(auth.uid()));
end;
$$;
revoke all on function public.redeem_license(text) from public,anon,authenticated;
grant execute on function public.redeem_license(text) to authenticated;

create or replace function public.is_business_admin(target_business_id uuid)
returns boolean language sql stable security definer set search_path='' as $$
  select exists(select 1 from public.businesses b
    cross join lateral private.owner_access(b.owner_id) a
    where b.id=target_business_id and b.owner_id=auth.uid() and (a->>'active')::boolean)
$$;

create or replace function public.can_read_calendar(p_calendar uuid)
returns boolean language sql stable security definer set search_path='' as $$
  select exists(select 1 from public.resources r join public.businesses b on b.id=r.business_id
    cross join lateral private.owner_access(b.owner_id) a
    where r.id=p_calendar and (a->>'active')::boolean and (
      b.owner_id=auth.uid() or exists(select 1 from public.calendar_members m
        where m.calendar_id=r.id and m.user_id=auth.uid())))
$$;

create or replace function public.can_manage_calendar(p_calendar uuid)
returns boolean language sql stable security definer set search_path='' as $$
  select exists(select 1 from public.resources r join public.businesses b on b.id=r.business_id
    cross join lateral private.owner_access(b.owner_id) a
    where r.id=p_calendar and (a->>'active')::boolean and (
      b.owner_id=auth.uid() or exists(select 1 from public.calendar_members m
        where m.calendar_id=r.id and m.user_id=auth.uid() and m.permission='manager')))
$$;

commit;
