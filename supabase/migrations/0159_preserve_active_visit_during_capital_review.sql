-- A field visit can already be open when staff reclassifies the work as
-- capital or submits its capital quote. Preserve the capital stage while the
-- technician records the real checkout, then release an existing job as a
-- Resume (not a new first visit) after authorization.

begin;

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
    where v.id=v_visit and (v.contractor_id is distinct from v_work.contractor_id or v.check_in_at>p_check_out_at)) then
    raise exception 'The active visit does not match this checkout' using errcode='PT409'; end if;
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
  'Checks out an active visit. Ordinary pauses preserve parallel billing queues; capital-review checkout preserves the capital stage and records the real visit boundary.';

-- 0123 wrapped this compatibility command with a transaction-scoped lifecycle
-- capability. Replace only its private core so the wrapper and execute surface
-- remain unchanged.
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

  update public.work_orders
  set status = case
        when contractor_id is null then 'unassigned'::public.wo_status
        when v_has_prior_visit then 'parts'::public.wo_status
        else 'assigned'::public.wo_status
      end,
      functional_status = case
        when contractor_id is null then 'New'::public.fsm_functional_status
        when v_has_prior_visit then 'Awaiting Parts'::public.fsm_functional_status
        else 'Dispatched'::public.fsm_functional_status
      end,
      capital_status = 'Approved - work authorized',
      is_capital = true,
      closed_at = null,
      updated_at = now()
  where id = v_work_order.id
  returning * into v_work_order;

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
      'nextFieldAction', case when v_has_prior_visit then 'resume' else 'start' end
    )
  );

  return v_work_order;
end;
$$;

revoke all on function public.resume_capital_work_lc_core(text)
  from public, anon, authenticated, service_role;

create or replace function public.complete_capital_work_lc_core(
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
  v_quote_id uuid;
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
    raise exception 'Work order is not pending capital completion'
      using errcode = '23514';
  end if;
  if exists (
    select 1 from public.work_order_visits visit
    where visit.work_order_id = v_work_order.id
      and visit.check_out_at is null
  ) then
    raise exception 'Clock out the active visit before completing capital work'
      using errcode = 'PT409';
  end if;

  select quote.id into v_quote_id
  from public.invoices quote
  where quote.work_order_id = v_work_order.id
    and quote.invoice_type = 'staff'
    and quote.document_kind = 'capital_quote'
    and quote.state in ('approved', 'paid')
    and quote.deleted_at is null
  order by quote.updated_at desc, quote.id desc
  limit 1;

  if v_quote_id is null then
    raise exception 'An approved capital quote is required before completion'
      using errcode = '23514';
  end if;

  update public.work_orders
  set status = 'pending_invoice',
      functional_status = 'Completed',
      capital_status = 'Installed',
      is_capital = true,
      billing_ready_at = now(),
      billing_ready_by = v_actor.id,
      closed_at = null,
      updated_at = now()
  where id = v_work_order.id
  returning * into v_work_order;

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
      'Capital work marked completed by %s and moved to final billing.',
      v_actor.name
    ),
    'system',
    false,
    true,
    'capital_completed',
    jsonb_build_object(
      'action', 'capital_completed',
      'capitalQuoteInvoiceId', v_quote_id,
      'workOrderStatus', v_work_order.status,
      'capitalStatus', v_work_order.capital_status
    )
  );

  return v_work_order;
end;
$$;

revoke all on function public.complete_capital_work_lc_core(text)
  from public, anon, authenticated, service_role;

commit;
