-- Repair legacy visits that remained open after the parent work order moved to
-- an off-site field state, and make that parent/visit mismatch impossible for
-- future transactions. Normal Pause, capital-review checkout, and Completion
-- already update the parent and visit atomically; the deferred invariant checks
-- their final transaction state rather than their intermediate statement order.

begin;

create table public.work_order_visit_checkout_repairs (
  operation_id uuid primary key,
  visit_id uuid not null unique references public.work_order_visits(id) on delete restrict,
  work_order_id text not null references public.work_orders(id) on delete restrict,
  actor_id uuid not null references public.profiles(id) on delete restrict,
  technician_profile_id uuid references public.profiles(id) on delete restrict,
  activity_id uuid not null references public.activities(id) on delete restrict,
  assignment_version integer not null check (assignment_version >= 0),
  workflow_cycle integer not null check (workflow_cycle >= 0),
  lifecycle_version bigint not null check (lifecycle_version >= 0),
  check_in_at timestamptz not null,
  check_out_at timestamptz not null,
  reason text not null check (length(btrim(reason)) between 5 and 1000),
  created_at timestamptz not null default clock_timestamp(),
  constraint work_order_visit_checkout_repairs_time_order
    check (check_out_at >= check_in_at)
);

create index work_order_visit_checkout_repairs_work_order_created_idx
  on public.work_order_visit_checkout_repairs(work_order_id, created_at desc);

alter table public.work_order_visit_checkout_repairs enable row level security;

create policy work_order_visit_checkout_repairs_read
  on public.work_order_visit_checkout_repairs
  for select
  using (
    public.is_staff()
    or public.can_access_contractor_work_order(work_order_id)
  );

revoke all on public.work_order_visit_checkout_repairs
  from public, anon, authenticated, service_role;
grant select on public.work_order_visit_checkout_repairs to authenticated;
grant all on public.work_order_visit_checkout_repairs to service_role;

