-- Every accepted staff member shares every calendar in the business. Calendar
-- assignment arrays remain only as a compatibility detail for older clients.
begin;

-- Expand existing selective assignments to every existing calendar, preserving
-- the member's strongest current permission as one global permission.
insert into public.calendar_members(calendar_id,business_id,user_id,permission)
select r.id,m.business_id,m.user_id,
  case when exists(select 1 from public.calendar_members old
    where old.business_id=m.business_id and old.user_id=m.user_id and old.permission='manager')
    then 'manager' else 'viewer' end
from public.business_members m
join public.resources r on r.business_id=m.business_id
where m.role='staff'
on conflict(calendar_id,user_id) do update set permission=excluded.permission;

create function private.share_new_team_member_calendars()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if new.role='staff' then
    insert into public.calendar_members(calendar_id,business_id,user_id,permission)
      select r.id,new.business_id,new.user_id,'viewer' from public.resources r
      where r.business_id=new.business_id
      on conflict(calendar_id,user_id) do nothing;
  end if;
  return new;
end;
$$;
revoke all on function private.share_new_team_member_calendars() from public,anon,authenticated;
create trigger share_new_team_member_calendars after insert on public.business_members
  for each row execute function private.share_new_team_member_calendars();

create function private.share_new_calendar_with_team()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  insert into public.calendar_members(calendar_id,business_id,user_id,permission)
    select new.id,new.business_id,m.user_id,
      case when exists(select 1 from public.calendar_members cm
        where cm.business_id=m.business_id and cm.user_id=m.user_id and cm.permission='manager')
        then 'manager' else 'viewer' end
    from public.business_members m where m.business_id=new.business_id and m.role='staff'
    on conflict(calendar_id,user_id) do nothing;
  return new;
end;
$$;
revoke all on function private.share_new_calendar_with_team() from public,anon,authenticated;
create trigger share_new_calendar_with_team after insert on public.resources
  for each row execute function private.share_new_calendar_with_team();

