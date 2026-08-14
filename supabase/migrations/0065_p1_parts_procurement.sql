-- Add a workflow for parts that P1 must purchase on a contractor's behalf.
-- Existing contractor-owned ordering/tracking remains unchanged. Alert
-- recipients and cutoff are data, so changes never require a deployment.

begin;

alter table public.wo_parts
  add column if not exists ordering_responsibility text not null default 'contractor',
  add column if not exists p1_order_status text,
  add column if not exists p1_requested_at timestamptz,
  add column if not exists p1_requested_by uuid
    references public.profiles(id) on delete set null,
  add column if not exists p1_resolved_at timestamptz,
  add column if not exists p1_resolved_by uuid
    references public.profiles(id) on delete set null;

do $constraints$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'wo_parts_ordering_responsibility_check'
      and conrelid = 'public.wo_parts'::regclass
  ) then
    alter table public.wo_parts
      add constraint wo_parts_ordering_responsibility_check
      check (ordering_responsibility in ('contractor', 'p1'));
  end if;

  alter table public.wo_parts
    drop constraint if exists wo_parts_p1_order_status_check;

  alter table public.wo_parts
    add constraint wo_parts_p1_order_status_check
    check (
      (
        ordering_responsibility = 'contractor'
        and p1_order_status is null
        and p1_requested_at is null
        and p1_requested_by is null
        and p1_resolved_at is null
        and p1_resolved_by is null
      )
      or (
        ordering_responsibility = 'p1'
        and p1_order_status is not null
        and p1_order_status in ('requested', 'ordered', 'received', 'cancelled')
        and p1_requested_at is not null
        and p1_requested_by is not null
      )
    );
end
$constraints$;

create index if not exists wo_parts_p1_procurement_queue
  on public.wo_parts(p1_order_status, p1_requested_at)
  where ordering_responsibility = 'p1';

-- Private one-transaction permits let the security-definer workflow update
-- procurement columns without trusting a caller-settable session variable.
-- An authenticated client cannot create one of these rows directly.
create table if not exists public.p1_part_procurement_transition_guards (
  transaction_id bigint not null,
  part_id uuid not null references public.wo_parts(id) on delete cascade,
  actor_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (transaction_id, part_id)
);

revoke all on public.p1_part_procurement_transition_guards
  from public, anon, authenticated, service_role;

create or replace function public.protect_p1_part_procurement_fields()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  procurement_changed boolean;
begin
  procurement_changed := case
    when tg_op = 'INSERT' then
      new.ordering_responsibility <> 'contractor'
      or new.p1_order_status is not null
      or new.p1_requested_at is not null
      or new.p1_requested_by is not null
      or new.p1_resolved_at is not null
      or new.p1_resolved_by is not null
    else
      new.ordering_responsibility is distinct from old.ordering_responsibility
      or new.p1_order_status is distinct from old.p1_order_status
      or new.p1_requested_at is distinct from old.p1_requested_at
      or new.p1_requested_by is distinct from old.p1_requested_by
      or new.p1_resolved_at is distinct from old.p1_resolved_at
      or new.p1_resolved_by is distinct from old.p1_resolved_by
  end;

  if procurement_changed
     and not exists (
       select 1
       from public.p1_part_procurement_transition_guards transition_guard
       where transition_guard.transaction_id = txid_current()
         and transition_guard.part_id = new.id
         and transition_guard.actor_id = auth.uid()
     ) then
    raise exception 'Use the P1 parts procurement workflow to change purchasing ownership'
      using errcode = '42501';
  end if;

  return new;
end;
$$;

drop trigger if exists protect_p1_part_procurement_fields_trigger
  on public.wo_parts;
create trigger protect_p1_part_procurement_fields_trigger
  before insert or update on public.wo_parts
  for each row execute function public.protect_p1_part_procurement_fields();

create or replace function public.request_p1_part_order(
  p_part_id uuid
)
returns public.wo_parts
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor_id uuid := auth.uid();
  actor_name text;
  part public.wo_parts%rowtype;
