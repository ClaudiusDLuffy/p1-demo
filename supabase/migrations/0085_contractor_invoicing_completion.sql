-- Separate contractor-invoice activity from operational work-order state.
-- Invoices may be prepared before field work is complete, but they must not
-- pull a dispatched/WIP/parts job into a billing queue. Contractors explicitly
-- signal when the current invoice set is complete; any later invoice change
-- clears that signal. Draft/rejected invoice deletion is soft, scoped, and
-- audited.

begin;

alter table public.work_orders
  add column if not exists contractor_invoicing_completed_at timestamptz,
  add column if not exists contractor_invoicing_completed_by uuid
    references public.profiles(id),
  add column if not exists contractor_invoicing_assignment_version integer,
  add column if not exists contractor_invoicing_workflow_cycle integer,
  add column if not exists contractor_invoicing_completion_source text;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'work_orders_contractor_invoicing_completion_source'
      and conrelid = 'public.work_orders'::regclass
  ) then
    alter table public.work_orders
      add constraint work_orders_contractor_invoicing_completion_source
      check (
        contractor_invoicing_completion_source is null
        or contractor_invoicing_completion_source in (
          'contractor', 'staff_override', 'legacy'
        )
      );
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'work_orders_contractor_invoicing_completion_shape'
      and conrelid = 'public.work_orders'::regclass
  ) then
    alter table public.work_orders
      add constraint work_orders_contractor_invoicing_completion_shape
      check (
        (
          contractor_invoicing_completed_at is null
          and contractor_invoicing_completed_by is null
          and contractor_invoicing_assignment_version is null
          and contractor_invoicing_workflow_cycle is null
          and contractor_invoicing_completion_source is null
        )
        or (
          contractor_invoicing_completed_at is not null
          and contractor_invoicing_assignment_version is not null
          and contractor_invoicing_workflow_cycle is not null
          and contractor_invoicing_completion_source is not null
        )
      );
  end if;
end
$$;

create index if not exists work_orders_contractor_invoicing_ready
  on public.work_orders(
    contractor_invoicing_completed_at,
    contractor_assignment_version,
    workflow_cycle
  )
  where contractor_invoicing_completed_at is not null
    and deleted_at is null;

comment on column public.work_orders.contractor_invoicing_completed_at is
  'Time the current contractor invoice set was declared complete. Any invoice-set, assignment, or workflow-cycle change clears it.';
comment on column public.work_orders.contractor_invoicing_completed_by is
  'Authenticated profile that declared invoicing complete; null only for a legacy compatibility backfill.';

-- Restore rows that can be proven to have been pulled into billing while the
-- operational FSM still said field work was not complete. Invoice rows and
-- activity history are intentionally untouched.
update public.work_orders work_order
set status = case work_order.functional_status::text
      when 'New' then case
        when work_order.contractor_id is null then 'unassigned'::public.wo_status
        else 'assigned'::public.wo_status
      end
      when 'Dispatched' then 'assigned'::public.wo_status
      when 'Work in Progress' then 'wip'::public.wo_status
      when 'Awaiting Parts' then 'parts'::public.wo_status
      else work_order.status
    end,
    updated_at = now()
where work_order.deleted_at is null
  and work_order.status::text in (
    'pending_approval', 'pending_invoice', 'pending_payment'
  )
  and work_order.functional_status::text in (
    'New', 'Dispatched', 'Work in Progress', 'Awaiting Parts'
  );

-- Preserve already-valid production billing queues. This does not assert that
-- a historical contractor clicked the new control; it only prevents rollout
-- from hiding work that was already in a billing stage.
update public.work_orders work_order
set contractor_invoicing_completed_at = coalesce(
      work_order.updated_at,
      work_order.end_time,
      now()
    ),
    contractor_invoicing_completed_by = null,
    contractor_invoicing_assignment_version =
      work_order.contractor_assignment_version,
    contractor_invoicing_workflow_cycle = work_order.workflow_cycle,
    contractor_invoicing_completion_source = 'legacy'
