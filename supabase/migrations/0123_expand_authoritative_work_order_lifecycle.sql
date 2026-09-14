-- Batch 1B expansion. Apply this before the compatible web release. The
-- separate 0123 migration enables contraction; never apply both ahead of it.
begin;

alter table public.work_orders add column lifecycle_version bigint not null default 0
  check (lifecycle_version >= 0);

create table public.work_order_lifecycle_control (
  singleton boolean primary key default true check (singleton),
  contracted boolean not null default false
);
insert into public.work_order_lifecycle_control(singleton) values (true);

create table public.work_order_lifecycle_operations (
  operation_id uuid primary key,
  work_order_id text not null references public.work_orders(id) on delete restrict,
  actor_id uuid not null references public.profiles(id) on delete restrict,
  command_kind text not null check (command_kind in ('eta','start','resume','pause','complete')),
  assignment_version integer not null,
  workflow_cycle integer not null,
  expected_lifecycle_version bigint not null,
  payload jsonb not null,
  result jsonb,
  parent_snapshot jsonb,
  visit_snapshot jsonb,
  created_at timestamptz not null default clock_timestamp(),
  constraint lifecycle_operation_outcome_complete check (
    (result is null and parent_snapshot is null)
    or (result is not null and parent_snapshot is not null)
  )
);
create index work_order_lifecycle_operations_target
  on public.work_order_lifecycle_operations(work_order_id,assignment_version,workflow_cycle,created_at);

create table public.work_order_lifecycle_transition_guards (
  transaction_id bigint not null,
  work_order_id text not null references public.work_orders(id) on delete cascade,
  actor_id uuid,
  command_kind text not null,
  operation_id uuid references public.work_order_lifecycle_operations(operation_id),
  activity_id uuid,
  parent_allowed boolean not null default false,
  visit_allowed boolean not null default false,
  event_key text,
  primary key (transaction_id,work_order_id,command_kind)
);

alter table public.work_order_lifecycle_control enable row level security;
alter table public.work_order_lifecycle_operations enable row level security;
alter table public.work_order_lifecycle_transition_guards enable row level security;
revoke all on public.work_order_lifecycle_control,
  public.work_order_lifecycle_operations,public.work_order_lifecycle_transition_guards
  from public,anon,authenticated,service_role;

alter table public.activities
  add column lifecycle_operation_id uuid references public.work_order_lifecycle_operations(operation_id),
  add column lifecycle_version bigint;
alter table public.activities add constraint activities_lifecycle_identity_complete
  check ((lifecycle_operation_id is null and lifecycle_version is null)
    or (lifecycle_operation_id is not null and lifecycle_version > 0));
create unique index activities_one_lifecycle_operation
  on public.activities(lifecycle_operation_id) where lifecycle_operation_id is not null;

-- Legacy evidence is neither deleted nor retrospectively declared trusted.
-- A caller-created legacy completion must not reserve the new command's slot.
drop index public.activities_one_job_completion_per_workflow_cycle;
create unique index activities_one_job_completion_per_workflow_cycle
  on public.activities(work_order_id,contractor_assignment_version,workflow_cycle)
  where event_key='job_completed' and lifecycle_operation_id is not null;

create function public.lifecycle_parent_snapshot(p_row public.work_orders)
returns jsonb language sql immutable set search_path=public,pg_temp as $$
  select jsonb_build_object(
    'status',p_row.status,'functional_status',p_row.functional_status,
    'eta',p_row.eta,'start_time',p_row.start_time,'end_time',p_row.end_time,
    'asset_make',p_row.asset_make,'asset_model',p_row.asset_model,
    'asset_serial',p_row.asset_serial,'asset_year',p_row.asset_year,
    'resolution_code',p_row.resolution_code,'resolution_notes',p_row.resolution_notes,
    'part_needed',p_row.part_needed,'part_eta',p_row.part_eta,
    'contractor_id',p_row.contractor_id,'assigned_technician_profile_id',p_row.assigned_technician_profile_id,
    'assignment_version',p_row.contractor_assignment_version,
    'workflow_cycle',p_row.workflow_cycle,'lifecycle_version',p_row.lifecycle_version
  );
$$;

create function public.lifecycle_visit_snapshot(p_visit_id uuid)
returns jsonb language sql stable security definer set search_path=public,pg_temp as $$
  select to_jsonb(v)-'updated_at' from public.work_order_visits v where v.id=p_visit_id;
$$;

create function public.lifecycle_part_snapshot(p_row public.wo_parts)
returns jsonb language sql immutable set search_path=public,pg_temp as $$
  select jsonb_build_object('id',p_row.id,'workOrderId',p_row.work_order_id,
    'description',p_row.description,'partNumber',p_row.part_number,'qty',p_row.qty,
    'status',p_row.status,'expectedReturnDate',p_row.expected_return_date,
    'trackingNumber',p_row.tracking_number,'notes',p_row.notes,'createdAt',p_row.created_at);
$$;

create function public.lifecycle_is_owner_maintenance()
returns boolean language sql stable set search_path=public,pg_temp as $$
  select session_user in ('postgres','supabase_admin')
    and current_setting('role') in ('none','postgres','supabase_admin')
    and auth.uid() is null and coalesce(auth.role(),'')='';
$$;

create function public.require_work_order_lifecycle_actor(p_work_order_id text)
returns public.profiles language plpgsql security definer set search_path=public,pg_temp as $$
declare v_actor public.profiles%rowtype;
begin
  select * into v_actor from public.profiles p where p.id=auth.uid() and p.active=true;
  if not found then raise exception 'Active portal access required' using errcode='42501'; end if;
  if v_actor.role in ('manager','dispatcher','back_office') then
    if public.profile_has_staff_permission(v_actor.id,'invoice_controller') then
      raise exception 'Operational staff access required' using errcode='42501';
    end if;
  elsif v_actor.role='contractor' and public.can_access_contractor_work_order(p_work_order_id) then
    null;
  else raise exception 'Work order access is not permitted' using errcode='42501'; end if;
  return v_actor;
end;
$$;

create function public.begin_work_order_lifecycle_command(
  p_work_order_id text,p_expected_assignment_version integer,p_expected_workflow_cycle integer,
  p_expected_lifecycle_version bigint,p_operation_id uuid,p_command_kind text,p_payload jsonb
)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare
  v_actor public.profiles%rowtype; v_work public.work_orders%rowtype;
  v_operation public.work_order_lifecycle_operations%rowtype; v_inserted integer;
