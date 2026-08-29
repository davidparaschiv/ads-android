-- Owner-only approval screen and 30-day, single-current-code enrollment policy.
begin;

alter table private.enrollment_requests
  alter column expires_at set default now()+interval '30 days';
alter table private.enrollment_links
  alter column expires_at set default now()+interval '30 days';

-- Keep still-pending requests and unused codes useful under the new policy.
update private.enrollment_requests
set expires_at=greatest(expires_at,created_at+interval '30 days')
where status='pending';
update private.enrollment_links
set expires_at=greatest(expires_at,now()+interval '30 days')
where used_at is null and expires_at>now();

create or replace function public.is_platform_owner_account()
returns boolean language sql stable security definer set search_path='' as $$
  select private.is_platform_owner()
$$;
revoke all on function public.is_platform_owner_account() from public,anon;
grant execute on function public.is_platform_owner_account() to authenticated;

create or replace function public.issue_enrollment_link(p_request_id uuid,p_owner uuid,p_kind text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare r private.enrollment_requests%rowtype; v_token text; v_email text;
begin
  select * into r from private.enrollment_requests where id=p_request_id and owner_id=p_owner for update;
  if not found or r.status<>'pending' or r.expires_at<=now() then return jsonb_build_object('ok',false); end if;
  if p_kind='approval' then
    if r.email_verified_at is null or r.phone_verified_at is null then return jsonb_build_object('ok',false); end if;
    select owner_email into v_email from private.platform_settings where singleton;
  elsif p_kind='email' and r.email_verified_at is null then
    v_email:=r.contact_email;
  else
    return jsonb_build_object('ok',false);
  end if;

  -- Exactly one usable code per request and kind. A resend supersedes the old code.
  update private.enrollment_links set used_at=now()
    where request_id=r.id and kind=p_kind and used_at is null;
  v_token:=case when p_kind='email' then 'RZE-' else 'RZA-' end
    ||upper(replace(gen_random_uuid()::text||gen_random_uuid()::text,'-',''));
  insert into private.enrollment_links(request_id,kind,token_hash,expires_at)
    values(r.id,p_kind,encode(sha256(convert_to(v_token,'UTF8')),'hex'),now()+interval '30 days');
  return jsonb_build_object('ok',true,'token',v_token,'recipient',v_email,'name',r.name,
    'category',r.category,'address',r.address,'cui',r.cui,'phone',r.phone,'email',r.contact_email);
end;
$$;
revoke all on function public.issue_enrollment_link(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.issue_enrollment_link(uuid,uuid,text) to service_role;

commit;