begin
  if actor_id is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;

  if public.is_staff() and public.is_invoice_controller() then
    raise exception 'Operational staff access required' using errcode = '42501';
  end if;

  select * into part
  from public.wo_parts
  where id = p_part_id
  for update;

  if not found then
    raise exception 'Part not found' using errcode = 'P0002';
  end if;

  if not exists (
    select 1
    from public.work_orders work_order
    where work_order.id = part.work_order_id
      and work_order.deleted_at is null
      and work_order.status <> 'closed'
  ) then
    raise exception 'P1 purchasing cannot be requested for a closed or deleted work order'
      using errcode = '23514';
  end if;

  if part.status = 'received' then
    raise exception 'A received part cannot be sent to P1 purchasing'
      using errcode = '23514';
  end if;

  if not public.is_staff()
     and not public.can_access_contractor_work_order(part.work_order_id) then
    raise exception 'You cannot request purchasing for this work order'
      using errcode = '42501';
  end if;

  if part.ordering_responsibility = 'p1'
     and part.p1_order_status in ('ordered', 'received') then
    raise exception 'P1 purchasing has already acted on this part'
      using errcode = '23514';
  end if;

  insert into public.p1_part_procurement_transition_guards (
    transaction_id,
    part_id,
    actor_id
  ) values (
    txid_current(),
    part.id,
    actor_id
  )
  on conflict (transaction_id, part_id) do update
  set actor_id = excluded.actor_id,
      created_at = now();

  update public.wo_parts
  set ordering_responsibility = 'p1',
      p1_order_status = 'requested',
      p1_requested_at = now(),
      p1_requested_by = actor_id,
      p1_resolved_at = null,
      p1_resolved_by = null,
      updated_at = now()
  where id = p_part_id
  returning * into part;

  delete from public.p1_part_procurement_transition_guards transition_guard
  where transition_guard.transaction_id = txid_current()
    and transition_guard.part_id = part.id;

  select profile.name into actor_name
  from public.profiles profile
  where profile.id = actor_id;

  insert into public.activities (
    work_order_id,
    author_id,
    author_name,
    text,
    type,
    event_key,
    event_data
  ) values (
    part.work_order_id,
    actor_id,
    coalesce(actor_name, 'Portal user'),
    format('P1 purchasing requested for part: %s.', part.description),
    'system',
    'p1_part_order_requested',
    jsonb_build_object(
      'partId', part.id,
      'description', part.description,
      'status', 'requested'
    )
  );

  return part;
end;
$$;

create or replace function public.set_p1_part_order_status(
  p_part_id uuid,
  p_status text
)
returns public.wo_parts
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor_id uuid := auth.uid();
  actor_name text;
  previous_status text;
  part public.wo_parts%rowtype;
begin
  if actor_id is null
     or not public.is_staff()
     or public.is_invoice_controller() then
    raise exception 'P1 staff access required' using errcode = '42501';
  end if;

  if p_status not in ('requested', 'ordered', 'received', 'cancelled') then
    raise exception 'Invalid P1 purchasing status' using errcode = '22023';
  end if;

  select * into part
  from public.wo_parts
  where id = p_part_id
  for update;

  if not found then
    raise exception 'Part not found' using errcode = 'P0002';
  end if;
  if part.ordering_responsibility <> 'p1' then
    raise exception 'This part is not assigned to P1 purchasing'
      using errcode = '23514';
  end if;
  if part.p1_order_status = 'received' and p_status <> 'received' then
    raise exception 'A received P1 part cannot be reopened'
      using errcode = '23514';
  end if;
  if part.p1_order_status = 'cancelled'
     and p_status not in ('cancelled', 'requested') then
    raise exception 'Reopen a cancelled request before advancing it'
      using errcode = '23514';
  end if;

  previous_status := part.p1_order_status;
  if previous_status = p_status then
    return part;
  end if;

  insert into public.p1_part_procurement_transition_guards (
    transaction_id,
    part_id,
    actor_id
  ) values (
    txid_current(),
    part.id,
    actor_id
  )
  on conflict (transaction_id, part_id) do update
  set actor_id = excluded.actor_id,
      created_at = now();

  update public.wo_parts
  set p1_order_status = p_status,
      p1_requested_at = case
        when p_status = 'requested' then now()
        else p1_requested_at
      end,
      p1_requested_by = case
        when p_status = 'requested' then actor_id
        else p1_requested_by
      end,
      p1_resolved_at = case
        when p_status in ('received', 'cancelled') then now()
        else null
      end,
      p1_resolved_by = case
        when p_status in ('received', 'cancelled') then actor_id
        else null
      end,
      updated_at = now()
  where id = p_part_id
  returning * into part;

  delete from public.p1_part_procurement_transition_guards transition_guard
  where transition_guard.transaction_id = txid_current()
    and transition_guard.part_id = part.id;

  select profile.name into actor_name
  from public.profiles profile
  where profile.id = actor_id;

  insert into public.activities (
    work_order_id,
    author_id,
    author_name,
    text,
    type,
    event_key,
    event_data
  ) values (
    part.work_order_id,
    actor_id,
    coalesce(actor_name, 'P1 staff'),
    format(
      'P1 purchasing for %s changed from %s to %s.',
      part.description,
      coalesce(previous_status, 'not requested'),
      p_status
    ),
    'system',
    'p1_part_order_status_changed',
    jsonb_build_object(
      'partId', part.id,
      'description', part.description,
      'from', previous_status,
      'to', p_status
    )
  );

  return part;
