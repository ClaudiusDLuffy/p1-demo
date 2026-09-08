-- Let operational staff close a reopened field-work cycle when the prior
-- billing already covered the follow-up and no new invoice was created.
-- Historical invoices remain immutable and attached to the work order.

begin;

-- Authenticated callers can update work_orders under RLS, so terminal state
-- transitions need a transaction-local capability issued only by an owning
-- close workflow. The matching activity insert consumes the capability;
-- successful transactions never leave a reusable row behind.
create table if not exists public.work_order_close_transition_guards (
  transaction_id bigint not null,
  work_order_id text not null
    references public.work_orders(id) on delete cascade,
  actor_id uuid not null
    references public.profiles(id) on delete cascade,
  transition_kind text not null
    check (transition_kind in (
      'without_invoice',
      'reopened_without_additional_billing'
    )),
  created_at timestamptz not null default now(),
  primary key (transaction_id, work_order_id)
);

revoke all on public.work_order_close_transition_guards
  from public, anon, authenticated, service_role;

create or replace function public.close_reopened_work_order_without_additional_billing(
  p_work_order_id text,
  p_expected_workflow_cycle integer,
  p_expected_contractor_assignment_version integer,
  p_expected_updated_at timestamptz,
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
  v_reopen_activity public.activities%rowtype;
  v_now timestamptz := now();
  v_work_order_id text := nullif(trim(coalesce(p_work_order_id, '')), '');
  v_reason text := nullif(trim(coalesce(p_reason, '')), '');
  v_current_cycle_invoice_count integer := 0;
  v_prior_invoice_count integer := 0;
  v_visits_closed integer := 0;
  v_prior_billing_activity_id uuid;
  v_prior_billing_invoice_id uuid;
  v_prior_billing_invoice_num text;
begin
  select profile.*
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

  if v_work_order_id is null then
    raise exception 'Work order is required'
      using errcode = '22023';
  end if;
  if p_expected_workflow_cycle is null or p_expected_workflow_cycle <= 0 then
    raise exception 'A valid expected workflow cycle is required'
      using errcode = '22023';
  end if;
  if p_expected_contractor_assignment_version is null
     or p_expected_contractor_assignment_version < 0 then
    raise exception 'A valid expected assignment version is required'
      using errcode = '22023';
  end if;
  if p_expected_updated_at is null then
    raise exception 'The expected work-order update time is required'
      using errcode = '22023';
  end if;
  if v_reason is null or char_length(v_reason) < 3 then
    raise exception 'A close reason of at least 3 characters is required'
      using errcode = '22023';
  end if;
  if char_length(v_reason) > 1000 then
    raise exception 'Close reason must be 1000 characters or fewer'
      using errcode = '22023';
  end if;

  select work_order.*
  into v_work_order
  from public.work_orders work_order
  where work_order.id = v_work_order_id
    and work_order.deleted_at is null
  for update;

  if not found then
    raise exception 'Work order not found'
      using errcode = 'P0002';
  end if;

  -- A delayed browser request from an older reopen cycle must not close the
  -- current cycle. The row lock makes the check and mutation one decision.
  if v_work_order.workflow_cycle is distinct from p_expected_workflow_cycle then
    raise exception 'The work order changed before it could be closed; refresh and try again'
      using errcode = '40001';
  end if;

  if v_work_order.status = 'closed' then
    return jsonb_build_object(
      'applied', false,
      'reason', 'already_closed',
      'workOrderId', v_work_order.id,
      'workOrderStatus', v_work_order.status,
      'functionalStatus', v_work_order.functional_status,
      'closedAt', v_work_order.closed_at,
      'workflowCycle', v_work_order.workflow_cycle,
      'visitsClosed', 0
    );
  end if;

  if v_work_order.contractor_assignment_version
       is distinct from p_expected_contractor_assignment_version
     or v_work_order.updated_at is distinct from p_expected_updated_at then
    raise exception 'The work order changed before it could be closed; refresh and review it before retrying'
      using errcode = '40001';
  end if;

  if v_work_order.workflow_cycle <= 0 then
    raise exception 'Only a reopened work order can use this close workflow'
      using errcode = '23514';
  end if;
  if v_work_order.billing_only then
    raise exception 'Billing-only work orders cannot use the field follow-up close workflow'
      using errcode = '23514';
  end if;
  if coalesce(v_work_order.is_capital, false) then
    raise exception 'Capital work orders must use the capital completion workflow'
      using errcode = '23514';
  end if;
  if v_work_order.status::text not in (
    'unassigned', 'assigned', 'wip', 'parts', 'completed'
  ) then
    raise exception 'This follow-up cannot close from its current billing status'
      using errcode = '23514';
  end if;

  select activity.*
  into v_reopen_activity
  from public.activities activity
  where activity.work_order_id = v_work_order.id
    and activity.workflow_cycle = v_work_order.workflow_cycle
    and activity.event_key = 'work_order_reopened'
    and activity.deleted_at is null
  order by activity.created_at desc, activity.id desc
  limit 1;

  if not found then
    raise exception 'Current reopened workflow metadata is missing'
      using errcode = '23514';
  end if;
  if coalesce(v_reopen_activity.event_data ->> 'mode', '') <> 'resume_work' then
    raise exception 'Only a field-work follow-up can close without additional billing'
      using errcode = '23514';
  end if;

  -- Contractor submission and the guarded staff-invoice wrapper below lock
  -- this same work-order row before writing. The invoice trigger takes a
  -- key-share lock for browser writes, so no invoice can slip across this
  -- transaction boundary.
  select count(*)::integer
  into v_current_cycle_invoice_count
  from public.invoices invoice
  where invoice.work_order_id = v_work_order.id
    and (
      (invoice.deleted_at is null and (
        invoice.created_at is null
        or invoice.created_at >= v_reopen_activity.created_at
      ))
      or invoice.deleted_at >= v_reopen_activity.created_at
    );

  if v_current_cycle_invoice_count > 0 then
    raise exception 'This reopened follow-up has % new or deleted invoice record(s); use the normal billing workflow',
      v_current_cycle_invoice_count
      using errcode = '23514';
  end if;

  if exists (
    select 1
    from public.activities activity
    where activity.work_order_id = v_work_order.id
      and activity.requires_7eleven_sync = true
      and activity.synced_to_7eleven_at is null
      and activity.deleted_at is null
  ) then
    raise exception 'Copy all pending work-order updates to 7-Eleven before closing the work order'
      using errcode = '23514';
  end if;

  if exists (
    select 1
    from public.activities activity
    where activity.work_order_id = v_work_order.id
      and activity.requires_contractor_attention = true
      and activity.contractor_attention_acknowledged_at is null
      and activity.deleted_at is null
  ) then
    raise exception 'Resolve all pending contractor attention before closing the work order'
      using errcode = '23514';
  end if;

  if exists (
    select 1
    from public.invoices invoice
    where invoice.work_order_id = v_work_order.id
      and invoice.deleted_at is null
      and invoice.created_at < v_reopen_activity.created_at
      and invoice.state not in ('approved', 'paid')
  ) then
    raise exception 'Resolve all prior invoice records before closing this follow-up'
      using errcode = '23514';
  end if;

  -- Every prior P1 invoice must have its own completed billing event before
  -- the reopen boundary. One billed invoice cannot be used as evidence for a
  -- second approved-but-unbilled document on the same work order.
  if exists (
    select 1
    from public.invoices invoice
    where invoice.work_order_id = v_work_order.id
      and invoice.invoice_type = 'staff'
      and invoice.document_kind = 'invoice'
      and invoice.deleted_at is null
      and invoice.created_at < v_reopen_activity.created_at
      and not exists (
        select 1
        from public.activities billing_activity
        where billing_activity.work_order_id = v_work_order.id
          and billing_activity.event_key = 'staff_billing'
          and billing_activity.event_data ->> 'action' = 'billed_to_7_eleven'
          and billing_activity.event_data ->> 'invoiceId' = invoice.id::text
          and billing_activity.workflow_cycle < v_work_order.workflow_cycle
          and billing_activity.created_at < v_reopen_activity.created_at
          and billing_activity.deleted_at is null
      )
  ) then
    raise exception 'Every prior P1 invoice must be billed to 7-Eleven before closing this follow-up'
      using errcode = '23514';
  end if;

  -- A draft header created before reopen is not proof of prior work. Require
  -- each contractor bill's own submission event from a previous cycle.
  if exists (
    select 1
    from public.invoices contractor_invoice
    where contractor_invoice.work_order_id = v_work_order.id
      and contractor_invoice.invoice_type = 'contractor'
      and contractor_invoice.document_kind = 'invoice'
      and contractor_invoice.deleted_at is null
      and contractor_invoice.created_at < v_reopen_activity.created_at
      and not exists (
        select 1
        from public.activities submission_activity
        where submission_activity.work_order_id = v_work_order.id
          and submission_activity.event_key = 'invoice_submitted'
          and submission_activity.event_data ->> 'invoiceId' = contractor_invoice.id::text
          and submission_activity.workflow_cycle < v_work_order.workflow_cycle
          and submission_activity.created_at < v_reopen_activity.created_at
          and submission_activity.deleted_at is null
      )
  ) then
    raise exception 'Every prior contractor bill must have submission evidence from before this follow-up; use the normal billing workflow'
      using errcode = '23514';
  end if;

  -- A pre-existing invoice header can otherwise be marked ready or billed
  -- during the reopened cycle without changing its created_at timestamp.
  if exists (
    select 1
    from public.activities billing_activity
    where billing_activity.work_order_id = v_work_order.id
      and billing_activity.event_key in (
        'staff_invoice_ready',
        'staff_billing',
        'invoice_draft',
        'invoice_submitted',
        'invoice_resubmitted',
        'invoice_uploaded',
        'invoice_approved',
        'invoice_rejected',
        'invoice_rejection_retracted',
        'invoice_deleted',
        'invoice_deleted_by_contractor'
      )
      and billing_activity.created_at >= v_reopen_activity.created_at
      and billing_activity.deleted_at is null
  ) then
    raise exception 'An invoice changed during this reopened cycle; use the normal billing workflow'
      using errcode = '23514';
  end if;

  select count(*)::integer
  into v_prior_invoice_count
  from public.invoices invoice
  where invoice.work_order_id = v_work_order.id
    and invoice.deleted_at is null
    and invoice.created_at < v_reopen_activity.created_at;

  -- Do not infer prior billing from invoice state alone. Require the actual
  -- historical billed-to-7-Eleven audit event and the live staff invoice it
  -- names, both from before this reopen boundary.
  select activity.id, invoice.id, invoice.num
  into
    v_prior_billing_activity_id,
    v_prior_billing_invoice_id,
    v_prior_billing_invoice_num
    from public.activities activity
    join public.invoices invoice
      on invoice.id::text = activity.event_data ->> 'invoiceId'
     and invoice.work_order_id = v_work_order.id
     and invoice.invoice_type = 'staff'
     and invoice.document_kind = 'invoice'
     and invoice.state in ('approved', 'paid')
     and invoice.deleted_at is null
     and invoice.created_at < v_reopen_activity.created_at
    where activity.work_order_id = v_work_order.id
      and activity.event_key = 'staff_billing'
      and activity.event_data ->> 'action' = 'billed_to_7_eleven'
      and activity.workflow_cycle < v_work_order.workflow_cycle
      and activity.deleted_at is null
      and activity.created_at < v_reopen_activity.created_at
  order by activity.created_at desc, activity.id desc
  limit 1;

  if v_prior_billing_activity_id is null then
    raise exception 'No completed prior 7-Eleven billing cycle was found'
      using errcode = '23514';
  end if;

  update public.work_order_visits visit
  set check_out_at = v_now,
      checked_out_by = v_actor.id,
      updated_at = v_now
  where visit.work_order_id = v_work_order.id
    and visit.check_out_at is null;
  get diagnostics v_visits_closed = row_count;

  insert into public.work_order_close_transition_guards (
    transaction_id,
    work_order_id,
    actor_id,
    transition_kind
  ) values (
    txid_current(),
    v_work_order.id,
    v_actor.id,
    'reopened_without_additional_billing'
  )
  on conflict (transaction_id, work_order_id) do update
  set actor_id = excluded.actor_id,
      transition_kind = excluded.transition_kind,
      created_at = now();

  update public.work_orders work_order
  set status = 'closed',
      functional_status = 'Completed',
      closed_at = v_now,
      billing_ready_at = null,
      billing_ready_by = null,
      updated_at = v_now
  where work_order.id = v_work_order.id
    and work_order.deleted_at is null;

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
    activity_channel,
    workflow_cycle
  ) values (
    v_work_order.id,
    v_actor.id,
    v_actor.name,
    format(
      'Reopened follow-up closed by %s with no additional billing. Reason: %s',
      v_actor.name,
      v_reason
    ),
    'system',
    false,
    true,
    'work_order_follow_up_closed_without_additional_billing',
    jsonb_build_object(
      'action', 'closed_without_additional_billing',
      'reason', v_reason,
      'previousStatus', v_work_order.status,
      'previousFunctionalStatus', v_work_order.functional_status,
      'workOrderStatus', 'closed',
      'functionalStatus', 'Completed',
      'workflowCycle', v_work_order.workflow_cycle,
      'reopenedAt', v_reopen_activity.created_at,
      'reopenActivityId', v_reopen_activity.id,
      'priorBillingActivityId', v_prior_billing_activity_id,
      'priorBillingInvoiceId', v_prior_billing_invoice_id,
      'priorBillingInvoiceNum', v_prior_billing_invoice_num,
      'priorInvoiceCount', v_prior_invoice_count,
      'newInvoiceCount', 0,
      'invoicesChanged', false,
      'visitsClosed', v_visits_closed
    ),
    'internal_note',
    v_work_order.workflow_cycle
  );

  return jsonb_build_object(
    'applied', true,
    'reason', 'closed_without_additional_billing',
    'workOrderId', v_work_order.id,
    'workOrderStatus', 'closed',
    'functionalStatus', 'Completed',
    'closedAt', v_now,
    'workflowCycle', v_work_order.workflow_cycle,
    'priorInvoiceCount', v_prior_invoice_count,
    'visitsClosed', v_visits_closed
  );