create function public.record_missed_work_order_visit_checkout_v1(
  p_visit_id uuid,
  p_expected_assignment_version integer,
  p_expected_workflow_cycle integer,
  p_expected_lifecycle_version bigint,
  p_operation_id uuid,
  p_check_out_at timestamptz,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor public.profiles%rowtype;
  v_visit public.work_order_visits%rowtype;
  v_work public.work_orders%rowtype;
  v_existing public.work_order_visit_checkout_repairs%rowtype;
  v_activity uuid;
  v_reason text := btrim(coalesce(p_reason, ''));
  v_technician_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;
  if p_visit_id is null or p_operation_id is null
     or p_expected_assignment_version is null or p_expected_assignment_version < 0
     or p_expected_workflow_cycle is null or p_expected_workflow_cycle < 0
     or p_expected_lifecycle_version is null or p_expected_lifecycle_version < 0
     or p_check_out_at is null or not isfinite(p_check_out_at)
     or length(v_reason) not between 5 and 1000 then
    raise exception 'Visit, current work-order version, checkout time, and a reason of at least 5 characters are required'
      using errcode = '22023';
  end if;
  if p_check_out_at > clock_timestamp() + interval '5 minutes' then
    raise exception 'Checkout time cannot be in the future' using errcode = 'PT409';
  end if;

  select candidate.* into v_visit
  from public.work_order_visits candidate
  where candidate.id = p_visit_id;
  if not found then
    raise exception 'Visit not found' using errcode = 'P0002';
  end if;

  v_actor := public.require_work_order_lifecycle_actor(v_visit.work_order_id);
  select candidate.* into v_work
  from public.work_orders candidate
  where candidate.id = v_visit.work_order_id
    and candidate.deleted_at is null
  for update;
  if not found then
    raise exception 'Work order not found' using errcode = 'P0002';
  end if;
  -- Re-check access after acquiring the parent lock because assignment may
  -- have changed while this request was waiting.
  v_actor := public.require_work_order_lifecycle_actor(v_visit.work_order_id);
  select candidate.* into strict v_visit
  from public.work_order_visits candidate
  where candidate.id = p_visit_id
    and candidate.work_order_id = v_work.id
  for update;

  select repair.* into v_existing
  from public.work_order_visit_checkout_repairs repair
  where repair.operation_id = p_operation_id;
  if found then
    if v_existing.visit_id is distinct from p_visit_id
       or v_existing.actor_id is distinct from v_actor.id
       or v_existing.assignment_version is distinct from p_expected_assignment_version
       or v_existing.workflow_cycle is distinct from p_expected_workflow_cycle
       or v_existing.lifecycle_version is distinct from p_expected_lifecycle_version
       or v_existing.check_out_at is distinct from p_check_out_at
       or v_existing.reason is distinct from v_reason then
      raise exception 'Operation identity was reused with different input' using errcode = 'PT409';
    end if;
    if v_work.contractor_assignment_version is distinct from v_existing.assignment_version
       or v_work.workflow_cycle is distinct from v_existing.workflow_cycle
       or v_work.lifecycle_version is distinct from v_existing.lifecycle_version
       or v_visit.check_out_at is distinct from v_existing.check_out_at
       or v_visit.checked_out_by is distinct from v_existing.actor_id
       or not exists (
         select 1 from public.activities activity
         where activity.id = v_existing.activity_id
           and activity.work_order_id = v_existing.work_order_id
           and activity.author_id = v_existing.actor_id
           and activity.event_key = 'visit_time_corrected'
           and activity.deleted_at is null
       ) then
      raise exception 'Work order changed after this operation. Refresh and reconcile.'
        using errcode = 'PT409';
    end if;
    return jsonb_build_object(
      'applied', false,
      'reason', 'already_applied',
      'operationId', v_existing.operation_id,
      'workOrderId', v_existing.work_order_id,
      'visitId', v_existing.visit_id,
      'activityId', v_existing.activity_id,
      'checkedOutAt', v_existing.check_out_at
    );
  end if;

  if v_work.contractor_assignment_version <> p_expected_assignment_version
     or v_work.workflow_cycle <> p_expected_workflow_cycle
     or v_work.lifecycle_version <> p_expected_lifecycle_version then
    raise exception 'Work order changed. Refresh and try again.' using errcode = 'PT409';
  end if;
  if v_work.billing_only or v_work.status = 'closed'
     or v_work.functional_status::text not in (
       'Awaiting Parts',
       'Completed'
     ) then
    raise exception 'Missed checkout is available only after field work has moved off site'
      using errcode = 'PT409';
  end if;
  if v_visit.check_out_at is not null then
    raise exception 'This visit is already checked out' using errcode = 'PT409';
  end if;
  if v_visit.contractor_id is distinct from v_work.contractor_id then
    raise exception 'The active visit contractor does not match this work order'
      using errcode = 'PT409';
  end if;
  if p_check_out_at < v_visit.check_in_at then
    raise exception 'Checkout time cannot be before active visit check-in'
      using errcode = 'PT409';
  end if;
  if p_check_out_at - v_visit.check_in_at > interval '72 hours' then
    raise exception 'A single visit cannot exceed 72 hours' using errcode = '22023';
  end if;

  v_technician_id := coalesce(v_visit.technician_profile_id, v_visit.checked_in_by);
  if not public.is_staff() and not (
    v_visit.checked_in_by = v_actor.id
    or v_technician_id = v_actor.id
    or public.can_manage_contractor_company()
    or public.contractor_team_lead_can_manage_profile(v_technician_id, v_visit.contractor_id)
  ) then
    raise exception 'Only the visit technician, acting lead, or company admin can record this checkout'
      using errcode = '42501';
  end if;

  if exists (
    select 1
    from public.invoices invoice
    where invoice.work_order_id = v_work.id
      and invoice.invoice_type = 'staff'
      and invoice.document_kind::text <> 'capital_quote'
      and invoice.deleted_at is null
      and invoice.state::text in ('approved', 'paid')
  ) then
    raise exception 'Visit time is locked after the P1 invoice is approved'
      using errcode = 'PT409';
  end if;

  if exists (
    select 1
    from public.work_order_visits other
    where other.id <> v_visit.id
      and coalesce(other.technician_profile_id, other.checked_in_by) = v_technician_id
      and tstzrange(other.check_in_at, coalesce(other.check_out_at, clock_timestamp()), '[)')
        && tstzrange(v_visit.check_in_at, p_check_out_at, '[)')
  ) then
    raise exception 'The checkout time overlaps another visit for this technician'
      using errcode = 'PT409';
  end if;

  insert into public.work_order_lifecycle_transition_guards(
    transaction_id, work_order_id, actor_id, command_kind,
    parent_allowed, visit_allowed, event_key
  ) values (
    txid_current(), v_work.id, v_actor.id, 'repair_checkout',
    false, true, 'visit_time_corrected'
  );

  insert into public.activities(
    work_order_id, author_id, author_name, text, type, entered_by_role,
    is_staff_override, is_staff_only, event_key, event_data,
    requires_7eleven_sync, requires_contractor_attention
  ) values (
    v_work.id,
    v_actor.id,
    v_actor.name,
    v_actor.name || ' recorded a missed checkout: ' || v_reason,
    'system',
    v_actor.role::text,
    public.is_staff(),
    false,
    'visit_time_corrected',
    jsonb_build_object(
      'operationId', p_operation_id,
      'visitId', v_visit.id,
      'actedByProfileId', v_actor.id,
      'technicianProfileId', v_technician_id,
      'onBehalfOfTechnician', v_actor.role = 'contractor' and v_actor.id <> v_technician_id,
      'before', jsonb_build_object('checkInAt', v_visit.check_in_at, 'checkOutAt', null),
      'after', jsonb_build_object('checkInAt', v_visit.check_in_at, 'checkOutAt', p_check_out_at),
      'reason', v_reason,
      'repairKind', 'missed_checkout'
    ),
    false,
    false
  ) returning id into v_activity;

  update public.work_order_visits
  set check_out_at = p_check_out_at,
      checked_out_by = v_actor.id,
      check_out_activity_id = v_activity,
      updated_at = clock_timestamp()
  where id = v_visit.id;

  insert into public.work_order_visit_checkout_repairs(
    operation_id, visit_id, work_order_id, actor_id, technician_profile_id,
    activity_id, assignment_version, workflow_cycle, lifecycle_version,
    check_in_at, check_out_at, reason
  ) values (
    p_operation_id, v_visit.id, v_work.id, v_actor.id, v_technician_id,
    v_activity, v_work.contractor_assignment_version, v_work.workflow_cycle,
    v_work.lifecycle_version, v_visit.check_in_at, p_check_out_at, v_reason
  );

  delete from public.work_order_lifecycle_transition_guards guard
  where guard.transaction_id = txid_current()
    and guard.work_order_id = v_work.id
    and guard.command_kind = 'repair_checkout';

  return jsonb_build_object(
    'applied', true,
    'reason', 'applied',
    'operationId', p_operation_id,
    'workOrderId', v_work.id,
    'visitId', v_visit.id,
    'activityId', v_activity,
    'checkedOutAt', p_check_out_at
  );
end
$$;

comment on function public.record_missed_work_order_visit_checkout_v1(uuid, integer, integer, bigint, uuid, timestamptz, text) is
  'Closes one legacy stranded visit without changing the parent field status. Requires current work-order versions, an actual checkout time, a reason, bounded technician scope, and immutable audit evidence.';

revoke all on function public.record_missed_work_order_visit_checkout_v1(uuid, integer, integer, bigint, uuid, timestamptz, text)
  from public, anon, authenticated, service_role;
grant execute on function public.record_missed_work_order_visit_checkout_v1(uuid, integer, integer, bigint, uuid, timestamptz, text)
  to authenticated;

create function public.assert_offsite_work_order_has_no_open_visit()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_work_order_id text;
begin
  if tg_table_name = 'work_orders' then
    v_work_order_id := new.id;
  else
    v_work_order_id := new.work_order_id;
  end if;
  if exists (
    select 1
    from public.work_orders work_order
    join public.work_order_visits visit
      on visit.work_order_id = work_order.id
     and visit.check_out_at is null
    where work_order.id = v_work_order_id
      and work_order.deleted_at is null
      and work_order.functional_status::text in (
        'Awaiting Parts',
        'Completed'
      )
  ) then
    raise exception 'An off-site work order cannot retain an open field visit. Record checkout in the same workflow action.'
      using errcode = '23514';
  end if;
  return null;
end
$$;

revoke all on function public.assert_offsite_work_order_has_no_open_visit()
  from public, anon, authenticated, service_role;

create constraint trigger work_orders_offsite_visit_closed
  after insert or update of functional_status on public.work_orders
  deferrable initially deferred
  for each row execute function public.assert_offsite_work_order_has_no_open_visit();

create constraint trigger work_order_visits_offsite_parent_consistent
  after insert or update of check_out_at, work_order_id on public.work_order_visits
  deferrable initially deferred
  for each row execute function public.assert_offsite_work_order_has_no_open_visit();

commit;