begin
  if nullif(btrim(p_work_order_id),'') is null or p_operation_id is null
     or p_expected_assignment_version is null or p_expected_assignment_version<0
     or p_expected_workflow_cycle is null or p_expected_workflow_cycle<0
     or p_expected_lifecycle_version is null or p_expected_lifecycle_version<0 then
    raise exception 'Work order identity and versions are required' using errcode='22023';
  end if;
  v_actor:=public.require_work_order_lifecycle_actor(p_work_order_id);
  select * into v_work from public.work_orders w
    where w.id=p_work_order_id and w.deleted_at is null for update;
  if not found then raise exception 'Work order not found' using errcode='P0002'; end if;
  -- Re-check authorization after the lock: assignment may have changed while waiting.
  v_actor:=public.require_work_order_lifecycle_actor(p_work_order_id);
  if v_work.contractor_assignment_version<>p_expected_assignment_version then
    raise exception 'Work order assignment changed. Refresh and try again.' using errcode='PT409';
  end if;
  if v_work.workflow_cycle<>p_expected_workflow_cycle then
    raise exception 'Work order workflow changed. Refresh and try again.' using errcode='PT409';
  end if;
  insert into public.work_order_lifecycle_operations(operation_id,work_order_id,actor_id,
    command_kind,assignment_version,workflow_cycle,expected_lifecycle_version,payload)
  values(p_operation_id,p_work_order_id,v_actor.id,p_command_kind,p_expected_assignment_version,
    p_expected_workflow_cycle,p_expected_lifecycle_version,p_payload)
  on conflict(operation_id) do nothing;
  get diagnostics v_inserted=row_count;
  select * into v_operation from public.work_order_lifecycle_operations o
    where o.operation_id=p_operation_id for update;
  if v_operation.work_order_id is distinct from p_work_order_id
     or v_operation.actor_id is distinct from v_actor.id
     or v_operation.command_kind is distinct from p_command_kind
     or v_operation.assignment_version is distinct from p_expected_assignment_version
     or v_operation.workflow_cycle is distinct from p_expected_workflow_cycle
     or v_operation.expected_lifecycle_version is distinct from p_expected_lifecycle_version
     or v_operation.payload is distinct from p_payload then
    raise exception 'Operation identity was reused with different input' using errcode='PT409';
  end if;
  if v_inserted=0 then
    if v_operation.result is null
       or v_operation.parent_snapshot is distinct from public.lifecycle_parent_snapshot(v_work)
       or not exists(select 1 from public.activities a where a.lifecycle_operation_id=p_operation_id
          and a.id=(v_operation.result->>'activityId')::uuid and a.deleted_at is null
          and a.work_order_id=p_work_order_id and a.author_id=v_actor.id
          and a.lifecycle_version=v_work.lifecycle_version)
       or (v_operation.result->>'visitId' is not null
           and v_operation.visit_snapshot is distinct from
             public.lifecycle_visit_snapshot((v_operation.result->>'visitId')::uuid))
       or exists(select 1 from jsonb_array_elements(coalesce(v_operation.result->'parts','[]'::jsonb)) part_snapshot
         where not exists(select 1 from public.wo_parts part
           where part.id=(part_snapshot->>'id')::uuid
             and part.work_order_id=p_work_order_id
             and public.lifecycle_part_snapshot(part)=part_snapshot)) then
      raise exception 'Work order changed after this operation. Refresh and reconcile.' using errcode='PT409';
    end if;
    return v_operation.result||jsonb_build_object('applied',false,'reason','already_applied');
  end if;
  if v_work.lifecycle_version<>p_expected_lifecycle_version then
    raise exception 'Work order changed. Refresh and try again.' using errcode='PT409';
  end if;
  if v_work.billing_only or v_work.status='closed' then
    raise exception 'This work order is not available for field actions' using errcode='PT409';
  end if;
  insert into public.work_order_lifecycle_transition_guards(transaction_id,work_order_id,
    actor_id,command_kind,operation_id,parent_allowed,visit_allowed,event_key)
  values(txid_current(),p_work_order_id,v_actor.id,p_command_kind,p_operation_id,true,true,
    case p_command_kind when 'eta' then 'eta_updated' when 'pause' then 'job_paused'
      when 'complete' then 'job_completed' else 'check_in' end);
  return null;
end;
$$;

create function public.finish_work_order_lifecycle_command(
  p_work_order_id text,p_operation_id uuid,p_activity_id uuid,p_visit_id uuid,p_parts jsonb default '[]'::jsonb
)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_work public.work_orders%rowtype; v_result jsonb;
begin
  select * into strict v_work from public.work_orders w where w.id=p_work_order_id;
  v_result:=jsonb_build_object('applied',true,'reason','applied','workOrderId',p_work_order_id,
    'operationId',p_operation_id,'assignmentVersion',v_work.contractor_assignment_version,
    'workflowCycle',v_work.workflow_cycle,'lifecycleVersion',v_work.lifecycle_version,
    'workOrderStatus',v_work.status,'functionalStatus',v_work.functional_status,
    'activityId',p_activity_id,'visitId',p_visit_id,'parts',coalesce(p_parts,'[]'::jsonb));
  update public.work_order_lifecycle_operations set result=v_result,
    parent_snapshot=public.lifecycle_parent_snapshot(v_work),
    visit_snapshot=public.lifecycle_visit_snapshot(p_visit_id)
  where operation_id=p_operation_id;
  delete from public.work_order_lifecycle_transition_guards
    where transaction_id=txid_current() and work_order_id=p_work_order_id and operation_id=p_operation_id;
  return v_result;
end;
$$;

create function public.insert_work_order_lifecycle_activity(
  p_work_order_id text,p_operation_id uuid,p_text text,p_event_data jsonb
)
returns uuid language plpgsql security definer set search_path=public,pg_temp as $$
declare v_actor public.profiles%rowtype; v_event text; v_activity uuid; v_version bigint;
begin
  v_actor:=public.require_work_order_lifecycle_actor(p_work_order_id);
  select g.event_key into strict v_event from public.work_order_lifecycle_transition_guards g
    where g.transaction_id=txid_current() and g.work_order_id=p_work_order_id
      and g.operation_id=p_operation_id and g.actor_id=v_actor.id;
  select w.lifecycle_version into strict v_version from public.work_orders w where w.id=p_work_order_id;
  insert into public.activities(work_order_id,author_id,author_name,text,type,is_staff_override,
    event_key,event_data,lifecycle_operation_id,lifecycle_version)
  values(p_work_order_id,v_actor.id,v_actor.name,p_text,
    case when v_event='eta_updated' then 'system' else 'note' end,
    v_actor.role in ('manager','dispatcher','back_office'),v_event,
    p_event_data||jsonb_build_object('operationId',p_operation_id,'lifecycleVersion',v_version),
    p_operation_id,v_version) returning id into v_activity;
  return v_activity;
end;
$$;

create function public.set_work_order_eta_v1(
  p_work_order_id text,p_expected_assignment_version integer,p_expected_workflow_cycle integer,
  p_expected_lifecycle_version bigint,p_operation_id uuid,p_eta timestamptz
)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_replay jsonb; v_work public.work_orders%rowtype; v_activity uuid;
begin
  if p_eta is null or not isfinite(p_eta) then
    raise exception 'A valid ETA is required' using errcode='22023'; end if;
  v_replay:=public.begin_work_order_lifecycle_command(p_work_order_id,p_expected_assignment_version,
    p_expected_workflow_cycle,p_expected_lifecycle_version,p_operation_id,'eta',jsonb_build_object('eta',p_eta));
  if v_replay is not null then return v_replay; end if;
  select * into strict v_work from public.work_orders w where w.id=p_work_order_id;
  if v_work.status<>'assigned' or v_work.functional_status::text is distinct from 'Dispatched'
     or v_work.contractor_id is null then
    raise exception 'ETA can only be set for dispatched work' using errcode='PT409'; end if;
  update public.work_orders set eta=p_eta where id=p_work_order_id;
  v_activity:=public.insert_work_order_lifecycle_activity(p_work_order_id,p_operation_id,
    'ETA set: '||p_eta::text,jsonb_build_object('eta',p_eta));
  return public.finish_work_order_lifecycle_command(p_work_order_id,p_operation_id,v_activity,null);