end;
$$;

create unique index if not exists activities_follow_up_close_cycle_unique
  on public.activities(work_order_id, workflow_cycle)
  where event_key = 'work_order_follow_up_closed_without_additional_billing'
    and deleted_at is null;

create unique index if not exists activities_one_reopen_per_workflow_cycle
  on public.activities(work_order_id, workflow_cycle)
  where event_key = 'work_order_reopened'
    and deleted_at is null;

-- Inspect the final row after all earlier BEFORE triggers. Browser roles may
-- update ordinary work-order fields, but cannot create a terminal state
-- without the one-transaction capability issued by an approved close RPC.
create or replace function public.prevent_direct_work_order_close()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_guarded boolean := false;
begin
  if new.status <> 'closed' then
    return new;
  end if;

  if coalesce(auth.role(), '') in ('service_role', '') then
    return new;
  end if;

  -- Browser-created work orders must always enter through an operational
  -- state. There is no approved INSERT workflow that can atomically provide
  -- the billing or no-invoice evidence required by a terminal row.
  if tg_op = 'INSERT' then
    raise exception 'Work orders cannot be created in a closed state'
      using errcode = '42501';
  end if;

  -- A terminal timestamp is lifecycle evidence, not an editable display
  -- field. Reopen is the only browser workflow allowed to clear it, and that
  -- transition has already returned above because NEW.status is not closed.
  if old.status = 'closed' then
    if new.closed_at is distinct from old.closed_at then
      raise exception 'A closed work order timestamp cannot be changed directly'
        using errcode = '42501';
    end if;
    return new;
  end if;

  if new.closed_at is null then
    raise exception 'A closed work order requires a terminal timestamp'
      using errcode = '23514';
  end if;

  select exists (
    select 1
    from public.work_order_close_transition_guards transition_guard
    where transition_guard.transaction_id = txid_current()
      and transition_guard.work_order_id = new.id
      and transition_guard.actor_id = auth.uid()
  ) into v_guarded;

  if not v_guarded then
    raise exception 'Work orders must be closed through an approved close or billing workflow'
      using errcode = '42501';
  end if;

  return new;
