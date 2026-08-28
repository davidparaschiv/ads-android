-- Apply AFTER 004. QR is a reservation locator, never an authorization credential.
-- No existing booking rows, plan entitlements or reminder logic are changed.
begin;

create table private.booking_qr_tokens (
  booking_id uuid primary key references public.bookings(id) on delete cascade,
  token text not null unique check (token ~ '^RZB-[A-F0-9]{64}$'),
  created_at timestamptz not null default now()
);
alter table private.booking_qr_tokens enable row level security;
revoke all on private.booking_qr_tokens from public, anon, authenticated;
-- Tokens are private, retrievable only by the booking's customer via the RPC.
-- They contain no PII and never grant access to someone holding a screenshot.

create function public.get_customer_booking_qr(p_booking_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_booking public.bookings%rowtype; v_token text; v_details jsonb;
begin
  if private.verified_google_email() is null then
    return jsonb_build_object('ok',false,'message','Autentificare Google verificată necesară.');
  end if;
  if not private.take_attempt('booking_qr_display',120) then
    return jsonb_build_object('ok',false,'message','Prea multe încercări. Reîncearcă peste 15 minute.');
  end if;
  select * into v_booking from public.bookings where id=p_booking_id and customer_id=auth.uid();
  if not found then return jsonb_build_object('ok',false,'message','Programare indisponibilă pentru acest cont.'); end if;

  insert into private.booking_qr_tokens(booking_id,token)
    values(v_booking.id,'RZB-'||upper(replace(gen_random_uuid()::text||gen_random_uuid()::text,'-','')))
    on conflict(booking_id) do nothing;
  select token into v_token from private.booking_qr_tokens where booking_id=v_booking.id;
  select jsonb_build_object('id',b.id,'businessId',b.business_id,'business',company.name,
    'calendarId',b.resource_id,'calendar',r.name,'service',e.name,'customer',b.customer_name,
    'startAt',b.start_at,'endAt',b.end_at,'status',b.status) into v_details
    from public.bookings b join public.businesses company on company.id=b.business_id
    join public.resources r on r.id=b.resource_id join public.event_types e on e.id=b.event_type_id
    where b.id=v_booking.id;
  return jsonb_build_object('ok',true,'booking',v_details,
    'payload','ro.rezerva.app://reservation?token='||v_token);
end;
$$;

create function public.resolve_booking_qr(p_token text,p_business_id uuid default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_booking jsonb;
begin
  if private.verified_google_email() is null then
    return jsonb_build_object('ok',false,'message','Autentificare Google verificată necesară.');
  end if;
  -- Return errors (rather than raising) so failed attempts stay counted.
  if not private.take_attempt('booking_qr_scan',120) then
    return jsonb_build_object('ok',false,'message','Prea multe scanări. Reîncearcă peste 15 minute.');
  end if;
  if p_token is null or length(p_token)<>68 or p_token !~ '^RZB-[A-F0-9]{64}$' then
    return jsonb_build_object('ok',false,'message','Cod invalid sau programare inaccesibilă.');
  end if;
  select jsonb_build_object('id',b.id,'businessId',b.business_id,'business',company.name,
    'calendarId',b.resource_id,'calendar',r.name,'service',e.name,'customer',b.customer_name,
    'email',b.customer_email_snapshot,'startAt',b.start_at,'endAt',b.end_at,'status',b.status)
    into v_booking
    from private.booking_qr_tokens q join public.bookings b on b.id=q.booking_id
    join public.businesses company on company.id=b.business_id
    join public.resources r on r.id=b.resource_id join public.event_types e on e.id=b.event_type_id
    where q.token=p_token and (p_business_id is null or b.business_id=p_business_id)
      and public.is_business_member(b.business_id) and public.can_read_calendar(b.resource_id);
  if v_booking is null then
    return jsonb_build_object('ok',false,'message','Cod invalid sau programare inaccesibilă.');
  end if;
  -- Both plans can inspect existing bookings. Scan never marks arrival/completion,
  -- changes status, consumes the QR, or returns its token to a business.
  return jsonb_build_object('ok',true,'booking',v_booking);
end;
$$;

revoke all on function public.get_customer_booking_qr(uuid) from public, anon;
revoke all on function public.resolve_booking_qr(text,uuid) from public, anon;
grant execute on function public.get_customer_booking_qr(uuid), public.resolve_booking_qr(text,uuid) to authenticated;
commit;