end;
$$;

-- First start and resume share visit persistence, but retain distinct state
-- requirements and operation families. This private routine is not an RPC.
create function public.begin_work_order_visit_command(
  p_work_order_id text,p_expected_assignment_version integer,p_expected_workflow_cycle integer,
  p_expected_lifecycle_version bigint,p_operation_id uuid,p_check_in_at timestamptz,p_notes text,p_resume boolean
)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_replay jsonb; v_work public.work_orders%rowtype; v_activity uuid; v_visit uuid;
  v_notes text:=nullif(btrim(coalesce(p_notes,'')),'');
begin
  if p_check_in_at is null or not isfinite(p_check_in_at) or length(coalesce(v_notes,''))>10000 then
    raise exception 'A valid check-in time and notes are required' using errcode='22023'; end if;
  v_replay:=public.begin_work_order_lifecycle_command(p_work_order_id,p_expected_assignment_version,
    p_expected_workflow_cycle,p_expected_lifecycle_version,p_operation_id,
    case when p_resume then 'resume' else 'start' end,
    jsonb_build_object('checkedInAt',p_check_in_at,'notes',v_notes));
  if v_replay is not null then return v_replay; end if;
  select * into strict v_work from public.work_orders w where w.id=p_work_order_id;
  if v_work.contractor_id is null
     or v_work.status::text is distinct from (case when p_resume then 'parts' else 'assigned' end)
     or v_work.functional_status::text is distinct from (case when p_resume then 'Awaiting Parts' else 'Dispatched' end) then
    raise exception 'Work order cannot start or resume from its current state' using errcode='PT409'; end if;
  if exists(select 1 from public.work_order_visits v where v.work_order_id=p_work_order_id and v.check_out_at is null)
     or exists(select 1 from public.work_order_visits v where v.work_order_id=p_work_order_id
       and v.created_at>=v_work.contractor_assignment_started_at and v.check_out_at>p_check_in_at) then
    raise exception 'The requested visit overlaps existing work' using errcode='PT409'; end if;
  update public.work_orders set status='wip',functional_status='Work in Progress',
    start_time=coalesce(start_time,p_check_in_at) where id=p_work_order_id;
  v_activity:=public.insert_work_order_lifecycle_activity(p_work_order_id,p_operation_id,
    'Checked in and started work at '||p_check_in_at::text||'.'||case when v_notes is null then '' else ' Notes: '||v_notes end,
    jsonb_build_object('checkedInAt',p_check_in_at,'notes',v_notes));
  insert into public.work_order_visits(work_order_id,contractor_id,check_in_at,checked_in_by,check_in_activity_id)
    values(p_work_order_id,v_work.contractor_id,p_check_in_at,auth.uid(),v_activity) returning id into v_visit;
  return public.finish_work_order_lifecycle_command(p_work_order_id,p_operation_id,v_activity,v_visit);
end;
$$;

create function public.start_work_order_visit_v1(
  p_work_order_id text,p_expected_assignment_version integer,p_expected_workflow_cycle integer,
  p_expected_lifecycle_version bigint,p_operation_id uuid,p_check_in_at timestamptz,p_notes text
)
returns jsonb language sql security definer set search_path=public,pg_temp as $$
  select public.begin_work_order_visit_command(p_work_order_id,p_expected_assignment_version,
    p_expected_workflow_cycle,p_expected_lifecycle_version,p_operation_id,p_check_in_at,p_notes,false);
$$;
create function public.resume_work_order_visit_v1(
  p_work_order_id text,p_expected_assignment_version integer,p_expected_workflow_cycle integer,
  p_expected_lifecycle_version bigint,p_operation_id uuid,p_check_in_at timestamptz,p_notes text
)
returns jsonb language sql security definer set search_path=public,pg_temp as $$
  select public.begin_work_order_visit_command(p_work_order_id,p_expected_assignment_version,
    p_expected_workflow_cycle,p_expected_lifecycle_version,p_operation_id,p_check_in_at,p_notes,true);
$$;

create function public.pause_work_order_for_parts_v1(
  p_work_order_id text,p_expected_assignment_version integer,p_expected_workflow_cycle integer,
  p_expected_lifecycle_version bigint,p_operation_id uuid,p_check_out_at timestamptz,p_reason text,
  p_parts jsonb,p_notes text,p_legacy_part_needed text,p_legacy_part_eta date
)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare
  v_replay jsonb; v_work public.work_orders%rowtype; v_activity uuid; v_visit uuid;
  v_reason text:=nullif(btrim(coalesce(p_reason,'')),''); v_notes text:=nullif(btrim(coalesce(p_notes,'')),'');
  v_parts jsonb:=coalesce(p_parts,'[]'::jsonb); v_part jsonb; v_row public.wo_parts%rowtype;
  v_saved_parts jsonb:='[]'::jsonb; v_label text:=nullif(btrim(coalesce(p_legacy_part_needed,'')),'');
  v_eta date:=p_legacy_part_eta; v_return_date date; v_qty numeric;