end;
$$;

drop trigger if exists zz_prevent_direct_work_order_close_trigger
  on public.work_orders;
create trigger zz_prevent_direct_work_order_close_trigger
  before insert or update
  on public.work_orders
  for each row execute function public.prevent_direct_work_order_close();

-- The close decision depends on immutable workflow evidence. Protect the
-- exact event shapes used as proof while leaving ordinary notes and the
-- non-terminal staff_billing queue marker editable under existing policies.
create or replace function public.protect_authoritative_close_activity()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_old_protected boolean := false;
  v_new_protected boolean := false;
  v_required_transition_kind text;
  v_guard_consumed integer := 0;
  v_work_order_status public.wo_status;
  v_workflow_cycle integer;
begin
  if tg_op = 'INSERT' and coalesce(auth.role(), '') = 'authenticated'
     and new.event_key in (
       'staff_billing', 'staff_invoice_ready', 'invoice_approved',
       'invoice_rejected', 'invoice_rejection_retracted', 'invoice_deleted'
     ) and not exists (
       select 1 from public.profiles actor
       where actor.id = auth.uid() and actor.active = true
         and actor.role in ('manager', 'dispatcher', 'back_office')
         and not public.profile_has_staff_permission(actor.id, 'invoice_controller')
     ) then
    raise exception 'Operational staff invoice event required'
      using errcode = '42501';
  end if;

  if tg_op in ('UPDATE', 'DELETE') then
    v_old_protected := old.event_key in (
      'work_order_reopened',
      'work_order_closed_without_invoice',
      'work_order_follow_up_closed_without_additional_billing',
      'staff_invoice_ready',
      'invoice_draft',
      'invoice_submitted',
      'invoice_resubmitted',
      'invoice_uploaded',
      'invoice_approved',
      'invoice_rejected',
      'invoice_rejection_retracted',
      'invoice_deleted',
      'invoice_deleted_by_contractor'
    ) or old.event_key = 'staff_billing';
  end if;

  if tg_op in ('INSERT', 'UPDATE') then
    v_new_protected := new.event_key in (
      'work_order_reopened',
      'work_order_closed_without_invoice',
      'work_order_follow_up_closed_without_additional_billing',
      'staff_invoice_ready',
      'invoice_draft',
      'invoice_submitted',
      'invoice_resubmitted',
      'invoice_uploaded',
      'invoice_approved',
      'invoice_rejected',
      'invoice_rejection_retracted',
      'invoice_deleted',
      'invoice_deleted_by_contractor'
    ) or new.event_key = 'staff_billing';
  end if;

  if tg_op in ('UPDATE', 'DELETE')
     and (v_old_protected or v_new_protected)
     and coalesce(auth.role(), '') not in ('service_role', '') then
    -- Billing review/retraction and synchronization RPCs legitimately update
    -- attention flags. Preserve that workflow while freezing the evidence
    -- itself, including its deletion state, timestamp, and event identity.
    if tg_op = 'DELETE' then
      raise exception 'Authoritative work-order lifecycle activity is immutable'
        using errcode = '42501';
    end if;
    if (to_jsonb(new) - array[
          'requires_contractor_attention',
          'contractor_attention_acknowledged_at',
          'contractor_attention_acknowledged_by',
          'requires_7eleven_sync',
          'synced_to_7eleven_at',
          'synced_to_7eleven_by'
        ]) is distinct from (to_jsonb(old) - array[
          'requires_contractor_attention',
          'contractor_attention_acknowledged_at',
          'contractor_attention_acknowledged_by',
          'requires_7eleven_sync',
          'synced_to_7eleven_at',
          'synced_to_7eleven_by'
        ]) then
      raise exception 'Authoritative work-order lifecycle activity is immutable'
        using errcode = '42501';
    end if;
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;

  if tg_op = 'INSERT'
     and new.event_key = 'staff_billing'
     and new.event_data ->> 'action' = 'billed_to_7_eleven'
     and coalesce(auth.role(), '') not in ('service_role', '') then
    raise exception 'Billed-to-7-Eleven activity must be created by the billing workflow'
      using errcode = '42501';
  end if;

  if tg_op = 'INSERT'
     and new.event_key in (
       'work_order_closed_without_invoice',
       'work_order_follow_up_closed_without_additional_billing'
     )
     and coalesce(auth.role(), '') not in ('service_role', '') then
    v_required_transition_kind := case new.event_key
      when 'work_order_closed_without_invoice' then 'without_invoice'
      else 'reopened_without_additional_billing'
    end;

    delete from public.work_order_close_transition_guards transition_guard
    where transition_guard.transaction_id = txid_current()
      and transition_guard.work_order_id = new.work_order_id
      and transition_guard.actor_id = auth.uid()
      and transition_guard.transition_kind = v_required_transition_kind;
    get diagnostics v_guard_consumed = row_count;

    if v_guard_consumed <> 1 then
      raise exception 'Terminal close activity must be created by its owning workflow'
        using errcode = '42501';
    end if;
  end if;

  if tg_op = 'INSERT'
     and new.event_key = 'work_order_reopened'
     and coalesce(auth.role(), '') not in ('service_role', '') then
    select work_order.status, work_order.workflow_cycle
    into v_work_order_status, v_workflow_cycle
    from public.work_orders work_order
    where work_order.id = new.work_order_id;

    if not found
       or v_work_order_status = 'closed'
       or v_workflow_cycle <= 0
       or new.workflow_cycle is distinct from v_workflow_cycle
       or new.author_id is distinct from auth.uid() then
      raise exception 'Reopen activity must match the guarded reopen workflow'
        using errcode = '42501';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists zy_protect_authoritative_close_activity_trigger
  on public.activities;
