-- Phase 3: let a technician or staff member correct actual visit times
-- without weakening the normal check-in/check-out protections. Every change
-- is preserved in an append-only audit table and a visible work-order event.

begin;

create table if not exists public.work_order_visit_corrections (
  id uuid primary key default gen_random_uuid(),
  visit_id uuid not null references public.work_order_visits(id) on delete restrict,
  work_order_id text not null references public.work_orders(id) on delete restrict,
  actor_id uuid not null references public.profiles(id) on delete restrict,
  actor_role text not null,
  old_check_in_at timestamptz not null,
  old_check_out_at timestamptz not null,
  new_check_in_at timestamptz not null,
  new_check_out_at timestamptz not null,
  reason text not null check (length(trim(reason)) >= 5),
  created_at timestamptz not null default now()
);

alter table public.work_order_visit_corrections enable row level security;

drop policy if exists work_order_visit_corrections_read
  on public.work_order_visit_corrections;
create policy work_order_visit_corrections_read
  on public.work_order_visit_corrections
  for select using (
    public.is_staff()
    or public.can_access_contractor_work_order(work_order_id)
  );

revoke all on public.work_order_visit_corrections from public, anon, authenticated;
grant select on public.work_order_visit_corrections to authenticated;
grant all on public.work_order_visit_corrections to service_role;