begin
  if p_check_out_at is null or not isfinite(p_check_out_at) or v_reason is null
     or v_reason not in ('Awaiting parts','Temporary fix')
     or length(v_reason)>1000 or length(coalesce(v_notes,''))>10000
     or length(coalesce(v_label,''))>1000 then
    raise exception 'A valid checkout time, reason and parts details are required' using errcode='22023'; end if;
  if jsonb_typeof(v_parts)<>'array' or jsonb_array_length(v_parts)>100 or octet_length(v_parts::text)>65536 then
    raise exception 'Parts must be a supported bounded list' using errcode='22023'; end if;
  for v_part in select value from jsonb_array_elements(v_parts) loop
    if jsonb_typeof(v_part)<>'object' or exists(select 1 from jsonb_object_keys(v_part) k
      where k<>all(array['description','partNumber','qty','expectedReturnDate']))
      or jsonb_typeof(v_part->'description') is distinct from 'string'
      or nullif(btrim(v_part->>'description'),'') is null or length(v_part->>'description')>1000
      or (v_part ? 'partNumber' and jsonb_typeof(v_part->'partNumber') not in ('string','null'))
      or length(coalesce(v_part->>'partNumber',''))>200
      or (v_part ? 'qty' and jsonb_typeof(v_part->'qty')<>'number') then
      raise exception 'Each part needs a valid description, quantity and return date' using errcode='22023'; end if;
    v_qty:=coalesce((v_part->>'qty')::numeric,1);
    if v_qty<=0 or v_qty>100000 then raise exception 'Part quantity is invalid' using errcode='22023'; end if;
    if nullif(v_part->>'expectedReturnDate','') is not null then
      if (v_part->>'expectedReturnDate')!~'^\d{4}-\d{2}-\d{2}$' then
        raise exception 'Part return date is invalid' using errcode='22023'; end if;
      begin v_return_date:=(v_part->>'expectedReturnDate')::date;
      exception when datetime_field_overflow or invalid_datetime_format then
        raise exception 'Part return date is invalid' using errcode='22023'; end;
    end if;
  end loop;
  if jsonb_array_length(v_parts)>0 then
    v_part:=v_parts->0;
    v_label:=btrim(v_part->>'description')||case when nullif(btrim(v_part->>'partNumber'),'') is null
      then '' else ' ('||btrim(v_part->>'partNumber')||')' end;
    v_eta:=coalesce(nullif(v_part->>'expectedReturnDate','')::date,p_legacy_part_eta);
  end if;
  if v_reason='Awaiting parts' and v_label is null then
    raise exception 'Describe the parts required before pausing for parts' using errcode='22023'; end if;
  if v_eta is not null and not isfinite(v_eta) then
    raise exception 'Part return date is invalid' using errcode='22023'; end if;
  v_replay:=public.begin_work_order_lifecycle_command(p_work_order_id,p_expected_assignment_version,
    p_expected_workflow_cycle,p_expected_lifecycle_version,p_operation_id,'pause',
    jsonb_build_object('pausedAt',p_check_out_at,'reason',v_reason,'notes',v_notes,'parts',v_parts,
      'legacyPartNeeded',nullif(btrim(coalesce(p_legacy_part_needed,'')),''),'legacyPartEta',p_legacy_part_eta));
  if v_replay is not null then return v_replay; end if;
  select * into strict v_work from public.work_orders w where w.id=p_work_order_id;
  if v_work.functional_status::text is distinct from 'Work in Progress'
    or v_work.status::text not in ('wip','pending_invoice','pending_approval','pending_payment') then
    raise exception 'Only work in progress can be paused for parts' using errcode='PT409'; end if;
  select v.id into v_visit from public.work_order_visits v where v.work_order_id=p_work_order_id
    and v.check_out_at is null for update;
  if v_visit is not null and exists(select 1 from public.work_order_visits v
    where v.id=v_visit and (v.contractor_id is distinct from v_work.contractor_id or v.check_in_at>p_check_out_at)) then
    raise exception 'The active visit does not match this checkout' using errcode='PT409'; end if;
  update public.work_orders set status='parts',functional_status='Awaiting Parts',
    part_needed=coalesce(v_label,part_needed),part_eta=coalesce(v_eta,part_eta) where id=p_work_order_id;
  update public.work_order_visits set check_out_at=p_check_out_at,checked_out_by=auth.uid()
    where id=v_visit;
  for v_part in select value from jsonb_array_elements(v_parts) loop
    insert into public.wo_parts(work_order_id,description,part_number,qty,status,expected_return_date,created_by)
    values(p_work_order_id,btrim(v_part->>'description'),coalesce(btrim(v_part->>'partNumber'),''),
      coalesce((v_part->>'qty')::numeric,1),'ordered',nullif(v_part->>'expectedReturnDate','')::date,auth.uid())
    returning * into v_row;
    v_saved_parts:=v_saved_parts||jsonb_build_array(public.lifecycle_part_snapshot(v_row));
  end loop;
  v_activity:=public.insert_work_order_lifecycle_activity(p_work_order_id,p_operation_id,
    'Work paused at '||p_check_out_at::text||': '||v_reason||'.'
      ||case when v_label is null then '' else ' Part needed: '||v_label||'.' end
      ||case when v_notes is null then '' else ' Notes: '||v_notes end,
    jsonb_build_object('pausedAt',p_check_out_at,'reason',v_reason,'notes',v_notes));
  -- The operation retains the authoritative visit link; old visit identity
  -- triggers intentionally prohibit rewriting a closed visit a second time.
  return public.finish_work_order_lifecycle_command(p_work_order_id,p_operation_id,v_activity,v_visit,v_saved_parts);
end;
$$;

-- This trigger runs after the existing BEFORE normalizers. The invoice-only
-- operational queue remains a separate Batch 1C boundary: it cannot set any
-- field-completion data or turn uncompleted field work into completed work.
create function public.protect_work_order_lifecycle_fields()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare v_changed boolean; v_context_changed boolean; v_capable boolean; v_strict boolean; v_invoice_only boolean;
begin
  select contracted into v_strict from public.work_order_lifecycle_control where singleton;
  if tg_op='INSERT' then
    if not public.lifecycle_is_owner_maintenance() and v_strict and (
      new.status::text in ('wip','parts','completed')
      or (new.functional_status::text='Completed' and not new.billing_only)
      or new.start_time is not null or new.end_time is not null or new.lifecycle_version<>0
    ) then
      raise exception 'Field work must begin through its lifecycle command' using errcode='42501';
    end if;
    return new;
  end if;
  v_changed:=(public.lifecycle_parent_snapshot(new)-array['lifecycle_version','assigned_technician_profile_id'])
    is distinct from (public.lifecycle_parent_snapshot(old)-array['lifecycle_version','assigned_technician_profile_id']);
  v_context_changed:=new.assigned_technician_profile_id is distinct from old.assigned_technician_profile_id;
  select exists(select 1 from public.work_order_lifecycle_transition_guards g
    where g.transaction_id=txid_current() and g.work_order_id=new.id
      and g.actor_id is not distinct from auth.uid() and g.parent_allowed)
    or exists(select 1 from public.work_order_assignment_transition_guards g
      where g.transaction_id=txid_current() and g.work_order_id=new.id and g.actor_id=auth.uid())
    or exists(select 1 from public.work_order_close_transition_guards g
      where g.transaction_id=txid_current() and g.work_order_id=new.id and g.actor_id=auth.uid())
    or exists(select 1 from public.work_order_reopen_transition_guards g
      where g.transaction_id=txid_current() and g.work_order_id=new.id and g.actor_id=auth.uid())
    into v_capable;
  v_invoice_only:=(public.lifecycle_parent_snapshot(new)-array['status','lifecycle_version'])
      is not distinct from (public.lifecycle_parent_snapshot(old)-array['status','lifecycle_version'])
    and old.status<>'closed' and (
      new.status::text in ('pending_invoice','pending_approval','pending_payment')
      or (new.status='completed' and old.status::text in ('pending_invoice','pending_approval','pending_payment')
        and old.functional_status::text='Completed')
    );
  if not public.lifecycle_is_owner_maintenance() and (
    (new.lifecycle_version is distinct from old.lifecycle_version and not v_capable)
    or (v_strict and v_changed and not v_capable and not v_invoice_only)
  ) then raise exception 'Use the current work-order lifecycle action. Refresh this page.' using errcode='42501'; end if;
  -- Database-owner fixture/maintenance sessions have no JWT. Service-role
  -- requests do have a JWT role and must use an explicit trusted command.
  new.lifecycle_version:=old.lifecycle_version+case when v_changed or v_context_changed or exists(
    select 1 from public.work_order_lifecycle_transition_guards g
    where g.transaction_id=txid_current() and g.work_order_id=new.id
      and g.actor_id is not distinct from auth.uid() and g.operation_id is not null and g.parent_allowed
  ) then 1 else 0 end;
  return new;
end;
$$;
create trigger zzz_protect_work_order_lifecycle_fields
  before insert or update on public.work_orders for each row
  execute function public.protect_work_order_lifecycle_fields();