create trigger zy_protect_authoritative_close_activity_trigger
  before insert or update or delete
  on public.activities
  for each row execute function public.protect_authoritative_close_activity();

-- Serialize new/pending field activity with terminal work-order transitions.
-- Trigger names are ordered alphabetically in PostgreSQL, so the `zz_`
-- prefix deliberately runs this after the existing activity-normalization
-- triggers have derived the two pending-work flags.
create or replace function public.guard_terminal_work_order_activity_mutation()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_work_order_status public.wo_status;
  v_work_order_deleted_at timestamptz;
  v_creates_closed_field_work boolean := false;
begin
  select work_order.status, work_order.deleted_at
  into v_work_order_status, v_work_order_deleted_at
  from public.work_orders work_order
  where work_order.id = new.work_order_id
  for key share;

  if not found then
    raise exception 'Activity must reference an existing work order'
      using errcode = '23503';
  end if;

  if tg_op = 'INSERT' then
    v_creates_closed_field_work := new.activity_channel = 'field_note';
  else
    v_creates_closed_field_work := new.activity_channel = 'field_note'
      and (
        old.activity_channel is distinct from new.activity_channel
        or old.event_key is distinct from new.event_key
        or old.text is distinct from new.text
        or old.event_data is distinct from new.event_data
      );
  end if;

  if (v_work_order_status = 'closed' or v_work_order_deleted_at is not null)
     and (
       v_creates_closed_field_work
       or
       (
         new.requires_7eleven_sync = true
         and new.synced_to_7eleven_at is null
       )
       or (
         new.requires_contractor_attention = true
         and new.contractor_attention_acknowledged_at is null
       )
     ) then
    raise exception 'Field or pending contractor activity cannot be added to a closed or archived work order; reopen it first'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

