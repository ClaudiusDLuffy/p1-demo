-- Batch 2A expansion. Keep 0122--0125 byte-identical. Deploy the command-capable
-- web candidate before 0127 enables the remaining raw-write restrictions.
begin;

create table public.work_order_assignment_control (
  singleton boolean primary key default true check (singleton),
  contracted boolean not null default false
);
insert into public.work_order_assignment_control(singleton) values (true);

create table public.work_order_assignment_operations (
  operation_id uuid primary key,
  work_order_id text not null,
  actor_id uuid references public.profiles(id) on delete restrict,
  actor_role text not null,
  command_family text not null check (command_family in
    ('transition','reject','duplicate','create','create_email','refresh_email')),
  payload jsonb not null,
  result jsonb,
  parent_snapshot jsonb,
  related_snapshot jsonb,
  evidence_snapshot jsonb,
  created_at timestamptz not null default clock_timestamp(),
  check ((result is null and parent_snapshot is null and evidence_snapshot is null)
    or (result is not null and parent_snapshot is not null and evidence_snapshot is not null))
);
create index work_order_assignment_operations_target
  on public.work_order_assignment_operations(work_order_id,created_at,operation_id);

-- 0115's existing parent capability remains unchanged. Its existing-parent FK
-- and non-null staff actor cannot represent pre-insert creation or trusted
-- email intake. This narrowly namespaced grant adds those two capabilities;
-- it never authorizes general lifecycle/financial mutations.
create table public.work_order_assignment_command_guards (
  transaction_id bigint not null,
  work_order_id text not null,
  actor_id uuid,
  actor_role text not null,
  command_family text not null,
  operation_id uuid references public.work_order_assignment_operations(operation_id),
  parent_allowed boolean not null default false,
  insert_allowed boolean not null default false,
  history_allowed boolean not null default false,
  delivery_allowed boolean not null default false,
  event_keys text[] not null default '{}'::text[],
  primary key(transaction_id,work_order_id,command_family)
);
alter table public.work_order_assignment_control enable row level security;
alter table public.work_order_assignment_operations enable row level security;
alter table public.work_order_assignment_command_guards enable row level security;
revoke all on public.work_order_assignment_control,
  public.work_order_assignment_operations,public.work_order_assignment_command_guards
  from public,anon,authenticated,service_role;

alter table public.activities add column assignment_operation_id uuid
  references public.work_order_assignment_operations(operation_id) on delete restrict;
alter table public.work_order_assignment_history add column assignment_operation_id uuid
  references public.work_order_assignment_operations(operation_id) on delete restrict;
alter table public.contractor_assignment_transition_deliveries add column assignment_operation_id uuid
  references public.work_order_assignment_operations(operation_id) on delete restrict;
create unique index activities_one_assignment_operation_event
  on public.activities(assignment_operation_id,work_order_id,event_key)
  where assignment_operation_id is not null;
create unique index assignment_history_one_owned_version
  on public.work_order_assignment_history(work_order_id,assignment_version)
  where assignment_operation_id is not null;
create index assignment_history_operation on public.work_order_assignment_history(assignment_operation_id)
  where assignment_operation_id is not null;
create index assignment_delivery_operation on public.contractor_assignment_transition_deliveries(assignment_operation_id)
  where assignment_operation_id is not null;

create function public.require_work_order_assignment_actor()
returns public.profiles language plpgsql security definer set search_path=public,pg_temp as $$
declare v_actor public.profiles%rowtype;
begin
  select * into v_actor from public.profiles p
  where p.id=auth.uid() and p.active=true and p.role in ('manager','dispatcher','back_office')
    and not public.profile_has_staff_permission(p.id,'invoice_controller');
  if not found then raise exception 'Active operational P1 staff required' using errcode='42501'; end if;
  return v_actor;
end;
$$;

create function public.require_assignable_contractor(p_contractor_id uuid)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if p_contractor_id is null then return; end if;
  perform 1 from public.profiles p where p.id=p_contractor_id
    and p.role='contractor' and p.active=true and p.is_assignable=true
    and public.contractor_account_id_for_profile(p.id)=p.id for share;
  if not found then raise exception 'Active assignable contractor required' using errcode='22023'; end if;
  -- Lock organization eligibility as well as the target profile. Membership
  -- cannot be deactivated between validation and the accepted assignment.
  perform 1 from public.organizations o join public.profiles p
    on p.contractor_organization_id=o.id where p.id=p_contractor_id for share of o;
  if public.contractor_account_id_for_profile(p_contractor_id) is distinct from p_contractor_id then
    raise exception 'Active canonical contractor required' using errcode='22023'; end if;
end;
$$;

create function public.assignment_parent_snapshot(p_work_order_id text)
returns jsonb language sql stable security definer set search_path=public,pg_temp as $$
  select jsonb_build_object('id',w.id,'contractorId',w.contractor_id,
    'assignmentVersion',w.contractor_assignment_version,'assignmentStartedAt',w.contractor_assignment_started_at,
    'dispatchedAt',w.dispatched_at,'workflowCycle',w.workflow_cycle,'lifecycleVersion',w.lifecycle_version,
    'status',w.status,'functionalStatus',w.functional_status,'deletedAt',w.deleted_at,'deletedBy',w.deleted_by,
    'isCapital',w.is_capital,'capitalStatus',w.capital_status,'billingOnly',w.billing_only,
    'assignedTechnicianProfileId',w.assigned_technician_profile_id,'technicianOnJob',w.technician_on_job,
    'sourceId',w.duplicated_from_work_order_id,'rootId',w.duplicate_root_work_order_id,'sequence',w.duplicate_sequence)
  from public.work_orders w where w.id=p_work_order_id;
$$;