create function public.protect_work_order_lifecycle_activity()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare v_reserved boolean; v_strict boolean; v_guarded boolean; v_work_id text;
begin
  v_work_id:=case when tg_op='DELETE' then old.work_order_id else new.work_order_id end;
  select contracted into v_strict from public.work_order_lifecycle_control where singleton;
  v_reserved:=case when tg_op='INSERT' then false else old.event_key in (
    'eta_updated','check_in','check_out','job_paused','job_completed','visit_time_corrected')
    or old.lifecycle_operation_id is not null end;
  if tg_op<>'DELETE' then v_reserved:=v_reserved or new.event_key in (
    'eta_updated','check_in','check_out','job_paused','job_completed','visit_time_corrected')
    or new.lifecycle_operation_id is not null; end if;
  if not v_reserved then
    if tg_op='INSERT' and coalesce(auth.role(),'')='authenticated' then
      if new.author_id is distinct from auth.uid() then
        raise exception 'Activity author must match the signed-in user' using errcode='42501'; end if;
      select p.name into new.author_name from public.profiles p where p.id=auth.uid() and p.active=true;
      if not found then raise exception 'Active portal access required' using errcode='42501'; end if;
    end if;
    if tg_op='UPDATE' and not public.lifecycle_is_owner_maintenance()
       and (new.author_id is distinct from old.author_id
         or new.author_name is distinct from old.author_name
         or new.entered_by_role is distinct from old.entered_by_role) then
      raise exception 'Activity author identity cannot be changed' using errcode='42501'; end if;
    if tg_op='DELETE' then return old; else return new; end if;
  end if;
  if tg_op='INSERT' then
    select exists(select 1 from public.work_order_lifecycle_transition_guards g
      where g.transaction_id=txid_current() and g.work_order_id=new.work_order_id
        and g.actor_id is not distinct from auth.uid() and g.event_key=new.event_key
        and g.operation_id is not distinct from new.lifecycle_operation_id
        and (new.lifecycle_operation_id is null or exists(
          select 1 from public.work_order_lifecycle_operations o join public.work_orders w on w.id=o.work_order_id
          where o.operation_id=g.operation_id and o.actor_id=auth.uid() and o.work_order_id=new.work_order_id
            and o.assignment_version=w.contractor_assignment_version and o.workflow_cycle=w.workflow_cycle
            and new.lifecycle_version=w.lifecycle_version
        ))) into v_guarded;
    if not v_guarded and (new.lifecycle_operation_id is not null
       or (v_strict and not public.lifecycle_is_owner_maintenance())) then
      raise exception 'Lifecycle evidence must be created by its owning command' using errcode='42501'; end if;
    if v_guarded and new.author_id is distinct from auth.uid() then
      raise exception 'Lifecycle actor does not match the command' using errcode='42501'; end if;
    return new;
  end if;
  if (v_strict and not public.lifecycle_is_owner_maintenance()) or old.lifecycle_operation_id is not null
     or (tg_op='UPDATE' and new.lifecycle_operation_id is not null) then
    if tg_op='UPDATE' and (to_jsonb(new)-array['synced_to_7eleven_at','synced_to_7eleven_by'])
        is not distinct from (to_jsonb(old)-array['synced_to_7eleven_at','synced_to_7eleven_by'])
       and ((not v_strict and public.is_staff()) or exists(select 1 from public.work_order_lifecycle_transition_guards g
         where g.transaction_id=txid_current() and g.work_order_id=v_work_id
           and g.actor_id=auth.uid() and g.command_kind='sync' and g.activity_id=old.id)) then return new; end if;
    if tg_op='UPDATE' and (to_jsonb(new)-array['requires_contractor_attention',
        'contractor_attention_acknowledged_at','contractor_attention_acknowledged_by'])
        is not distinct from (to_jsonb(old)-array['requires_contractor_attention',
          'contractor_attention_acknowledged_at','contractor_attention_acknowledged_by'])
       and exists(select 1 from public.work_order_lifecycle_transition_guards g
         where g.transaction_id=txid_current() and g.work_order_id=v_work_id
           and g.actor_id=auth.uid() and g.command_kind='attention' and g.activity_id=old.id) then return new; end if;
    raise exception 'Authoritative lifecycle evidence is immutable' using errcode='42501';
  end if;
  if tg_op='DELETE' then return old; else return new; end if;
end;
$$;
create trigger zzz_protect_work_order_lifecycle_activity
  before insert or update or delete on public.activities for each row
  execute function public.protect_work_order_lifecycle_activity();

create function public.protect_work_order_lifecycle_visit()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare v_work_id text; v_allowed boolean; v_strict boolean;
begin
  v_work_id:=case when tg_op='DELETE' then old.work_order_id else new.work_order_id end;
  select contracted into v_strict from public.work_order_lifecycle_control where singleton;
  if not v_strict or public.lifecycle_is_owner_maintenance() then
    if tg_op='DELETE' then return old; else return new; end if;
  end if;
  select exists(select 1 from public.work_order_lifecycle_transition_guards g
    where g.transaction_id=txid_current() and g.work_order_id=v_work_id
      and g.actor_id is not distinct from auth.uid() and g.visit_allowed)
    or (tg_op='UPDATE' and exists(select 1 from public.work_order_visit_correction_context c
      where c.transaction_id=txid_current() and c.visit_id=old.id)) into v_allowed;
  if not v_allowed then
    raise exception 'Visit changes must use the work-order lifecycle action' using errcode='42501'; end if;
  if tg_op='DELETE' then return old; else return new; end if;
end;
$$;
create trigger zzz_protect_work_order_lifecycle_visit
  before insert or update or delete on public.work_order_visits for each row
  execute function public.protect_work_order_lifecycle_visit();

create function public.mark_work_order_activity_synced_v1(p_activity_id uuid,p_synced boolean)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare v_work_id text;
begin
  if auth.uid() is null or not public.is_staff() then
    raise exception 'Active staff access required' using errcode='42501'; end if;
  if p_activity_id is null or p_synced is null then
    raise exception 'Activity and synchronization state are required' using errcode='22023'; end if;
  select a.work_order_id into v_work_id from public.activities a
    where a.id=p_activity_id and a.deleted_at is null;
  if not found then raise exception 'Activity not found' using errcode='P0002'; end if;
  perform 1 from public.work_orders w where w.id=v_work_id for update;
  perform 1 from public.activities a where a.id=p_activity_id and a.requires_7eleven_sync for update;
  if not found then raise exception 'Activity is not a field update' using errcode='22023'; end if;
  insert into public.work_order_lifecycle_transition_guards(transaction_id,work_order_id,actor_id,command_kind,activity_id)
    values(txid_current(),v_work_id,auth.uid(),'sync',p_activity_id);
  update public.activities set synced_to_7eleven_at=case when p_synced then now() else null end,
    synced_to_7eleven_by=case when p_synced then auth.uid() else null end where id=p_activity_id;
  delete from public.work_order_lifecycle_transition_guards where transaction_id=txid_current()
    and work_order_id=v_work_id and command_kind='sync';
end;
$$;

