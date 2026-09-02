-- Keep Capital as an additional staff view instead of treating it as a
-- contractor-assignment dead end. Assignment changes retain the staff-owned
-- capital lifecycle and billing documents, while the existing privacy
-- boundary still archives and clears every outgoing-contractor work product.

begin;

-- Assignment changes are lifecycle transitions, not generic row edits. A
-- private transaction permit keeps every authenticated caller on the locked,
-- versioned RPC path while preserving service-role recovery access.
create table if not exists public.work_order_assignment_transition_guards (
  transaction_id bigint not null,
  work_order_id text not null
    references public.work_orders(id) on delete cascade,
  actor_id uuid not null
    references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (transaction_id, work_order_id)
);

alter table public.work_order_assignment_transition_guards
  enable row level security;

revoke all on public.work_order_assignment_transition_guards
  from public, anon, authenticated, service_role;

-- Re-check the contractor owner after taking the parent-row lock. This makes
-- invoice attachment serialize with reassignment in either lock order: an
-- insert that started for the former contractor cannot commit after the work
-- order has crossed to a new assignment.
create or replace function public.guard_invoice_active_work_order()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_work_order public.work_orders%rowtype;
begin
  if new.work_order_id is null
     or (
       tg_op = 'UPDATE'
       and new.work_order_id is not distinct from old.work_order_id
       and new.contractor_id is not distinct from old.contractor_id
       and not (
         old.deleted_at is not null
         and new.deleted_at is null
       )
     ) then
    return new;
  end if;

  select work_order.*
  into v_work_order
  from public.work_orders work_order
  where work_order.id = new.work_order_id
    and work_order.deleted_at is null
  for share;

  if not found then
    raise exception 'Invoices cannot be attached to an archived work order'
      using errcode = '23514';
  end if;

  if new.invoice_type = 'contractor'
     and (
       new.contractor_id is null
       or new.contractor_id is distinct from v_work_order.contractor_id
       or v_work_order.contractor_assignment_started_at is null
       or coalesce(new.created_at, clock_timestamp()) <
         v_work_order.contractor_assignment_started_at
     ) then
    raise exception 'Contractor invoices must belong to the current work-order assignment'
      using errcode = 'PT409';
  end if;

  return new;
end;
$$;

drop trigger if exists guard_invoice_active_work_order_trigger
  on public.invoices;
create trigger guard_invoice_active_work_order_trigger
  before insert or update of work_order_id, contractor_id, deleted_at
  on public.invoices
  for each row execute function public.guard_invoice_active_work_order();

revoke all on function public.guard_invoice_active_work_order()
  from public, anon, authenticated;

-- Staff retain technician-assignment history. A contractor company can read
-- only technician rows from its current work-order assignment boundary, so a
-- newly assigned company never inherits the former company's roster/history.
drop policy if exists work_order_technician_assignments_read
  on public.work_order_technician_assignments;
create policy work_order_technician_assignments_read
  on public.work_order_technician_assignments
  for select using (
    public.is_staff()
    or (
      public.can_manage_work_order_technician(work_order_id)
      and exists (
        select 1
        from public.work_orders work_order
        join public.contractor_technicians technician
          on technician.profile_id =
            work_order_technician_assignments.technician_profile_id
         and technician.contractor_id = work_order.contractor_id
        where work_order.id =
          work_order_technician_assignments.work_order_id
          and work_order.deleted_at is null
          and work_order.contractor_assignment_started_at is not null
          and work_order_technician_assignments.assigned_at >=
            work_order.contractor_assignment_started_at
      )
    )
  );

-- Historical intake messages could set the capital status without setting
-- its canonical classification bit. Repair only that inconsistent shape and
-- avoid making old calls appear newly updated.
alter table public.work_orders disable trigger touch_wo;

