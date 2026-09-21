-- Capital review is a parallel decision track. Restore the authoritative
-- field state when review is declined, let an audited emergency transfer use
-- the open visit as its source of truth, and open a new completion cycle when
-- approved capital work follows an already-completed field cycle.

begin;

-- 0123 keeps the public compatibility wrapper and moves the original
-- implementation behind this private core. Replace the core so the wrapper's
-- lifecycle capability, actor checks, and execute surface remain unchanged.
create or replace function public.decline_capital_work_order_lc_core(
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
  v_invoice_status public.wo_status;
  v_has_open_visit boolean := false;
  v_has_closed_visit boolean := false;
  v_has_current_completion boolean := false;
  v_activity_id uuid;
  v_destination text;
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

  if v_work_order.contractor_id is not null then
    select
      exists (
        select 1
        from public.work_order_visits visit
        where visit.work_order_id = v_work_order.id
          and visit.contractor_id = v_work_order.contractor_id
          and visit.check_out_at is null
          and (
            v_work_order.contractor_assignment_started_at is null
            or visit.check_in_at >= v_work_order.contractor_assignment_started_at
          )
      ),
      exists (
        select 1
        from public.work_order_visits visit
        where visit.work_order_id = v_work_order.id
          and visit.contractor_id = v_work_order.contractor_id
          and visit.check_out_at is not null
          and (
            v_work_order.contractor_assignment_started_at is null
            or visit.check_in_at >= v_work_order.contractor_assignment_started_at
          )
      ),
      exists (
        select 1
        from public.activities activity
        where activity.work_order_id = v_work_order.id
          and activity.contractor_assignment_version =
            v_work_order.contractor_assignment_version
          and activity.workflow_cycle = v_work_order.workflow_cycle
          and activity.event_key = 'job_completed'
          and activity.deleted_at is null
      )
    into v_has_open_visit, v_has_closed_visit, v_has_current_completion;

    v_invoice_status := public.contractor_invoice_work_order_status(
      v_work_order.id
    );
  end if;

  if v_work_order.contractor_id is null then
    v_next_status := 'unassigned';
    v_next_functional_status := 'New';
    v_destination := 'the unassigned queue';
  elsif v_work_order.assignment_transfer_pending_visit then
    -- The outgoing visit was administratively closed during transfer. Keep
    -- the special WIP marker so the receiving contractor must create its own
    -- visit and can never inherit the outgoing contractor's time.
    v_next_status := 'wip';
    v_next_functional_status := 'Work in Progress';
    v_destination := 'the receiving contractor visit';
  elsif v_has_open_visit then
    v_next_status := coalesce(v_invoice_status, 'wip'::public.wo_status);
    v_next_functional_status := 'Work in Progress';
    v_destination := 'work in progress';
  elsif v_has_current_completion then
    v_next_status := coalesce(
      v_invoice_status,
      'completed'::public.wo_status
    );
    v_next_functional_status := 'Completed';
    v_destination := 'completed field work';
  elsif v_has_closed_visit then
    v_next_status := coalesce(v_invoice_status, 'parts'::public.wo_status);
    v_next_functional_status := 'Awaiting Parts';
    v_destination := 'awaiting parts';
  else
    v_next_status := 'assigned';
    v_next_functional_status := 'Dispatched';
    v_destination := 'dispatched';
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
      v_destination
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
      'restoredFromVisitState', true,
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

comment on function public.decline_capital_work_order_lc_core(text, integer) is
  'Private guarded core that declines capital review and restores the current assignment field state from authoritative visits, completion evidence, and invoice state.';

revoke all on function public.decline_capital_work_order_lc_core(text, integer)
  from public, anon, authenticated, service_role;

-- An open visit is the authoritative evidence for the exceptional transfer.
-- Capital classification can legitimately replace the parent WIP status while
-- that visit remains open, so do not require the ordinary WIP label alone.
create or replace function public.administrative_close_visit_and_transfer_v1(
  p_work_order_id text,p_new_contractor_id uuid,p_expected_assignment_version integer,
  p_expected_workflow_cycle integer,p_expected_lifecycle_version bigint,p_operation_id uuid,
  p_reason text,p_confirmed boolean
)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_result jsonb; v_work public.work_orders%rowtype; v_visit public.work_order_visits%rowtype;
  v_actor public.profiles%rowtype; v_closed_at timestamptz; v_activity uuid; v_count integer;
  v_reason text:=regexp_replace(p_reason,'^\s+|\s+$','','g');
begin
  if p_confirmed is distinct from true or v_reason is null or length(v_reason) not between 1 and 500 then
    raise exception 'A nonempty reason and explicit confirmation are required' using errcode='22023'; end if;
  v_result:=public.begin_work_order_assignment_command(p_work_order_id,p_expected_assignment_version,
    p_expected_workflow_cycle,p_expected_lifecycle_version,p_operation_id,'transition',jsonb_build_object('newContractorId',p_new_contractor_id,
      'transferMode','administrative_close','reason',v_reason,'confirmed',true));
  if v_result is not null then return v_result; end if;
  v_actor:=public.require_work_order_assignment_actor();
  select * into strict v_work from public.work_orders w where w.id=p_work_order_id;
  if v_work.contractor_id is null or v_work.contractor_id is not distinct from p_new_contractor_id
    or v_work.billing_only or v_work.status::text not in ('wip','capital','pending_capital_completion')
    or v_work.functional_status::text not in ('Work in Progress','Pending Capital Approval','Pending Capital Completion') then
    raise exception 'Administrative transfer requires active field work' using errcode='PT409'; end if;
  perform public.require_assignable_contractor(p_new_contractor_id);
  select * into v_visit from public.work_order_visits v where v.work_order_id=p_work_order_id and v.check_out_at is null for update;
  if not found or v_visit.contractor_id is distinct from v_work.contractor_id then
    raise exception 'Current assignment has no eligible active visit' using errcode='PT409'; end if;
  v_closed_at:=clock_timestamp();
  if v_visit.check_in_at>v_closed_at then raise exception 'Visit time requires review before transfer' using errcode='PT409'; end if;
  update public.work_order_assignment_command_guards set administrative_visit_id=v_visit.id,preserve_transfer_state=true
    where transaction_id=txid_current() and work_order_id=p_work_order_id and operation_id=p_operation_id;
  insert into public.activities(work_order_id,author_id,author_name,text,type,activity_channel,entered_by_role,
    is_staff_only,is_staff_override,requires_7eleven_sync,requires_contractor_attention,event_key,event_data,administrative_transfer_operation_id)
  values(p_work_order_id,v_actor.id,v_actor.name,'Visit administratively closed for assignment transfer; duration requires review.',
    'system','system_event',v_actor.role::text,true,false,false,false,'visit_administratively_closed_for_transfer',
    jsonb_build_object('operationId',p_operation_id,'visitId',v_visit.id,'closedAt',v_closed_at,'reason',v_reason,
      'previousContractorId',v_work.contractor_id,'newContractorId',p_new_contractor_id,
      'assignmentVersion',v_work.contractor_assignment_version,'durationReviewRequired',true,
      'capitalStagePreserved',v_work.status::text in ('capital','pending_capital_completion')),p_operation_id)
    returning id into v_activity;
  if v_activity is null then raise exception 'Administrative closure evidence was not recorded' using errcode='23514'; end if;
  update public.work_order_visits set check_out_at=v_closed_at,checked_out_by=v_actor.id,check_out_activity_id=v_activity,
    closure_kind='administrative_transfer',duration_review_required=true,administrative_closed_at=v_closed_at,
    administrative_closed_by=v_actor.id,administrative_close_reason=v_reason,administrative_transfer_operation_id=p_operation_id
    where id=v_visit.id;
  get diagnostics v_count=row_count;
  if v_count<>1 then raise exception 'Administrative visit closure was not recorded' using errcode='23514'; end if;
  v_result:=public.transition_work_order_contractor_assignment_core(p_work_order_id,p_new_contractor_id,p_expected_assignment_version);
  return public.finish_work_order_assignment_command(p_operation_id,v_result||jsonb_build_object('receivingVisitRequired',true,
    'administrativeClosedVisitId',v_visit.id,'administrativeClosedAt',v_closed_at,'administrativeClosureActivityId',v_activity,
    'durationReviewRequired',true));
end;
$$;

comment on function public.administrative_close_visit_and_transfer_v1(text,uuid,integer,integer,bigint,uuid,text,boolean) is
  'Explicitly closes the current assignment open visit and transfers the work while preserving ordinary or capital parent state and immutable audit provenance.';

revoke all on function public.administrative_close_visit_and_transfer_v1(text,uuid,integer,integer,bigint,uuid,text,boolean)
  from public,anon,authenticated,service_role;
grant execute on function public.administrative_close_visit_and_transfer_v1(text,uuid,integer,integer,bigint,uuid,text,boolean)
  to authenticated;

-- Authorization after an already-recorded completion begins a genuinely new
-- field cycle. Without this increment the second completion collides with the
-- one-completion-per-assignment-and-cycle invariant.
create or replace function public.resume_capital_work_lc_core(
  p_work_order_id text
)
returns public.work_orders
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor public.profiles%rowtype;
  v_work_order public.work_orders%rowtype;
  v_has_prior_visit boolean := false;
  v_has_current_completion boolean := false;
  v_next_workflow_cycle integer;
begin
  select * into v_actor
  from public.profiles profile
  where profile.id = auth.uid()
    and profile.active = true
    and profile.role in ('manager', 'dispatcher', 'back_office');

  if not found then
    raise exception 'Active P1 staff access required' using errcode = '42501';
  end if;
  if public.profile_has_staff_permission(v_actor.id, 'invoice_controller') then
    raise exception 'Operational staff access required' using errcode = '42501';
  end if;

  select * into v_work_order
  from public.work_orders work_order
  where work_order.id = p_work_order_id
    and work_order.deleted_at is null
  for update;

  if not found then
    raise exception 'Work order not found' using errcode = 'P0002';
  end if;
  if v_work_order.status <> 'pending_capital_completion' then
    raise exception 'Work order is not waiting for capital approval'
      using errcode = '23514';
  end if;
  if exists (
    select 1 from public.work_order_visits visit
    where visit.work_order_id = v_work_order.id
      and visit.check_out_at is null
  ) then
    raise exception 'Clock out the active visit before authorizing the next capital visit'
      using errcode = 'PT409';
  end if;

  select exists (
    select 1
    from public.work_order_visits visit
    where visit.work_order_id = v_work_order.id
      and visit.contractor_id = v_work_order.contractor_id
      and visit.check_out_at is not null
      and (
        v_work_order.contractor_assignment_started_at is null
        or visit.check_in_at >= v_work_order.contractor_assignment_started_at
      )
  ) into v_has_prior_visit;

  select exists (
    select 1
    from public.activities activity
    where activity.work_order_id = v_work_order.id
      and activity.contractor_assignment_version =
        v_work_order.contractor_assignment_version
      and activity.workflow_cycle = v_work_order.workflow_cycle
      and activity.event_key = 'job_completed'
      and activity.deleted_at is null
  ) into v_has_current_completion;

  v_next_workflow_cycle := v_work_order.workflow_cycle
    + case when v_has_current_completion then 1 else 0 end;

  if v_has_current_completion then
    insert into public.work_order_reopen_transition_guards (
      transaction_id, work_order_id, actor_id
    ) values (
      txid_current(), v_work_order.id, v_actor.id
    )
    on conflict (transaction_id, work_order_id) do update
    set actor_id = excluded.actor_id,
        created_at = now();
  end if;

  update public.work_orders
  set status = case
        when contractor_id is null then 'unassigned'::public.wo_status
        when assignment_transfer_pending_visit then 'wip'::public.wo_status
        when v_has_prior_visit then 'parts'::public.wo_status
        else 'assigned'::public.wo_status
      end,
      functional_status = case
        when contractor_id is null then 'New'::public.fsm_functional_status
        when assignment_transfer_pending_visit then 'Work in Progress'::public.fsm_functional_status
        when v_has_prior_visit then 'Awaiting Parts'::public.fsm_functional_status
        else 'Dispatched'::public.fsm_functional_status
      end,
      capital_status = 'Approved - work authorized',
      is_capital = true,
      closed_at = null,
      workflow_cycle = v_next_workflow_cycle,
      updated_at = now()
  where id = v_work_order.id
  returning * into v_work_order;

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
    event_data
  ) values (
    v_work_order.id,
    v_actor.id,
    v_actor.name,
    format(
      'Capital work authorized by 7-Eleven and released for the next field visit by %s.',
      v_actor.name
    ),
    'system',
    false,
    true,
    'capital_work_authorized',
    jsonb_build_object(
      'action', 'capital_work_authorized',
      'workOrderStatus', v_work_order.status,
      'capitalStatus', v_work_order.capital_status,
      'previousWorkflowCycle', v_work_order.workflow_cycle
        - case when v_has_current_completion then 1 else 0 end,
      'workflowCycle', v_work_order.workflow_cycle,
      'newCompletionCycle', v_has_current_completion,
      'nextFieldAction', case
        when v_work_order.assignment_transfer_pending_visit then 'receiving_start'
        when v_has_prior_visit then 'resume'
        else 'start'
      end
    )
  );

  return v_work_order;
end;
$$;

comment on function public.resume_capital_work_lc_core(text) is
  'Private guarded core that authorizes capital field work, requires checkout first, and opens a new workflow cycle after a prior completion.';

revoke all on function public.resume_capital_work_lc_core(text)
  from public, anon, authenticated, service_role;

commit;