-- Compatibility for the combined completion/invoicing RPC and old completion
-- callers. The old free-text argument no longer controls authoritative text.
create or replace function public.complete_work_order_once(
  p_work_order_id text,p_completed_at timestamptz,p_asset_make text,p_asset_model text,p_asset_serial text,
  p_asset_year integer,p_resolution_code text,p_resolution_notes text,p_activity_text text
)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_work public.work_orders%rowtype; v_operation public.work_order_lifecycle_operations%rowtype; v_result jsonb;
begin
  perform public.require_work_order_lifecycle_actor(p_work_order_id);
  select * into v_work from public.work_orders w where w.id=p_work_order_id and w.deleted_at is null for update;
  if not found then raise exception 'Work order not found' using errcode='P0002'; end if;
  perform public.require_work_order_lifecycle_actor(p_work_order_id);
  if v_work.functional_status::text='Completed' or v_work.status='completed' then
    select o.* into v_operation from public.work_order_lifecycle_operations o
      join public.activities a on a.lifecycle_operation_id=o.operation_id
      where o.work_order_id=p_work_order_id and o.assignment_version=v_work.contractor_assignment_version
        and o.workflow_cycle=v_work.workflow_cycle and o.command_kind='complete'
        and a.event_key='job_completed' and a.deleted_at is null;
    if not found or v_work.functional_status::text is distinct from 'Completed'
       or v_work.end_time is distinct from (v_operation.payload->>'completedAt')::timestamptz
       or exists(select 1 from public.work_order_visits v where v.work_order_id=p_work_order_id and v.check_out_at is null)
       or v_work.asset_make is distinct from v_operation.payload->>'assetMake'
       or v_work.asset_model is distinct from v_operation.payload->>'assetModel'
       or v_work.asset_serial is distinct from v_operation.payload->>'assetSerial'
       or (public.lifecycle_parent_snapshot(v_work)-array['status','lifecycle_version'])
          is distinct from (v_operation.parent_snapshot-array['status','lifecycle_version'])
       or not exists(select 1 from public.activities a where a.lifecycle_operation_id=v_operation.operation_id
         and a.id=(v_operation.result->>'activityId')::uuid and a.author_id=v_operation.actor_id
         and a.lifecycle_version=(v_operation.result->>'lifecycleVersion')::bigint
         and a.contractor_assignment_version=v_work.contractor_assignment_version
         and a.workflow_cycle=v_work.workflow_cycle and a.deleted_at is null) then
      raise exception 'Completion evidence needs review before retrying' using errcode='PT409'; end if;
    if v_operation.payload is distinct from jsonb_build_object('completedAt',p_completed_at,
      'assetMake',nullif(btrim(coalesce(p_asset_make,'')),''),'assetModel',nullif(btrim(coalesce(p_asset_model,'')),''),
      'assetSerial',nullif(btrim(coalesce(p_asset_serial,'')),''),'assetYear',p_asset_year,
      'resolutionCode',nullif(btrim(coalesce(p_resolution_code,'')),''),
      'resolutionNotes',nullif(btrim(coalesce(p_resolution_notes,'')),'')) then
      raise exception 'Completion input changed after this work was completed' using errcode='PT409'; end if;
    return v_operation.result||jsonb_build_object('applied',false,'reason','already_completed',
      'workOrderStatus',v_work.status);
  end if;
  v_result:=public.complete_work_order_field_v1(p_work_order_id,v_work.contractor_assignment_version,
    v_work.workflow_cycle,v_work.lifecycle_version,gen_random_uuid(),p_completed_at,p_asset_make,p_asset_model,
    p_asset_serial,p_asset_year,p_resolution_code,p_resolution_notes);
  return v_result||jsonb_build_object('visitsClosed',case when v_result->>'visitId' is null then 0 else 1 end);
end;
$$;

create function public.flag_work_order_capital_v1(
  p_work_order_id text,p_expected_assignment_version integer,p_expected_workflow_cycle integer,p_expected_lifecycle_version bigint
)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_actor public.profiles%rowtype; v_work public.work_orders%rowtype;
begin
  v_actor:=public.require_work_order_lifecycle_actor(p_work_order_id);
  if v_actor.role='contractor' then raise exception 'Operational staff access required' using errcode='42501'; end if;
  select * into v_work from public.work_orders w where w.id=p_work_order_id and w.deleted_at is null for update;
  if not found then raise exception 'Work order not found' using errcode='P0002'; end if;
  if p_expected_assignment_version is null or p_expected_workflow_cycle is null or p_expected_lifecycle_version is null then
    raise exception 'Expected work-order versions are required' using errcode='22023'; end if;
  if v_work.contractor_assignment_version<>p_expected_assignment_version or v_work.workflow_cycle<>p_expected_workflow_cycle
    or v_work.lifecycle_version<>p_expected_lifecycle_version then
    raise exception 'Work order changed. Refresh and try again.' using errcode='PT409'; end if;
  if v_work.status::text not in ('assigned','wip','parts','completed','pending_invoice','pending_approval','pending_payment') then
    raise exception 'Work order cannot be flagged capital from this state' using errcode='PT409'; end if;
  insert into public.work_order_lifecycle_transition_guards(transaction_id,work_order_id,actor_id,command_kind,parent_allowed)
    values(txid_current(),p_work_order_id,auth.uid(),'capital_flag',true);
  update public.work_orders set status='capital',functional_status='Work in Progress',capital_status=null,is_capital=true
    where id=p_work_order_id returning * into v_work;
  insert into public.activities(work_order_id,author_id,author_name,text,type,event_key)
    values(p_work_order_id,v_actor.id,v_actor.name,
      'Marked as a capital replacement and ready for quote preparation.','system','system');
  delete from public.work_order_lifecycle_transition_guards where transaction_id=txid_current()
    and work_order_id=p_work_order_id and command_kind='capital_flag';
  return jsonb_build_object('applied',true,'workOrderId',p_work_order_id,'status',v_work.status,
    'functionalStatus',v_work.functional_status,'lifecycleVersion',v_work.lifecycle_version);
end;
$$;

create function public.complete_work_order_field_v1(
  p_work_order_id text,p_expected_assignment_version integer,p_expected_workflow_cycle integer,
  p_expected_lifecycle_version bigint,p_operation_id uuid,p_completed_at timestamptz,
  p_asset_make text,p_asset_model text,p_asset_serial text,p_asset_year integer,
  p_resolution_code text,p_resolution_notes text
)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare
  v_replay jsonb; v_work public.work_orders%rowtype; v_activity uuid; v_visit uuid;
  v_make text:=nullif(btrim(coalesce(p_asset_make,'')),'');
  v_model text:=nullif(btrim(coalesce(p_asset_model,'')),'');
  v_serial text:=nullif(btrim(coalesce(p_asset_serial,'')),'');
  v_resolution text:=nullif(btrim(coalesce(p_resolution_code,'')),'');
  v_notes text:=nullif(btrim(coalesce(p_resolution_notes,'')),'');