where work_order.deleted_at is null
  and work_order.status::text in (
    'pending_approval', 'pending_invoice', 'pending_payment'
  )
  and exists (
    select 1
    from public.invoices invoice
    where invoice.work_order_id = work_order.id
      and invoice.invoice_type = 'contractor'
      and invoice.deleted_at is null
      and invoice.state::text not in ('draft', 'rejected')
      and (
        work_order.contractor_assignment_started_at is null
        or invoice.created_at >= work_order.contractor_assignment_started_at
      )
  )
  and not exists (
    select 1
    from public.invoices invoice
    where invoice.work_order_id = work_order.id
      and invoice.invoice_type = 'contractor'
      and invoice.deleted_at is null
      and invoice.state::text in ('draft', 'rejected')
      and (
        work_order.contractor_assignment_started_at is null
        or invoice.created_at >= work_order.contractor_assignment_started_at
      )
  );

create or replace function public.contractor_invoicing_is_complete(
  p_work_order_id text
)
returns boolean
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  select case
    -- A work order with no contractor invoice has no contractor invoice set
    -- to wait for. Existing staff "close without invoice" flows stay valid.
    when not exists (
      select 1
      from public.invoices invoice
      where invoice.work_order_id = work_order.id
        and invoice.invoice_type = 'contractor'
        and invoice.deleted_at is null
        and (
          work_order.contractor_assignment_started_at is null
          or invoice.created_at >= work_order.contractor_assignment_started_at
        )
    ) then true
    else work_order.contractor_invoicing_completed_at is not null
      and work_order.contractor_invoicing_assignment_version =
        work_order.contractor_assignment_version
      and work_order.contractor_invoicing_workflow_cycle =
        work_order.workflow_cycle
  end
  from public.work_orders work_order
  where work_order.id = p_work_order_id
    and work_order.deleted_at is null
    and (
      coalesce(auth.role(), '') = 'service_role'
      or public.is_staff()
      or public.can_access_contractor_work_order(work_order.id)
    );
$$;

revoke all on function public.contractor_invoicing_is_complete(text)
  from public, anon;
grant execute on function public.contractor_invoicing_is_complete(text)
  to authenticated, service_role;

-- The mature invoice RPCs continue to own invoice review. This narrow guard
-- only rejects their unintended side effect on an unfinished field job.
create or replace function public.preserve_operational_work_order_status()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  invoice_transition text := coalesce(
    current_setting('app.contractor_invoice_transition', true),
    ''
  );
  invoicing_transition text := coalesce(
    current_setting('app.contractor_invoicing_transition', true),
    ''
  );
  actor_is_contractor boolean := exists (
    select 1
    from public.profiles profile
    where profile.id = auth.uid()
      and profile.role = 'contractor'
      and profile.active = true
  );
  completion_fields_changed boolean;
begin
  completion_fields_changed :=
    new.contractor_invoicing_completed_at is distinct from
      old.contractor_invoicing_completed_at
    or new.contractor_invoicing_completed_by is distinct from
      old.contractor_invoicing_completed_by
    or new.contractor_invoicing_assignment_version is distinct from
      old.contractor_invoicing_assignment_version
    or new.contractor_invoicing_workflow_cycle is distinct from
      old.contractor_invoicing_workflow_cycle
    or new.contractor_invoicing_completion_source is distinct from
      old.contractor_invoicing_completion_source;

  if completion_fields_changed
     and invoicing_transition not in ('finish', 'invoice_changed')
     and coalesce(auth.role(), '') not in ('service_role', '') then
    raise exception 'Contractor invoicing completion must use its workflow'
      using errcode = '42501';
  end if;

  if (
    new.contractor_id is distinct from old.contractor_id
    or new.contractor_assignment_version is distinct from
      old.contractor_assignment_version
    or new.workflow_cycle is distinct from old.workflow_cycle
  ) then
    new.contractor_invoicing_completed_at := null;
    new.contractor_invoicing_completed_by := null;
    new.contractor_invoicing_assignment_version := null;
    new.contractor_invoicing_workflow_cycle := null;
    new.contractor_invoicing_completion_source := null;
  end if;

  if new.status::text in (
       'pending_approval', 'pending_invoice', 'pending_payment'
     )
     and invoicing_transition <> 'finish'
     and (
       old.functional_status::text in (
         'New', 'Dispatched', 'Work in Progress', 'Awaiting Parts'
       )
       or not (
         new.contractor_invoicing_completed_at is not null
         and new.contractor_invoicing_assignment_version =
           new.contractor_assignment_version
         and new.contractor_invoicing_workflow_cycle = new.workflow_cycle
       )
     )
     and (
       actor_is_contractor
       or invoice_transition in ('review', 'resubmit', 'undo_rejection')
     ) then
    new.status := old.status;
  end if;

  return new;
