-- High-risk entitlement gate: cancelled/expired payment or license access cannot
-- read or mutate business data. Billing recovery endpoints remain available.
begin;

create or replace function private.owner_access_base(p_owner uuid)
returns jsonb language sql stable security definer set search_path='' as $$
  with candidates as (
    select 'license'::text source,5 calendar_limit,'large'::text plan_id,l.expires_at
    from private.license_keys l join auth.users u on u.id=l.redeemed_by
    where l.redeemed_by=p_owner and l.revoked_at is null
      and l.bound_email=lower(btrim(u.email)) and u.email_confirmed_at is not null
      and l.starts_at<=now() and now()<l.expires_at
    union all
    select 'google_play',case s.plan_id when 'small' then 1 when 'large' then 5 else 0 end,
      s.plan_id,s.expires_at
    from public.subscriptions s
    where s.owner_id=p_owner and s.status in ('active','grace') and s.expires_at>now()
      and (s.environment='production' or
        (s.environment='sandbox' and (select allow_sandbox_payments from private.server_settings)))
  )
  select coalesce(
    (select jsonb_build_object('active',true,'source',source,'planId',plan_id,
      'calendarLimit',calendar_limit,'expiresAt',expires_at,'serverTime',now())
     from candidates where calendar_limit>0 order by calendar_limit desc,expires_at desc limit 1),
    jsonb_build_object('active',false,'source','none','planId',null,'calendarLimit',0,
      'expiresAt',null,'serverTime',now())
  )
$$;

create or replace function private.block_complete_to_small()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if old.plan_id='large' and new.plan_id='small' then
    -- Never grant the lower plan through a forged/stale provider transition.
    -- The account is locked and must restore Complete or use a valid license.
    new.plan_id:='large';
    new.status:='cancelled';
    new.expires_at:=least(new.expires_at,now());
  end if;
  return new;
end;
$$;
revoke all on function private.block_complete_to_small() from public,anon,authenticated;
drop trigger if exists block_complete_to_small on public.subscriptions;
create trigger block_complete_to_small before update on public.subscriptions
  for each row execute function private.block_complete_to_small();

create or replace function public.business_has_active_access(p_business uuid)
returns boolean language sql stable security definer set search_path='' as $$
  select exists(select 1 from public.businesses b
    cross join lateral private.owner_access(b.owner_id) a
    where b.id=p_business and b.is_active and (a->>'active')::boolean)
$$;
revoke all on function public.business_has_active_access(uuid) from public,anon;
grant execute on function public.business_has_active_access(uuid) to authenticated;

drop policy if exists business_read_v2 on public.businesses;
create policy business_read_v2 on public.businesses for select to authenticated
  using(public.business_has_active_access(id));

drop policy if exists members_read_v2 on public.business_members;
create policy members_read_v2 on public.business_members for select to authenticated
  using(public.business_has_active_access(business_id)
    and (user_id=auth.uid() or public.is_business_admin(business_id)));

drop policy if exists calendar_members_read_v2 on public.calendar_members;
create policy calendar_members_read_v2 on public.calendar_members for select to authenticated
  using(public.business_has_active_access(business_id)
    and (user_id=auth.uid() or public.is_business_admin(business_id)));

drop policy if exists resource_metadata_v2 on public.resources;
create policy resource_metadata_v2 on public.resources for select to authenticated
  using(public.business_has_active_access(business_id) and (is_active or public.can_read_calendar(id)));

drop policy if exists locations_read_v2 on public.locations;
create policy locations_read_v2 on public.locations for select to authenticated
  using(public.business_has_active_access(business_id) and (is_active or public.is_business_admin(business_id)));

drop policy if exists events_read_v2 on public.event_types;
create policy events_read_v2 on public.event_types for select to authenticated
  using(public.business_has_active_access(business_id) and (is_active or public.is_business_member(business_id)));

drop policy if exists availability_read_v2 on public.availability_rules;
create policy availability_read_v2 on public.availability_rules for select to authenticated using(
  public.business_has_active_access(business_id) and exists(
    select 1 from public.resources r where r.id=resource_id and (r.is_active or public.can_read_calendar(r.id))));

commit;