begin
  if p_completed_at is null or not isfinite(p_completed_at)
    or v_make is null or v_model is null or v_serial is null
    or greatest(length(v_make),length(v_model),length(v_serial))>1000
    or length(coalesce(v_resolution,''))>1000 or length(coalesce(v_notes,''))>10000 then
    raise exception 'Completion time, equipment make, model and serial are required' using errcode='22023'; end if;
  v_replay:=public.begin_work_order_lifecycle_command(p_work_order_id,p_expected_assignment_version,
    p_expected_workflow_cycle,p_expected_lifecycle_version,p_operation_id,'complete',
    jsonb_build_object('completedAt',p_completed_at,'assetMake',v_make,'assetModel',v_model,
      'assetSerial',v_serial,'assetYear',p_asset_year,'resolutionCode',v_resolution,'resolutionNotes',v_notes));
  if v_replay is not null then return v_replay; end if;
  select * into strict v_work from public.work_orders w where w.id=p_work_order_id;
  if v_work.status::text not in ('wip','pending_invoice','pending_approval','pending_payment')
     or v_work.functional_status::text='Completed' then
    raise exception 'This work order cannot be completed from its current state' using errcode='PT409'; end if;
  select v.id into v_visit from public.work_order_visits v where v.work_order_id=p_work_order_id
    and v.check_out_at is null for update;
  if v_visit is not null and exists(select 1 from public.work_order_visits v
    where v.id=v_visit and (v.contractor_id is distinct from v_work.contractor_id or v.check_in_at>p_completed_at)) then
    raise exception 'The active visit does not match this completion' using errcode='PT409'; end if;
  update public.work_orders set status=case when status::text in ('pending_invoice','pending_approval','pending_payment')
      then status else 'completed'::public.wo_status end,
    functional_status='Completed',asset_make=v_make,asset_model=v_model,asset_serial=v_serial,
    asset_year=p_asset_year,end_time=p_completed_at,resolution_code=v_resolution,resolution_notes=v_notes
    where id=p_work_order_id;
  update public.work_order_visits set check_out_at=p_completed_at,checked_out_by=auth.uid() where id=v_visit;
  v_activity:=public.insert_work_order_lifecycle_activity(p_work_order_id,p_operation_id,
    'Job completed and clocked out at '||p_completed_at::text||'. Asset: '||v_make||' '||v_model||' / '||v_serial
      ||'. Resolution: '||coalesce(v_resolution,'Repaired')||'.'
      ||case when v_notes is null then '' else ' Closing notes: '||v_notes end,
    jsonb_build_object('clockedOutAt',p_completed_at,'resolution',v_resolution,'closingNotes',v_notes,
      'preservedWorkOrderStatus',case when v_work.status::text in ('pending_invoice','pending_approval','pending_payment')
        then v_work.status::text else 'completed' end));
  return public.finish_work_order_lifecycle_command(p_work_order_id,p_operation_id,v_activity,v_visit);
end;
$$;

-- Preserve reviewed neighboring policies rather than duplicating or rewriting
-- them. These finite, migration-owned wrappers create only a target-scoped
-- capability, call the unchanged private implementation (which authenticates,
-- authorizes and validates), and remove the capability before returning. The
-- dynamic DDL below uses catalog signatures and a fixed allow-list, never user
-- input. Direct access to each renamed core is explicitly revoked.
do $wrap$
declare
  v_signature text; v_proc record; v_name text; v_core text; v_arguments text;
  v_call_arguments text; v_target_sql text; v_prelock text; v_is_service boolean;
begin
  foreach v_signature in array array[
    'public.move_work_order_straight_to_billing(text)',
    'public.resume_capital_work(text)',
    'public.complete_capital_work(text)',
    'public.decline_capital_work_order(text,integer)',
    'public.close_work_order_without_invoice(text,integer,integer,timestamp with time zone)',
    'public.close_reopened_work_order_without_additional_billing(text,integer,integer,timestamp with time zone,text)',
    'public.correct_work_order_visit(uuid,timestamp with time zone,timestamp with time zone,text)',
    'public.mark_staff_invoice_billed(uuid,uuid)',
    'public.refresh_email_work_order_dispatch(text,text,text,timestamp with time zone,text,timestamp with time zone,timestamp with time zone,timestamp with time zone,jsonb,text)'
  ] loop
    select p.*,pg_get_function_arguments(p.oid) arguments,
      pg_get_function_identity_arguments(p.oid) identity_arguments,
      pg_get_function_result(p.oid) result_type into strict v_proc
    from pg_proc p where p.oid=v_signature::regprocedure;
    v_name:=v_proc.proname; v_core:=v_name||'_lc_core'; v_arguments:=v_proc.arguments;
    select string_agg(format('%I',arg_name),',' order by ordinality) into v_call_arguments
      from unnest(v_proc.proargnames[1:v_proc.pronargs]) with ordinality as args(arg_name,ordinality);
    v_is_service:=v_name in ('mark_staff_invoice_billed','refresh_email_work_order_dispatch');
    v_prelock:='';
    if v_name='correct_work_order_visit' then
      -- Serialize correction with field commands in the same parent -> visit
      -- order. The original core retains its authorization and time policy.
      v_target_sql:=$target$
        select v.work_order_id into v_target from public.work_order_visits v where v.id=p_visit_id;
        perform 1 from public.work_orders w where w.id=v_target for update;
      $target$;
    elsif v_name='mark_staff_invoice_billed' then
      v_target_sql:='select i.work_order_id into v_target from public.invoices i where i.id=p_invoice_id;';
    elsif v_name='refresh_email_work_order_dispatch' then
      -- Match the existing priority command's message -> family lock order.
      -- It may redirect the external WOT to its current reassignment copy.
      v_prelock:=$pre$
        if coalesce(auth.role(),'')<>'service_role' then
          raise exception 'Service role required' using errcode='42501'; end if;
        perform pg_advisory_xact_lock(hashtextextended(trim(p_source_message_id),0));
        select coalesce(w.duplicate_root_work_order_id,w.id) into v_family
          from public.work_orders w where w.id=trim(p_work_order_id);
        perform pg_advisory_xact_lock(hashtextextended('work-order-priority:'||v_family,0));
      $pre$;
      v_target_sql:=$target$
        select w.id into v_target from public.work_orders w
          where w.deleted_at is null and (w.id=v_family or w.duplicate_root_work_order_id=v_family)
          order by coalesce(w.duplicate_sequence,0) desc,w.id desc limit 1;
      $target$;
    else v_target_sql:='v_target:=p_work_order_id;'; end if;
    execute format('alter function %s rename to %I',v_signature,v_core);
    execute format('revoke all on function public.%I(%s) from public,anon,authenticated,service_role',
      v_core,v_proc.identity_arguments);
    execute format($definition$
      create function public.%I(%s) returns %s language plpgsql security definer
      set search_path=public,pg_temp as $body$
      declare v_target text; v_family text; v_result %s;
      begin
        %s
        %s
        if v_target is not null and exists(select 1 from public.work_orders w where w.id=v_target) then
          insert into public.work_order_lifecycle_transition_guards(transaction_id,work_order_id,actor_id,
            command_kind,parent_allowed,visit_allowed,event_key)
          values(txid_current(),v_target,auth.uid(),%L,true,true,%L);
        end if;
        v_result:=public.%I(%s);
        delete from public.work_order_lifecycle_transition_guards where transaction_id=txid_current()
          and work_order_id=v_target and command_kind=%L;
        return v_result;
      end;
      $body$;
    $definition$,v_name,v_arguments,v_proc.result_type,v_proc.result_type,
      v_prelock,v_target_sql,'compat:'||v_name,
      case when v_name='correct_work_order_visit' then 'visit_time_corrected' else null end,
      v_core,v_call_arguments,'compat:'||v_name);
    execute format('revoke all on function public.%I(%s) from public,anon,authenticated,service_role',v_name,v_proc.identity_arguments);
    execute format('grant execute on function public.%I(%s) to %s',v_name,v_proc.identity_arguments,
      case when v_is_service then 'service_role' else 'authenticated,service_role' end);
  end loop;
end;
$wrap$;