end;
$$;

drop trigger if exists preserve_operational_work_order_status_trigger
  on public.work_orders;
create trigger preserve_operational_work_order_status_trigger
  before update on public.work_orders
  for each row execute function public.preserve_operational_work_order_status();

create or replace function public.reset_contractor_invoicing_on_invoice_change()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  should_reset boolean := false;
begin
  if new.invoice_type <> 'contractor' or new.work_order_id is null then
    return new;
  end if;

  if tg_op = 'INSERT' then
    should_reset := new.deleted_at is null;
  else
    should_reset := (
      old.deleted_at is null and new.deleted_at is not null
    ) or (
      new.deleted_at is null
      and new.state is distinct from old.state
      and new.state::text in ('submitted', 'revised', 'rejected')
    );
  end if;

  if should_reset then
    perform set_config(
      'app.contractor_invoicing_transition',
      'invoice_changed',
      true
    );

    update public.work_orders work_order
    set contractor_invoicing_completed_at = null,
        contractor_invoicing_completed_by = null,
        contractor_invoicing_assignment_version = null,
        contractor_invoicing_workflow_cycle = null,
        contractor_invoicing_completion_source = null,
        updated_at = now()
    where work_order.id = new.work_order_id
      and work_order.deleted_at is null
      and work_order.contractor_invoicing_completed_at is not null;
  end if;

  return new;
end;
$$;

drop trigger if exists reset_contractor_invoicing_on_invoice_change_trigger
  on public.invoices;
create trigger reset_contractor_invoicing_on_invoice_change_trigger
  after insert or update of state, deleted_at on public.invoices
  for each row execute function public.reset_contractor_invoicing_on_invoice_change();

