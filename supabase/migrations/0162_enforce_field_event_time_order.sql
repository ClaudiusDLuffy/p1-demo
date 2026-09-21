-- Reject impossible field-event chronology before it can become a generic
-- visit conflict. The browser performs the same checks for immediate feedback;
-- these command-owned checks remain authoritative for stale or alternate
-- clients. Five minutes is clock-skew tolerance, not future scheduling.

begin;

do $preflight$
declare
  v_begin text;
  v_pause text;
  v_complete text;
begin
  select pg_get_functiondef(
    'public.begin_work_order_visit_command(text,integer,integer,bigint,uuid,timestamptz,text,boolean)'::regprocedure
  ) into strict v_begin;
  select pg_get_functiondef(
    'public.pause_work_order_for_parts_v1(text,integer,integer,bigint,uuid,timestamptz,text,jsonb,text,text,date)'::regprocedure
  ) into strict v_pause;
  select pg_get_functiondef(
    'public.complete_work_order_field_v1(text,integer,integer,bigint,uuid,timestamptz,text,text,text,integer,text,text)'::regprocedure
  ) into strict v_complete;

  if position('assignment_transfer_pending_visit' in v_begin) = 0
     or position('technician_profile_id' in v_begin) = 0
     or position('capitalStagePreserved' in v_pause) = 0
     or position('The active visit does not match this checkout' in v_pause) = 0
     or position('The active visit does not match this completion' in v_complete) = 0
  then
    raise exception 'Field lifecycle command definitions drifted; review before applying time policy'
      using errcode = '23514';
  end if;
end;
$preflight$;

