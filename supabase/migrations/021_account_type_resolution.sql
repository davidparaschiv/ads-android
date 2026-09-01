-- Resolve the one authoritative application account type after Google login.
-- Owners are business accounts; accepted non-owner members are invitees;
-- completed customer profiles are clients. Existing exclusivity rules remain.
begin;

create or replace function public.get_account_role()
returns text language sql stable security definer set search_path='' as $$
  select case
    when exists(select 1 from public.businesses b where b.owner_id=auth.uid())
      or exists(select 1 from public.business_members m where m.user_id=auth.uid() and m.role='owner')
      then 'business'
    when exists(select 1 from public.business_members m where m.user_id=auth.uid())
      then 'invitee'
    when exists(select 1 from public.profiles p where p.id=auth.uid() and p.customer_profile_completed_at is not null)
      then 'client'
    else 'unassigned'
  end
$$;

revoke all on function public.get_account_role() from public,anon;
grant execute on function public.get_account_role() to authenticated;

commit;
