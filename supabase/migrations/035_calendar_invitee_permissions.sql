-- Owner-managed per-calendar restrictions for invited BV accounts.
-- No row means full access. One row means that invitee cannot see or operate
-- on that calendar. Authorization is enforced by database functions and RLS.

begin;

do $logger_types$
begin
  if to_regtype('public.logger_action_type') is not null then
    alter type public.logger_action_type add value if not exists 'BV_VIEW_CALENDAR_INVITEE_PERMISSIONS';
    alter type public.logger_action_type add value if not exists 'BV_UPDATE_CALENDAR_INVITEE_PERMISSION';
  end if;
end
$logger_types$;

create table public.bv_restrict_calendar_invitee(
  business_id uuid not null,
  calendar_id uuid not null,
  user_id uuid not null,
  primary key(business_id,calendar_id,user_id),
  foreign key(calendar_id,business_id)
    references public.resources(id,business_id) on delete cascade,
  foreign key(business_id,user_id)
    references public.business_members(business_id,user_id) on delete cascade
);

alter table public.bv_restrict_calendar_invitee enable row level security;
revoke all on public.bv_restrict_calendar_invitee from public,anon,authenticated;

create or replace function public.can_read_calendar(p_calendar uuid)
returns boolean language sql stable security definer set search_path='' as $$
  select exists(
    select 1
    from public.resources r
    join public.businesses b on b.id=r.business_id
    cross join lateral private.owner_access(b.owner_id) access
    where r.id=p_calendar and (access->>'active')::boolean and (
      b.owner_id=auth.uid()
      or (
        access->>'planId'='large'
        and exists(select 1 from public.calendar_members member
          where member.calendar_id=r.id and member.user_id=auth.uid())
        and not exists(select 1 from public.bv_restrict_calendar_invitee restriction
          where restriction.business_id=r.business_id
            and restriction.calendar_id=r.id
            and restriction.user_id=auth.uid())
      )
    )
  );
$$;

create or replace function public.can_manage_calendar(p_calendar uuid)
returns boolean language sql stable security definer set search_path='' as $$
  select exists(
    select 1
    from public.resources r
    join public.businesses b on b.id=r.business_id
    cross join lateral private.owner_access(b.owner_id) access
    where r.id=p_calendar and (access->>'active')::boolean and (
      b.owner_id=auth.uid()
      or (
        access->>'planId'='large'
        and exists(select 1 from public.calendar_members member
          where member.calendar_id=r.id and member.user_id=auth.uid())
        and not exists(select 1 from public.bv_restrict_calendar_invitee restriction
          where restriction.business_id=r.business_id
            and restriction.calendar_id=r.id
            and restriction.user_id=auth.uid())
      )
    )
  );
$$;

drop policy if exists resource_metadata_v2 on public.resources;
create policy resource_metadata_v2 on public.resources for select to authenticated using(
  is_active and (
    not public.is_business_member(business_id)
    or public.can_read_calendar(id)
  )
);

drop policy if exists events_read_v2 on public.event_types;
create policy events_read_v2 on public.event_types for select to authenticated using(
  is_active and (
    not public.is_business_member(business_id)
    or resource_id is null
    or public.can_read_calendar(resource_id)
  )
);

drop policy if exists availability_read_v2 on public.availability_rules;
create policy availability_read_v2 on public.availability_rules for select to authenticated using(
  exists(select 1 from public.resources resource
    where resource.id=resource_id and resource.is_active and (
      not public.is_business_member(resource.business_id)
      or public.can_read_calendar(resource.id)
    ))
);

create or replace function public.get_calendar_invitee_permissions(
  p_business_id uuid,p_calendar_id uuid
) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_owner uuid;
begin
  select owner_id into v_owner from public.businesses where id=p_business_id;
  if auth.uid() is null or v_owner is null or v_owner<>auth.uid()
    or not exists(select 1 from public.resources
      where id=p_calendar_id and business_id=p_business_id and is_active) then
    raise exception 'Acces interzis';
  end if;
  perform private.require_business_access(p_business_id);

  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'userId',member.user_id,
      'email',account.email,
      'allowed',restriction.user_id is null
    ) order by lower(account.email),member.user_id)
    from public.business_members member
    join auth.users account on account.id=member.user_id
    left join public.bv_restrict_calendar_invitee restriction
      on restriction.business_id=member.business_id
      and restriction.calendar_id=p_calendar_id
      and restriction.user_id=member.user_id
    where member.business_id=p_business_id and member.role='staff'
  ),'[]'::jsonb);
end;
$$;

create or replace function public.set_calendar_invitee_permission(
  p_business_id uuid,p_calendar_id uuid,p_user_id uuid,p_allowed boolean
) returns void language plpgsql security definer set search_path='' as $$
declare v_owner uuid; v_minutes integer;
begin
  select owner_id into v_owner from public.businesses where id=p_business_id for update;
  if auth.uid() is null or v_owner is null or v_owner<>auth.uid() then
    raise exception 'Doar proprietarul poate modifica accesul la calendare';
  end if;
  perform private.require_business_access(p_business_id);
  if p_allowed is null
    or not exists(select 1 from public.resources
      where id=p_calendar_id and business_id=p_business_id and is_active)
    or not exists(select 1 from public.business_members
      where business_id=p_business_id and user_id=p_user_id and role='staff') then
    raise exception 'Membru sau calendar invalid';
  end if;

  if p_allowed then
    delete from public.bv_restrict_calendar_invitee
    where business_id=p_business_id and calendar_id=p_calendar_id and user_id=p_user_id;

    select coalesce((select preference.minutes_before
      from public.business_notification_preferences preference
      where preference.calendar_id=p_calendar_id and preference.user_id=p_user_id),15)
      into v_minutes;
    if v_minutes<>-1 then
      perform private.reschedule_business_reminders_after_save(
        p_calendar_id,p_user_id,v_minutes
      );
    end if;
  else
    insert into public.bv_restrict_calendar_invitee(business_id,calendar_id,user_id)
      values(p_business_id,p_calendar_id,p_user_id)
      on conflict(business_id,calendar_id,user_id) do nothing;

    update public.notification_jobs job set status='cancelled'
    from public.bookings booking
    where job.booking_id=booking.id
      and booking.business_id=p_business_id
      and booking.resource_id=p_calendar_id
      and job.user_id=p_user_id
      and job.type='business'
      and job.status in ('pending','failed');
  end if;
