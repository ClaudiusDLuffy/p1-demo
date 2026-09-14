-- Owner-approved hybrid policy: recorded checkout is the default. Operational
-- staff may explicitly close the visit administratively and transfer it, with
-- immutable non-field provenance and a mandatory duration-review flag.
-- Apply after 0127 and the command-compatible hybrid UI. No historical repair.
begin;

alter table public.work_orders
  add column assignment_transfer_pending_visit boolean not null default false,
  add column assignment_transfer_operation_id uuid references public.work_order_assignment_operations(operation_id);
alter table public.work_orders add constraint assignment_transfer_pending_identity
  check (not assignment_transfer_pending_visit or assignment_transfer_operation_id is not null);
alter table public.work_order_assignment_command_guards
  add column administrative_visit_id uuid references public.work_order_visits(id),
  add column preserve_transfer_state boolean not null default false;
alter table public.work_order_visits
  add column closure_kind text check (closure_kind is null or closure_kind='administrative_transfer'),
  add column duration_review_required boolean not null default false,
  add column administrative_closed_at timestamptz,
  add column administrative_closed_by uuid references public.profiles(id),
  add column administrative_close_reason text,
  add column administrative_transfer_operation_id uuid references public.work_order_assignment_operations(operation_id);
alter table public.work_order_visits add constraint administrative_transfer_provenance_complete check (
  case when closure_kind is null then not duration_review_required and administrative_closed_at is null
    and administrative_closed_by is null and administrative_close_reason is null and administrative_transfer_operation_id is null
  else closure_kind='administrative_transfer' and duration_review_required and check_out_at is not null
    and administrative_closed_at is not null and administrative_closed_by is not null
    and administrative_close_reason is not null and length(btrim(administrative_close_reason)) between 1 and 500
    and administrative_transfer_operation_id is not null end);
alter table public.activities add column administrative_transfer_operation_id uuid
  references public.work_order_assignment_operations(operation_id);
create unique index activities_one_administrative_transfer
  on public.activities(administrative_transfer_operation_id) where administrative_transfer_operation_id is not null;
create unique index visits_one_administrative_transfer
  on public.work_order_visits(administrative_transfer_operation_id) where administrative_transfer_operation_id is not null;

-- Preserve the prior replay projection for pre-0128 operations. Only hybrid
-- operations acquire additional immutable evidence; no legacy backfill.
alter function public.assignment_evidence_snapshot(uuid) rename to assignment_evidence_snapshot_pre_hybrid;
create function public.assignment_evidence_snapshot(p_operation_id uuid)
returns jsonb language sql stable security definer set search_path=public,pg_temp as $$
  with base as (select public.assignment_evidence_snapshot_pre_hybrid(p_operation_id) value)
  select jsonb_set(base.value,'{activities}',coalesce((select jsonb_agg(item-'administrative_transfer_operation_id' order by position)
    from jsonb_array_elements(base.value->'activities') with ordinality as ordered(item,position)),'[]'::jsonb))||case when exists(
    select 1 from public.activities a where a.administrative_transfer_operation_id=p_operation_id) then jsonb_build_object(
    'administrativeActivity',(select to_jsonb(a) from public.activities a where a.administrative_transfer_operation_id=p_operation_id),
    'administrativeVisit',(select to_jsonb(v)-'updated_at' from public.work_order_visits v
      where v.administrative_transfer_operation_id=p_operation_id)) else '{}'::jsonb end from base;
$$;
create or replace function public.lifecycle_visit_snapshot(p_visit_id uuid)
returns jsonb language sql stable security definer set search_path=public,pg_temp as $$
  select (to_jsonb(v)-'updated_at')-case when v.closure_kind is null then array[
    'closure_kind','duration_review_required','administrative_closed_at','administrative_closed_by',
    'administrative_close_reason','administrative_transfer_operation_id'] else '{}'::text[] end
  from public.work_order_visits v where v.id=p_visit_id;