-- The existing capital-pending intake branch is a trusted service workflow,
-- not a browser field transition. Preserve its exact capital flag and event
-- shape while moving the formerly separate update/activity into one command.
create function public.record_email_capital_pending_v1(p_work_order_id text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_work public.work_orders%rowtype; v_activity uuid;
begin
  if coalesce(auth.role(),'')<>'service_role' then
    raise exception 'Service role required' using errcode='42501'; end if;
  if nullif(btrim(p_work_order_id),'') is null then
    raise exception 'Work order is required' using errcode='22023'; end if;
  select * into v_work from public.work_orders w
    where w.id=p_work_order_id and w.deleted_at is null for update;
  if not found then raise exception 'Active work order not found' using errcode='P0002'; end if;
  insert into public.work_order_lifecycle_transition_guards(transaction_id,work_order_id,actor_id,
    command_kind,parent_allowed)
    values(txid_current(),p_work_order_id,auth.uid(),'email_capital_pending',true);
  update public.work_orders set status='capital',is_capital=true
    where id=p_work_order_id returning * into v_work;
  -- Omitting event_key intentionally preserves the old intake insert's
  -- database default ('note') and system-event channel normalization.
  insert into public.activities(work_order_id,author_name,text,type,is_staff_only)
    values(p_work_order_id,'System','Capital approval pending','system',false)
    returning id into v_activity;
  delete from public.work_order_lifecycle_transition_guards where transaction_id=txid_current()
    and work_order_id=p_work_order_id and command_kind='email_capital_pending';
  return jsonb_build_object('applied',true,'workOrderId',p_work_order_id,'workOrderStatus',v_work.status,
    'functionalStatus',v_work.functional_status,'lifecycleVersion',v_work.lifecycle_version,'activityId',v_activity);
end;
$$;
revoke all on function public.record_email_capital_pending_v1(text) from public,anon,authenticated,service_role;
grant execute on function public.record_email_capital_pending_v1(text) to service_role;

alter function public.set_activity_contractor_attention(uuid,boolean)
  rename to set_activity_contractor_attention_lc_core;
alter function public.acknowledge_contractor_attention(uuid)
  rename to acknowledge_contractor_attention_lc_core;
revoke all on function public.set_activity_contractor_attention_lc_core(uuid,boolean),
  public.acknowledge_contractor_attention_lc_core(uuid) from public,anon,authenticated,service_role;

create function public.set_activity_contractor_attention(p_activity_id uuid,p_required boolean)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare v_target text;
begin
  if auth.uid() is null or not public.is_staff() then
    raise exception 'Active staff access required' using errcode='42501'; end if;
  if p_activity_id is null or p_required is null then
    raise exception 'Activity and attention state are required' using errcode='22023'; end if;
  select a.work_order_id into v_target from public.activities a where a.id=p_activity_id;
  if v_target is null then raise exception 'Activity not found' using errcode='P0002'; end if;
  perform 1 from public.work_orders w where w.id=v_target for update;
  insert into public.work_order_lifecycle_transition_guards(transaction_id,work_order_id,actor_id,command_kind,activity_id)
    values(txid_current(),v_target,auth.uid(),'attention',p_activity_id);
  perform public.set_activity_contractor_attention_lc_core(p_activity_id,p_required);
  delete from public.work_order_lifecycle_transition_guards where transaction_id=txid_current()
    and work_order_id=v_target and command_kind='attention';
end;
$$;
create function public.acknowledge_contractor_attention(p_activity_id uuid)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare v_target text;
begin
  if not exists(select 1 from public.profiles p where p.id=auth.uid() and p.active=true) then
    raise exception 'Active portal access required' using errcode='42501'; end if;
  select a.work_order_id into v_target from public.activities a where a.id=p_activity_id;
  if v_target is null then raise exception 'Activity not found' using errcode='P0002'; end if;
  perform 1 from public.work_orders w where w.id=v_target for update;
  insert into public.work_order_lifecycle_transition_guards(transaction_id,work_order_id,actor_id,command_kind,activity_id)
    values(txid_current(),v_target,auth.uid(),'attention',p_activity_id);
  perform public.acknowledge_contractor_attention_lc_core(p_activity_id);
  delete from public.work_order_lifecycle_transition_guards where transaction_id=txid_current()
    and work_order_id=v_target and command_kind='attention';
end;
$$;
revoke all on function public.set_activity_contractor_attention(uuid,boolean),
  public.acknowledge_contractor_attention(uuid) from public,anon,authenticated,service_role;
grant execute on function public.set_activity_contractor_attention(uuid,boolean),
  public.acknowledge_contractor_attention(uuid) to authenticated,service_role;

-- All helpers, including trigger functions, are private. Only the explicit
-- request contracts below form the browser RPC surface.
revoke all on function public.lifecycle_parent_snapshot(public.work_orders),
  public.lifecycle_visit_snapshot(uuid),public.lifecycle_part_snapshot(public.wo_parts),
  public.lifecycle_is_owner_maintenance(),public.require_work_order_lifecycle_actor(text),
  public.begin_work_order_lifecycle_command(text,integer,integer,bigint,uuid,text,jsonb),
  public.finish_work_order_lifecycle_command(text,uuid,uuid,uuid,jsonb),
  public.insert_work_order_lifecycle_activity(text,uuid,text,jsonb),
  public.begin_work_order_visit_command(text,integer,integer,bigint,uuid,timestamptz,text,boolean),
  public.protect_work_order_lifecycle_fields(),public.protect_work_order_lifecycle_activity(),
  public.protect_work_order_lifecycle_visit()
from public,anon,authenticated,service_role;

revoke all on function public.set_work_order_eta_v1(text,integer,integer,bigint,uuid,timestamptz),
  public.start_work_order_visit_v1(text,integer,integer,bigint,uuid,timestamptz,text),
  public.resume_work_order_visit_v1(text,integer,integer,bigint,uuid,timestamptz,text),
  public.pause_work_order_for_parts_v1(text,integer,integer,bigint,uuid,timestamptz,text,jsonb,text,text,date),
  public.complete_work_order_field_v1(text,integer,integer,bigint,uuid,timestamptz,text,text,text,integer,text,text),
  public.mark_work_order_activity_synced_v1(uuid,boolean),
  public.flag_work_order_capital_v1(text,integer,integer,bigint)
from public,anon,authenticated,service_role;
grant execute on function public.set_work_order_eta_v1(text,integer,integer,bigint,uuid,timestamptz),
  public.start_work_order_visit_v1(text,integer,integer,bigint,uuid,timestamptz,text),
  public.resume_work_order_visit_v1(text,integer,integer,bigint,uuid,timestamptz,text),
  public.pause_work_order_for_parts_v1(text,integer,integer,bigint,uuid,timestamptz,text,jsonb,text,text,date),
  public.complete_work_order_field_v1(text,integer,integer,bigint,uuid,timestamptz,text,text,text,integer,text,text),
  public.mark_work_order_activity_synced_v1(uuid,boolean),
  public.flag_work_order_capital_v1(text,integer,integer,bigint)
to authenticated;

revoke all on function public.complete_work_order_once(text,timestamptz,text,text,text,integer,text,text,text)
  from public,anon;
grant execute on function public.complete_work_order_once(text,timestamptz,text,text,text,integer,text,text,text)
  to authenticated,service_role;

commit;
