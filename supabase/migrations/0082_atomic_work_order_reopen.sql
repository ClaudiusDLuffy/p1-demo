-- Reopening is an operational lifecycle decision, not a pair of unrelated
-- client writes. Keep the transition, audit record, and repeat-completion
-- boundary in one locked transaction while leaving invoices, assignments,
-- technician history, and completed visits untouched.

begin;

-- A work order can be completed more than once only after staff explicitly
-- reopens it. Assignment version alone cannot represent this because a reopen
-- may keep the same contractor. The workflow cycle gives each reopened run an
-- independent idempotency boundary without deleting earlier completion logs.
alter table public.work_orders
  add column if not exists workflow_cycle integer not null default 0;

alter table public.activities
  add column if not exists workflow_cycle integer not null default 0;

comment on column public.work_orders.workflow_cycle is
  'Monotonic lifecycle cycle. Incremented only by the atomic reopen workflow.';
comment on column public.activities.workflow_cycle is
  'Work-order lifecycle cycle captured when the activity is created.';

create or replace function public.protect_activity_workflow_cycle()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_workflow_cycle integer;
begin
  if tg_op = 'UPDATE' then
    if new.work_order_id is distinct from old.work_order_id
       or new.workflow_cycle is distinct from old.workflow_cycle then
      raise exception 'Activity workflow identity cannot be changed'
        using errcode = '42501';
    end if;
    return new;
  end if;

  select work_order.workflow_cycle
  into v_workflow_cycle
  from public.work_orders work_order
  where work_order.id = new.work_order_id;

  if not found then
    raise exception 'Activity must reference an existing work order'
      using errcode = '23503';
  end if;

  new.workflow_cycle := v_workflow_cycle;
  return new;
end;
$$;

drop trigger if exists protect_activity_workflow_cycle_trigger
  on public.activities;
create trigger protect_activity_workflow_cycle_trigger
  before insert or update of work_order_id, workflow_cycle
  on public.activities
  for each row execute function public.protect_activity_workflow_cycle();

-- Completion remains replay-safe within one contractor assignment and one
-- reopen cycle, while prior completion events remain immutable history.
drop index if exists public.activities_one_job_completion_per_assignment;
create unique index if not exists activities_one_job_completion_per_workflow_cycle
  on public.activities(
    work_order_id,
    contractor_assignment_version,
    workflow_cycle
  )
  where event_key = 'job_completed'
    and deleted_at is null;

-- A private one-transaction permit lets the security-definer workflow move a
-- closed row without trusting a caller-settable session variable. This is the
-- same guard-table pattern used by the P1 parts workflow. Authenticated API
-- callers cannot read or write these permits directly.
create table if not exists public.work_order_reopen_transition_guards (
  transaction_id bigint not null,
  work_order_id text not null
    references public.work_orders(id) on delete cascade,
  actor_id uuid not null
    references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (transaction_id, work_order_id)
);

revoke all on public.work_order_reopen_transition_guards
  from public, anon, authenticated, service_role;

-- Prevent authenticated clients from bypassing the guarded workflow with a
-- raw work_orders update. Service-role maintenance and SQL-editor recovery
-- remain available.
create or replace function public.prevent_direct_work_order_reopen()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_guarded boolean := false;
begin
  -- Inspect the final row only when this update actually crossed a protected
  -- lifecycle boundary. This trigger intentionally runs AFTER every update:
  -- the existing contractor-assignment BEFORE trigger can change status even
  -- when status was not named in the caller's SET list.
  if new.workflow_cycle is not distinct from old.workflow_cycle
     and not (
       old.status = 'closed'
       and new.status <> 'closed'
     ) then
    return new;
  end if;

  if coalesce(auth.role(), '') in ('service_role', '') then
    return new;
  end if;

  select exists (
    select 1
    from public.work_order_reopen_transition_guards transition_guard
    where transition_guard.transaction_id = txid_current()
      and transition_guard.work_order_id = new.id
      and transition_guard.actor_id = auth.uid()
  ) into v_guarded;

  if new.workflow_cycle is distinct from old.workflow_cycle
     and not v_guarded then
    raise exception 'Work-order workflow cycle can only change during reopen'
      using errcode = '42501';
  end if;

  if old.status = 'closed'
     and new.status <> 'closed'
     and not v_guarded then
    raise exception 'Closed work orders must be reopened through the reopen workflow'
      using errcode = '42501';
  end if;

  return new;