$$;
-- Financial events cannot be administrative visit events. Exclude the newly
-- added null column so accepted financial replay survives this expansion.
create or replace function public.invoice_financial_activity_snapshot(p_activity_id uuid)
returns jsonb language plpgsql stable security definer set search_path=public,pg_temp as $$
declare v_activity public.activities%rowtype; v_snapshot jsonb; v_previous jsonb; v_operation text;
begin
  select * into v_activity from public.activities a where a.id=p_activity_id and a.deleted_at is null;
  if not found then return null; end if;
  v_snapshot:=to_jsonb(v_activity)-array['synced_to_7eleven_at','synced_to_7eleven_by',
    'contractor_attention_acknowledged_at','contractor_attention_acknowledged_by','administrative_transfer_operation_id'];
  v_operation:=v_activity.event_data->>'operationId';
  if v_operation ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    select o.activity_snapshot into v_previous from public.invoice_financial_operations o
      where o.operation_id=v_operation::uuid and o.result->>'activityId'=p_activity_id::text;
    if v_previous is null then select o.activity_snapshot into v_previous from public.work_order_billing_operations o
      where o.operation_id=v_operation::uuid and o.result->>'activityId'=p_activity_id::text; end if;
    -- 0126 also added a nullable assignment column. Preserve the exact saved
    -- projection for a financial command accepted before that expansion.
    if v_previous is not null and not (v_previous ? 'assignment_operation_id') then
      v_snapshot:=v_snapshot-'assignment_operation_id'; end if;
  end if;
  return v_snapshot;
end;
$$;
alter function public.assignment_parent_snapshot(text) rename to assignment_parent_snapshot_pre_hybrid;
create function public.assignment_parent_snapshot(p_work_order_id text)
returns jsonb language sql stable security definer set search_path=public,pg_temp as $$
  select public.assignment_parent_snapshot_pre_hybrid(p_work_order_id)||case when w.assignment_transfer_pending_visit
    then jsonb_build_object('receivingVisitRequired',true,'transferOperationId',w.assignment_transfer_operation_id)
    else '{}'::jsonb end from public.work_orders w where w.id=p_work_order_id;
$$;

create function public.protect_administrative_transfer_visit()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare v_guard public.work_order_assignment_command_guards%rowtype;
begin
  if public.lifecycle_is_owner_maintenance() then
    if tg_op='DELETE' then return old; else return new; end if; end if;
  if tg_op='DELETE' then
    if old.closure_kind is not null then raise exception 'Administrative visit evidence is immutable' using errcode='42501'; end if;
    return old;
  end if;
  if tg_op='UPDATE' and old.closure_kind is not null then
    -- Audited correction may change actual times, never classify this
    -- administrative duration as approved billable time or rewrite its author.
    if (to_jsonb(new)-array['check_in_at','check_out_at','updated_at'])
      is distinct from (to_jsonb(old)-array['check_in_at','check_out_at','updated_at']) then
      raise exception 'Administrative visit provenance and duration review are immutable' using errcode='42501'; end if;
    return new;
  end if;
  if new.closure_kind is null and not new.duration_review_required and new.administrative_closed_at is null
    and new.administrative_closed_by is null and new.administrative_close_reason is null
    and new.administrative_transfer_operation_id is null then return new; end if;
  select * into v_guard from public.work_order_assignment_command_guards g
    where g.transaction_id=txid_current() and g.work_order_id=new.work_order_id and g.administrative_visit_id=new.id
      and g.actor_id=auth.uid() and g.actor_role=auth.role() and g.operation_id=new.administrative_transfer_operation_id;
  if tg_op<>'UPDATE' or v_guard.transaction_id is null or old.check_out_at is not null
    or new.closure_kind is distinct from 'administrative_transfer' or not new.duration_review_required
    or new.administrative_closed_by is distinct from auth.uid()
    or new.check_out_at is distinct from new.administrative_closed_at then
    raise exception 'Administrative visit closure requires its confirmed command' using errcode='42501'; end if;
  return new;