end;
$$;

create or replace function public.notification_recipient_allowed(p_booking uuid,p_user uuid)
returns boolean language sql stable security definer set search_path='' as $$
  select exists(
    select 1 from public.bookings booking
    left join public.client_notification_preferences client_preference
      on client_preference.user_id=p_user and booking.customer_id=p_user
    left join public.business_notification_preferences business_preference
      on business_preference.calendar_id=booking.resource_id
      and business_preference.user_id=p_user
    where booking.id=p_booking and booking.status='confirmed' and booking.start_at>now()
      and (
        (booking.customer_id=p_user and coalesce(client_preference.push_enabled,true))
        or (private.business_has_team_features(booking.business_id)
          and exists(select 1 from public.business_members member
            where member.business_id=booking.business_id and member.user_id=p_user)
          and not exists(select 1 from public.bv_restrict_calendar_invitee restriction
            where restriction.business_id=booking.business_id
              and restriction.calendar_id=booking.resource_id
              and restriction.user_id=p_user)
          and coalesce(business_preference.minutes_before,15)<>-1)
      )
  );
$$;

create or replace function public.notification_job_recipient_allowed(p_job uuid)
returns boolean language sql stable security definer set search_path='' as $$
  select exists(
    select 1
    from public.notification_jobs job
    join public.bookings booking on booking.id=job.booking_id
    left join public.client_notification_preferences preference
      on preference.user_id=job.user_id and job.type='client'
    where job.id=p_job and job.status='processing' and (
      (job.kind='booking_request' and job.type='business'
        and booking.status='pending' and booking.start_at>now()
        and private.business_has_team_features(booking.business_id)
        and exists(select 1 from public.business_members member
          where member.business_id=booking.business_id and member.user_id=job.user_id)
        and not exists(select 1 from public.bv_restrict_calendar_invitee restriction
          where restriction.business_id=booking.business_id
            and restriction.calendar_id=booking.resource_id
            and restriction.user_id=job.user_id))
      or (job.kind='status_update' and job.type='client'
        and booking.customer_id=job.user_id
        and booking.status in ('confirmed','rejected')
        and coalesce(preference.push_enabled,true))
      or (job.kind='reminder' and (
        (job.type='client' and booking.customer_id=job.user_id)
        or (job.type='business' and exists(select 1 from public.business_members member
          where member.business_id=booking.business_id and member.user_id=job.user_id))
      ) and public.notification_recipient_allowed(booking.id,job.user_id))
    )
  );
$$;

create or replace function private.filter_plan_reminder()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if new.kind='booking_request' then
    if new.type<>'business' or not exists(
      select 1 from public.bookings booking
      join public.business_members member on member.business_id=booking.business_id
      where booking.id=new.booking_id and booking.status='pending' and booking.start_at>now()
        and member.user_id=new.user_id
        and private.business_has_team_features(booking.business_id)
        and not exists(select 1 from public.bv_restrict_calendar_invitee restriction
          where restriction.business_id=booking.business_id
            and restriction.calendar_id=booking.resource_id
            and restriction.user_id=new.user_id)
    ) then return null; end if;
  elsif new.kind='status_update' then
    if new.type<>'client' or not exists(
      select 1 from public.bookings booking
      left join public.client_notification_preferences preference
        on preference.user_id=new.user_id
      where booking.id=new.booking_id and booking.customer_id=new.user_id
        and booking.status in ('confirmed','rejected')
        and coalesce(preference.push_enabled,true)
    ) then return null; end if;
  elsif new.kind='reminder' then
    if not ((new.type='client' and exists(select 1 from public.bookings booking
        where booking.id=new.booking_id and booking.customer_id=new.user_id))
      or (new.type='business' and exists(select 1 from public.bookings booking
        join public.business_members member on member.business_id=booking.business_id
        where booking.id=new.booking_id and member.user_id=new.user_id)))
      or not public.notification_recipient_allowed(new.booking_id,new.user_id)
    then return null; end if;
  end if;
  return new;
end;
$$;

create or replace function public.delete_calendar(p_business_id uuid,p_calendar_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_resource public.resources%rowtype;
begin
  if auth.uid() is null or not public.can_manage_calendar(p_calendar_id)
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

revoke all on function public.can_read_calendar(uuid),public.can_manage_calendar(uuid),
  public.get_calendar_invitee_permissions(uuid,uuid),
  public.set_calendar_invitee_permission(uuid,uuid,uuid,boolean),
  public.notification_recipient_allowed(uuid,uuid),
  public.notification_job_recipient_allowed(uuid),
  public.delete_calendar(uuid,uuid) from public,anon,authenticated;
grant execute on function public.can_read_calendar(uuid),public.can_manage_calendar(uuid),
  public.get_calendar_invitee_permissions(uuid,uuid),
  public.set_calendar_invitee_permission(uuid,uuid,uuid,boolean),
  public.delete_calendar(uuid,uuid) to authenticated;
grant execute on function public.notification_recipient_allowed(uuid,uuid),
  public.notification_job_recipient_allowed(uuid) to service_role;

commit;