create function public.assignment_evidence_snapshot(p_operation_id uuid)
returns jsonb language sql stable security definer set search_path=public,pg_temp as $$
  select jsonb_build_object(
    'activities',coalesce((select jsonb_agg(to_jsonb(a)-array['updated_at','requires_7eleven_sync',
      'requires_contractor_attention'] order by a.id) from public.activities a
      where a.assignment_operation_id=p_operation_id),'[]'::jsonb),
    'history',coalesce((select jsonb_agg(to_jsonb(h) order by h.id)
      from public.work_order_assignment_history h where h.assignment_operation_id=p_operation_id),'[]'::jsonb),
    'deliveries',coalesce((select jsonb_agg(to_jsonb(d)-array['status','claimed_at','completed_at','error_message'] order by d.id)
      from public.contractor_assignment_transition_deliveries d where d.assignment_operation_id=p_operation_id),'[]'::jsonb));
$$;

create function public.begin_work_order_assignment_command(
  p_work_order_id text,p_expected_assignment_version integer,p_expected_workflow_cycle integer,
  p_expected_lifecycle_version bigint,p_operation_id uuid,p_command_family text,p_payload jsonb
)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_work public.work_orders%rowtype; v_operation public.work_order_assignment_operations%rowtype;
  v_actor public.profiles%rowtype; v_family text; v_payload jsonb; v_related text; v_result jsonb;
begin
  if p_operation_id is null or p_work_order_id is null or btrim(p_work_order_id)='' or length(p_work_order_id)>100
    or p_payload is null or jsonb_typeof(p_payload)<>'object' then
    raise exception 'Assignment command input is invalid' using errcode='22023'; end if;
  if p_command_family not in ('transition','reject','duplicate','create','create_email') then
    raise exception 'Assignment command is invalid' using errcode='22023'; end if;
  if p_command_family='create_email' then
    if coalesce(auth.role(),'')<>'service_role' or auth.uid() is not null then
      raise exception 'Trusted email intake required' using errcode='42501'; end if;
  else v_actor:=public.require_work_order_assignment_actor(); end if;
  if p_command_family not in ('create','create_email') and (
    p_expected_assignment_version is null or p_expected_assignment_version<0
    or p_expected_workflow_cycle is null or p_expected_workflow_cycle<0
    or p_expected_lifecycle_version is null or p_expected_lifecycle_version<0) then
    raise exception 'Expected assignment context is required' using errcode='22023'; end if;
  v_payload:=p_payload||jsonb_build_object('expectedAssignmentVersion',p_expected_assignment_version,
    'expectedWorkflowCycle',p_expected_workflow_cycle,'expectedLifecycleVersion',p_expected_lifecycle_version);
  -- All assignment commands use operation -> priority family -> parent. No
  -- provider calls occur while locks are held. Lifecycle/invoice commands
  -- already lock the same parent before changing their own state.
  perform pg_advisory_xact_lock(hashtextextended('assignment-operation:'||p_operation_id::text,0));
  select coalesce(w.duplicate_root_work_order_id,w.id) into v_family from public.work_orders w where w.id=p_work_order_id;
  perform pg_advisory_xact_lock(hashtextextended('work-order-priority:'||coalesce(v_family,p_work_order_id),0));
  select * into v_work from public.work_orders w where w.id=p_work_order_id for update;
  if p_command_family<>'create_email' then
    -- Recheck after waiting on the authoritative parent and retain a profile
    -- share lock until commit, so deactivation cannot race accepted authority.
    select * into v_actor from public.profiles p where p.id=auth.uid() and p.active=true
      and p.role in ('manager','dispatcher','back_office')
      and not public.profile_has_staff_permission(p.id,'invoice_controller') for share;
    if not found then raise exception 'Active operational P1 staff required' using errcode='42501'; end if;
  end if;
  select * into v_operation from public.work_order_assignment_operations o where o.operation_id=p_operation_id;
  if found then
    if v_operation.work_order_id is distinct from p_work_order_id
      or v_operation.actor_id is distinct from auth.uid() or v_operation.actor_role is distinct from auth.role()
      or v_operation.command_family is distinct from p_command_family or v_operation.payload is distinct from v_payload then
      raise exception 'Assignment operation was already used for a different command' using errcode='PT409'; end if;
    v_related:=case when p_command_family='duplicate' then v_operation.result->>'workOrderId' else null end;
    if v_operation.result is null or v_operation.parent_snapshot is distinct from public.assignment_parent_snapshot(p_work_order_id)
      or (v_related is not null and v_operation.related_snapshot is distinct from public.assignment_parent_snapshot(v_related))
      or v_operation.evidence_snapshot is distinct from public.assignment_evidence_snapshot(p_operation_id) then
      raise exception 'Assignment changed after this operation; refresh and reconcile' using errcode='PT409'; end if;
    v_result:=v_operation.result||jsonb_build_object('applied',false,'reason','already_applied');
    if v_operation.result->>'deliveryId' is not null then
      select v_result||jsonb_build_object('deliveryStatus',d.status) into v_result
        from public.contractor_assignment_transition_deliveries d where d.id=(v_operation.result->>'deliveryId')::uuid;
    end if;
    return v_result;
  end if;
  if p_command_family in ('create','create_email') then
    if v_work.id is not null then raise exception 'Work order already exists' using errcode='PT409'; end if;
  else
    if v_work.id is null or v_work.deleted_at is not null then
      raise exception 'Active work order not found' using errcode='P0002'; end if;
    if v_work.contractor_assignment_version<>p_expected_assignment_version
      or v_work.workflow_cycle<>p_expected_workflow_cycle or v_work.lifecycle_version<>p_expected_lifecycle_version then
      raise exception 'Work-order assignment or workflow changed; refresh and try again' using errcode='PT409'; end if;
  end if;
  insert into public.work_order_assignment_operations(operation_id,work_order_id,actor_id,actor_role,command_family,payload)
  values(p_operation_id,p_work_order_id,auth.uid(),auth.role(),p_command_family,v_payload);
  insert into public.work_order_assignment_command_guards(transaction_id,work_order_id,actor_id,actor_role,command_family,
    operation_id,parent_allowed,insert_allowed,history_allowed,delivery_allowed,event_keys)
  values(txid_current(),p_work_order_id,auth.uid(),auth.role(),p_command_family,p_operation_id,
    p_command_family in ('transition','reject'),p_command_family in ('create','create_email'),
    p_command_family='transition',p_command_family in ('transition','duplicate'),
    case p_command_family when 'transition' then array['work_order_assignment','work_order_reassigned','work_order_unassigned']
      when 'reject' then array['work_order_rejected'] when 'duplicate' then array['work_order_duplicated']
      else array['work_order_assignment'] end);
  return null;