end;
$$;
create trigger aaa_protect_administrative_transfer_visit before insert or update or delete on public.work_order_visits
  for each row execute function public.protect_administrative_transfer_visit();

-- Extend the existing visit capability by one exact visit identity, not a
-- general lifecycle permission. Existing correction and lifecycle rules stay.
create or replace function public.protect_work_order_lifecycle_visit()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare v_work_id text; v_allowed boolean; v_strict boolean;
begin
  v_work_id:=case when tg_op='DELETE' then old.work_order_id else new.work_order_id end;
  select contracted into v_strict from public.work_order_lifecycle_control where singleton;
  if not v_strict or public.lifecycle_is_owner_maintenance() then
    if tg_op='DELETE' then return old; else return new; end if; end if;
  select exists(select 1 from public.work_order_lifecycle_transition_guards g
    where g.transaction_id=txid_current() and g.work_order_id=v_work_id
      and g.actor_id is not distinct from auth.uid() and g.visit_allowed)
    or (tg_op='UPDATE' and exists(select 1 from public.work_order_visit_correction_context c
      where c.transaction_id=txid_current() and c.visit_id=old.id))
    or (tg_op='UPDATE' and exists(select 1 from public.work_order_assignment_command_guards g
      where g.transaction_id=txid_current() and g.work_order_id=v_work_id and g.actor_id=auth.uid()
        and g.actor_role=auth.role() and g.administrative_visit_id=old.id)) into v_allowed;
  if not v_allowed then raise exception 'Visit changes must use the work-order lifecycle action' using errcode='42501'; end if;
  if tg_op='DELETE' then return old; else return new; end if;
end;
$$;

create function public.protect_administrative_transfer_activity()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare v_guard public.work_order_assignment_command_guards%rowtype; v_reserved boolean:=false;
begin
  if public.lifecycle_is_owner_maintenance() then
    if tg_op='DELETE' then return old; else return new; end if; end if;
  if tg_op<>'INSERT' then v_reserved:=old.event_key='visit_administratively_closed_for_transfer'
    or old.administrative_transfer_operation_id is not null; end if;
  if tg_op<>'DELETE' then v_reserved:=coalesce(v_reserved,false) or new.event_key='visit_administratively_closed_for_transfer'
    or new.administrative_transfer_operation_id is not null; end if;
  if not coalesce(v_reserved,false) then if tg_op='DELETE' then return old; else return new; end if; end if;
  if tg_op<>'INSERT' then raise exception 'Administrative transfer evidence is immutable' using errcode='42501'; end if;
  select * into v_guard from public.work_order_assignment_command_guards g
    where g.transaction_id=txid_current() and g.work_order_id=new.work_order_id and g.actor_id=auth.uid()
      and g.actor_role=auth.role() and g.operation_id=new.administrative_transfer_operation_id
      and g.administrative_visit_id is not null;
  if v_guard.transaction_id is null or new.event_key is distinct from 'visit_administratively_closed_for_transfer'
    or new.author_id is distinct from auth.uid() or new.assignment_operation_id is not null
    or new.lifecycle_operation_id is not null then
    raise exception 'Administrative transfer evidence requires its owning command' using errcode='42501'; end if;
  return new;
end;
$$;
create trigger zzzzz_protect_administrative_transfer_activity before insert or update or delete on public.activities
  for each row execute function public.protect_administrative_transfer_activity();

