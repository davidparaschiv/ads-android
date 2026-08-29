-- Team flow belongs to Complete/5-calendar access. Pending invitations do not
-- consume seats; at most 15 accepted staff members may belong to a business.
begin;

create function private.enforce_team_invitation_plan()
returns trigger language plpgsql security definer set search_path='' as $$
declare v_access jsonb;
begin
  select private.owner_access(b.owner_id) into v_access from public.businesses b where b.id=new.business_id;
  if not coalesce((v_access->>'active')::boolean,false) or v_access->>'planId'<>'large' then
    raise exception 'Team flow necesită planul Complete sau o licență de 5 calendare.';
  end if;
  return new;
end;
$$;
revoke all on function private.enforce_team_invitation_plan() from public,anon,authenticated;
create trigger enforce_team_invitation_plan before insert on private.calendar_invitations
  for each row execute function private.enforce_team_invitation_plan();

create function private.enforce_team_member_limit()
returns trigger language plpgsql security definer set search_path='' as $$
declare v_access jsonb; v_members integer;
begin
  if new.role<>'staff' then return new; end if;
  -- Serialize accepted-seat checks per business so concurrent acceptances cannot
  -- both observe the same remaining seat.
  perform 1 from public.businesses where id=new.business_id for update;
  select private.owner_access(b.owner_id) into v_access from public.businesses b where b.id=new.business_id;
  if not coalesce((v_access->>'active')::boolean,false) or v_access->>'planId'<>'large' then
    raise exception 'Team flow necesită planul Complete sau o licență de 5 calendare.';
  end if;
  select count(*) into v_members from public.business_members
    where business_id=new.business_id and role='staff';
  if v_members>=15 then raise exception 'Echipa are maximum 15 membri acceptați.'; end if;
  return new;
end;
$$;
revoke all on function private.enforce_team_member_limit() from public,anon,authenticated;
create trigger enforce_team_member_limit before insert on public.business_members
  for each row execute function private.enforce_team_member_limit();

create or replace function public.can_read_calendar(p_calendar uuid)
returns boolean language sql stable security definer set search_path='' as $$
  select exists(select 1 from public.resources r join public.businesses b on b.id=r.business_id
    cross join lateral private.owner_access(b.owner_id) a
    where r.id=p_calendar and (a->>'active')::boolean and (
      b.owner_id=auth.uid() or (a->>'planId'='large' and exists(select 1 from public.calendar_members m
        where m.calendar_id=r.id and m.user_id=auth.uid()))))
$$;

create or replace function public.can_manage_calendar(p_calendar uuid)
returns boolean language sql stable security definer set search_path='' as $$
  select exists(select 1 from public.resources r join public.businesses b on b.id=r.business_id
    cross join lateral private.owner_access(b.owner_id) a
    where r.id=p_calendar and (a->>'active')::boolean and (
      b.owner_id=auth.uid() or (a->>'planId'='large' and exists(select 1 from public.calendar_members m
        where m.calendar_id=r.id and m.user_id=auth.uid() and m.permission='manager'))))
$$;

commit;
