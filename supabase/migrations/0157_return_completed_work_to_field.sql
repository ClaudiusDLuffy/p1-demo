-- Completed field work sometimes needs another visit even while contractor
-- invoices are already in review. Keep the field and billing tracks parallel:
-- preserve every invoice and prior visit, open a new audited workflow cycle,
-- and require the next visit to start through the existing Resume command.

begin;

create unique index if not exists activities_one_completed_return_operation
  on public.activities ((event_data ->> 'operationId'))
  where event_key = 'work_order_reopened'
    and event_data ->> 'action' = 'work_order_returned_to_field'
    and deleted_at is null;

create or replace function public.return_completed_work_order_to_field_v1(
  p_work_order_id text,
  p_expected_assignment_version integer,
  p_expected_workflow_cycle integer,
  p_expected_lifecycle_version bigint,
  p_operation_id uuid,
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
  v_updated public.work_orders%rowtype;
  v_existing_activity public.activities%rowtype;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_is_staff boolean := false;
  v_is_company_admin boolean := false;
  v_next_status public.wo_status;
  v_next_workflow_cycle integer;
  v_result jsonb;
begin
  if nullif(btrim(coalesce(p_work_order_id, '')), '') is null
     or p_expected_assignment_version is null or p_expected_assignment_version < 0
     or p_expected_workflow_cycle is null or p_expected_workflow_cycle < 0
     or p_expected_lifecycle_version is null or p_expected_lifecycle_version < 0
     or p_operation_id is null then
    raise exception 'Work order identity and versions are required'
      using errcode = '22023';
  end if;
  if v_reason is null or char_length(v_reason) < 5 then
    raise exception 'A return reason of at least 5 characters is required'
      using errcode = '22023';
  end if;
  if char_length(v_reason) > 1000 then
    raise exception 'Return reason must be 1000 characters or fewer'
      using errcode = '22023';
  end if;

  select *
  into v_actor
  from public.profiles profile
  where profile.id = auth.uid()
    and profile.active = true;

  if not found then
    raise exception 'Active portal access required' using errcode = '42501';
  end if;

  v_is_staff := v_actor.role in ('manager', 'dispatcher', 'back_office')
    and not public.profile_has_staff_permission(v_actor.id, 'invoice_controller');
  v_is_company_admin := v_actor.role = 'contractor'
    and public.can_manage_contractor_company();

  if not v_is_staff and not v_is_company_admin then
    raise exception 'Operational staff or contractor company administrator access required'
      using errcode = '42501';
  end if;

  select *
  into v_work_order
  from public.work_orders work_order
  where work_order.id = p_work_order_id
    and work_order.deleted_at is null
  for update;

  if not found then
    raise exception 'Work order not found' using errcode = 'P0002';
  end if;

  -- Authorization is checked again after the row lock. A company assignment
  -- may have changed while this request was waiting for the lock.
  if v_is_company_admin
     and not public.can_access_contractor_work_order(v_work_order.id) then
    raise exception 'This work order is outside your contractor company'
      using errcode = '42501';
  end if;

  select *
  into v_existing_activity
  from public.activities activity
  where activity.event_key = 'work_order_reopened'
    and activity.event_data ->> 'action' = 'work_order_returned_to_field'
    and activity.event_data ->> 'operationId' = p_operation_id::text
    and activity.deleted_at is null;

  if found then
    if v_existing_activity.work_order_id is distinct from p_work_order_id
       or v_existing_activity.author_id is distinct from v_actor.id
       or v_existing_activity.event_data ->> 'reason' is distinct from v_reason
       or (v_existing_activity.event_data ->> 'expectedAssignmentVersion')::integer
          is distinct from p_expected_assignment_version
       or (v_existing_activity.event_data ->> 'expectedWorkflowCycle')::integer
          is distinct from p_expected_workflow_cycle
       or (v_existing_activity.event_data ->> 'expectedLifecycleVersion')::bigint
          is distinct from p_expected_lifecycle_version then
      raise exception 'Operation identity was reused with different input'
        using errcode = 'PT409';
    end if;
    return (v_existing_activity.event_data -> 'result')
      || jsonb_build_object('applied', false, 'reason', 'already_applied');
  end if;

  if v_work_order.contractor_assignment_version is distinct from
       p_expected_assignment_version then
    raise exception 'Work order assignment changed. Refresh and try again.'
      using errcode = 'PT409';
  end if;
  if v_work_order.workflow_cycle is distinct from p_expected_workflow_cycle then
    raise exception 'Work order workflow changed. Refresh and try again.'
      using errcode = 'PT409';
  end if;
  if v_work_order.lifecycle_version is distinct from p_expected_lifecycle_version then
    raise exception 'Work order changed. Refresh and try again.'
      using errcode = 'PT409';
  end if;
  if v_work_order.status::text not in (
       'completed', 'pending_invoice', 'pending_approval', 'pending_payment'
     ) or v_work_order.functional_status::text is distinct from 'Completed' then
    raise exception 'Only completed field work can be returned for another visit'
      using errcode = 'PT409';
  end if;
  if v_work_order.status = 'closed' then
    raise exception 'Closed work orders remain a P1 staff reopen workflow'
      using errcode = 'PT409';
  end if;
  if v_work_order.billing_only then
    raise exception 'Billing-only work orders have no field work to resume'
      using errcode = '23514';
  end if;
  if coalesce(v_work_order.is_capital, false) then
    raise exception 'Capital work must use the capital authorization workflow'
      using errcode = '23514';
  end if;
  if v_work_order.contractor_id is null then
    raise exception 'A contractor assignment is required before field work can return'
      using errcode = '23514';
  end if;
  if exists (
    select 1
    from public.work_order_visits visit
    where visit.work_order_id = v_work_order.id
      and visit.check_out_at is null
  ) then
    raise exception 'Close the active visit before returning completed work'
      using errcode = '23514';
  end if;

  v_next_status := case
    when v_work_order.status::text in (
      'pending_invoice', 'pending_approval', 'pending_payment'
    ) then v_work_order.status
    else coalesce(
      public.contractor_invoice_work_order_status(v_work_order.id),
      'parts'::public.wo_status
    )
  end;
  v_next_workflow_cycle := v_work_order.workflow_cycle + 1;

  insert into public.work_order_reopen_transition_guards (
    transaction_id, work_order_id, actor_id
  ) values (
    txid_current(), v_work_order.id, v_actor.id
  )
  on conflict (transaction_id, work_order_id) do update
  set actor_id = excluded.actor_id,
      created_at = now();

  -- This is an authoritative workflow command. Tell the existing parallel-
  -- billing guard not to restore the old `completed` portal status when the
  -- actor is a contractor; the fixed UPDATE below cannot alter invoices.
  perform set_config('app.contractor_invoicing_transition', 'finish', true);

  update public.work_orders work_order
  set status = v_next_status,
      functional_status = 'Awaiting Parts',
      workflow_cycle = v_next_workflow_cycle,
      updated_at = now()
  where work_order.id = v_work_order.id
    and work_order.deleted_at is null
  returning * into v_updated;

  v_result := jsonb_build_object(
    'applied', true,
    'reason', 'returned_to_field',
    'workOrderId', v_updated.id,
    'operationId', p_operation_id,
    'assignmentVersion', v_updated.contractor_assignment_version,
    'workflowCycle', v_updated.workflow_cycle,
    'lifecycleVersion', v_updated.lifecycle_version,
    'workOrderStatus', v_updated.status,
    'functionalStatus', v_updated.functional_status,
    'invoicesChanged', false,
    'assignmentsChanged', false,
    'visitsChanged', false
  );

  insert into public.activities (
    work_order_id, author_id, author_name, text, type,
    is_staff_override, is_staff_only, event_key, event_data, workflow_cycle
  ) values (
    v_updated.id,
    v_actor.id,
    v_actor.name,
    format(
      'Completed work returned for another field visit by %s. Reason: %s',
      v_actor.name,
      v_reason
    ),
    'system',
    v_is_staff,
    false,
    'work_order_reopened',
    jsonb_build_object(
      'action', 'work_order_returned_to_field',
      'mode', 'resume_work',
      'reason', v_reason,
      'operationId', p_operation_id,
      'expectedAssignmentVersion', p_expected_assignment_version,
      'expectedWorkflowCycle', p_expected_workflow_cycle,
      'expectedLifecycleVersion', p_expected_lifecycle_version,
      'previousStatus', v_work_order.status,
      'previousFunctionalStatus', v_work_order.functional_status,
      'workOrderStatus', v_updated.status,
      'functionalStatus', v_updated.functional_status,
      'workflowCycle', v_updated.workflow_cycle,
      'invoicesChanged', false,
      'assignmentsChanged', false,
      'visitsChanged', false,
      'result', v_result
    ),
    v_updated.workflow_cycle
  );

  delete from public.work_order_reopen_transition_guards transition_guard
  where transition_guard.transaction_id = txid_current()
    and transition_guard.work_order_id = v_updated.id;

  return v_result;
end;
$$;

revoke all on function public.return_completed_work_order_to_field_v1(
  text, integer, integer, bigint, uuid, text
) from public, anon, service_role;
grant execute on function public.return_completed_work_order_to_field_v1(
  text, integer, integer, bigint, uuid, text
) to authenticated;

comment on function public.return_completed_work_order_to_field_v1(
  text, integer, integer, bigint, uuid, text
) is
  'Returns completed non-capital field work to Awaiting Parts for an audited new visit cycle. Existing invoices, assignment, visits, and history are preserved.';

commit;