create function public.protect_pending_assignment_transfer()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare v_guard public.work_order_assignment_command_guards%rowtype; v_lifecycle boolean;
begin
  if public.lifecycle_is_owner_maintenance() then return new; end if;
  if tg_op='INSERT' then
    if new.assignment_transfer_pending_visit or new.assignment_transfer_operation_id is not null then
      raise exception 'Transfer provenance cannot be supplied at creation' using errcode='42501'; end if;
    return new;
  end if;
  -- This catches every trusted writer as well as the browser command, including
  -- a DO NOT DISPATCH intake refresh. A service command cannot silently strand
  -- an active visit by changing its contractor. The explicit admin command
  -- closes its exact visit before its assignment UPDATE reaches this guard.
  if new.contractor_id is distinct from old.contractor_id and exists(
    select 1 from public.work_order_visits v where v.work_order_id=old.id and v.check_out_at is null) then
    raise exception 'active_visit_requires_checkout' using errcode='PT409',detail='active_visit_requires_checkout'; end if;
  select * into v_guard from public.work_order_assignment_command_guards g
    where g.transaction_id=txid_current() and g.work_order_id=new.id and g.actor_id=auth.uid()
      and g.actor_role=auth.role() and g.preserve_transfer_state;
  if v_guard.transaction_id is not null and new.contractor_id is distinct from old.contractor_id then
    -- Runs after the legacy privacy/reset trigger but before lifecycle-version
    -- calculation. Keep the operational state, never the outgoing private fields.
    new.status:=old.status; new.functional_status:=old.functional_status;
    new.assignment_transfer_pending_visit:=true;
    new.assignment_transfer_operation_id:=case when v_guard.administrative_visit_id is not null
      then v_guard.operation_id else old.assignment_transfer_operation_id end;
  end if;
  if new.assignment_transfer_pending_visit is distinct from old.assignment_transfer_pending_visit
    or new.assignment_transfer_operation_id is distinct from old.assignment_transfer_operation_id then
    select exists(select 1 from public.work_order_lifecycle_transition_guards g where g.transaction_id=txid_current()
      and g.work_order_id=new.id and g.actor_id=auth.uid() and g.command_kind in ('start','resume')
      and g.operation_id is not null and g.parent_allowed) into v_lifecycle;
    if v_guard.transaction_id is null and not (v_lifecycle and not new.assignment_transfer_pending_visit
      and new.assignment_transfer_operation_id is not distinct from old.assignment_transfer_operation_id) then
      raise exception 'Transfer provenance is command-owned' using errcode='42501'; end if;
  end if;
  -- A transferred job stays started, but no receiving visit has happened yet.
  -- Existing no-visit completion/billing compatibility is unchanged elsewhere;
  -- it cannot consume this new pending state or borrow the outgoing visit.
  if old.assignment_transfer_pending_visit and new.assignment_transfer_pending_visit
    and (new.status is distinct from 'wip' or new.functional_status is distinct from 'Work in Progress') then
    raise exception 'receiving_visit_required' using errcode='PT409',detail='receiving_visit_required'; end if;
  return new;
end;
$$;
create trigger zz_preserve_pending_assignment_transfer before insert or update on public.work_orders
  for each row execute function public.protect_pending_assignment_transfer();

