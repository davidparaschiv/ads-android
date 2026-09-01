-- Generic invitation failures and customer reminders only after booking approval.
-- Apply after 018.

begin;

create or replace function public.accept_calendar_invitation(p_token text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_email text; v_inv private.calendar_invitations%rowtype; v_business uuid;
begin
  v_email:=private.verified_google_email();
  if v_email is null then return jsonb_build_object('ok',false,'message','Cod invalid.'); end if;
  if not private.take_attempt('invite_accept',5) then
    return jsonb_build_object('ok',false,'message','Prea multe încercări. Reîncearcă peste 15 minute.');
  end if;
  if length(btrim(p_token))<>68 or upper(btrim(p_token)) !~ '^RZI-[A-F0-9]{64}$' then
    return jsonb_build_object('ok',false,'message','Cod invalid.');
  end if;
  select business_id into v_business from private.calendar_invitations
    where token_hash=encode(sha256(convert_to(upper(btrim(p_token)),'UTF8')),'hex');
  perform 1 from public.businesses where id=v_business for update;
  select * into v_inv from private.calendar_invitations
    where token_hash=encode(sha256(convert_to(upper(btrim(p_token)),'UTF8')),'hex') for update;
  if not found or v_inv.invited_email<>v_email or v_inv.expires_at<=now()
    or v_inv.status not in ('pending','sent') then
    return jsonb_build_object('ok',false,'message','Cod invalid.');
  end if;
  if not (private.owner_access((select owner_id from public.businesses where id=v_inv.business_id))->>'active')::boolean then
    return jsonb_build_object('ok',false,'message','Cod invalid.');
  end if;
  insert into public.business_members(business_id,user_id,role) values(v_inv.business_id,auth.uid(),'staff')
    on conflict(business_id,user_id) do nothing;
  insert into public.calendar_members(calendar_id,business_id,user_id,permission)
    select r.id,v_inv.business_id,auth.uid(),v_inv.permission from public.resources r
      where r.business_id=v_inv.business_id
    on conflict(calendar_id,user_id) do update set permission=excluded.permission;
  update private.calendar_invitations set status='accepted',accepted_by=auth.uid(),accepted_at=now()
    where id=v_inv.id;
  return jsonb_build_object('ok',true,'businessId',v_inv.business_id);
end;
$$;

create or replace function public.notification_recipient_allowed(p_booking uuid,p_user uuid)
returns boolean language sql stable security definer set search_path='' as $$
  select exists(select 1 from public.bookings b join public.businesses owner on owner.id=b.business_id
    left join public.notification_preferences pref on pref.user_id=p_user
    where b.id=p_booking and b.status='confirmed' and b.start_at>now()
      and coalesce(pref.push_enabled,true)
      and (b.customer_id=p_user or (private.business_has_team_features(b.business_id)
        and (owner.owner_id=p_user or exists(select 1 from public.calendar_members m
          where m.calendar_id=b.resource_id and m.user_id=p_user)))));
$$;
revoke all on function public.notification_recipient_allowed(uuid,uuid) from public,anon,authenticated;
grant execute on function public.notification_recipient_allowed(uuid,uuid) to service_role;

create or replace function private.queue_customer_reminder_on_confirmation()
returns trigger language plpgsql security definer set search_path='' as $$
declare v_minutes integer; v_business_name text; v_send_at timestamptz;
begin
  if new.status<>'confirmed' or old.status='confirmed' or new.start_at<=now() then return new; end if;
  select coalesce(p.default_minutes,60),b.name into v_minutes,v_business_name
    from public.businesses b left join public.notification_preferences p on p.user_id=new.customer_id
    where b.id=new.business_id;
  v_send_at:=greatest(now()+interval '1 second',new.start_at-make_interval(mins=>v_minutes));
  if not exists(select 1 from public.notification_jobs j where j.booking_id=new.id
    and j.user_id=new.customer_id and j.kind='reminder' and j.status in ('pending','processing','sent')) then
    insert into public.notification_jobs(booking_id,user_id,send_at,title,body,kind,target_route)
      values(new.id,new.customer_id,v_send_at,'Programarea ta se apropie',
        v_business_name||' · Verifică detaliile în aplicație.','reminder','/customer/notifications');
  end if;
  return new;
end;
$$;
revoke all on function private.queue_customer_reminder_on_confirmation() from public,anon,authenticated;
drop trigger if exists queue_customer_reminder_on_confirmation on public.bookings;
create trigger queue_customer_reminder_on_confirmation after update of status on public.bookings
  for each row execute function private.queue_customer_reminder_on_confirmation();

update public.notification_jobs j set status='cancelled'
  from public.bookings b where b.id=j.booking_id and j.user_id=b.customer_id
    and j.kind='reminder' and j.status='pending' and b.status<>'confirmed';

insert into public.notification_jobs(booking_id,user_id,send_at,title,body,kind,target_route)
select b.id,b.customer_id,greatest(now()+interval '1 second',b.start_at-make_interval(mins=>coalesce(p.default_minutes,60))),
  'Programarea ta se apropie',company.name||' · Verifică detaliile în aplicație.',
  'reminder','/customer/notifications'
from public.bookings b join public.businesses company on company.id=b.business_id
left join public.notification_preferences p on p.user_id=b.customer_id
where b.status='confirmed' and b.start_at>now() and coalesce(p.push_enabled,true)
  and not exists(select 1 from public.notification_jobs j where j.booking_id=b.id
    and j.user_id=b.customer_id and j.kind='reminder' and j.status in ('pending','processing','sent'));

commit;