end;
$$;

create function public.finish_work_order_assignment_command(p_operation_id uuid,p_result jsonb)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_operation public.work_order_assignment_operations%rowtype; v_work public.work_orders%rowtype;
  v_result jsonb; v_activity_id uuid; v_count integer; v_delivery public.contractor_assignment_transition_deliveries%rowtype;
begin
  select * into strict v_operation from public.work_order_assignment_operations o where o.operation_id=p_operation_id;
  select * into strict v_work from public.work_orders w where w.id=p_result->>'workOrderId';
  select count(*),(array_agg(a.id order by a.id))[1] into v_count,v_activity_id from public.activities a
    where a.assignment_operation_id=p_operation_id;
  if (v_operation.command_family not in ('create','create_email') or v_work.contractor_id is not null) and v_count<>1 then
    raise exception 'Assignment command evidence was not recorded' using errcode='23514'; end if;
  if p_result->>'deliveryId' is not null then
    select * into v_delivery from public.contractor_assignment_transition_deliveries d
      where d.id=(p_result->>'deliveryId')::uuid and d.assignment_operation_id=p_operation_id
        and d.work_order_id=v_operation.work_order_id;
    if not found then
      raise exception 'Outgoing assignment evidence belongs to another operation' using errcode='23514'; end if;
    if v_operation.command_family='transition' and not exists(
      select 1 from public.work_order_assignment_history h where h.assignment_operation_id=p_operation_id
        and h.work_order_id=v_operation.work_order_id and h.assignment_version=v_delivery.outgoing_assignment_version
        and h.contractor_id=v_delivery.outgoing_contractor_id and h.next_contractor_id is not distinct from v_work.contractor_id
        and h.assignment_ended_by is not distinct from v_operation.actor_id) then
      raise exception 'Assignment history and outgoing delivery disagree' using errcode='23514'; end if;
  elsif p_result->>'reason' in ('reassigned','unassigned','duplicated') then
    raise exception 'Required outgoing assignment evidence is missing' using errcode='23514';
  end if;
  v_result:=p_result||jsonb_build_object('operationId',p_operation_id,'activityId',v_activity_id,
    'assignmentVersion',v_work.contractor_assignment_version,'workflowCycle',v_work.workflow_cycle,
    'lifecycleVersion',v_work.lifecycle_version,'contractorId',v_work.contractor_id);
  update public.work_order_assignment_operations o set result=v_result,
    parent_snapshot=public.assignment_parent_snapshot(v_operation.work_order_id),
    related_snapshot=case when v_operation.command_family='duplicate' then public.assignment_parent_snapshot(v_work.id) else null end,
    evidence_snapshot=public.assignment_evidence_snapshot(p_operation_id) where o.operation_id=p_operation_id;
  delete from public.work_order_assignment_command_guards g where g.transaction_id=txid_current() and g.operation_id=p_operation_id;
  return v_result;
end;
$$;

-- Capture caller input before 0115's normalizer can silently erase a forged
-- assignment timestamp/version. Ended-assignment history retains its existing
-- meaning; initial assignment is evidenced by the owning event/operation.
create function public.protect_assignment_archive_input()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare v_strict boolean; v_guard public.work_order_assignment_command_guards%rowtype;
  v_changed boolean; v_source_guard public.work_order_assignment_command_guards%rowtype;
begin
  if public.lifecycle_is_owner_maintenance() then
    if tg_op='DELETE' then return old; else return new; end if;
  end if;
  select contracted into v_strict from public.work_order_assignment_control where singleton;
  if tg_op='DELETE' then
    if v_strict then raise exception 'Work-order history cannot be physically deleted' using errcode='42501'; end if;
    return old;
  end if;
  if tg_op='INSERT' and new.duplicated_from_work_order_id is not null then
    select * into v_source_guard from public.work_order_assignment_command_guards g
      where g.transaction_id=txid_current() and g.work_order_id=new.duplicated_from_work_order_id
        and g.actor_id is not distinct from auth.uid() and g.actor_role=auth.role() and g.command_family='duplicate';
    if found then
      insert into public.work_order_assignment_command_guards(transaction_id,work_order_id,actor_id,actor_role,command_family,
        operation_id,insert_allowed,event_keys)
      values(txid_current(),new.id,auth.uid(),auth.role(),'duplicate',v_source_guard.operation_id,true,array['work_order_duplicated']);
    end if;
  end if;
  select * into v_guard from public.work_order_assignment_command_guards g
    where g.transaction_id=txid_current() and g.work_order_id=new.id
      and g.actor_id is not distinct from auth.uid() and g.actor_role=auth.role()
      and case when tg_op='INSERT' then g.insert_allowed else g.parent_allowed end limit 1;
  if tg_op='INSERT' then
    v_changed:=new.contractor_id is not null or new.deleted_at is not null or new.deleted_by is not null
      or new.contractor_assignment_started_at is not null or coalesce(new.contractor_assignment_version,0)<>0
      or new.dispatched_at is not null or new.duplicated_from_work_order_id is not null
      or new.duplicate_root_work_order_id is not null or new.duplicate_sequence is not null;
    if v_strict and v_changed and v_guard.transaction_id is null then
      raise exception 'Assigned work-order creation must use its command' using errcode='42501'; end if;
    if v_guard.transaction_id is not null then
      if new.deleted_at is not null or new.deleted_by is not null then
        raise exception 'New work orders cannot be archived' using errcode='42501'; end if;
      perform public.require_assignable_contractor(new.contractor_id);
    end if;
    return new;
  end if;
  v_changed:=new.contractor_id is distinct from old.contractor_id
    or new.contractor_assignment_started_at is distinct from old.contractor_assignment_started_at
    or new.contractor_assignment_version is distinct from old.contractor_assignment_version
    or new.dispatched_at is distinct from old.dispatched_at
    or new.deleted_at is distinct from old.deleted_at or new.deleted_by is distinct from old.deleted_by;
  if v_strict and (v_changed or old.deleted_at is not null) and v_guard.transaction_id is null then
    -- The existing straight-to-billing command may clear an old intake dispatch
    -- timestamp on an unassigned row; this grants no contractor/archive change.
    if old.deleted_at is null and old.contractor_id is null and new.contractor_id is null
      and new.deleted_at is not distinct from old.deleted_at and new.deleted_by is not distinct from old.deleted_by
      and new.contractor_assignment_started_at is not distinct from old.contractor_assignment_started_at
      and new.contractor_assignment_version=old.contractor_assignment_version and new.dispatched_at is null
      and exists(select 1 from public.work_order_lifecycle_transition_guards g where g.transaction_id=txid_current()
        and g.work_order_id=new.id and g.actor_id=auth.uid() and g.command_kind='compat:move_work_order_straight_to_billing') then
      return new;
    end if;
    raise exception 'Assignment and archive changes must use their current command' using errcode='42501';
  end if;
  return new;