-- Only the previous administrative transfer can leave an unassigned WIP
-- record. Its subsequent initial assignment needs no outgoing delivery; the
-- original transfer already owns that ledger. All other initial assignment
-- eligibility remains in the unchanged legacy core.
create function public.assign_pending_transferred_work_order(p_work_order_id text,p_new_contractor_id uuid)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_work public.work_orders%rowtype; v_actor public.profiles%rowtype; v_target public.profiles%rowtype;
begin
  v_actor:=public.require_work_order_assignment_actor();
  select * into strict v_work from public.work_orders w where w.id=p_work_order_id for update;
  if v_work.contractor_id is not null or p_new_contractor_id is null or not v_work.assignment_transfer_pending_visit
    or v_work.assignment_transfer_operation_id is null or v_work.status<>'wip'
    or v_work.functional_status<>'Work in Progress' or v_work.deleted_at is not null or v_work.billing_only then
    raise exception 'Work order is not awaiting a receiving assignment' using errcode='PT409'; end if;
  perform public.require_assignable_contractor(p_new_contractor_id);
  select * into strict v_target from public.profiles p where p.id=p_new_contractor_id;
  insert into public.work_order_assignment_transition_guards(transaction_id,work_order_id,actor_id)
    values(txid_current(),p_work_order_id,v_actor.id);
  update public.work_orders set contractor_id=p_new_contractor_id where id=p_work_order_id returning * into v_work;
  delete from public.work_order_assignment_transition_guards where transaction_id=txid_current() and work_order_id=p_work_order_id;
  insert into public.activities(work_order_id,author_id,author_name,text,type,activity_channel,entered_by_role,
    is_staff_only,is_staff_override,requires_7eleven_sync,requires_contractor_attention,event_key,event_data)
  values(p_work_order_id,v_actor.id,v_actor.name,'Transferred work assigned to the receiving contractor.','system','system_event',
    v_actor.role::text,true,false,false,false,'work_order_assignment',jsonb_build_object('action','assigned',
      'previousContractorId',null,'newContractorId',p_new_contractor_id,'assignmentVersion',v_work.contractor_assignment_version,
      'transferOperationId',v_work.assignment_transfer_operation_id));
  return jsonb_build_object('applied',true,'reason','assigned','workOrderId',v_work.id,'contractorId',v_work.contractor_id,
    'assignmentVersion',v_work.contractor_assignment_version,'assignmentStartedAt',v_work.contractor_assignment_started_at,
    'status',v_work.status,'functionalStatus',v_work.functional_status,'isCapital',v_work.is_capital,'capitalStatus',v_work.capital_status,
    'dispatchedAt',v_work.dispatched_at,'deliveryId',null,'deliveryStatus',null);
end;
$$;

create or replace function public.transition_work_order_contractor_v1(
  p_work_order_id text,p_new_contractor_id uuid,p_expected_assignment_version integer,
  p_expected_workflow_cycle integer,p_expected_lifecycle_version bigint,p_operation_id uuid
)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_result jsonb; v_work public.work_orders%rowtype;
begin
  v_result:=public.begin_work_order_assignment_command(p_work_order_id,p_expected_assignment_version,
    p_expected_workflow_cycle,p_expected_lifecycle_version,p_operation_id,'transition',jsonb_build_object('newContractorId',p_new_contractor_id));
  if v_result is not null then return v_result; end if;
  if exists(select 1 from public.work_order_visits v where v.work_order_id=p_work_order_id and v.check_out_at is null) then
    raise exception 'active_visit_requires_checkout' using errcode='PT409',detail='active_visit_requires_checkout'; end if;
  select * into strict v_work from public.work_orders w where w.id=p_work_order_id;
  perform public.require_assignable_contractor(p_new_contractor_id);
  if v_work.assignment_transfer_pending_visit then
    update public.work_order_assignment_command_guards set preserve_transfer_state=true
      where transaction_id=txid_current() and work_order_id=p_work_order_id and operation_id=p_operation_id;
  end if;
  if v_work.contractor_id is null and v_work.assignment_transfer_pending_visit then
    v_result:=public.assign_pending_transferred_work_order(p_work_order_id,p_new_contractor_id);
  else v_result:=public.transition_work_order_contractor_assignment_core(p_work_order_id,p_new_contractor_id,p_expected_assignment_version); end if;
  return public.finish_work_order_assignment_command(p_operation_id,v_result||jsonb_build_object('receivingVisitRequired',v_work.assignment_transfer_pending_visit));
end;
$$;

create function public.administrative_close_visit_and_transfer_v1(
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
    or v_work.status<>'wip' or v_work.functional_status<>'Work in Progress' or v_work.billing_only then
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
      'assignmentVersion',v_work.contractor_assignment_version,'durationReviewRequired',true),p_operation_id)
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