end;
$$;

revoke all on function public.protect_p1_part_procurement_fields()
  from public, anon, authenticated;
revoke all on function public.request_p1_part_order(uuid)
  from public, anon;
revoke all on function public.set_p1_part_order_status(uuid, text)
  from public, anon;
grant execute on function public.request_p1_part_order(uuid),
  public.set_p1_part_order_status(uuid, text)
  to authenticated, service_role;

create table if not exists public.p1_parts_alert_settings (
  singleton boolean primary key default true check (singleton),
  enabled boolean not null default false,
  timezone text not null default 'America/New_York',
  cutoff_time time,
  updated_by uuid references public.profiles(id) on delete set null,
  updated_at timestamptz not null default now(),
  constraint p1_parts_alert_timezone_present
    check (length(trim(timezone)) > 0)
);

insert into public.p1_parts_alert_settings (singleton)
values (true)
on conflict (singleton) do nothing;

create table if not exists public.p1_parts_alert_recipients (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null unique references public.profiles(id) on delete cascade,
  phone_e164 text not null,
  active boolean not null default true,
  added_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint p1_parts_alert_phone_e164
    check (phone_e164 ~ '^\+[1-9][0-9]{7,14}$')
);

create table if not exists public.p1_parts_alert_deliveries (
  id uuid primary key default gen_random_uuid(),
  recipient_id uuid not null
    references public.p1_parts_alert_recipients(id) on delete cascade,
  local_date date not null,
  request_signature text not null,
  status text not null default 'claimed'
    check (status in ('claimed', 'sent', 'failed')),
  attempt_count integer not null default 1 check (attempt_count > 0),
  claimed_at timestamptz not null default now(),
  completed_at timestamptz,
  provider_message_id text,
  error_message text,
  unique (recipient_id, local_date)
);

alter table public.p1_parts_alert_settings enable row level security;
alter table public.p1_parts_alert_recipients enable row level security;
alter table public.p1_parts_alert_deliveries enable row level security;

revoke all on public.p1_parts_alert_settings,
  public.p1_parts_alert_recipients,
  public.p1_parts_alert_deliveries
  from public, anon, authenticated;
grant all on public.p1_parts_alert_settings,
  public.p1_parts_alert_recipients,
  public.p1_parts_alert_deliveries
  to service_role;

create or replace function public.configure_p1_parts_alerts(
  p_actor_id uuid,
  p_enabled boolean,
  p_timezone text,
  p_cutoff_time time,
  p_recipients jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  requested_count integer;
  distinct_count integer;
begin
  if auth.role() <> 'service_role' then
    raise exception 'Service role required' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.profiles profile
    where profile.id = p_actor_id
      and profile.active = true
      and profile.role in ('manager', 'dispatcher', 'back_office')
  ) then
    raise exception 'Active staff actor required' using errcode = '42501';
  end if;
  if public.profile_has_staff_permission(p_actor_id, 'invoice_controller') then
    raise exception 'Operational staff access required' using errcode = '42501';
  end if;
  if nullif(trim(coalesce(p_timezone, '')), '') is null then
    raise exception 'Timezone is required' using errcode = '22023';
  end if;
  if jsonb_typeof(coalesce(p_recipients, '[]'::jsonb)) <> 'array' then
    raise exception 'Recipients must be an array' using errcode = '22023';
  end if;

  with requested as (
    select
      nullif(trim(item ->> 'profileId'), '')::uuid as profile_id,
      trim(item ->> 'phoneE164') as phone_e164,
      coalesce((item ->> 'active')::boolean, true) as active
    from jsonb_array_elements(coalesce(p_recipients, '[]'::jsonb)) item
  )
  select count(*), count(distinct profile_id)
  into requested_count, distinct_count
  from requested;

  if requested_count <> distinct_count then
    raise exception 'Each alert recipient may appear only once'
      using errcode = '22023';
  end if;

  if exists (
    with requested as (
      select
        nullif(trim(item ->> 'profileId'), '')::uuid as profile_id,
        trim(item ->> 'phoneE164') as phone_e164
      from jsonb_array_elements(coalesce(p_recipients, '[]'::jsonb)) item
    )
    select 1
    from requested
    left join public.profiles profile on profile.id = requested.profile_id
    where requested.profile_id is null
      or requested.phone_e164 !~ '^\+[1-9][0-9]{7,14}$'
      or profile.id is null
      or profile.active is not true
      or profile.role not in ('manager', 'dispatcher', 'back_office')
  ) then
    raise exception 'Every recipient must be active staff with a valid E.164 phone number'
      using errcode = '22023';
  end if;

  insert into public.p1_parts_alert_settings (
    singleton,
    enabled,
    timezone,
    cutoff_time,
    updated_by,
    updated_at
  ) values (
    true,
    coalesce(p_enabled, false),
    trim(p_timezone),
    p_cutoff_time,
    p_actor_id,
    now()
  )
  on conflict (singleton) do update
  set enabled = excluded.enabled,
      timezone = excluded.timezone,
      cutoff_time = excluded.cutoff_time,
      updated_by = excluded.updated_by,
      updated_at = excluded.updated_at;

  update public.p1_parts_alert_recipients recipient
  set active = false,
      updated_at = now()
  where recipient.active = true
    and not exists (
      select 1
      from jsonb_array_elements(coalesce(p_recipients, '[]'::jsonb)) item
      where nullif(trim(item ->> 'profileId'), '')::uuid = recipient.profile_id
        and coalesce((item ->> 'active')::boolean, true)
    );

  insert into public.p1_parts_alert_recipients (
    profile_id,
    phone_e164,
    active,
    added_by,
    updated_at
  )
  select
    nullif(trim(item ->> 'profileId'), '')::uuid,
    trim(item ->> 'phoneE164'),
    coalesce((item ->> 'active')::boolean, true),
    p_actor_id,
    now()
  from jsonb_array_elements(coalesce(p_recipients, '[]'::jsonb)) item
  on conflict (profile_id) do update
  set phone_e164 = excluded.phone_e164,
      active = excluded.active,
      updated_at = excluded.updated_at;

  return jsonb_build_object(
    'enabled', coalesce(p_enabled, false),
    'timezone', trim(p_timezone),
    'cutoffTime', p_cutoff_time,
    'recipientCount', (
      select count(*) from public.p1_parts_alert_recipients where active
    )
  );