create or replace function public.issue_calendar_invitation(p_business_id uuid,p_email text,p_calendar_ids uuid[],p_permission text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_token text; v_id uuid; v_email text; v_business text; v_all_calendars uuid[];
begin
  if not public.is_business_admin(p_business_id) or private.verified_google_email() is null then raise exception 'Acces interzis'; end if;
  if not private.take_attempt('invite_send',10) then return jsonb_build_object('ok',false,'message','Prea multe invitații. Reîncearcă peste 15 minute.'); end if;
  perform private.require_business_access(p_business_id);
  v_email:=lower(btrim(p_email));
  if length(v_email)>254 or v_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
    or p_permission not in ('viewer','manager') then raise exception 'Invitație invalidă'; end if;
  if v_email=private.verified_google_email() then raise exception 'Ai deja acces ca proprietar'; end if;
  select coalesce(array_agg(id order by created_at,id),'{}'::uuid[]) into v_all_calendars
    from public.resources where business_id=p_business_id;
  update private.calendar_invitations set status='revoked'
    where business_id=p_business_id and invited_email=v_email and status in ('pending','sent');
  v_token:='RZI-'||upper(replace(gen_random_uuid()::text||gen_random_uuid()::text,'-',''));
  insert into private.calendar_invitations(business_id,invited_email,calendar_ids,permission,token_hash,invited_by)
    values(p_business_id,v_email,v_all_calendars,p_permission,encode(sha256(convert_to(v_token,'UTF8')),'hex'),auth.uid())
    returning id into v_id;
  select name into v_business from public.businesses where id=p_business_id;
  return jsonb_build_object('ok',true,'id',v_id,'token',v_token,'email',v_email,'businessName',v_business);
end;
$$;

create or replace function public.accept_calendar_invitation(p_token text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_email text; v_inv private.calendar_invitations%rowtype; v_business uuid;
begin
  v_email:=private.verified_google_email();
  if v_email is null then return jsonb_build_object('ok',false,'message','Autentifică-te cu adresa Google invitată.'); end if;
  if not private.take_attempt('invite_accept',5) then return jsonb_build_object('ok',false,'message','Prea multe încercări. Reîncearcă peste 15 minute.'); end if;
  if length(btrim(p_token))<>68 or upper(btrim(p_token)) !~ '^RZI-[A-F0-9]{64}$' then
    return jsonb_build_object('ok',false,'message','Invitație indisponibilă pentru acest cont.');
  end if;
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
  insert into public.business_members(business_id,user_id,role) values(v_inv.business_id,auth.uid(),'staff')
    on conflict(business_id,user_id) do nothing;
  insert into public.calendar_members(calendar_id,business_id,user_id,permission)
    select r.id,v_inv.business_id,auth.uid(),v_inv.permission from public.resources r
      where r.business_id=v_inv.business_id
    on conflict(calendar_id,user_id) do update set permission=excluded.permission;
  update private.calendar_invitations set status='accepted',accepted_by=auth.uid(),accepted_at=now() where id=v_inv.id;
  return jsonb_build_object('ok',true,'businessId',v_inv.business_id);
end;
$$;

create or replace function public.list_team(p_business_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
  if not public.is_business_admin(p_business_id) then raise exception 'Acces interzis'; end if;
  return jsonb_build_object(
    'members',coalesce((select jsonb_agg(jsonb_build_object('userId',m.user_id,'email',u.email,'role',m.role,
      'permission',case when exists(select 1 from public.calendar_members c where c.business_id=p_business_id
        and c.user_id=m.user_id and c.permission='manager') then 'manager' else 'viewer' end))
      from public.business_members m join auth.users u on u.id=m.user_id where m.business_id=p_business_id),'[]'::jsonb),
    'invitations',coalesce((select jsonb_agg(jsonb_build_object('id',i.id,'email',i.invited_email,
      'permission',i.permission,'status',i.status,'expiresAt',i.expires_at))
      from private.calendar_invitations i where i.business_id=p_business_id),'[]'::jsonb));
end;
$$;

create or replace function public.set_member_access(p_business_id uuid,p_user_id uuid,p_calendar_ids uuid[],p_permission text)
returns void language plpgsql security definer set search_path='' as $$
begin
  if not public.is_business_admin(p_business_id) or p_user_id=auth.uid() then raise exception 'Acces interzis'; end if;
  perform 1 from public.businesses where id=p_business_id for update;
  if not exists(select 1 from public.business_members where business_id=p_business_id and user_id=p_user_id)
    or p_permission not in ('viewer','manager') then raise exception 'Acces invalid'; end if;
  if coalesce(array_length(p_calendar_ids,1),0)=0 then
    delete from public.calendar_members where business_id=p_business_id and user_id=p_user_id;
    update private.calendar_invitations set status='revoked' where business_id=p_business_id
      and invited_email=(select lower(btrim(email)) from auth.users where id=p_user_id) and status in ('pending','sent');
    delete from public.business_members where business_id=p_business_id and user_id=p_user_id;
  else
    perform private.require_business_access(p_business_id);
    insert into public.calendar_members(calendar_id,business_id,user_id,permission)
      select r.id,p_business_id,p_user_id,p_permission from public.resources r where r.business_id=p_business_id
      on conflict(calendar_id,user_id) do update set permission=excluded.permission;
  end if;
  update public.notification_jobs j set status='cancelled' from public.bookings b
    where j.booking_id=b.id and j.user_id=p_user_id and b.business_id=p_business_id and j.status='pending'
      and not exists(select 1 from public.calendar_members m where m.calendar_id=b.resource_id and m.user_id=p_user_id);
end;
$$;

create function public.set_team_member(p_business_id uuid,p_user_id uuid,p_permission text,p_remove boolean default false)
returns void language plpgsql security definer set search_path='' as $$
begin
  perform public.set_member_access(p_business_id,p_user_id,
    case when p_remove then '{}'::uuid[] else array[p_business_id] end,p_permission);
end;
$$;
revoke all on function public.set_team_member(uuid,uuid,text,boolean) from public,anon,authenticated;
grant execute on function public.set_team_member(uuid,uuid,text,boolean) to authenticated;

commit;