-- Reuse the actual lifecycle command/visit/event transaction. Only a trusted
-- pending transfer adds WIP eligibility; it never opens the receiver's visit
-- during assignment or pretends the administrative event was a field checkout.
create or replace function public.begin_work_order_visit_command(
  p_work_order_id text,p_expected_assignment_version integer,p_expected_workflow_cycle integer,
  p_expected_lifecycle_version bigint,p_operation_id uuid,p_check_in_at timestamptz,p_notes text,p_resume boolean
)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_replay jsonb; v_work public.work_orders%rowtype; v_activity uuid; v_visit uuid;
  v_notes text:=nullif(btrim(coalesce(p_notes,'')),''); v_receiving boolean;
begin
  if p_check_in_at is null or not isfinite(p_check_in_at) or length(coalesce(v_notes,''))>10000 then
    raise exception 'A valid check-in time and notes are required' using errcode='22023'; end if;
  v_replay:=public.begin_work_order_lifecycle_command(p_work_order_id,p_expected_assignment_version,
    p_expected_workflow_cycle,p_expected_lifecycle_version,p_operation_id,case when p_resume then 'resume' else 'start' end,
    jsonb_build_object('checkedInAt',p_check_in_at,'notes',v_notes));
  if v_replay is not null then return v_replay; end if;
  select * into strict v_work from public.work_orders w where w.id=p_work_order_id;
  v_receiving:=v_work.assignment_transfer_pending_visit and v_work.assignment_transfer_operation_id is not null
    and v_work.status='wip' and v_work.functional_status='Work in Progress';
  if v_work.contractor_id is null or (not v_receiving and (
    v_work.status::text is distinct from case when p_resume then 'parts' else 'assigned' end
    or v_work.functional_status::text is distinct from case when p_resume then 'Awaiting Parts' else 'Dispatched' end)) then
    raise exception 'Work order cannot start or resume from its current state' using errcode='PT409'; end if;
  if exists(select 1 from public.work_order_visits v where v.work_order_id=p_work_order_id and v.check_out_at is null)
    or exists(select 1 from public.work_order_visits v where v.work_order_id=p_work_order_id
      and v.created_at>=v_work.contractor_assignment_started_at and v.check_out_at>p_check_in_at)
    or (v_receiving and p_check_in_at<v_work.contractor_assignment_started_at) then
    raise exception 'The requested visit overlaps existing work' using errcode='PT409'; end if;
  update public.work_orders set status='wip',functional_status='Work in Progress',start_time=coalesce(start_time,p_check_in_at),
    assignment_transfer_pending_visit=false where id=p_work_order_id;
  v_activity:=public.insert_work_order_lifecycle_activity(p_work_order_id,p_operation_id,
    'Checked in and started work at '||p_check_in_at::text||'.'||case when v_notes is null then '' else ' Notes: '||v_notes end,
    jsonb_build_object('checkedInAt',p_check_in_at,'notes',v_notes));
  insert into public.work_order_visits(work_order_id,contractor_id,check_in_at,checked_in_by,check_in_activity_id)
    values(p_work_order_id,v_work.contractor_id,p_check_in_at,auth.uid(),v_activity) returning id into v_visit;
  return public.finish_work_order_lifecycle_command(p_work_order_id,p_operation_id,v_activity,v_visit);
end;
$$;

revoke all on function public.assignment_evidence_snapshot_pre_hybrid(uuid),public.assignment_parent_snapshot_pre_hybrid(text),
  public.assignment_evidence_snapshot(uuid),public.assignment_parent_snapshot(text),public.protect_administrative_transfer_visit(),
  public.protect_administrative_transfer_activity(),public.protect_pending_assignment_transfer(),
  public.assign_pending_transferred_work_order(text,uuid),public.protect_work_order_lifecycle_visit(),
  public.begin_work_order_visit_command(text,integer,integer,bigint,uuid,timestamptz,text,boolean)
  from public,anon,authenticated,service_role;
revoke all on function public.administrative_close_visit_and_transfer_v1(text,uuid,integer,integer,bigint,uuid,text,boolean)
  from public,anon,authenticated,service_role;
grant execute on function public.administrative_close_visit_and_transfer_v1(text,uuid,integer,integer,bigint,uuid,text,boolean)
  to authenticated;

commit;