end;
$$;

revoke all on function public.configure_p1_parts_alerts(
  uuid,
  boolean,
  text,
  time,
  jsonb
) from public, anon, authenticated;
grant execute on function public.configure_p1_parts_alerts(
  uuid,
  boolean,
  text,
  time,
  jsonb
) to service_role;

create or replace function public.claim_p1_parts_alert_delivery(
  p_recipient_id uuid,
  p_local_date date,
  p_request_signature text
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  delivery public.p1_parts_alert_deliveries%rowtype;
begin
  if auth.role() <> 'service_role' then
    raise exception 'Service role required' using errcode = '42501';
  end if;
  if p_recipient_id is null
     or p_local_date is null
     or nullif(trim(coalesce(p_request_signature, '')), '') is null then
    raise exception 'Recipient, local date, and request signature are required'
      using errcode = '22023';
  end if;

  select * into delivery
  from public.p1_parts_alert_deliveries
  where recipient_id = p_recipient_id
    and local_date = p_local_date
  for update;

  if found then
    if delivery.status = 'sent'
       or (delivery.status = 'claimed' and delivery.claimed_at > now() - interval '15 minutes') then
      return null;
    end if;

    update public.p1_parts_alert_deliveries
    set status = 'claimed',
        request_signature = trim(p_request_signature),
        attempt_count = attempt_count + 1,
        claimed_at = now(),
        completed_at = null,
        provider_message_id = null,
        error_message = null
    where id = delivery.id
    returning * into delivery;
    return delivery.id;
  end if;

  insert into public.p1_parts_alert_deliveries (
    recipient_id,
    local_date,
    request_signature
  ) values (
    p_recipient_id,
    p_local_date,
    trim(p_request_signature)
  )
  returning * into delivery;

  return delivery.id;
end;
$$;

create or replace function public.complete_p1_parts_alert_delivery(
  p_delivery_id uuid,
  p_status text,
  p_provider_message_id text default null,
  p_error_message text default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.role() <> 'service_role' then
    raise exception 'Service role required' using errcode = '42501';
  end if;
  if p_status not in ('sent', 'failed') then
    raise exception 'Delivery status must be sent or failed' using errcode = '22023';
  end if;

  update public.p1_parts_alert_deliveries
  set status = p_status,
      completed_at = now(),
      provider_message_id = nullif(trim(coalesce(p_provider_message_id, '')), ''),
      error_message = nullif(left(trim(coalesce(p_error_message, '')), 1000), '')
  where id = p_delivery_id
    and status = 'claimed';

  if not found then
    raise exception 'Claimed alert delivery not found' using errcode = 'P0002';
  end if;
end;
$$;

revoke all on function public.claim_p1_parts_alert_delivery(uuid, date, text)
  from public, anon, authenticated;
revoke all on function public.complete_p1_parts_alert_delivery(uuid, text, text, text)
  from public, anon, authenticated;
grant execute on function public.claim_p1_parts_alert_delivery(uuid, date, text),
  public.complete_p1_parts_alert_delivery(uuid, text, text, text)
  to service_role;

commit;