update public.work_orders work_order
set is_capital = true
where work_order.deleted_at is null
  and (
    work_order.status::text in ('capital', 'pending_capital_completion')
    or exists (
      select 1
      from public.invoices capital_quote
      where capital_quote.work_order_id = work_order.id
        and capital_quote.invoice_type = 'staff'
        and capital_quote.document_kind = 'capital_quote'
        and capital_quote.deleted_at is null
        and not exists (
          select 1
          from public.activities decline_activity
          where decline_activity.work_order_id = work_order.id
            and decline_activity.created_at >= capital_quote.created_at
            and (
              decline_activity.event_key = 'capital_declined'
              or decline_activity.text ilike 'Capital replacement declined%'
            )
        )
    )
  )
  and not coalesce(work_order.is_capital, false);

alter table public.work_orders enable trigger touch_wo;

create or replace function public.protect_work_order_assignment_boundary()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  boundary_at timestamptz := clock_timestamp();
  actor_role text := coalesce(auth.role(), '');
  preserve_capital_identity boolean := false;
  preserve_capital_stage boolean := false;
  assignment_transition_guarded boolean := false;
begin
  if tg_op = 'INSERT' then
    if new.contractor_id is null then
      new.contractor_assignment_started_at := null;
      new.contractor_assignment_version := 0;
    else
      new.contractor_assignment_started_at := coalesce(
        new.contractor_assignment_started_at,
        new.dispatched_at,
        boundary_at
      );
      new.contractor_assignment_version := greatest(
        coalesce(new.contractor_assignment_version, 0),
        1
      );
    end if;
    return new;
  end if;

  if new.contractor_id is not distinct from old.contractor_id then
    -- Assignment boundaries are system-owned and cannot be edited directly.
    new.contractor_assignment_started_at := old.contractor_assignment_started_at;
    new.contractor_assignment_version := old.contractor_assignment_version;
    return new;
  end if;

  if actor_role not in ('service_role', '') then
    select exists (
      select 1
      from public.work_order_assignment_transition_guards transition_guard
      where transition_guard.transaction_id = txid_current()
        and transition_guard.work_order_id = new.id
        and transition_guard.actor_id = auth.uid()
    ) into assignment_transition_guarded;

    if not assignment_transition_guarded then
      raise exception 'Work-order assignments must use the guarded transition workflow'
        using errcode = '42501';
    end if;
  end if;

  preserve_capital_identity := coalesce(old.is_capital, false)
    or old.status::text in ('capital', 'pending_capital_completion');
  preserve_capital_stage := old.status::text in (
    'capital',
    'pending_capital_completion'
  );

  if old.contractor_id is not null then
    insert into public.work_order_assignment_history (
      work_order_id,
      contractor_id,
      next_contractor_id,
      assignment_version,
      assignment_started_at,
      assignment_ended_at,
      assignment_ended_by,
      workflow_snapshot
    ) values (
      old.id,
      old.contractor_id,
      new.contractor_id,
      greatest(old.contractor_assignment_version, 1),
      old.contractor_assignment_started_at,
      boundary_at,
      auth.uid(),
      jsonb_build_object(
        'status', old.status,
        'functionalStatus', old.functional_status,
        'eta', old.eta,
        'dispatchedAt', old.dispatched_at,
        'startTime', old.start_time,
        'endTime', old.end_time,
        'technicianOnJob', old.technician_on_job,
        'assetMake', old.asset_make,
        'assetModel', old.asset_model,
        'assetSerial', old.asset_serial,
        'assetYear', old.asset_year,
        'resolutionCode', old.resolution_code,
        'resolutionNotes', old.resolution_notes,
        'partNeeded', old.part_needed,
        'partEta', old.part_eta,
        'invoiceTotal', old.invoice_total,
        'repairQuote', old.repair_quote,
        'installQuote', old.install_quote,
        'capitalNotes', old.capital_notes,
        'isCapital', old.is_capital,
        'capitalStatus', old.capital_status,
        'nteFlagged', old.nte_flagged,
        'nteFlagAmount', old.nte_flag_amount
      )
    );

    -- These values belong to the outgoing field assignment. The immutable
    -- staff history above retains them, but the receiving contractor starts
    -- with a clean operational workspace.
    new.eta := null;
    new.start_time := null;
    new.end_time := null;
    new.technician_on_job := null;
    new.asset_make := null;
    new.asset_model := null;
    new.asset_serial := null;
    new.asset_year := null;
    new.resolution_code := null;
    new.resolution_notes := null;
    new.part_needed := null;
    new.part_eta := null;
    new.invoice_total := null;
    new.repair_quote := null;
    new.install_quote := null;
    new.capital_notes := null;
    new.nte_flagged := false;
    new.nte_flag_amount := null;
  end if;

  -- Capital identity and approval state are P1-owned lifecycle data, not the
  -- outgoing contractor's field output. Linked staff quote/invoice rows are
  -- untouched because the assignment transition updates work_orders only.
  new.is_capital := preserve_capital_identity;
  new.capital_status := case
    when preserve_capital_identity then old.capital_status
    else null
  end;
  new.contractor_assignment_version := old.contractor_assignment_version + 1;

  if new.contractor_id is null then
    new.contractor_assignment_started_at := null;
    new.dispatched_at := null;
    if preserve_capital_stage then
      new.status := old.status;
      new.functional_status := old.functional_status;
    else
      new.status := 'unassigned';
      new.functional_status := 'New';
    end if;
  else
    new.contractor_assignment_started_at := boundary_at;
    new.dispatched_at := boundary_at;
    if preserve_capital_stage then
      new.status := old.status;
      new.functional_status := old.functional_status;
    else
      new.status := 'assigned';
      new.functional_status := 'Dispatched';
    end if;
  end if;

  return new;
