-- Rezerva multi-tenant schema. Run through Supabase migrations, not from the mobile client.
create extension if not exists pgcrypto;
create extension if not exists btree_gist;

create type public.member_role as enum ('owner', 'manager', 'staff');
create type public.booking_status as enum ('pending', 'confirmed', 'completed', 'cancelled', 'no_show');
create type public.subscription_status as enum ('trial', 'active', 'grace', 'expired', 'cancelled');
create type public.notification_status as enum ('pending', 'processing', 'sent', 'failed', 'cancelled');

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default '',
  email text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.businesses (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles(id),
  name text not null check (char_length(name) between 2 and 80),
  category text not null,
  address text not null,
  phone text,
  timezone text not null default 'Europe/Bucharest',
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.business_members (
  business_id uuid not null references public.businesses(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  role public.member_role not null default 'staff',
  created_at timestamptz not null default now(),
  primary key (business_id, user_id)
);

create table public.subscriptions (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null unique references public.profiles(id) on delete cascade,
  business_id uuid unique references public.businesses(id) on delete set null,
  plan_id text not null check (plan_id in ('small', 'large')),
  product_id text not null,
  status public.subscription_status not null default 'trial',
  store text not null default 'google_play',
  environment text not null default 'sandbox',
  expires_at timestamptz,
  updated_at timestamptz not null default now()
);

create table public.locations (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  name text not null,
  address text not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create table public.resources (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  location_id uuid references public.locations(id) on delete cascade,
  name text not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (id, business_id)
);

create table public.event_types (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  name text not null,
  description text not null default '',
  duration_minutes integer not null check (duration_minutes between 5 and 1440),
  price_cents integer check (price_cents is null or price_cents >= 0),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (id, business_id)
);

create table public.availability_rules (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  resource_id uuid not null references public.resources(id) on delete cascade,
  weekday smallint not null check (weekday between 1 and 7),
  start_time time not null,
  end_time time not null,
  valid_from date,
  valid_until date,
  check (start_time < end_time)
);

create table public.blocked_periods (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  resource_id uuid not null references public.resources(id) on delete cascade,
  start_at timestamptz not null,
  end_at timestamptz not null,
  reason text not null default '',
  check (start_at < end_at)
);

create table public.bookings (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  customer_id uuid not null references public.profiles(id),
  event_type_id uuid not null references public.event_types(id),
  resource_id uuid not null references public.resources(id),
  start_at timestamptz not null,
  end_at timestamptz not null,
  customer_name text not null check (char_length(customer_name) between 2 and 80),
  customer_email_snapshot text not null,
  status public.booking_status not null default 'confirmed',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (start_at < end_at),
  constraint no_resource_booking_overlap exclude using gist (
    resource_id with =,
    tstzrange(start_at, end_at, '[)') with &&
  ) where (status in ('pending', 'confirmed'))
);

create table public.notification_preferences (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  default_minutes integer not null default 60 check (default_minutes between 5 and 10080),
  push_enabled boolean not null default true,
  updated_at timestamptz not null default now()
);

create table public.device_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  token text not null unique,
  platform text not null check (platform in ('android', 'ios')),
  updated_at timestamptz not null default now()
);

create table public.notification_jobs (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references public.bookings(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  send_at timestamptz not null,
  title text not null,
  body text not null,
  status public.notification_status not null default 'pending',
  attempts integer not null default 0,
  last_error text,
  created_at timestamptz not null default now(),
  unique (booking_id, user_id, send_at)
);

create table public.notification_log (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  booking_id uuid references public.bookings(id) on delete cascade,
  title text not null,
  body text not null,
  read_at timestamptz,
  created_at timestamptz not null default now()
);

create index bookings_business_start_idx on public.bookings (business_id, start_at);
create index bookings_customer_start_idx on public.bookings (customer_id, start_at);
create index bookings_resource_start_idx on public.bookings (resource_id, start_at);
create index notification_jobs_due_idx on public.notification_jobs (status, send_at) where status = 'pending';
create index device_tokens_user_idx on public.device_tokens (user_id);

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = ''
as $$
begin
  insert into public.profiles (id, display_name, email)
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'full_name', split_part(coalesce(new.email, ''), '@', 1)),
    coalesce(new.email, '')
  );
  return new;
end;
$$;

create trigger on_auth_user_created
after insert on auth.users
for each row execute procedure public.handle_new_user();

create or replace function public.is_business_member(target_business_id uuid)
returns boolean
language sql
stable
security definer set search_path = ''
as $$
  select exists (
    select 1 from public.business_members
    where business_id = target_business_id and user_id = auth.uid()
  );
$$;

create or replace function public.is_business_admin(target_business_id uuid)
returns boolean
language sql
stable
security definer set search_path = ''
as $$
  select exists (
    select 1 from public.business_members
    where business_id = target_business_id
      and user_id = auth.uid()
      and role in ('owner', 'manager')
  );
$$;

create or replace function public.add_owner_membership()
returns trigger
language plpgsql
security definer set search_path = ''
as $$
begin
  insert into public.business_members (business_id, user_id, role)
  values (new.id, new.owner_id, 'owner');
  update public.subscriptions set business_id = new.id
  where owner_id = new.owner_id and business_id is null;
  return new;
end;
$$;

create trigger business_add_owner
after insert on public.businesses
for each row execute procedure public.add_owner_membership();

create or replace function public.create_booking(
  p_business_id uuid,
  p_event_type_id uuid,
  p_resource_id uuid,
  p_start_at timestamptz,
  p_customer_name text,
  p_reminder_minutes integer default 60
)
returns uuid
language plpgsql
security definer set search_path = ''
as $$
declare
  v_booking_id uuid;
  v_duration integer;
  v_end_at timestamptz;
  v_email text;
  v_business_name text;
  v_event_name text;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if p_reminder_minutes < 5 or p_reminder_minutes > 10080 then raise exception 'Invalid reminder'; end if;

  select duration_minutes, name into v_duration, v_event_name
  from public.event_types
  where id = p_event_type_id and business_id = p_business_id and is_active;
  if v_duration is null then raise exception 'Invalid event type'; end if;
  if not exists (select 1 from public.resources where id = p_resource_id and business_id = p_business_id and is_active) then
    raise exception 'Invalid resource';
  end if;
  if not exists (select 1 from public.businesses where id = p_business_id and is_active) then
    raise exception 'Business unavailable';
  end if;

  v_end_at := p_start_at + make_interval(mins => v_duration);
  v_email := coalesce(auth.jwt() ->> 'email', '');
  select name into v_business_name from public.businesses where id = p_business_id;

  insert into public.bookings (
    business_id, customer_id, event_type_id, resource_id, start_at, end_at,
    customer_name, customer_email_snapshot
  ) values (
    p_business_id, auth.uid(), p_event_type_id, p_resource_id, p_start_at, v_end_at,
    trim(p_customer_name), v_email
  ) returning id into v_booking_id;

  insert into public.notification_preferences (user_id, default_minutes)
  values (auth.uid(), p_reminder_minutes)
  on conflict (user_id) do update set default_minutes = excluded.default_minutes, updated_at = now();

  insert into public.notification_jobs (booking_id, user_id, send_at, title, body)
  values (
    v_booking_id,
    auth.uid(),
    p_start_at - make_interval(mins => p_reminder_minutes),
    'Programarea ta se apropie',
    v_business_name || ' · ' || v_event_name
  );

  return v_booking_id;
end;
$$;

revoke all on function public.create_booking(uuid, uuid, uuid, timestamptz, text, integer) from public;
grant execute on function public.create_booking(uuid, uuid, uuid, timestamptz, text, integer) to authenticated;

create or replace function public.setup_business(
  p_business_id uuid,
  p_service_name text,
  p_duration_minutes integer,
  p_price_cents integer,
  p_resource_name text,
  p_open_time time,
  p_close_time time,
  p_weekdays smallint[]
)
returns jsonb
language plpgsql
security definer set search_path = ''
as $$
declare
  v_location_id uuid;
  v_resource_id uuid;
  v_event_type_id uuid;
  v_address text;
  v_day smallint;
begin
  if not public.is_business_admin(p_business_id) then raise exception 'Permission denied'; end if;
  if p_duration_minutes < 5 or p_duration_minutes > 1440 then raise exception 'Invalid duration'; end if;
  if p_open_time >= p_close_time then raise exception 'Invalid hours'; end if;
  if coalesce(array_length(p_weekdays, 1), 0) = 0 then raise exception 'Choose at least one day'; end if;
  if not exists (
    select 1 from public.subscriptions
    where owner_id = auth.uid() and status in ('trial', 'active', 'grace')
      and (expires_at is null or expires_at > now())
  ) then raise exception 'Active subscription required'; end if;

  select address into v_address from public.businesses where id = p_business_id;
  insert into public.locations (business_id, name, address)
  values (p_business_id, 'Locația principală', v_address)
  returning id into v_location_id;

  insert into public.resources (business_id, location_id, name)
  values (p_business_id, v_location_id, trim(p_resource_name))
  returning id into v_resource_id;

  insert into public.event_types (business_id, name, duration_minutes, price_cents)
  values (p_business_id, trim(p_service_name), p_duration_minutes, p_price_cents)
  returning id into v_event_type_id;

  foreach v_day in array p_weekdays loop
    if v_day < 1 or v_day > 7 then raise exception 'Invalid weekday'; end if;
    insert into public.availability_rules (business_id, resource_id, weekday, start_time, end_time)
    values (p_business_id, v_resource_id, v_day, p_open_time, p_close_time);
  end loop;

  return jsonb_build_object('location_id', v_location_id, 'resource_id', v_resource_id, 'event_type_id', v_event_type_id);
end;
$$;

revoke all on function public.setup_business(uuid, text, integer, integer, text, time, time, smallint[]) from public;
grant execute on function public.setup_business(uuid, text, integer, integer, text, time, time, smallint[]) to authenticated;

alter table public.profiles enable row level security;
alter table public.businesses enable row level security;
alter table public.business_members enable row level security;
alter table public.subscriptions enable row level security;
alter table public.locations enable row level security;
alter table public.resources enable row level security;
alter table public.event_types enable row level security;
alter table public.availability_rules enable row level security;
alter table public.blocked_periods enable row level security;
alter table public.bookings enable row level security;
alter table public.notification_preferences enable row level security;
alter table public.device_tokens enable row level security;
alter table public.notification_jobs enable row level security;
alter table public.notification_log enable row level security;

create policy profiles_self_select on public.profiles for select to authenticated using (id = auth.uid());
create policy profiles_self_update on public.profiles for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

create policy businesses_search on public.businesses for select to authenticated using (is_active or public.is_business_member(id));
create policy businesses_create on public.businesses for insert to authenticated with check (owner_id = auth.uid());
create policy businesses_member_update on public.businesses for update to authenticated using (public.is_business_admin(id)) with check (public.is_business_admin(id));

create policy members_read on public.business_members for select to authenticated using (user_id = auth.uid() or public.is_business_member(business_id));
create policy members_manage on public.business_members for all to authenticated using (public.is_business_admin(business_id)) with check (public.is_business_admin(business_id));
create policy subscriptions_owner_read on public.subscriptions for select to authenticated using (owner_id = auth.uid());

create policy locations_read on public.locations for select to authenticated using (is_active or public.is_business_member(business_id));
create policy locations_manage on public.locations for all to authenticated using (public.is_business_admin(business_id)) with check (public.is_business_admin(business_id));
create policy resources_read on public.resources for select to authenticated using (is_active or public.is_business_member(business_id));
create policy resources_manage on public.resources for all to authenticated using (public.is_business_admin(business_id)) with check (public.is_business_admin(business_id));
create policy events_read on public.event_types for select to authenticated using (is_active or public.is_business_member(business_id));
create policy events_manage on public.event_types for all to authenticated using (public.is_business_admin(business_id)) with check (public.is_business_admin(business_id));
create policy availability_read on public.availability_rules for select to authenticated using (true);
create policy availability_manage on public.availability_rules for all to authenticated using (public.is_business_admin(business_id)) with check (public.is_business_admin(business_id));
create policy blocked_member_access on public.blocked_periods for all to authenticated using (public.is_business_admin(business_id)) with check (public.is_business_admin(business_id));

create policy bookings_customer_read on public.bookings for select to authenticated using (customer_id = auth.uid());
create policy bookings_business_read on public.bookings for select to authenticated using (public.is_business_member(business_id));
create policy bookings_customer_update on public.bookings for update to authenticated using (customer_id = auth.uid()) with check (customer_id = auth.uid());
create policy bookings_business_update on public.bookings for update to authenticated using (public.is_business_member(business_id)) with check (public.is_business_member(business_id));

create policy preferences_self on public.notification_preferences for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy tokens_self on public.device_tokens for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy jobs_self_read on public.notification_jobs for select to authenticated using (user_id = auth.uid());
create policy logs_self_read on public.notification_log for select to authenticated using (user_id = auth.uid());
create policy logs_self_update on public.notification_log for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
