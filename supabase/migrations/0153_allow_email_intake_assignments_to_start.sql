-- Email-intake assignments intentionally retain the provider-facing `New`
-- functional status until the contractor's first field action. The lifecycle
-- boundary must accept that valid assigned state in addition to manually
-- created `Dispatched` assignments. Resume and receiving-transfer eligibility
-- remain unchanged.
begin;

create or replace function public.set_work_order_eta_v1(
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
  if v_work.status<>'assigned'
     or v_work.functional_status::text not in ('New','Dispatched')
     or v_work.contractor_id is null then
    raise exception 'ETA can only be set for assigned field work' using errcode='PT409'; end if;
  update public.work_orders set eta=p_eta where id=p_work_order_id;
  v_activity:=public.insert_work_order_lifecycle_activity(p_work_order_id,p_operation_id,
    'ETA set: '||p_eta::text,jsonb_build_object('eta',p_eta));
  return public.finish_work_order_lifecycle_command(p_work_order_id,p_operation_id,v_activity,null);
end;
$$;

create or replace function public.begin_work_order_visit_command(
  p_work_order_id text,p_expected_assignment_version integer,p_expected_workflow_cycle integer,
  p_expected_lifecycle_version bigint,p_operation_id uuid,p_check_in_at timestamptz,p_notes text,p_resume boolean
)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_replay jsonb; v_work public.work_orders%rowtype; v_activity uuid; v_visit uuid;
  v_notes text:=nullif(btrim(coalesce(p_notes,'')),''); v_receiving boolean;
  v_regular_start boolean; v_regular_resume boolean;
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
  v_regular_start:=not p_resume and v_work.status='assigned'
    and v_work.functional_status::text in ('New','Dispatched');
  v_regular_resume:=p_resume and v_work.status='parts'
    and v_work.functional_status='Awaiting Parts';
  if v_work.contractor_id is null or not (v_receiving or v_regular_start or v_regular_resume) then
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

comment on function public.begin_work_order_visit_command(text,integer,integer,bigint,uuid,timestamptz,text,boolean) is
  'Private lifecycle owner for initial, resumed, and receiving-transfer visits. Initial assigned work accepts email-intake New and manual Dispatched states.';

commit;