create or replace function public.begin_work_order_visit_command(
  p_work_order_id text,
  p_expected_assignment_version integer,
  p_expected_workflow_cycle integer,
  p_expected_lifecycle_version bigint,
  p_operation_id uuid,
  p_check_in_at timestamptz,
  p_notes text,
  p_resume boolean
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_replay jsonb;
  v_work public.work_orders%rowtype;
  v_activity uuid;
  v_visit uuid;
  v_notes text := nullif(btrim(coalesce(p_notes, '')), '');
  v_receiving boolean;
  v_regular_start boolean;
  v_regular_resume boolean;
  v_next_status public.wo_status;
begin
  if p_check_in_at is null or not isfinite(p_check_in_at) or length(coalesce(v_notes, '')) > 10000 then
    raise exception 'A valid check-in time and notes are required' using errcode = '22023';
  end if;
  if p_check_in_at > clock_timestamp() + interval '5 minutes' then
    raise exception 'Check-in time cannot be in the future' using errcode = 'PT409';
  end if;
  v_replay := public.begin_work_order_lifecycle_command(
    p_work_order_id, p_expected_assignment_version, p_expected_workflow_cycle,
    p_expected_lifecycle_version, p_operation_id,
    case when p_resume then 'resume' else 'start' end,
    jsonb_build_object('checkedInAt', p_check_in_at, 'notes', v_notes)
  );
  if v_replay is not null then return v_replay; end if;

  select * into strict v_work from public.work_orders work_order where work_order.id = p_work_order_id;
  v_receiving := v_work.assignment_transfer_pending_visit
    and v_work.assignment_transfer_operation_id is not null
    and v_work.status = 'wip' and v_work.functional_status = 'Work in Progress';
  v_regular_start := not p_resume and v_work.status = 'assigned'
    and v_work.functional_status::text in ('New', 'Dispatched');
  v_regular_resume := p_resume
    and v_work.status::text in ('parts', 'pending_invoice', 'pending_approval', 'pending_payment')
    and v_work.functional_status = 'Awaiting Parts';
  if v_work.contractor_id is null or not (v_receiving or v_regular_start or v_regular_resume) then
    raise exception 'Work order cannot start or resume from its current state' using errcode = 'PT409';
  end if;
  if exists (
      select 1 from public.work_order_visits visit
      where visit.work_order_id = p_work_order_id and visit.check_out_at is null
    ) or exists (
      select 1 from public.work_order_visits visit
      where visit.work_order_id = p_work_order_id
        and visit.created_at >= v_work.contractor_assignment_started_at
        and visit.check_out_at > p_check_in_at
    ) or (v_receiving and p_check_in_at < v_work.contractor_assignment_started_at) then
    raise exception 'The requested visit overlaps existing work' using errcode = 'PT409';
  end if;

  v_next_status := case
    when v_regular_resume and v_work.status::text in ('pending_invoice', 'pending_approval', 'pending_payment')
      then v_work.status
    else 'wip'::public.wo_status
  end;
  update public.work_orders
  set status = v_next_status,
      functional_status = 'Work in Progress',
      start_time = coalesce(start_time, p_check_in_at),
      assignment_transfer_pending_visit = false
  where id = p_work_order_id;

  v_activity := public.insert_work_order_lifecycle_activity(
    p_work_order_id,
    p_operation_id,
    'Checked in and started work at ' || p_check_in_at::text || '.'
      || case when v_notes is null then '' else ' Notes: ' || v_notes end,
    jsonb_build_object(
      'checkedInAt', p_check_in_at,
      'notes', v_notes,
      'preservedWorkOrderStatus', v_next_status
    )
  );
  insert into public.work_order_visits(
    work_order_id, contractor_id, technician_profile_id,
    check_in_at, checked_in_by, check_in_activity_id
  ) values (
    p_work_order_id, v_work.contractor_id,
    coalesce(v_work.assigned_technician_profile_id, auth.uid()),
    p_check_in_at, auth.uid(), v_activity
  ) returning id into v_visit;
  return public.finish_work_order_lifecycle_command(
    p_work_order_id, p_operation_id, v_activity, v_visit
  );
end
$$;

comment on function public.begin_work_order_visit_command(text, integer, integer, bigint, uuid, timestamptz, text, boolean) is
  'Private lifecycle owner for initial, resumed, and transfer visits. Rejects arrivals beyond bounded clock skew and records actor and assigned technician separately.';

create or replace function public.pause_work_order_for_parts_v1(
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
  v_eta date:=p_legacy_part_eta; v_return_date date; v_qty numeric; v_next_status public.wo_status;
  v_next_functional public.fsm_functional_status; v_capital_checkout boolean:=false;
begin
  if p_check_out_at is null or not isfinite(p_check_out_at) or v_reason is null
     or v_reason not in ('Awaiting parts','Temporary fix','Capital review')
     or length(v_reason)>1000 or length(coalesce(v_notes,''))>10000
     or length(coalesce(v_label,''))>1000 then
    raise exception 'A valid checkout time, reason and parts details are required' using errcode='22023'; end if;
  if p_check_out_at > clock_timestamp() + interval '5 minutes' then
    raise exception 'Checkout time cannot be in the future' using errcode='PT409'; end if;
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
  if v_reason='Capital review' and (
       jsonb_array_length(v_parts)>0 or v_label is not null or v_eta is not null
     ) then
    raise exception 'Capital review checkout cannot add parts' using errcode='22023'; end if;
  if v_eta is not null and not isfinite(v_eta) then
    raise exception 'Part return date is invalid' using errcode='22023'; end if;
  v_replay:=public.begin_work_order_lifecycle_command(p_work_order_id,p_expected_assignment_version,
    p_expected_workflow_cycle,p_expected_lifecycle_version,p_operation_id,'pause',
    jsonb_build_object('pausedAt',p_check_out_at,'reason',v_reason,'notes',v_notes,'parts',v_parts,
      'legacyPartNeeded',nullif(btrim(coalesce(p_legacy_part_needed,'')),''),'legacyPartEta',p_legacy_part_eta));
  if v_replay is not null then return v_replay; end if;
  select * into strict v_work from public.work_orders w where w.id=p_work_order_id;
  v_capital_checkout:=v_work.status::text in ('capital','pending_capital_completion')
    and v_reason='Capital review';
  if not v_capital_checkout and (
       v_reason='Capital review'
       or v_work.functional_status::text is distinct from 'Work in Progress'
       or v_work.status::text not in ('wip','pending_invoice','pending_approval','pending_payment')
     ) then
    raise exception 'Only work in progress can be paused for parts' using errcode='PT409'; end if;
  if v_work.status::text in ('capital','pending_capital_completion') and not v_capital_checkout then
    raise exception 'Use capital review checkout for this active visit' using errcode='PT409'; end if;
  select v.id into v_visit from public.work_order_visits v where v.work_order_id=p_work_order_id
    and v.check_out_at is null for update;
  if v_capital_checkout and v_visit is null then
    raise exception 'The capital visit is already clocked out' using errcode='PT409'; end if;
  if v_visit is not null and exists(select 1 from public.work_order_visits v
    where v.id=v_visit and v.contractor_id is distinct from v_work.contractor_id) then
    raise exception 'The active visit contractor does not match this work order' using errcode='PT409'; end if;
  if v_visit is not null and exists(select 1 from public.work_order_visits v
    where v.id=v_visit and v.check_in_at>p_check_out_at) then
    raise exception 'Checkout time cannot be before active visit check-in' using errcode='PT409'; end if;
  v_next_status:=case
    when v_capital_checkout then v_work.status
    when v_work.status::text in ('pending_invoice','pending_approval','pending_payment') then v_work.status
    else 'parts'::public.wo_status
  end;
  v_next_functional:=case
    when v_capital_checkout and v_work.status='capital' then 'Pending Capital Approval'::public.fsm_functional_status
    when v_capital_checkout then 'Pending Capital Completion'::public.fsm_functional_status
    else 'Awaiting Parts'::public.fsm_functional_status
  end;
  update public.work_orders set status=v_next_status,functional_status=v_next_functional,
    part_needed=case when v_capital_checkout then part_needed else coalesce(v_label,part_needed) end,
    part_eta=case when v_capital_checkout then part_eta else coalesce(v_eta,part_eta) end
    where id=p_work_order_id;
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
    case when v_capital_checkout
      then 'Clocked out for capital review at '||p_check_out_at::text||'.'
      else 'Work paused at '||p_check_out_at::text||': '||v_reason||'.'
        ||case when v_label is null then '' else ' Part needed: '||v_label||'.' end
    end||case when v_notes is null then '' else ' Notes: '||v_notes end,
    jsonb_build_object('pausedAt',p_check_out_at,'reason',v_reason,'notes',v_notes,
      'preservedWorkOrderStatus',v_next_status,'capitalStagePreserved',v_capital_checkout));
  return public.finish_work_order_lifecycle_command(p_work_order_id,p_operation_id,v_activity,v_visit,v_saved_parts);
end;
$$;

comment on function public.pause_work_order_for_parts_v1(text,integer,integer,bigint,uuid,timestamptz,text,jsonb,text,text,date) is
  'Checks out an active visit with bounded future-time and visit-order validation while preserving parallel billing and capital stages.';

create or replace function public.complete_work_order_field_v1(
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
  if p_completed_at > clock_timestamp() + interval '5 minutes' then
    raise exception 'Completion time cannot be in the future' using errcode='PT409'; end if;
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
    where v.id=v_visit and v.contractor_id is distinct from v_work.contractor_id) then
    raise exception 'The active visit contractor does not match this work order' using errcode='PT409'; end if;
  if v_visit is not null and exists(select 1 from public.work_order_visits v
    where v.id=v_visit and v.check_in_at>p_completed_at) then
    raise exception 'Completion time cannot be before active visit check-in' using errcode='PT409'; end if;
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

comment on function public.complete_work_order_field_v1(text,integer,integer,bigint,uuid,timestamptz,text,text,text,integer,text,text) is
  'Completes field work with bounded future-time and visit-order validation while preserving an existing billing queue.';

revoke all on function public.begin_work_order_visit_command(text,integer,integer,bigint,uuid,timestamptz,text,boolean)
  from public,anon,authenticated,service_role;
revoke all on function public.pause_work_order_for_parts_v1(text,integer,integer,bigint,uuid,timestamptz,text,jsonb,text,text,date),
  public.complete_work_order_field_v1(text,integer,integer,bigint,uuid,timestamptz,text,text,text,integer,text,text)
  from public,anon,authenticated,service_role;
grant execute on function public.pause_work_order_for_parts_v1(text,integer,integer,bigint,uuid,timestamptz,text,jsonb,text,text,date),
  public.complete_work_order_field_v1(text,integer,integer,bigint,uuid,timestamptz,text,text,text,integer,text,text)
  to authenticated;

commit;