-- This transaction-scoped context is deliberately not exposed through the
-- API. The validated correction RPC inserts the row, and the existing visit
-- protection trigger consumes it during the same transaction. A custom GUC
-- alone would be spoofable by any role able to execute arbitrary SQL.
create table if not exists public.work_order_visit_correction_context (
  transaction_id bigint not null,
  visit_id uuid not null references public.work_order_visits(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (transaction_id, visit_id)
);

alter table public.work_order_visit_correction_context enable row level security;
revoke all on public.work_order_visit_correction_context
  from public, anon, authenticated, service_role;

create index if not exists work_order_visit_corrections_visit_created_idx
  on public.work_order_visit_corrections (visit_id, created_at desc);
create index if not exists work_order_visit_corrections_work_order_created_idx
  on public.work_order_visit_corrections (work_order_id, created_at desc);

-- Normal clients still cannot rewrite visit timestamps. The correction RPC
-- enables this narrow transaction-local path only after all validation.
create or replace function public.protect_work_order_visit()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor_id uuid := auth.uid();
  actor_role text := coalesce(auth.role(), '');
  actor_is_staff boolean := public.is_staff();
  actor_account_id uuid := public.current_contractor_account_id();
  assigned_contractor_id uuid;
  work_order_is_active boolean;
  correction_authorized boolean;
begin
  select
    work_order.contractor_id,
    work_order.deleted_at is null
  into
    assigned_contractor_id,
    work_order_is_active
  from public.work_orders work_order
  where work_order.id = new.work_order_id;

  if not found then
    raise exception 'Visit must reference an existing work order';
  end if;

  if new.check_in_activity_id is not null
     and not exists (
       select 1
       from public.activities activity
       where activity.id = new.check_in_activity_id
         and activity.work_order_id = new.work_order_id
     ) then
    raise exception 'Check-in activity must belong to the same work order';
  end if;

  if new.check_out_activity_id is not null
     and not exists (
       select 1
       from public.activities activity
       where activity.id = new.check_out_activity_id
         and activity.work_order_id = new.work_order_id
     ) then
    raise exception 'Check-out activity must belong to the same work order';
  end if;

  if tg_op = 'INSERT' then
    if not work_order_is_active then
      raise exception 'Cannot open a visit on an archived work order';
    end if;

    if assigned_contractor_id is null
       or new.contractor_id <> assigned_contractor_id then
      raise exception 'Visit contractor must match the assigned contractor';
    end if;

    if actor_role not in ('service_role', '') then
      new.checked_in_by := actor_id;

      if actor_is_staff and new.check_out_at is not null then
        new.checked_out_by := actor_id;
      end if;
    else
      new.checked_in_by := coalesce(new.checked_in_by, actor_id);
    end if;

    if new.checked_in_by is null then
      raise exception 'A check-in actor is required';
    end if;

    if actor_role not in ('service_role', '') and not actor_is_staff then
      if actor_id is null
         or actor_account_id is null
         or actor_account_id <> assigned_contractor_id
         or new.contractor_id <> actor_account_id
         or new.checked_in_by <> actor_id then
        raise exception 'Only a member of the assigned contractor can check in'
          using errcode = '42501';
      end if;

      if new.check_out_at is not null
         or new.checked_out_by is not null
         or new.check_out_activity_id is not null then
        raise exception 'Contractor check-in must create an open visit'
          using errcode = '42501';
      end if;
    end if;

    return new;
  end if;

  select exists (
    select 1
    from public.work_order_visit_correction_context correction_context
    where correction_context.transaction_id = txid_current()
      and correction_context.visit_id = old.id
  ) into correction_authorized;

  if correction_authorized then
    if new.work_order_id is distinct from old.work_order_id
       or new.contractor_id is distinct from old.contractor_id
       or new.checked_in_by is distinct from old.checked_in_by
       or new.checked_out_by is distinct from old.checked_out_by
       or new.check_in_activity_id is distinct from old.check_in_activity_id
       or new.check_out_activity_id is distinct from old.check_out_activity_id
       or new.created_at is distinct from old.created_at then
      raise exception 'Visit correction may only change actual start and stop times';
    end if;
    return new;
  end if;

  if new.work_order_id is distinct from old.work_order_id
     or new.contractor_id is distinct from old.contractor_id
     or new.check_in_at is distinct from old.check_in_at
     or new.checked_in_by is distinct from old.checked_in_by
     or new.check_in_activity_id is distinct from old.check_in_activity_id
     or new.created_at is distinct from old.created_at then
    raise exception 'Visit check-in identity and timestamps are immutable';
  end if;

  if actor_role not in ('service_role', '') and actor_is_staff then
    if new.check_out_at is null then
      new.checked_out_by := null;
    elsif old.check_out_at is null then
      new.checked_out_by := actor_id;
    else
      new.checked_out_by := old.checked_out_by;
    end if;
  end if;

  if actor_role not in ('service_role', '') and not actor_is_staff then
    if not work_order_is_active
       or actor_id is null
       or actor_account_id is null
       or actor_account_id <> assigned_contractor_id
       or old.contractor_id <> actor_account_id
       or (
         old.checked_in_by <> actor_id
         and not public.can_manage_contractor_company()
       ) then
      raise exception 'Only the visit author or a company admin can close this visit'
        using errcode = '42501';
    end if;

    if old.check_out_at is not null then
      raise exception 'A contractor cannot change a closed visit'
        using errcode = '42501';
    end if;

    if new.check_out_at is null then
      raise exception 'Contractor visit updates must close the visit'
        using errcode = '42501';
    end if;

    new.checked_out_by := actor_id;
  end if;

  return new;
end;
$$;

create or replace function public.correct_work_order_visit(
  p_visit_id uuid,
  p_check_in_at timestamptz,
  p_check_out_at timestamptz,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor public.profiles%rowtype;
  visit public.work_order_visits%rowtype;
  work_order public.work_orders%rowtype;
  corrected public.work_order_visits%rowtype;
  correction_id uuid;
  actor_is_staff boolean;
  clean_reason text := trim(coalesce(p_reason, ''));
begin
  if auth.uid() is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;

  select profile.* into actor
  from public.profiles profile
  where profile.id = auth.uid() and profile.active is not false;
  if not found then
    raise exception 'An active portal profile is required' using errcode = '42501';
  end if;

  select candidate.* into visit
  from public.work_order_visits candidate
  where candidate.id = p_visit_id
  for update;
  if not found then
    raise exception 'Visit not found';
  end if;

  select candidate.* into work_order
  from public.work_orders candidate
  where candidate.id = visit.work_order_id;
  if not found or work_order.deleted_at is not null then
    raise exception 'Work order is unavailable';
  end if;

  actor_is_staff := public.is_staff();

  if visit.check_out_at is null then
    raise exception 'Close the visit before correcting its actual times';
  end if;
  if length(clean_reason) < 5 then
    raise exception 'A correction reason of at least 5 characters is required';
  end if;
  if p_check_in_at is null or p_check_out_at is null then
    raise exception 'Both actual start and stop times are required';
  end if;
  if p_check_out_at < p_check_in_at then
    raise exception 'Actual stop time cannot be before actual start time';
  end if;
  if p_check_out_at > now() + interval '5 minutes'
     or p_check_in_at > now() + interval '5 minutes' then
    raise exception 'Visit times cannot be in the future';
  end if;
  if p_check_out_at - p_check_in_at > interval '72 hours' then
    raise exception 'A single visit cannot exceed 72 hours';
  end if;
  if p_check_in_at is not distinct from visit.check_in_at
     and p_check_out_at is not distinct from visit.check_out_at then
    raise exception 'The corrected times are unchanged';
  end if;

  if not actor_is_staff then
    if work_order.status::text = 'closed'
       or not public.can_access_contractor_work_order(visit.work_order_id)
       or (
         visit.checked_in_by <> actor.id
         and not public.can_manage_contractor_company()
       ) then
      raise exception 'You cannot correct this visit' using errcode = '42501';
    end if;
    if visit.check_out_at < now() - interval '24 hours' then
      raise exception 'Contractor corrections are limited to 24 hours after check-out'
        using errcode = '42501';
    end if;
  end if;

  if exists (
    select 1
    from public.invoices invoice
    where invoice.work_order_id = visit.work_order_id
      and invoice.invoice_type = 'staff'
      and invoice.document_kind::text <> 'capital_quote'
      and invoice.deleted_at is null
      and invoice.state::text in ('approved', 'paid')
  ) then
    raise exception 'Visit time is locked after the P1 invoice is approved';
  end if;

  if exists (
    select 1
    from public.work_order_visits other
    where other.id <> visit.id
      and other.checked_in_by = visit.checked_in_by
      and tstzrange(
        other.check_in_at,
        coalesce(other.check_out_at, now()),
        '[)'
      ) && tstzrange(p_check_in_at, p_check_out_at, '[)')
  ) then
    raise exception 'The corrected time overlaps another visit for this technician';
  end if;

  insert into public.work_order_visit_correction_context (
    transaction_id,
    visit_id
  ) values (
    txid_current(),
    visit.id
  );

  update public.work_order_visits
  set check_in_at = p_check_in_at,
      check_out_at = p_check_out_at,
      updated_at = now()
  where id = visit.id
  returning * into corrected;

  delete from public.work_order_visit_correction_context
  where transaction_id = txid_current()
    and visit_id = visit.id;

  insert into public.work_order_visit_corrections (
    visit_id,
    work_order_id,
    actor_id,
    actor_role,
    old_check_in_at,
    old_check_out_at,
    new_check_in_at,
    new_check_out_at,
    reason
  ) values (
    visit.id,
    visit.work_order_id,
    actor.id,
    actor.role::text,
    visit.check_in_at,
    visit.check_out_at,
    corrected.check_in_at,
    corrected.check_out_at,
    clean_reason
  ) returning id into correction_id;

  insert into public.activities (
    work_order_id,
    author_id,
    author_name,
    text,
    type,
    entered_by_role,
    is_staff_override,
    is_staff_only,
    event_key,
    event_data,
    requires_7eleven_sync,
    requires_contractor_attention
  ) values (
    visit.work_order_id,
    actor.id,
    actor.name,
    actor.name || ' corrected visit time: ' || clean_reason,
    'system',
    actor.role::text,
    actor_is_staff,
    false,
    'visit_time_corrected',
    jsonb_build_object(
      'correctionId', correction_id,
      'visitId', visit.id,
      'before', jsonb_build_object(
        'checkInAt', visit.check_in_at,
        'checkOutAt', visit.check_out_at
      ),
      'after', jsonb_build_object(
        'checkInAt', corrected.check_in_at,
        'checkOutAt', corrected.check_out_at
      ),
      'reason', clean_reason
    ),
    false,
    false
  );

  return jsonb_build_object(
    'correctionId', correction_id,
    'visit', to_jsonb(corrected)
  );
end;
$$;

revoke all on function public.correct_work_order_visit(uuid, timestamptz, timestamptz, text)
  from public, anon;
grant execute on function public.correct_work_order_visit(uuid, timestamptz, timestamptz, text)
  to authenticated, service_role;

commit;
