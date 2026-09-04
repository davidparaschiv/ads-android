-- Keep the owner permission lookup genuinely read-only. The previous version
-- called private.require_business_access(), which locks the business row with
-- SELECT FOR UPDATE and therefore cannot run inside a STABLE/read-only RPC.

begin;

create or replace function public.get_calendar_invitee_permissions(
  p_business_id uuid,p_calendar_id uuid
) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_owner uuid; v_access jsonb;
begin
  select owner_id into v_owner from public.businesses where id=p_business_id;
  if auth.uid() is null or v_owner is null or v_owner<>auth.uid()
    or not exists(select 1 from public.resources
      where id=p_calendar_id and business_id=p_business_id and is_active) then
    raise exception 'Acces interzis';
  end if;

  v_access:=private.owner_access(v_owner);
  if not coalesce((v_access->>'active')::boolean,false) then
    raise exception 'Abonamentul afacerii nu este activ';
  end if;

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

revoke all on function public.get_calendar_invitee_permissions(uuid,uuid)
  from public,anon,authenticated;
grant execute on function public.get_calendar_invitee_permissions(uuid,uuid)
  to authenticated;

commit;