end;
$$;

drop trigger if exists prevent_direct_work_order_reopen_trigger
  on public.work_orders;
create trigger prevent_direct_work_order_reopen_trigger
  after update on public.work_orders
  for each row execute function public.prevent_direct_work_order_reopen();

create or replace function public.reopen_work_order(
  p_work_order_id text,
  p_mode text,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor public.profiles%rowtype;
  v_work_order public.work_orders%rowtype;
  v_now timestamptz := now();
  v_mode text := lower(trim(coalesce(p_mode, '')));
  v_reason text := nullif(trim(coalesce(p_reason, '')), '');
  v_next_status public.wo_status;
  v_next_functional_status public.fsm_functional_status;
  v_has_approved_capital_quote boolean := false;
  v_unresolved_contractor_invoices integer := 0;
  v_next_workflow_cycle integer;
begin
  select *
  into v_actor
  from public.profiles profile
  where profile.id = auth.uid()
    and profile.active = true
    and profile.role in ('manager', 'dispatcher', 'back_office');

  if not found then
    raise exception 'Active P1 staff access required'
      using errcode = '42501';
  end if;
  if public.profile_has_staff_permission(v_actor.id, 'invoice_controller') then
    raise exception 'Operational staff access required'
      using errcode = '42501';
  end if;

  if v_mode not in ('resume_work', 'billing_follow_up') then
    raise exception 'Choose resume work or billing follow-up'
      using errcode = '22023';
  end if;
  if v_reason is null or char_length(v_reason) < 3 then
    raise exception 'A reopen reason of at least 3 characters is required'
      using errcode = '22023';
  end if;
  if char_length(v_reason) > 1000 then
    raise exception 'Reopen reason must be 1000 characters or fewer'
      using errcode = '22023';
  end if;

  select *
  into v_work_order
  from public.work_orders work_order
  where work_order.id = p_work_order_id
    and work_order.deleted_at is null
  for update;

  if not found then
    raise exception 'Work order not found'
      using errcode = 'P0002';
  end if;

  if v_work_order.status <> 'closed' then
    return jsonb_build_object(
      'applied', false,
      'reason', 'already_open',
      'workOrderId', v_work_order.id,
      'workOrderStatus', v_work_order.status,
      'functionalStatus', v_work_order.functional_status,
      'closedAt', v_work_order.closed_at,
      'workflowCycle', v_work_order.workflow_cycle
    );
  end if;

  if coalesce(v_work_order.is_capital, false) then
    select exists (
      select 1
      from public.invoices invoice
      where invoice.work_order_id = v_work_order.id
        and invoice.invoice_type = 'staff'
        and invoice.document_kind = 'capital_quote'
        and invoice.state in ('approved', 'paid')
        and invoice.deleted_at is null
    ) into v_has_approved_capital_quote;
  end if;

  if v_mode = 'resume_work' then
    if v_work_order.billing_only then
      raise exception 'Billing-only work orders can only reopen for billing follow-up'
        using errcode = '23514';
    end if;

    -- Invoice review also owns the work-order status. Do not create an
    -- ambiguous field-work state while a contractor invoice still needs an
    -- approval/rejection decision.
    select count(*)::integer
    into v_unresolved_contractor_invoices
    from public.invoices invoice
    where invoice.work_order_id = v_work_order.id
      and invoice.invoice_type = 'contractor'
      and invoice.deleted_at is null
      and invoice.state not in ('draft', 'approved', 'paid');

    if v_unresolved_contractor_invoices > 0 then
      raise exception 'Resolve % contractor invoice(s) or choose billing follow-up before resuming field work',
        v_unresolved_contractor_invoices
        using errcode = '23514';
    end if;

    if coalesce(v_work_order.is_capital, false) then
      if v_has_approved_capital_quote then
        v_next_status := 'pending_capital_completion';
        v_next_functional_status := 'Pending Capital Completion';
      else
        v_next_status := 'capital';
        v_next_functional_status := 'Work in Progress';
      end if;
    elsif v_work_order.contractor_id is null then
      v_next_status := 'unassigned';
      v_next_functional_status := 'New';
    else
      v_next_status := 'assigned';
      v_next_functional_status := 'Dispatched';
    end if;
  else
    if coalesce(v_work_order.is_capital, false)
       and not v_has_approved_capital_quote then
      raise exception 'This capital work order needs an approved capital quote before final billing'
        using errcode = '23514';
    end if;

    v_next_status := coalesce(
      public.contractor_invoice_work_order_status(v_work_order.id),
      'pending_invoice'::public.wo_status
    );
    v_next_functional_status := 'Completed';
  end if;

  v_next_workflow_cycle := v_work_order.workflow_cycle + 1;

  insert into public.work_order_reopen_transition_guards (
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
  set status = v_next_status,
      functional_status = v_next_functional_status,
      closed_at = null,
      billing_ready_at = case
        when v_mode = 'billing_follow_up'
             and v_next_status = 'pending_invoice' then v_now
        else null
      end,
      billing_ready_by = case
        when v_mode = 'billing_follow_up'
             and v_next_status = 'pending_invoice' then v_actor.id
        else null
      end,
      workflow_cycle = v_next_workflow_cycle,
      updated_at = v_now
  where work_order.id = v_work_order.id
    and work_order.deleted_at is null;

  delete from public.work_order_reopen_transition_guards transition_guard
  where transition_guard.transaction_id = txid_current()
    and transition_guard.work_order_id = v_work_order.id;

  insert into public.activities (
    work_order_id,
    author_id,
    author_name,
    text,
    type,
    is_staff_override,
    is_staff_only,
    event_key,
    event_data,
    workflow_cycle
  ) values (
    v_work_order.id,
    v_actor.id,
    v_actor.name,
    format(
      'Work order reopened by %s for %s. Reason: %s',
      v_actor.name,
      case
        when v_mode = 'resume_work' then 'field work'
        else 'billing follow-up'
      end,
      v_reason
    ),
    'system',
    false,
    true,
    'work_order_reopened',
    jsonb_build_object(
      'action', 'work_order_reopened',
      'mode', v_mode,
      'reason', v_reason,
      'previousStatus', v_work_order.status,
      'previousFunctionalStatus', v_work_order.functional_status,
      'previousClosedAt', v_work_order.closed_at,
      'workOrderStatus', v_next_status,
      'functionalStatus', v_next_functional_status,
      'workflowCycle', v_next_workflow_cycle,
      'invoicesChanged', false,
      'assignmentsChanged', false,
      'visitsChanged', false
    ),
    v_next_workflow_cycle
  );

  return jsonb_build_object(
    'applied', true,
    'reason', 'reopened',
    'mode', v_mode,
    'workOrderId', v_work_order.id,
    'workOrderStatus', v_next_status,
    'functionalStatus', v_next_functional_status,
    'closedAt', null,
    'billingReadyAt', case
      when v_mode = 'billing_follow_up'
           and v_next_status = 'pending_invoice' then v_now
      else null
    end,
    'workflowCycle', v_next_workflow_cycle
  );
end;
$$;

-- Repeat completions are replay-safe within the current reopen cycle. This is
-- the latest company/technician-aware definition with only the cycle boundary
-- added; its authorization and visit scoping remain unchanged.
create or replace function public.complete_work_order_once(
  p_work_order_id text,
  p_completed_at timestamptz,
  p_asset_make text,
  p_asset_model text,
  p_asset_serial text,
  p_asset_year integer,
  p_resolution_code text,
  p_resolution_notes text,
  p_activity_text text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor_id uuid := auth.uid();
  v_actor_name text;
  v_actor_role text;
  v_work_order public.work_orders%rowtype;
  v_activity_id uuid;
  v_visits_closed integer := 0;
begin
  if v_actor_id is null then
    raise exception 'Authentication required'
      using errcode = '42501';
  end if;

  select profile.name, profile.role::text
  into v_actor_name, v_actor_role
  from public.profiles profile
  where profile.id = v_actor_id
    and profile.active = true;

  select *
  into v_work_order
  from public.work_orders
  where id = p_work_order_id
    and deleted_at is null
  for update;

  if not found then
    raise exception 'Work order not found';
  end if;

  if v_actor_role not in ('manager', 'dispatcher', 'back_office')
     and not (
       v_actor_role = 'contractor'
       and public.can_access_contractor_work_order(p_work_order_id)
     ) then
    raise exception 'Work order completion is not permitted'
      using errcode = '42501';
  end if;

  select activity.id
  into v_activity_id
  from public.activities activity
  where activity.work_order_id = p_work_order_id
    and activity.event_key = 'job_completed'
    and activity.deleted_at is null
    and activity.contractor_assignment_version
      = v_work_order.contractor_assignment_version
    and activity.workflow_cycle = v_work_order.workflow_cycle
    and (
      public.is_staff()
      or (
        v_work_order.contractor_assignment_started_at is not null
        and activity.created_at >= v_work_order.contractor_assignment_started_at
      )
    )
  order by activity.created_at desc
  limit 1;

  if v_activity_id is not null or v_work_order.status = 'completed' then
    return jsonb_build_object(
      'applied', false,
      'reason', 'already_completed',
      'activityId', v_activity_id
    );
  end if;

  if v_work_order.status in ('closed', 'capital') then
    raise exception 'This work order cannot be completed from its current status';
  end if;

  update public.work_orders
  set status = 'completed',
      functional_status = 'Completed',
      asset_make = nullif(trim(coalesce(p_asset_make, '')), ''),
      asset_model = nullif(trim(coalesce(p_asset_model, '')), ''),
      asset_serial = nullif(trim(coalesce(p_asset_serial, '')), ''),
      asset_year = p_asset_year,
      end_time = p_completed_at,
      resolution_code = nullif(trim(coalesce(p_resolution_code, '')), ''),
      resolution_notes = nullif(trim(coalesce(p_resolution_notes, '')), ''),
      updated_at = now()
  where id = p_work_order_id;

  update public.work_order_visits visit
  set check_out_at = p_completed_at,
      checked_out_by = v_actor_id,
      updated_at = now()
  where visit.work_order_id = p_work_order_id
    and visit.contractor_id = v_work_order.contractor_id
    and visit.check_out_at is null
    and (
      public.is_staff()
      or visit.created_at >= v_work_order.contractor_assignment_started_at
    );
  get diagnostics v_visits_closed = row_count;

  insert into public.activities (
    work_order_id,
    author_id,
    author_name,
    text,
    type,
    is_staff_override,
    event_key,
    event_data,
    workflow_cycle
  ) values (
    p_work_order_id,
    v_actor_id,
    coalesce(v_actor_name, 'Portal user'),
    p_activity_text,
    'note',
    v_actor_role in ('manager', 'dispatcher', 'back_office'),
    'job_completed',
    jsonb_build_object(
      'clockedOutAt', p_completed_at,
      'resolution', nullif(trim(coalesce(p_resolution_code, '')), ''),
      'closingNotes', nullif(trim(coalesce(p_resolution_notes, '')), '')
    ),
    v_work_order.workflow_cycle
  )
  returning id into v_activity_id;

  return jsonb_build_object(
    'applied', true,
    'activityId', v_activity_id,
    'visitsClosed', v_visits_closed
  );
end;
$$;

revoke all on function public.reopen_work_order(text, text, text)
  from public, anon;
grant execute on function public.reopen_work_order(text, text, text)
  to authenticated, service_role;

revoke all on function public.prevent_direct_work_order_reopen()
  from public, anon, authenticated;
revoke all on function public.protect_activity_workflow_cycle()
  from public, anon, authenticated;

commit;