create or replace function public.finish_contractor_invoicing(
  p_work_order_id text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor_id uuid := auth.uid();
  actor public.profiles%rowtype;
  account_id uuid := public.current_contractor_account_id();
  work_order public.work_orders%rowtype;
  next_status public.wo_status;
  active_invoice_count integer;
  completion_source text;
begin
  if actor_id is null then
    raise exception 'Authentication is required'
      using errcode = '42501';
  end if;

  select profile.*
  into actor
  from public.profiles profile
  where profile.id = actor_id
    and profile.active = true;

  if not found then
    raise exception 'Active profile not found'
      using errcode = '42501';
  end if;

  if actor.role = 'contractor' then
    if account_id is null
       or not public.can_invoice_for_contractor(account_id)
       or not public.can_access_contractor_work_order(p_work_order_id) then
      raise exception 'Invoice access is required for this work order'
        using errcode = '42501';
    end if;
    completion_source := 'contractor';
  elsif actor.role in ('manager', 'dispatcher', 'back_office')
        and not public.is_invoice_controller() then
    completion_source := 'staff_override';
  else
    raise exception 'Invoice-completion access is required'
      using errcode = '42501';
  end if;

  select candidate.*
  into work_order
  from public.work_orders candidate
  where candidate.id = p_work_order_id
    and candidate.deleted_at is null
  for update;

  if not found then
    raise exception 'Work order not found'
      using errcode = 'P0002';
  end if;

  if actor.role = 'contractor'
     and work_order.contractor_id is distinct from account_id then
    raise exception 'This work order is not assigned to your company'
      using errcode = '42501';
  end if;

  if work_order.status = 'closed' then
    raise exception 'Closed work orders cannot change invoicing completion'
      using errcode = '22023';
  end if;

  if not coalesce(work_order.billing_only, false)
     and work_order.functional_status::text <> 'Completed' then
    raise exception 'Complete the field work before finishing invoicing'
      using errcode = '22023';
  end if;

  select count(*)::integer
  into active_invoice_count
  from public.invoices invoice
  where invoice.work_order_id = work_order.id
    and invoice.invoice_type = 'contractor'
    and invoice.deleted_at is null
    and invoice.contractor_id = work_order.contractor_id
    and (
      work_order.contractor_assignment_started_at is null
      or invoice.created_at >= work_order.contractor_assignment_started_at
    )
    and invoice.state::text not in ('draft', 'rejected');

  if active_invoice_count = 0 then
    raise exception 'Submit at least one invoice before finishing invoicing'
      using errcode = '22023';
  end if;

  if exists (
    select 1
    from public.invoices invoice
    where invoice.work_order_id = work_order.id
      and invoice.invoice_type = 'contractor'
      and invoice.deleted_at is null
      and invoice.contractor_id = work_order.contractor_id
      and (
        work_order.contractor_assignment_started_at is null
        or invoice.created_at >= work_order.contractor_assignment_started_at
      )
      and invoice.state::text in ('draft', 'rejected')
  ) then
    raise exception 'Submit or delete drafts and resolve rejected invoices first'
      using errcode = '22023';
  end if;

  if work_order.contractor_invoicing_completed_at is not null
     and work_order.contractor_invoicing_assignment_version =
       work_order.contractor_assignment_version
     and work_order.contractor_invoicing_workflow_cycle =
       work_order.workflow_cycle then
    return jsonb_build_object(
      'applied', false,
      'reason', 'already_complete',
      'workOrderId', work_order.id,
      'workOrderStatus', work_order.status,
      'completedAt', work_order.contractor_invoicing_completed_at
    );
  end if;

  next_status := public.contractor_invoice_work_order_status(work_order.id);
  perform set_config(
    'app.contractor_invoicing_transition',
    'finish',
    true
  );

  update public.work_orders candidate
  set contractor_invoicing_completed_at = now(),
      contractor_invoicing_completed_by = actor_id,
      contractor_invoicing_assignment_version =
        candidate.contractor_assignment_version,
      contractor_invoicing_workflow_cycle = candidate.workflow_cycle,
      contractor_invoicing_completion_source = completion_source,
      status = coalesce(next_status, candidate.status),
      updated_at = now()
  where candidate.id = work_order.id
  returning candidate.* into work_order;

  insert into public.activities (
    work_order_id,
    author_id,
    author_name,
    text,
    type,
    event_key,
    event_data
  ) values (
    work_order.id,
    actor_id,
    actor.name,
    case completion_source
      when 'contractor' then format(
        '%s marked contractor invoicing complete.', actor.name
      )
      else format(
        '%s marked contractor invoicing complete for staff follow-up.',
        actor.name
      )
    end,
    'system',
    'contractor_invoicing_completed',
    jsonb_build_object(
      'completedBy', actor_id,
      'completedAt', work_order.contractor_invoicing_completed_at,
      'source', completion_source,
      'invoiceCount', active_invoice_count,
      'assignmentVersion', work_order.contractor_assignment_version,
      'workflowCycle', work_order.workflow_cycle
    )
  );

  return jsonb_build_object(
    'applied', true,
    'reason', 'completed',
    'workOrderId', work_order.id,
    'workOrderStatus', work_order.status,
    'completedAt', work_order.contractor_invoicing_completed_at,
    'completedBy', actor_id,
    'source', completion_source,
    'invoiceCount', active_invoice_count
  );
end;
$$;

revoke all on function public.finish_contractor_invoicing(text)
  from public, anon;
grant execute on function public.finish_contractor_invoicing(text)
  to authenticated, service_role;

create or replace function public.protect_contractor_invoice_soft_delete()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  transition_kind text := coalesce(
    current_setting('app.contractor_invoice_delete_transition', true),
    ''
  );
begin
  if new.invoice_type <> 'contractor' then
    return new;
  end if;

  if coalesce(auth.role(), '') in ('service_role', '') then
    return new;
  end if;

  if new.deleted_by is distinct from old.deleted_by
     or new.deleted_at is distinct from old.deleted_at then
    if transition_kind <> 'delete_own' then
      raise exception 'Invoice deletion must use the guarded workflow'
        using errcode = '42501';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists protect_contractor_invoice_soft_delete_trigger
  on public.invoices;
create trigger protect_contractor_invoice_soft_delete_trigger
  before update of deleted_at, deleted_by on public.invoices
  for each row execute function public.protect_contractor_invoice_soft_delete();

create or replace function public.delete_own_contractor_invoice(
  p_invoice_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor_id uuid := auth.uid();
  actor_name text;
  account_id uuid := public.current_contractor_account_id();
  invoice public.invoices%rowtype;
  work_order public.work_orders%rowtype;
  previous_state public.invoice_state;
begin
  if actor_id is null or account_id is null then
    raise exception 'Contractor authentication is required'
      using errcode = '42501';
  end if;

  select profile.name
  into actor_name
  from public.profiles profile
  where profile.id = actor_id
    and profile.role = 'contractor'
    and profile.active = true;

  if not found or not public.can_invoice_for_contractor(account_id) then
    raise exception 'Invoice access is required'
      using errcode = '42501';
  end if;

  select candidate.*
  into invoice
  from public.invoices candidate
  where candidate.id = p_invoice_id
    and candidate.invoice_type = 'contractor'
    and candidate.deleted_at is null
    and candidate.contractor_id = account_id
  for update;

  if not found then
    raise exception 'Contractor invoice not found'
      using errcode = 'P0002';
  end if;

  select candidate.*
  into work_order
  from public.work_orders candidate
  where candidate.id = invoice.work_order_id
    and candidate.deleted_at is null
  for update;

  if not found
     or work_order.contractor_id is distinct from account_id
     or not public.can_access_contractor_work_order(work_order.id)
     or work_order.contractor_assignment_started_at is null
     or invoice.created_at < work_order.contractor_assignment_started_at then
    raise exception 'This invoice is not part of your current assignment'
      using errcode = '42501';
  end if;

  if invoice.state::text not in ('draft', 'rejected') then
    raise exception 'Only draft or rejected invoices can be deleted'
      using errcode = '22023';
  end if;

  if exists (
    select 1
    from public.staff_invoice_sources source
    join public.invoices staff_invoice
      on staff_invoice.id = source.staff_invoice_id
    where source.contractor_invoice_id = invoice.id
      and staff_invoice.deleted_at is null
  ) then
    raise exception 'This invoice is already used by a P1 billing invoice'
      using errcode = '22023';
  end if;

  previous_state := invoice.state;
  perform set_config(
    'app.contractor_invoice_delete_transition',
    'delete_own',
    true
  );

  update public.invoices candidate
  set deleted_at = now(),
      deleted_by = actor_id,
      updated_at = now()
  where candidate.id = invoice.id
    and candidate.deleted_at is null
  returning candidate.* into invoice;

  if not found then
    raise exception 'Invoice changed before it could be deleted'
      using errcode = 'PT409';
  end if;

  update public.activities activity
  set contractor_attention_acknowledged_at = now(),
      contractor_attention_acknowledged_by = actor_id
  where activity.work_order_id = work_order.id
    and activity.event_key = 'invoice_rejected'
    and activity.event_data ->> 'invoiceId' = invoice.id::text
    and activity.requires_contractor_attention = true
    and activity.contractor_attention_acknowledged_at is null
    and activity.deleted_at is null;

  insert into public.activities (
    work_order_id,
    author_id,
    author_name,
    text,
    type,
    event_key,
    event_data
  ) values (
    work_order.id,
    actor_id,
    actor_name,
    format(
      'Invoice #%s deleted by %s (%s).',
      invoice.num,
      actor_name,
      previous_state::text
    ),
    'system',
    'invoice_deleted_by_contractor',
    jsonb_build_object(
      'invoiceId', invoice.id,
      'invoiceNum', invoice.num,
      'previousState', previous_state,
      'deletedBy', actor_id,
      'deletedAt', invoice.deleted_at
    )
  );

  return jsonb_build_object(
    'invoiceId', invoice.id,
    'invoiceNum', invoice.num,
    'workOrderId', work_order.id,
    'previousState', previous_state,
    'deletedAt', invoice.deleted_at,
    'deletedBy', actor_id
  );
end;
$$;

revoke all on function public.delete_own_contractor_invoice(uuid)
  from public, anon;
grant execute on function public.delete_own_contractor_invoice(uuid)
  to authenticated, service_role;

commit;