drop trigger if exists zz_guard_terminal_work_order_activity_trigger
  on public.activities;
create trigger zz_guard_terminal_work_order_activity_trigger
  before insert or update
  on public.activities
  for each row execute function
    public.guard_terminal_work_order_activity_mutation();

-- A visit INSERT has no existing row to lock, so take a parent key-share lock
-- before the foreign-key check. A closed visit cannot become open again:
-- a return visit must create its own row. This also avoids a child-to-parent
-- lock inversion during UPDATE. Corrections retaining checkout are unchanged.
drop trigger if exists zz_guard_terminal_work_order_visit_insert_trigger
  on public.work_order_visits;
drop function if exists public.guard_terminal_work_order_visit_insert();

create or replace function public.guard_terminal_work_order_visit_mutation()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_work_order_status public.wo_status;
  v_work_order_deleted_at timestamptz;
begin
  if tg_op = 'UPDATE' then
    if old.check_out_at is not null and new.check_out_at is null then
      raise exception 'A closed visit cannot be reopened; start a new visit'
        using errcode = '23514';
    end if;
    return new;
  end if;

  select work_order.status, work_order.deleted_at
  into v_work_order_status, v_work_order_deleted_at
  from public.work_orders work_order
  where work_order.id = new.work_order_id
  for key share;

  if not found then
    raise exception 'Visit must reference an existing work order'
      using errcode = '23503';
  end if;

  if v_work_order_deleted_at is not null
     or v_work_order_status = 'closed' then
    raise exception 'A visit cannot be opened on a closed or archived work order; reopen it first'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

drop trigger if exists zz_guard_terminal_work_order_visit_mutation_trigger
  on public.work_order_visits;
create trigger zz_guard_terminal_work_order_visit_mutation_trigger
  before insert or update
  on public.work_order_visits
  for each row execute function
    public.guard_terminal_work_order_visit_mutation();