end;
$$;
create trigger aaa_protect_assignment_archive_input before insert or update or delete on public.work_orders
  for each row execute function public.protect_assignment_archive_input();

create function public.protect_assignment_evidence()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare v_strict boolean; v_reserved boolean; v_work_id text; v_guard public.work_order_assignment_command_guards%rowtype;
begin
  if public.lifecycle_is_owner_maintenance() then
    if tg_op='DELETE' then return old; else return new; end if;
  end if;
  select contracted into v_strict from public.work_order_assignment_control where singleton;
  if tg_table_name='activities' then
    v_reserved:=false;
    if tg_op<>'INSERT' then v_reserved:=coalesce(old.event_key=any(array['work_order_assignment','work_order_reassigned',
      'work_order_unassigned','work_order_rejected','work_order_duplicated']),false) or old.assignment_operation_id is not null; end if;
    if tg_op<>'DELETE' then v_reserved:=v_reserved or coalesce(new.event_key=any(array['work_order_assignment','work_order_reassigned',
      'work_order_unassigned','work_order_rejected','work_order_duplicated']),false) or new.assignment_operation_id is not null; end if;
    if not v_reserved then if tg_op='DELETE' then return old; else return new; end if; end if;
    if tg_op<>'INSERT' then
      if v_strict or old.assignment_operation_id is not null or new.assignment_operation_id is not null then
        raise exception 'Authoritative assignment activity is immutable' using errcode='42501'; end if;
      if tg_op='DELETE' then return old; else return new; end if;
    end if;
    v_work_id:=new.work_order_id;
    select * into v_guard from public.work_order_assignment_command_guards g where g.transaction_id=txid_current()
      and g.work_order_id=v_work_id and g.actor_id is not distinct from auth.uid() and g.actor_role=auth.role()
      and new.event_key=any(g.event_keys) limit 1;
    if v_guard.transaction_id is null then
      if v_strict or new.assignment_operation_id is not null then
        raise exception 'Assignment activity must be created by its owning command' using errcode='42501'; end if;
    else
      if new.author_id is distinct from auth.uid() then raise exception 'Assignment author is command-owned' using errcode='42501'; end if;
      new.assignment_operation_id:=v_guard.operation_id;
      new.event_data:=coalesce(new.event_data,'{}'::jsonb)||jsonb_build_object('operationId',v_guard.operation_id);
    end if;
    return new;
  end if;
  v_work_id:=case when tg_op='DELETE' then old.work_order_id else new.work_order_id end;
  select * into v_guard from public.work_order_assignment_command_guards g where g.transaction_id=txid_current()
    and g.work_order_id=v_work_id and g.actor_id is not distinct from auth.uid() and g.actor_role=auth.role()
    and case when tg_table_name='work_order_assignment_history' then g.history_allowed else g.delivery_allowed end limit 1;
  if v_guard.transaction_id is null then
    if v_strict then raise exception 'Assignment history and delivery are command-owned' using errcode='42501'; end if;
    if tg_op='DELETE' then return old; else return new; end if;
  end if;
  if tg_op='UPDATE' and tg_table_name='contractor_assignment_transition_deliveries'
    and v_guard.command_family='delivery_state' and coalesce(auth.role(),'')='service_role' then
    if (to_jsonb(new)-array['status','claimed_at','completed_at','error_message'])
      is distinct from (to_jsonb(old)-array['status','claimed_at','completed_at','error_message']) then
      raise exception 'Outgoing delivery ownership is immutable' using errcode='42501'; end if;
    return new;
  end if;
  if tg_op='DELETE' or (tg_op='UPDATE' and tg_table_name='contractor_assignment_transition_deliveries') then
    raise exception 'Assignment evidence cannot be deleted or reassigned' using errcode='42501'; end if;
  if tg_op='UPDATE' and (old.assignment_operation_id is distinct from v_guard.operation_id
    or new.work_order_id is distinct from old.work_order_id) then
    raise exception 'Historical assignment identity is immutable' using errcode='42501'; end if;
  new.assignment_operation_id:=v_guard.operation_id;
  return new;