end;
$$;

comment on function public.protect_work_order_assignment_boundary() is
  'Archives outgoing contractor work, clears the receiving assignment, and preserves P1-owned capital lifecycle state.';

revoke all on function public.protect_work_order_assignment_boundary()
  from public, anon, authenticated;
grant execute on function public.protect_work_order_assignment_boundary()
  to service_role;

create or replace function public.transition_work_order_contractor(
  p_work_order_id text,
  p_new_contractor_id uuid,
  p_expected_assignment_version integer
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor public.profiles%rowtype;
  v_work_order public.work_orders%rowtype;
  v_updated public.work_orders%rowtype;
  v_outgoing_name text;
  v_new_contractor public.profiles%rowtype;
  v_delivery public.contractor_assignment_transition_deliveries%rowtype;
  v_transition_reason text;
  v_activity_text text;
  v_event_key text;
  v_capital_identity boolean := false;
  v_capital_stage boolean := false;
  v_unresolved_contractor_invoices integer := 0;
  v_now timestamptz := clock_timestamp();
begin
  if nullif(trim(coalesce(p_work_order_id, '')), '') is null then
    raise exception 'Work order is required'
      using errcode = '22023';
  end if;

  if p_expected_assignment_version is null
     or p_expected_assignment_version < 0 then
    raise exception 'Expected assignment version is required'
      using errcode = '22023';
  end if;

  select profile.*
  into v_actor
  from public.profiles profile
  where profile.id = auth.uid()
    and profile.active = true
    and profile.role in ('manager', 'dispatcher', 'back_office')
    and not public.profile_has_staff_permission(
      profile.id,
      'invoice_controller'
    );

  if not found then
    raise exception 'Active operational P1 staff required'
      using errcode = '42501';
  end if;

  select work_order.*
  into v_work_order
  from public.work_orders work_order
  where work_order.id = trim(p_work_order_id)
    and work_order.deleted_at is null
  for update;

  if not found then
    raise exception 'Active work order not found'
      using errcode = 'P0002';
  end if;

  if v_work_order.contractor_assignment_version
       <> p_expected_assignment_version then
    raise exception 'Work-order assignment changed; refresh and try again'
      using errcode = 'PT409';
  end if;

  if v_work_order.contractor_id is not distinct from p_new_contractor_id then
    raise exception 'Work order is already in that assignment state'
      using errcode = 'PT409';
  end if;

  if v_work_order.billing_only then
    raise exception 'Billing-only work orders cannot be dispatched'
      using errcode = 'PT409';
  end if;

  v_capital_identity := coalesce(v_work_order.is_capital, false)
    or v_work_order.status::text in (
      'capital',
      'pending_capital_completion'
    );
  v_capital_stage := v_work_order.status::text in (
    'capital',
    'pending_capital_completion'
  );

  if v_work_order.contractor_id is null then
    if p_new_contractor_id is null
       or (
         not v_capital_stage
         and (
           v_work_order.status::text <> 'unassigned'
           or v_work_order.functional_status::text is distinct from 'New'
         )
       ) then
      raise exception 'Only a new unassigned or active capital work order can be assigned'
        using errcode = 'PT409';
    end if;
  elsif v_work_order.status::text not in (
    'assigned',
    'wip',
    'parts',
    'capital',
    'pending_capital_completion'
  ) then
    raise exception 'Only an active field or capital work order can be reassigned or unassigned'
      using errcode = 'PT409';
  end if;

  -- Capital calls cannot use the duplicate workflow to retain an outgoing
  -- contractor's correction access. Do not cross the assignment boundary
  -- while that contractor still owns an unresolved invoice.
  if v_capital_identity and v_work_order.contractor_id is not null then
    select count(*)::integer
    into v_unresolved_contractor_invoices
    from public.invoices invoice
    where invoice.work_order_id = v_work_order.id
      and invoice.invoice_type = 'contractor'
      and invoice.contractor_id = v_work_order.contractor_id
      and invoice.deleted_at is null
      and (
        v_work_order.contractor_assignment_started_at is null
        or invoice.created_at >=
          v_work_order.contractor_assignment_started_at
      )
      and invoice.state not in ('approved', 'paid');

    if v_unresolved_contractor_invoices > 0 then
      raise exception 'Resolve or remove % current contractor invoice(s) before changing this capital assignment',
        v_unresolved_contractor_invoices
        using errcode = 'PT409';
    end if;

  end if;

  if p_new_contractor_id is not null then
    select profile.*
    into v_new_contractor
    from public.profiles profile
    where profile.id = p_new_contractor_id
      and profile.role = 'contractor'
      and profile.active = true
      and profile.is_assignable = true;

    if not found then
      raise exception 'Active assignable contractor not found'
        using errcode = 'P0002';
    end if;
  end if;

  if v_work_order.contractor_id is null then
    v_transition_reason := 'assigned';
    v_activity_text := format(
      'Dispatched to %s%s.',
      v_new_contractor.name,
      case
        when nullif(trim(coalesce(v_new_contractor.company, '')), '') is null
          then ''
        else ' (' || trim(v_new_contractor.company) || ')'
      end
    );
  else
    select coalesce(nullif(trim(profile.name), ''), 'Contractor')
    into v_outgoing_name
    from public.profiles profile
    where profile.id = v_work_order.contractor_id;

    if p_new_contractor_id is null then
      v_transition_reason := 'unassigned';
      v_activity_text := format(
        'Work order unassigned by %s.',
        v_actor.name
      );
    else
      v_transition_reason := 'reassigned';
      v_activity_text := format(
        'Reassigned from %s to %s by %s.',
        coalesce(v_outgoing_name, 'Contractor'),
        v_new_contractor.name,
        v_actor.name
      );
    end if;
  end if;

  insert into public.work_order_assignment_transition_guards (
    transaction_id,
    work_order_id,
    actor_id
  ) values (
    txid_current(),
    v_work_order.id,
    v_actor.id
  )
  on conflict (transaction_id, work_order_id) do update
  set actor_id = excluded.actor_id,
      created_at = now();

  update public.work_orders work_order
  set contractor_id = p_new_contractor_id,
      updated_at = v_now
  where work_order.id = v_work_order.id
    and work_order.deleted_at is null
  returning work_order.* into v_updated;

  if not found then
    raise exception 'Work-order assignment conflicted with another change'
      using errcode = 'PT409';
  end if;

  delete from public.work_order_assignment_transition_guards transition_guard
  where transition_guard.transaction_id = txid_current()
    and transition_guard.work_order_id = v_work_order.id;

  insert into public.activities (
    work_order_id,
    author_id,
    author_name,
    text,
    type,
    activity_channel,
    entered_by_role,
    is_staff_override,
    is_staff_only,
    requires_7eleven_sync,
    requires_contractor_attention,
    event_key,
    event_data,
    contractor_assignment_version,
    workflow_cycle,
    created_at
  ) values (
    v_updated.id,
    v_actor.id,
    v_actor.name,
    v_activity_text,
    'system',
    'system_event',
    v_actor.role::text,
    false,
    true,
    false,
    false,
    case v_transition_reason
      when 'assigned' then 'work_order_assignment'
      when 'reassigned' then 'work_order_reassigned'
      else 'work_order_unassigned'
    end,
    jsonb_build_object(
      'action', v_transition_reason,
      'previousContractorId', v_work_order.contractor_id,
      'newContractorId', p_new_contractor_id,
      'assignmentVersion', v_updated.contractor_assignment_version,
      'capitalStagePreserved', v_capital_stage,
      'changedBy', v_actor.id
    ),
    v_updated.contractor_assignment_version,
    v_updated.workflow_cycle,
    v_now
  );

  if v_work_order.contractor_id is not null then
    v_event_key := 'assignment:'
      || v_work_order.id
      || ':'
      || greatest(v_work_order.contractor_assignment_version, 1)::text;

    select delivery.*
    into v_delivery
    from public.contractor_assignment_transition_deliveries delivery
    where delivery.event_key = v_event_key;

    if not found then
      raise exception 'Outgoing contractor notification was not queued'
        using errcode = '23514';
    end if;
  end if;

  return jsonb_build_object(
    'applied', true,
    'reason', v_transition_reason,
    'workOrderId', v_updated.id,
    'contractorId', v_updated.contractor_id,
    'assignmentVersion', v_updated.contractor_assignment_version,
    'assignmentStartedAt', v_updated.contractor_assignment_started_at,
    'status', v_updated.status,
    'functionalStatus', v_updated.functional_status,
    'isCapital', v_updated.is_capital,
    'capitalStatus', v_updated.capital_status,
    'dispatchedAt', v_updated.dispatched_at,
    'deliveryId', v_delivery.id,
    'deliveryStatus', v_delivery.status
  );
end;
$$;

comment on function public.transition_work_order_contractor(text, uuid, integer) is
  'Atomically assigns, reassigns, or unassigns an operational or capital work order while preserving capital lifecycle state and queuing the outgoing-contractor notice.';

revoke all on function public.transition_work_order_contractor(
  text,
  uuid,
  integer
) from public, anon;
grant execute on function public.transition_work_order_contractor(
  text,
  uuid,
  integer
) to authenticated, service_role;

-- Declining a capital review also crosses a workflow boundary. Derive the
-- destination after locking the row so a concurrent unassign cannot produce
-- an assigned status with no contractor, and write the activity atomically.
create or replace function public.decline_capital_work_order(
  p_work_order_id text,
  p_expected_assignment_version integer
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor public.profiles%rowtype;
  v_work_order public.work_orders%rowtype;
  v_updated public.work_orders%rowtype;
  v_next_status public.wo_status;
  v_next_functional_status public.fsm_functional_status;
  v_activity_id uuid;
  v_now timestamptz := clock_timestamp();
begin
  if nullif(trim(coalesce(p_work_order_id, '')), '') is null then
    raise exception 'Work order is required'
      using errcode = '22023';
  end if;

  if p_expected_assignment_version is null
     or p_expected_assignment_version < 0 then
    raise exception 'Expected assignment version is required'
      using errcode = '22023';
  end if;

  select profile.*
  into v_actor
  from public.profiles profile
  where profile.id = auth.uid()
    and profile.active = true
    and profile.role in ('manager', 'dispatcher', 'back_office')
    and not public.profile_has_staff_permission(
      profile.id,
      'invoice_controller'
    );

  if not found then
    raise exception 'Active operational P1 staff required'
      using errcode = '42501';
  end if;

  select work_order.*
  into v_work_order
  from public.work_orders work_order
  where work_order.id = trim(p_work_order_id)
    and work_order.deleted_at is null
  for update;

  if not found then
    raise exception 'Active work order not found'
      using errcode = 'P0002';
  end if;

  if v_work_order.contractor_assignment_version
       <> p_expected_assignment_version then
    raise exception 'Work-order assignment changed; refresh and try again'
      using errcode = 'PT409';
  end if;

  if v_work_order.status::text <> 'capital' then
    raise exception 'Only a capital review can be declined'
      using errcode = 'PT409';
  end if;

  if v_work_order.contractor_id is null then
    v_next_status := 'unassigned';
    v_next_functional_status := 'New';
  else
    v_next_status := 'assigned';
    v_next_functional_status := 'Dispatched';
  end if;

  update public.work_orders work_order
  set status = v_next_status,
      functional_status = v_next_functional_status,
      is_capital = false,
      capital_status = null,
      updated_at = v_now
  where work_order.id = v_work_order.id
    and work_order.deleted_at is null
  returning work_order.* into v_updated;

  if not found then
    raise exception 'Capital decline conflicted with another change'
      using errcode = 'PT409';
  end if;

  insert into public.activities (
    work_order_id,
    author_id,
    author_name,
    text,
    type,
    activity_channel,
    entered_by_role,
    is_staff_override,
    is_staff_only,
    requires_7eleven_sync,
    requires_contractor_attention,
    event_key,
    event_data,
    contractor_assignment_version,
    workflow_cycle,
    created_at
  ) values (
    v_updated.id,
    v_actor.id,
    v_actor.name,
    format(
      'Capital replacement declined by %s. Work order returned to %s.',
      v_actor.name,
      case
        when v_updated.contractor_id is null then 'the unassigned queue'
        else 'dispatched'
      end
    ),
    'system',
    'system_event',
    v_actor.role::text,
    false,
    false,
    false,
    false,
    'capital_declined',
    jsonb_build_object(
      'status', v_updated.status,
      'functionalStatus', v_updated.functional_status,
      'contractorId', v_updated.contractor_id,
      'assignmentVersion', v_updated.contractor_assignment_version,
      'changedBy', v_actor.id
    ),
    v_updated.contractor_assignment_version,
    v_updated.workflow_cycle,
    v_now
  )
  returning id into v_activity_id;

  return jsonb_build_object(
    'applied', true,
    'reason', 'capital_declined',
    'workOrderId', v_updated.id,
    'status', v_updated.status,
    'functionalStatus', v_updated.functional_status,
    'contractorId', v_updated.contractor_id,
    'assignmentVersion', v_updated.contractor_assignment_version,
    'isCapital', v_updated.is_capital,
    'capitalStatus', v_updated.capital_status,
    'activityId', v_activity_id
  );
end;
$$;

comment on function public.decline_capital_work_order(text, integer) is
  'Atomically declines capital review and derives the safe assigned or unassigned destination under a row lock.';

revoke all on function public.decline_capital_work_order(text, integer)
  from public, anon;
grant execute on function public.decline_capital_work_order(text, integer)
  to authenticated, service_role;

commit;