-- Replace the browser-facing no-invoice close with a stale-safe overload that
-- issues the same one-transaction terminal capability. The legacy one-arg
-- signature is revoked below so a delayed request from an older workflow
-- cycle cannot close a newly reopened cycle.
create or replace function public.close_work_order_without_invoice(
  p_work_order_id text,
  p_expected_workflow_cycle integer,
  p_expected_contractor_assignment_version integer,
  p_expected_updated_at timestamptz
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
  v_invoice_count integer := 0;
  v_visits_closed integer := 0;
begin
  select profile.*
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

  if p_expected_workflow_cycle is null or p_expected_workflow_cycle < 0 then
    raise exception 'A valid expected workflow cycle is required'
      using errcode = '22023';
  end if;
  if p_expected_contractor_assignment_version is null
     or p_expected_contractor_assignment_version < 0 then
    raise exception 'A valid expected assignment version is required'
      using errcode = '22023';
  end if;
  if p_expected_updated_at is null then
    raise exception 'The expected work-order update time is required'
      using errcode = '22023';
  end if;

  select work_order.*
  into v_work_order
  from public.work_orders work_order
  where work_order.id = p_work_order_id
    and work_order.deleted_at is null
  for update;

  if not found then
    raise exception 'Work order not found'
      using errcode = 'P0002';
  end if;

  if v_work_order.workflow_cycle is distinct from p_expected_workflow_cycle then
    raise exception 'The work order changed before it could be closed; refresh and try again'
      using errcode = '40001';
  end if;

  if v_work_order.status = 'closed' then
    return jsonb_build_object(
      'applied', false,
      'reason', 'already_closed',
      'workOrderId', v_work_order.id,
      'workOrderStatus', v_work_order.status,
      'closedAt', v_work_order.closed_at,
      'workflowCycle', v_work_order.workflow_cycle,
      'visitsClosed', 0
    );
  end if;

  if v_work_order.contractor_assignment_version
       is distinct from p_expected_contractor_assignment_version
     or v_work_order.updated_at is distinct from p_expected_updated_at then
    raise exception 'The work order changed before it could be closed; refresh and review it before retrying'
      using errcode = '40001';
  end if;

  select count(*)::integer
  into v_invoice_count
  from public.invoices invoice
  where invoice.work_order_id = v_work_order.id
    and invoice.deleted_at is null;

  if v_invoice_count > 0 then
    raise exception 'This work order has % active invoice(s); use the normal close workflow',
      v_invoice_count
      using errcode = '23514';
  end if;

  update public.work_order_visits visit
  set check_out_at = v_now,
      checked_out_by = v_actor.id,
      updated_at = v_now
  where visit.work_order_id = v_work_order.id
    and visit.check_out_at is null;
  get diagnostics v_visits_closed = row_count;

  insert into public.work_order_close_transition_guards (
    transaction_id,
    work_order_id,
    actor_id,
    transition_kind
  ) values (
    txid_current(),
    v_work_order.id,
    v_actor.id,
    'without_invoice'
  )
  on conflict (transaction_id, work_order_id) do update
  set actor_id = excluded.actor_id,
      transition_kind = excluded.transition_kind,
      created_at = now();

  update public.work_orders work_order
  set status = 'closed',
      closed_at = v_now,
      updated_at = v_now
  where work_order.id = v_work_order.id
    and work_order.deleted_at is null;

  insert into public.activities (
    work_order_id,
    author_id,
    author_name,
    text,
    type,
    is_staff_override,
    is_staff_only,
    event_key,
    event_data
  ) values (
    v_work_order.id,
    v_actor.id,
    v_actor.name,
    format('Work order closed without an invoice by %s.', v_actor.name),
    'system',
    false,
    true,
    'work_order_closed_without_invoice',
    jsonb_build_object(
      'action', 'closed_without_invoice',
      'workOrderStatus', 'closed',
      'visitsClosed', v_visits_closed
    )
  );

  return jsonb_build_object(
    'applied', true,
    'reason', 'closed_without_invoice',
    'workOrderId', v_work_order.id,
    'workOrderStatus', 'closed',
    'closedAt', v_now,
    'workflowCycle', v_work_order.workflow_cycle,
    'visitsClosed', v_visits_closed
  );
end;
$$;

-- Keep the V3 RPC signature used by the billing API, while placing the
-- parent-work-order lock ahead of every staff invoice write. The renamed core
-- retains the existing atomic invoice/line/source implementation.
do $migration$
begin
  if to_regprocedure(
    'public.save_staff_billing_invoice_v3_core(uuid,uuid,text,text,text,text,text,date,date,date,text,text,numeric,text,numeric,text,text,jsonb,uuid[])'
  ) is null then
    if to_regprocedure(
      'public.save_staff_billing_invoice_v3(uuid,uuid,text,text,text,text,text,date,date,date,text,text,numeric,text,numeric,text,text,jsonb,uuid[])'
    ) is null then
      raise exception 'Required save_staff_billing_invoice_v3 function is missing';
    end if;

    execute 'alter function public.save_staff_billing_invoice_v3(uuid,uuid,text,text,text,text,text,date,date,date,text,text,numeric,text,numeric,text,text,jsonb,uuid[]) rename to save_staff_billing_invoice_v3_core';
  end if;
end;
$migration$;

create or replace function public.save_staff_billing_invoice_v3(
  p_actor_id uuid,
  p_invoice_id uuid,
  p_num text,
  p_work_order_id text,
  p_store_number text,
  p_store_address text,
  p_cme text,
  p_invoice_date date,
  p_service_date date,
  p_due_date date,
  p_terms text,
  p_state text,
  p_sales_tax numeric,
  p_tax_state text,
  p_tax_rate numeric,
  p_territory text,
  p_equipment_tag text,
  p_lines jsonb,
  p_source_invoice_ids uuid[]
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_work_order_id text := nullif(trim(coalesce(p_work_order_id, '')), '');
  v_existing_work_order_id text;
  v_invoice_lock_ids uuid[] := '{}'::uuid[];
begin
  if auth.role() <> 'service_role' then
    raise exception 'Service role required' using errcode = '42501';
  end if;

  -- Invoice workflows already lock invoice rows before their parent work
  -- order. Preserve that global order to avoid review/save deadlocks, then
  -- delegate to the existing core while the locks remain held.
  select coalesce(array_agg(lock_id order by lock_id), '{}'::uuid[])
  into v_invoice_lock_ids
  from (
    select distinct requested.lock_id
    from (
      select p_invoice_id as lock_id
      union all
      select source_id
      from unnest(coalesce(p_source_invoice_ids, '{}'::uuid[])) source(source_id)
    ) requested
    where requested.lock_id is not null
  ) lock_set;

  if cardinality(v_invoice_lock_ids) > 0 then
    perform 1
    from public.invoices invoice
    where invoice.id = any(v_invoice_lock_ids)
    order by invoice.id
    for update;
  end if;

  if p_invoice_id is not null then
    select invoice.work_order_id
    into v_existing_work_order_id
    from public.invoices invoice
    where invoice.id = p_invoice_id
      and invoice.invoice_type = 'staff'
      and invoice.deleted_at is null;

    if not found then
      raise exception 'Billing invoice not found'
        using errcode = 'P0002';
    end if;
  end if;

  perform 1
  from public.work_orders work_order
  where work_order.id in (v_work_order_id, v_existing_work_order_id)
    and work_order.deleted_at is null
  order by work_order.id
  for update;

  if v_work_order_id is not null and not exists (
    select 1
    from public.work_orders work_order
    where work_order.id = v_work_order_id
      and work_order.deleted_at is null
  ) then
    raise exception 'Linked work order was not found'
      using errcode = '23503';
  end if;

  if exists (
    select 1
    from public.work_orders work_order
    where work_order.id in (v_work_order_id, v_existing_work_order_id)
      and work_order.deleted_at is null
      and work_order.status = 'closed'
      and exists (
        select 1
        from public.activities activity
        where activity.work_order_id = work_order.id
          and activity.event_key in (
            'work_order_closed_without_invoice',
            'work_order_follow_up_closed_without_additional_billing'
          )
          and activity.deleted_at is null
          and (
            work_order.closed_at is null
            or activity.created_at >= work_order.closed_at
          )
      )
  ) then
    raise exception 'Invoices cannot be saved for this closed work order; reopen it first'
      using errcode = '23514';
  end if;

  return public.save_staff_billing_invoice_v3_core(
    p_actor_id,
    p_invoice_id,
    p_num,
    p_work_order_id,
    p_store_number,
    p_store_address,
    p_cme,
    p_invoice_date,
    p_service_date,
    p_due_date,
    p_terms,
    p_state,
    p_sales_tax,
    p_tax_state,
    p_tax_rate,
    p_territory,
    p_equipment_tag,
    p_lines,
    p_source_invoice_ids
  );
end;
$$;

-- A delayed replay of an already-billed document must never close a newer
-- reopened cycle. Current-cycle billing remains the normal close path.
create or replace function public.mark_staff_invoice_billed(
  p_invoice_id uuid,
  p_actor_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_now timestamptz := now();
  v_actor_name text;
  v_actor_role text;
  v_invoice public.invoices%rowtype;
  v_work_order public.work_orders%rowtype;
  v_reopen_activity public.activities%rowtype;
  v_is_capital_quote boolean := false;
  v_work_order_closed boolean := false;
  v_pending_capital_completion boolean := false;
  v_visits_closed integer := 0;
  v_transitioned boolean := false;
  v_already_finalized boolean := false;
  v_finalization_needed boolean := false;
  v_existing_work_order_status text;
begin
  select profile.name, profile.role::text
  into v_actor_name, v_actor_role
  from public.profiles profile
  where profile.id = p_actor_id
    and profile.active = true;

  if v_actor_role not in ('manager', 'dispatcher', 'back_office') then
    raise exception 'Staff access required' using errcode = '42501';
  end if;
  if public.profile_has_staff_permission(p_actor_id, 'invoice_controller') then
    raise exception 'Operational staff access required' using errcode = '42501';
  end if;

  select invoice.*
  into v_invoice
  from public.invoices invoice
  where invoice.id = p_invoice_id
    and invoice.invoice_type = 'staff'
    and invoice.deleted_at is null
  for update;

  if not found then
    raise exception 'Billing invoice not found' using errcode = 'P0002';
  end if;
  if v_invoice.state not in ('submitted', 'approved') then
    raise exception 'Only a billing document ready for 7-Eleven can be submitted'
      using errcode = '23514';
  end if;

  v_is_capital_quote := v_invoice.document_kind = 'capital_quote';

  select exists (
    select 1
    from public.activities activity
    where activity.work_order_id = v_invoice.work_order_id
      and activity.deleted_at is null
      and activity.event_data ->> 'invoiceId' = v_invoice.id::text
      and (
        (
          v_is_capital_quote
          and activity.event_key = 'capital_quote_submitted'
          and activity.event_data ->> 'action' = 'capital_quote_submitted'
        )
        or (
          not v_is_capital_quote
          and activity.event_key = 'staff_billing'
          and activity.event_data ->> 'action' = 'billed_to_7_eleven'
        )
      )
  ) into v_already_finalized;

  if v_already_finalized then
    if v_invoice.state <> 'approved' then
      raise exception 'Billing audit state does not match the invoice state'
        using errcode = '23514';
    end if;

    select work_order.status::text
    into v_existing_work_order_status
    from public.work_orders work_order
    where work_order.id = v_invoice.work_order_id
      and work_order.deleted_at is null;

    return jsonb_build_object(
      'applied', false,
      'reason', case
        when v_is_capital_quote then 'already_submitted'
        else 'already_billed'
      end,
      'invoiceId', v_invoice.id,
      'documentKind', v_invoice.document_kind,
      'workOrderId', v_invoice.work_order_id,
      'transitioned', false,
      'workOrderClosed', v_existing_work_order_status = 'closed',
      'pendingCapitalCompletion',
        v_existing_work_order_status = 'pending_capital_completion',
      'workOrderStatus', v_existing_work_order_status,
      'visitsClosed', 0
    );
  end if;

  v_finalization_needed := true;

  if v_invoice.work_order_id is not null then
    select work_order.*
    into v_work_order
    from public.work_orders work_order
    where work_order.id = v_invoice.work_order_id
      and work_order.deleted_at is null
    for update;
  end if;

  if v_work_order.id is not null
     and v_work_order.status <> 'closed'
     and v_work_order.workflow_cycle > 0 then
    select activity.*
    into v_reopen_activity
    from public.activities activity
    where activity.work_order_id = v_work_order.id
      and activity.workflow_cycle = v_work_order.workflow_cycle
      and activity.event_key = 'work_order_reopened'
      and activity.deleted_at is null
    order by activity.created_at desc, activity.id desc
    limit 1;

    if not found then
      raise exception 'Current reopened workflow metadata is missing'
        using errcode = '23514';
    end if;
    if v_invoice.created_at is null
       or v_invoice.created_at < v_reopen_activity.created_at then
      raise exception 'This billing document belongs to a prior workflow cycle and cannot close the reopened work order'
        using errcode = '40001';
    end if;
  end if;

  -- Safe replays returned above before reaching this branch. A different,
  -- unfinalized invoice must never add billing to a work order that was
  -- explicitly closed without an invoice or without additional billing.
  if v_work_order.id is not null
     and v_work_order.status = 'closed'
     and exists (
       select 1
       from public.activities close_activity
       where close_activity.work_order_id = v_work_order.id
         and close_activity.event_key in (
           'work_order_closed_without_invoice',
           'work_order_follow_up_closed_without_additional_billing'
         )
         and close_activity.deleted_at is null
         and (
           v_work_order.closed_at is null
           or close_activity.created_at >= v_work_order.closed_at
         )
     ) then
    raise exception 'This work order was closed without additional billing; reopen it before billing another invoice'
      using errcode = '23514';
  end if;

  if v_is_capital_quote
     and (v_work_order.id is null or not coalesce(v_work_order.is_capital, false)) then
    raise exception 'Capital quote is not linked to an active capital work order'
      using errcode = '23514';
  end if;

  if v_invoice.state = 'submitted' then
    update public.invoices
    set state = 'approved',
        updated_at = v_now
    where id = v_invoice.id;
    v_transitioned := true;
  end if;

  if v_invoice.work_order_id is not null and v_work_order.id is not null then
    if v_is_capital_quote then
      update public.work_orders
      set status = 'pending_capital_completion',
          functional_status = 'Pending Capital Completion',
          capital_status = case
            when capital_status = 'Pending approval' then null
            else capital_status
          end,
          is_capital = true,
          closed_at = null,
          updated_at = v_now
      where id = v_work_order.id
        and deleted_at is null;
      v_pending_capital_completion := true;
    else
      update public.work_order_visits
      set check_out_at = v_now,
          checked_out_by = p_actor_id,
          updated_at = v_now
      where work_order_id = v_invoice.work_order_id
        and check_out_at is null;
      get diagnostics v_visits_closed = row_count;

      update public.work_orders
      set status = 'closed',
          closed_at = coalesce(closed_at, v_now),
          updated_at = v_now
      where id = v_invoice.work_order_id
        and deleted_at is null
        and (status <> 'closed' or closed_at is null);
      v_work_order_closed := found;
    end if;

    if v_finalization_needed then
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
        activity_channel,
        workflow_cycle
      ) values (
        v_invoice.work_order_id,
        p_actor_id,
        coalesce(v_actor_name, 'P1 staff'),
        case
          when v_is_capital_quote then format(
            'Capital quote #%s submitted to 7-Eleven. Work order remains open pending capital completion.',
            v_invoice.num
          )
          else format(
            'P1 invoice #%s billed to 7-Eleven. Work order closed.',
            v_invoice.num
          )
        end,
        'system',
        false,
        true,
        case
          when v_is_capital_quote then 'capital_quote_submitted'
          else 'staff_billing'
        end,
        jsonb_build_object(
          'action', case
            when v_is_capital_quote then 'capital_quote_submitted'
            else 'billed_to_7_eleven'
          end,
          'documentKind', v_invoice.document_kind,
          'invoiceId', v_invoice.id,
          'invoiceNum', v_invoice.num,
          'workflowCycle', coalesce(v_work_order.workflow_cycle, 0),
          'workOrderStatus', case
            when v_is_capital_quote then 'pending_capital_completion'
            else 'closed'
          end
        ),
        'internal_note',
        coalesce(v_work_order.workflow_cycle, 0)
      );
    end if;
  end if;

  return jsonb_build_object(
    'applied', v_finalization_needed,
    'reason', case
      when v_is_capital_quote then 'submitted'
      else 'billed'
    end,
    'invoiceId', v_invoice.id,
    'documentKind', v_invoice.document_kind,
    'workOrderId', v_invoice.work_order_id,
    'transitioned', v_transitioned,
    'workOrderClosed', v_work_order_closed,
    'pendingCapitalCompletion', v_pending_capital_completion,
    'workOrderStatus', case
      when v_pending_capital_completion then 'pending_capital_completion'
      when v_work_order_closed then 'closed'
      else v_work_order.status::text
    end,
    'visitsClosed', v_visits_closed
  );
end;
$$;

-- Treat payables confirmation as accounting-only. It may update the
-- contractor invoice and audit records, but never an open operational cycle.
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
  quickbooks_transition text := coalesce(
    current_setting('app.quickbooks_handoff_transition', true),
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
  -- Controller handoff owns invoice state only. Cancel the legacy parent-WO
  -- recomputation entirely, before touch_wo or any AFTER UPDATE side effect
  -- can turn an accounting confirmation into an operational change.
  if quickbooks_transition = 'confirm' then
    return null;
  end if;

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

-- Closing without more billing is also terminal for staff invoice creation.
create or replace function public.prevent_invoice_on_closed_work_order()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_status public.wo_status;
  v_closed_at timestamptz;
  v_closed_without_invoice boolean := false;
begin
  if new.work_order_id is null
     or new.deleted_at is not null
     or coalesce(auth.role(), '') = 'service_role' then
    return new;
  end if;

  select work_order.status, work_order.closed_at
  into v_status, v_closed_at
  from public.work_orders work_order
  where work_order.id = new.work_order_id
    and work_order.deleted_at is null
  for key share;

  if not found or v_status <> 'closed' then
    return new;
  end if;

  if new.invoice_type = 'staff' then
    select exists (
      select 1
      from public.activities activity
      where activity.work_order_id = new.work_order_id
        and activity.event_key in (
          'work_order_closed_without_invoice',
          'work_order_follow_up_closed_without_additional_billing'
        )
        and activity.deleted_at is null
        and (
          v_closed_at is null
          or activity.created_at >= v_closed_at
        )
    ) into v_closed_without_invoice;
  end if;

  if new.invoice_type = 'contractor' or v_closed_without_invoice then
    raise exception 'Invoices cannot be created for this closed work order; reopen it first'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

drop trigger if exists prevent_invoice_on_closed_work_order_trigger
  on public.invoices;
create trigger prevent_invoice_on_closed_work_order_trigger
  before insert or update of work_order_id, deleted_at, invoice_type
  on public.invoices
  for each row execute function public.prevent_invoice_on_closed_work_order();

revoke all on function public.close_reopened_work_order_without_additional_billing(
  text, integer, integer, timestamptz, text
) from public, anon;
grant execute on function public.close_reopened_work_order_without_additional_billing(
  text, integer, integer, timestamptz, text
) to authenticated, service_role;
revoke all on function public.close_work_order_without_invoice(text)
  from public, anon, authenticated, service_role;
revoke all on function public.close_work_order_without_invoice(
  text, integer, integer, timestamptz
) from public, anon;
grant execute on function public.close_work_order_without_invoice(
  text, integer, integer, timestamptz
)
  to authenticated, service_role;

revoke all on function public.save_staff_billing_invoice_v3_core(
  uuid, uuid, text, text, text, text, text, date, date, date, text,
  text, numeric, text, numeric, text, text, jsonb, uuid[]
) from public, anon, authenticated, service_role;
revoke all on function public.save_staff_billing_invoice_v3(
  uuid, uuid, text, text, text, text, text, date, date, date, text,
  text, numeric, text, numeric, text, text, jsonb, uuid[]
) from public, anon, authenticated;
grant execute on function public.save_staff_billing_invoice_v3(
  uuid, uuid, text, text, text, text, text, date, date, date, text,
  text, numeric, text, numeric, text, text, jsonb, uuid[]
) to service_role;

revoke all on function public.mark_staff_invoice_billed(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.mark_staff_invoice_billed(uuid, uuid)
  to service_role;

revoke all on function public.preserve_operational_work_order_status()
  from public, anon, authenticated;
revoke all on function public.prevent_invoice_on_closed_work_order()
  from public, anon, authenticated;
revoke all on function public.guard_terminal_work_order_activity_mutation()
  from public, anon, authenticated;
revoke all on function public.guard_terminal_work_order_visit_mutation()
  from public, anon, authenticated;
revoke all on function public.prevent_direct_work_order_close()
  from public, anon, authenticated;
revoke all on function public.protect_authoritative_close_activity()
  from public, anon, authenticated;

commit;