end;
$$;
create trigger zzzz_protect_assignment_activity before insert or update or delete on public.activities
  for each row execute function public.protect_assignment_evidence();
create trigger protect_assignment_history before insert or update or delete on public.work_order_assignment_history
  for each row execute function public.protect_assignment_evidence();
-- Delivery status has its separate existing service-only claim/completion
-- boundary. Its narrow wrapper, installed below, is the sole UPDATE grant.
create trigger protect_assignment_delivery before insert or update or delete on public.contractor_assignment_transition_deliveries
  for each row execute function public.protect_assignment_evidence();

-- Preserve existing capital, receiving-contractor privacy, outgoing snapshot,
-- numbering/root lineage and priority-family semantics in private cores.
alter function public.transition_work_order_contractor(text,uuid,integer)
  rename to transition_work_order_contractor_assignment_core;
alter function public.reject_unassigned_work_order(text,text)
  rename to reject_unassigned_work_order_assignment_core;
alter function public.duplicate_work_order_for_reassignment_notified(text)
  rename to duplicate_work_order_notified_assignment_core;
revoke all on function public.transition_work_order_contractor_assignment_core(text,uuid,integer),
  public.reject_unassigned_work_order_assignment_core(text,text),
  public.duplicate_work_order_notified_assignment_core(text)
  from public,anon,authenticated,service_role;

create function public.transition_work_order_contractor_v1(
  p_work_order_id text,p_new_contractor_id uuid,p_expected_assignment_version integer,
  p_expected_workflow_cycle integer,p_expected_lifecycle_version bigint,p_operation_id uuid
)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_result jsonb;
begin
  v_result:=public.begin_work_order_assignment_command(p_work_order_id,p_expected_assignment_version,
    p_expected_workflow_cycle,p_expected_lifecycle_version,p_operation_id,'transition',
    jsonb_build_object('newContractorId',p_new_contractor_id));
  if v_result is not null then return v_result; end if;
  perform public.require_assignable_contractor(p_new_contractor_id);
  v_result:=public.transition_work_order_contractor_assignment_core(p_work_order_id,p_new_contractor_id,p_expected_assignment_version);
  return public.finish_work_order_assignment_command(p_operation_id,v_result);
end;
$$;

create function public.reject_unassigned_work_order_v1(
  p_work_order_id text,p_reason text,p_expected_assignment_version integer,
  p_expected_workflow_cycle integer,p_expected_lifecycle_version bigint,p_operation_id uuid
)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_result jsonb; v_work public.work_orders%rowtype; v_reason text:=btrim(p_reason);
begin
  if v_reason is null or length(v_reason)<5 or length(v_reason)>500 then
    raise exception 'Rejection reason must be between 5 and 500 characters' using errcode='22023'; end if;
  v_result:=public.begin_work_order_assignment_command(p_work_order_id,p_expected_assignment_version,
    p_expected_workflow_cycle,p_expected_lifecycle_version,p_operation_id,'reject',jsonb_build_object('reason',v_reason));
  if v_result is not null then return v_result; end if;
  select * into strict v_work from public.work_orders w where w.id=p_work_order_id;
  -- The old command checks the parent/assignment history and active invoices.
  -- A deleted invoice, visit, completed event or retained work product still
  -- disproves "untouched" and cannot be hidden by resetting parent scalars.
  if coalesce(v_work.is_capital,false) or v_work.capital_status is not null
    or v_work.closed_at is not null or v_work.asset_make is not null or v_work.asset_model is not null
    or v_work.asset_serial is not null or v_work.resolution_code is not null or v_work.resolution_notes is not null
    or exists(select 1 from public.work_order_visits v where v.work_order_id=p_work_order_id)
    or exists(select 1 from public.invoices i where i.work_order_id=p_work_order_id)
    or exists(select 1 from public.work_reports r where r.work_order_id=p_work_order_id)
    or exists(select 1 from public.wo_parts p where p.work_order_id=p_work_order_id)
    or exists(select 1 from public.contractor_estimates e where e.work_order_id=p_work_order_id)
    or exists(select 1 from public.activities a where a.work_order_id=p_work_order_id
      and (a.lifecycle_operation_id is not null or a.event_key in
        ('check_in','check_out','job_paused','job_completed','visit_time_corrected'))) then
    raise exception 'A work order with protected history cannot be rejected' using errcode='PT409'; end if;
  v_result:=public.reject_unassigned_work_order_assignment_core(p_work_order_id,v_reason);
  return public.finish_work_order_assignment_command(p_operation_id,v_result);
end;
$$;

create function public.duplicate_work_order_for_reassignment_v1(
  p_source_work_order_id text,p_expected_assignment_version integer,p_expected_workflow_cycle integer,
  p_expected_lifecycle_version bigint,p_operation_id uuid
)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_result jsonb;
begin
  v_result:=public.begin_work_order_assignment_command(p_source_work_order_id,p_expected_assignment_version,
    p_expected_workflow_cycle,p_expected_lifecycle_version,p_operation_id,'duplicate','{}'::jsonb);
  if v_result is not null then return v_result; end if;
  v_result:=public.duplicate_work_order_notified_assignment_core(p_source_work_order_id);
  return public.finish_work_order_assignment_command(p_operation_id,v_result);
end;
$$;

-- Old transition callers already provide an assignment version. Retain that
-- safe signature and current-state validation; an old retry conflicts rather
-- than creating another transition. New callers retain the explicit UUID.
create function public.transition_work_order_contractor(
  p_work_order_id text,p_new_contractor_id uuid,p_expected_assignment_version integer
)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_work public.work_orders%rowtype;
begin
  perform public.require_work_order_assignment_actor();
  select * into v_work from public.work_orders w where w.id=p_work_order_id;
  if not found then raise exception 'Work order not found' using errcode='P0002'; end if;
  return public.transition_work_order_contractor_v1(p_work_order_id,p_new_contractor_id,p_expected_assignment_version,
    v_work.workflow_cycle,v_work.lifecycle_version,gen_random_uuid());
end;
$$;
create function public.reject_unassigned_work_order(p_work_order_id text,p_reason text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_work public.work_orders%rowtype;
begin
  perform public.require_work_order_assignment_actor();
  select * into v_work from public.work_orders w where w.id=p_work_order_id;
  if not found then raise exception 'Work order not found' using errcode='P0002'; end if;
  return public.reject_unassigned_work_order_v1(p_work_order_id,p_reason,v_work.contractor_assignment_version,
    v_work.workflow_cycle,v_work.lifecycle_version,gen_random_uuid());
end;
$$;
create function public.duplicate_work_order_for_reassignment_notified(p_source_work_order_id text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_work public.work_orders%rowtype;
begin
  perform public.require_work_order_assignment_actor();
  select * into v_work from public.work_orders w where w.id=p_source_work_order_id;
  if not found then raise exception 'Work order not found' using errcode='P0002'; end if;
  return public.duplicate_work_order_for_reassignment_v1(p_source_work_order_id,v_work.contractor_assignment_version,
    v_work.workflow_cycle,v_work.lifecycle_version,gen_random_uuid());
end;
$$;

-- Assigned creation is the same assignment invariant, not a new import API.
-- Only the current manual/intake fields are accepted; provenance, owner,
-- assignment version, deleted fields and duplicate lineage are never inputs.
create function public.create_work_order_assignment_core(p_operation_id uuid,p_work_order jsonb,p_email boolean)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_row public.work_orders%rowtype; v_result jsonb; v_actor public.profiles%rowtype;
  v_payload jsonb; v_family text; v_key text; v_email_only text[]; v_billing boolean;
begin
  if p_work_order is null or jsonb_typeof(p_work_order)<>'object' or octet_length(p_work_order::text)>262144 then
    raise exception 'Work-order creation input is invalid' using errcode='22023'; end if;
  v_email_only:=array['billing_only','billing_ready_at','billing_ready_by','assigned_technician_profile_id',
    'technician_on_job','technician_assigned_at','technician_assigned_by','contractor_assignment_started_at','eta',
    'priority_source_message_id','priority_source_received_at','created_at'];
  for v_key in select jsonb_object_keys(p_work_order) loop
    if v_key<>all(array['id','incident_id','store_number','city','address','store_state','store_timezone',
      'line_of_service','business_service','category','sub_category','summary','description','priority','status',
      'functional_status','contractor_id','afm_name','afm_email','nte','dispatched_at','is_capital','source',
      'sla_started_at','response_breach_at','resolution_breach_at']) and (not p_email or v_key<>all(v_email_only)) then
      raise exception 'Work-order creation contains unsupported fields' using errcode='22023'; end if;
  end loop;
  if p_email then
    if coalesce(auth.role(),'')<>'service_role' or auth.uid() is not null or p_work_order->>'source' is distinct from 'email_intake' then
      raise exception 'Trusted email intake required' using errcode='42501'; end if;
    v_family:='create_email';
  else
    v_actor:=public.require_work_order_assignment_actor(); v_family:='create';
    if p_work_order->>'source' is distinct from 'manual' then
      raise exception 'Manual work-order source required' using errcode='22023'; end if;
  end if;
  -- Typed record conversion rejects malformed enums, UUIDs, numbers and dates.
  -- JSON primitive types are checked first to avoid text-to-type coercion.
  for v_key in select jsonb_object_keys(p_work_order) loop
    if p_work_order->v_key='null'::jsonb then continue; end if;
    if v_key=any(array['is_capital','billing_only']) then
      if jsonb_typeof(p_work_order->v_key)<>'boolean' then raise exception 'Boolean work-order field required' using errcode='22023'; end if;
    elsif v_key='nte' then
      if jsonb_typeof(p_work_order->v_key)<>'number' then raise exception 'Numeric NTE required' using errcode='22023'; end if;
    elsif jsonb_typeof(p_work_order->v_key)<>'string' then
      raise exception 'Text work-order field required' using errcode='22023';
    end if;
  end loop;
  v_row:=jsonb_populate_record(null::public.work_orders,p_work_order);
  if v_row.id is null or v_row.id!~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$'
    or v_row.priority is null or v_row.status is null or v_row.functional_status is null
    or coalesce(length(v_row.summary),0)>4000 or coalesce(length(v_row.description),0)>100000
    or coalesce(v_row.nte,0)<0 or coalesce(v_row.nte,0)>99999999.99 then
    raise exception 'Work-order creation input is invalid' using errcode='22023'; end if;
  v_billing:=p_email and coalesce(v_row.billing_only,false);
  if v_row.assigned_technician_profile_id is not null or v_row.technician_on_job is not null
    or v_row.technician_assigned_at is not null or v_row.technician_assigned_by is not null
    or v_row.contractor_assignment_started_at is not null or v_row.eta is not null or v_row.billing_ready_by is not null then
    raise exception 'Creation cannot supply assignment provenance' using errcode='22023'; end if;
  if v_billing then
    if v_row.contractor_id is not null or v_row.status<>'pending_invoice' or v_row.functional_status<>'Completed'
      or v_row.dispatched_at is not null or v_row.billing_ready_at is null then
      raise exception 'Billing-only intake must remain unassigned' using errcode='22023'; end if;
  elsif (v_row.contractor_id is null and (v_row.status<>'unassigned' or v_row.functional_status<>'New'))
    or (v_row.contractor_id is not null and (v_row.status<>'assigned'
      or v_row.functional_status::text<>case when p_email then 'New' else 'Dispatched' end)) then
    raise exception 'New work-order assignment state is invalid' using errcode='22023';
  end if;
  -- Processing time can differ on redelivery; it is not source/event identity.
  -- Retain the first accepted created_at but bind every other accepted field.
  v_payload:=p_work_order-'created_at';
  v_result:=public.begin_work_order_assignment_command(v_row.id,null,null,null,p_operation_id,v_family,v_payload);
  if v_result is not null then return v_result; end if;
  perform public.require_assignable_contractor(v_row.contractor_id);
  insert into public.work_orders(id,incident_id,store_number,city,address,store_state,store_timezone,
    line_of_service,business_service,category,sub_category,summary,description,priority,status,functional_status,
    contractor_id,afm_name,afm_email,nte,dispatched_at,is_capital,source,sla_started_at,response_breach_at,resolution_breach_at,
    billing_only,billing_ready_at,billing_ready_by,priority_source_message_id,priority_source_received_at,created_by,created_at)
  values(v_row.id,v_row.incident_id,v_row.store_number,v_row.city,v_row.address,v_row.store_state,v_row.store_timezone,
    v_row.line_of_service,v_row.business_service,v_row.category,v_row.sub_category,v_row.summary,v_row.description,
    v_row.priority,v_row.status,v_row.functional_status,v_row.contractor_id,v_row.afm_name,null,coalesce(v_row.nte,0),
    v_row.dispatched_at,coalesce(v_row.is_capital,false),v_row.source,v_row.sla_started_at,v_row.response_breach_at,
    v_row.resolution_breach_at,v_billing,case when v_billing then v_row.billing_ready_at else null end,null,
    case when p_email then v_row.priority_source_message_id else null end,
    case when p_email then v_row.priority_source_received_at else null end,auth.uid(),coalesce(v_row.created_at,clock_timestamp()));
  if v_row.contractor_id is not null then
    insert into public.activities(work_order_id,author_id,author_name,text,type,activity_channel,entered_by_role,
      is_staff_only,is_staff_override,requires_7eleven_sync,requires_contractor_attention,event_key,event_data)
    values(v_row.id,auth.uid(),coalesce(v_actor.name,'System'),'Contractor assignment established at work-order creation.',
      'system','system_event',case when p_email then null else v_actor.role::text end,true,false,false,false,
      'work_order_assignment',jsonb_build_object('action','assigned','newContractorId',v_row.contractor_id,
        'source',case when p_email then 'email_intake' else 'manual' end));
  end if;
  return public.finish_work_order_assignment_command(p_operation_id,jsonb_build_object('applied',true,'reason','created','workOrderId',v_row.id));
end;
$$;
create function public.create_work_order_with_assignment_v1(p_operation_id uuid,p_work_order jsonb)
returns jsonb language sql security definer set search_path=public,pg_temp as $$
  select public.create_work_order_assignment_core(p_operation_id,p_work_order,false);
$$;
create function public.create_email_work_order_with_assignment_v1(p_operation_id uuid,p_work_order jsonb)
returns jsonb language sql security definer set search_path=public,pg_temp as $$
  select public.create_work_order_assignment_core(p_operation_id,p_work_order,true);
$$;

-- Preserve the trusted refresh's message -> priority-family -> parent order.
-- Its existing unique email receipt + assignment-removal delivery is the
-- replay identity, not a second receiving-notification queue.
alter function public.refresh_email_work_order_dispatch(text,text,text,timestamptz,text,timestamptz,timestamptz,timestamptz,jsonb,text)
  rename to refresh_email_dispatch_assignment_core;
revoke all on function public.refresh_email_dispatch_assignment_core(text,text,text,timestamptz,text,timestamptz,timestamptz,timestamptz,jsonb,text)
  from public,anon,authenticated,service_role;
create function public.refresh_email_work_order_dispatch(
  p_work_order_id text,p_reported_priority text,p_source_message_id text,p_source_received_at timestamptz,
  p_source_subject text,p_expected_sla_started_at timestamptz,p_response_breach_at timestamptz,
  p_resolution_breach_at timestamptz,p_intake_patch jsonb,p_afm_email text
)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_result jsonb; v_target text; v_family text; v_before public.work_orders%rowtype;
begin
  if coalesce(auth.role(),'')<>'service_role' or auth.uid() is not null then
    raise exception 'Trusted email intake required' using errcode='42501'; end if;
  perform pg_advisory_xact_lock(hashtextextended(trim(p_source_message_id),0));
  select coalesce(w.duplicate_root_work_order_id,w.id) into v_family from public.work_orders w where w.id=trim(p_work_order_id);
  perform pg_advisory_xact_lock(hashtextextended('work-order-priority:'||v_family,0));
  select w.* into v_before from public.work_orders w where w.deleted_at is null
    and (w.id=v_family or w.duplicate_root_work_order_id=v_family)
    order by coalesce(w.duplicate_sequence,0) desc,w.id desc limit 1 for update;
  v_target:=v_before.id;
  if v_target is not null then
    insert into public.work_order_assignment_command_guards(transaction_id,work_order_id,actor_id,actor_role,
      command_family,parent_allowed,history_allowed,delivery_allowed,event_keys)
    values(txid_current(),v_target,null,'service_role','refresh_email',true,true,true,array['work_order_unassigned']);
  end if;
  v_result:=public.refresh_email_dispatch_assignment_core(p_work_order_id,p_reported_priority,p_source_message_id,
    p_source_received_at,p_source_subject,p_expected_sla_started_at,p_response_breach_at,p_resolution_breach_at,p_intake_patch,p_afm_email);
  if v_before.contractor_id is not null and (v_result->>'metadataRefreshed')::boolean=true
    and not (v_result->>'replayed')::boolean and p_intake_patch->'billing_only'='true'::jsonb then
    insert into public.activities(work_order_id,author_id,author_name,text,type,activity_channel,is_staff_only,
      is_staff_override,requires_7eleven_sync,requires_contractor_attention,event_key,event_data)
    values(v_target,null,'System','Contractor assignment removed by the accepted 7-Eleven billing-only dispatch.',
      'system','system_event',true,false,false,false,'work_order_unassigned',jsonb_build_object(
        'action','unassigned','previousContractorId',v_before.contractor_id,'newContractorId',null,
        'emailPriorityEventId',v_result->>'eventId','sourceMessageId',p_source_message_id));
  end if;
  delete from public.work_order_assignment_command_guards g where g.transaction_id=txid_current()
    and g.work_order_id=v_target and g.command_family='refresh_email';
  return v_result;
end;
$$;
create unique index activities_one_email_assignment_removal
  on public.activities((event_data->>'emailPriorityEventId'))
  where event_key='work_order_unassigned' and event_data ? 'emailPriorityEventId';

-- Delivery claim/completion signatures and sent/unknown semantics are retained.
-- The fixed migration-time allow-list is not caller-controlled dynamic SQL.
do $delivery_wrappers$
declare v_signature text; v_proc record; v_core text; v_call_arguments text;
begin
  foreach v_signature in array array[
    'public.claim_contractor_assignment_transition_delivery(uuid,uuid)',
    'public.complete_contractor_assignment_transition_delivery(uuid,text,text)',
    'public.claim_email_assignment_removal_delivery(uuid)'
  ] loop
    select p.*,pg_get_function_arguments(p.oid) arguments,
      pg_get_function_identity_arguments(p.oid) identity_arguments,
      pg_get_function_result(p.oid) result_type into strict v_proc from pg_proc p where p.oid=v_signature::regprocedure;
    v_core:=case v_proc.proname when 'claim_contractor_assignment_transition_delivery' then 'claim_assignment_delivery_private_core'
      when 'complete_contractor_assignment_transition_delivery' then 'complete_assignment_delivery_private_core'
      else 'claim_email_assignment_delivery_private_core' end;
    select string_agg(format('%I',arg_name),',' order by ordinality) into v_call_arguments
      from unnest(v_proc.proargnames[1:v_proc.pronargs]) with ordinality as args(arg_name,ordinality);
    execute format('alter function %s rename to %I',v_signature,v_core);
    execute format('revoke all on function public.%I(%s) from public,anon,authenticated,service_role',v_core,v_proc.identity_arguments);
    execute format($definition$
      create function public.%I(%s) returns %s language plpgsql security definer set search_path=public,pg_temp as $body$
      declare v_target text; %s
      begin
        if coalesce(auth.role(),'')<>'service_role' then raise exception 'Service role required' using errcode='42501'; end if;
        select d.work_order_id into v_target from public.contractor_assignment_transition_deliveries d where d.id=p_delivery_id;
        if v_target is not null then
          insert into public.work_order_assignment_command_guards(transaction_id,work_order_id,actor_id,actor_role,
            command_family,delivery_allowed)
          values(txid_current(),v_target,auth.uid(),auth.role(),'delivery_state',true);
        end if;
        %s public.%I(%s);
        delete from public.work_order_assignment_command_guards g where g.transaction_id=txid_current()
          and g.work_order_id=v_target and g.command_family='delivery_state';
        %s
      end;
      $body$;
    $definition$,v_proc.proname,v_proc.arguments,v_proc.result_type,
      case when v_proc.result_type='void' then '' else 'v_result '||v_proc.result_type||';' end,
      case when v_proc.result_type='void' then 'perform' else 'v_result:=' end,v_core,v_call_arguments,
      case when v_proc.result_type='void' then 'return;' else 'return v_result;' end);
    execute format('revoke all on function public.%I(%s) from public,anon,authenticated,service_role',v_proc.proname,v_proc.identity_arguments);
    execute format('grant execute on function public.%I(%s) to service_role',v_proc.proname,v_proc.identity_arguments);
  end loop;
end;
$delivery_wrappers$;

-- Every helper is private, including trigger functions and renamed cores.
revoke all on function public.require_work_order_assignment_actor(),public.require_assignable_contractor(uuid),
  public.assignment_parent_snapshot(text),public.assignment_evidence_snapshot(uuid),
  public.begin_work_order_assignment_command(text,integer,integer,bigint,uuid,text,jsonb),
  public.finish_work_order_assignment_command(uuid,jsonb),public.protect_assignment_archive_input(),
  public.protect_assignment_evidence(),public.create_work_order_assignment_core(uuid,jsonb,boolean)
  from public,anon,authenticated,service_role;
revoke all on function public.transition_work_order_contractor_v1(text,uuid,integer,integer,bigint,uuid),
  public.reject_unassigned_work_order_v1(text,text,integer,integer,bigint,uuid),
  public.duplicate_work_order_for_reassignment_v1(text,integer,integer,bigint,uuid),
  public.create_work_order_with_assignment_v1(uuid,jsonb),public.create_email_work_order_with_assignment_v1(uuid,jsonb),
  public.transition_work_order_contractor(text,uuid,integer),public.reject_unassigned_work_order(text,text),
  public.duplicate_work_order_for_reassignment_notified(text),
  public.refresh_email_work_order_dispatch(text,text,text,timestamptz,text,timestamptz,timestamptz,timestamptz,jsonb,text)
  from public,anon,authenticated,service_role;
grant execute on function public.transition_work_order_contractor_v1(text,uuid,integer,integer,bigint,uuid),
  public.reject_unassigned_work_order_v1(text,text,integer,integer,bigint,uuid),
  public.duplicate_work_order_for_reassignment_v1(text,integer,integer,bigint,uuid),
  public.create_work_order_with_assignment_v1(uuid,jsonb),public.transition_work_order_contractor(text,uuid,integer),
  public.reject_unassigned_work_order(text,text),public.duplicate_work_order_for_reassignment_notified(text)
  to authenticated;
grant execute on function public.create_email_work_order_with_assignment_v1(uuid,jsonb),
  public.refresh_email_work_order_dispatch(text,text,text,timestamptz,text,timestamptz,timestamptz,timestamptz,jsonb,text)
  to service_role;

commit;
