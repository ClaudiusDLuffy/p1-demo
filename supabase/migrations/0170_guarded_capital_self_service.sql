-- Staff attestations are recorded, not invented. External quote references
-- are not receivable invoices. Sent quotes remain intact when revised.
begin;

alter table public.work_order_lifecycle_operations
  drop constraint work_order_lifecycle_operations_command_kind_check;
alter table public.work_order_lifecycle_operations add constraint work_order_lifecycle_operations_command_kind_check
  check(command_kind in ('eta','start','resume','pause','complete','capital_external_handoff',
    'capital_confirmed_completion','capital_quote_revision'));

create table public.external_capital_quote_handoffs (
  id uuid primary key default gen_random_uuid(),
  work_order_id text not null references public.work_orders(id) on delete restrict,
  workflow_cycle integer not null check(workflow_cycle>=0),
  operation_id uuid not null unique references public.work_order_lifecycle_operations(operation_id),
  reference text not null check(length(btrim(reference)) between 1 and 120),
  note text not null check(length(btrim(note)) between 5 and 1000),
  actor_id uuid not null references public.profiles(id),
  submitted_and_approved boolean not null check(submitted_and_approved),
  created_at timestamptz not null default clock_timestamp(),
  unique(work_order_id,workflow_cycle)
);
alter table public.external_capital_quote_handoffs enable row level security;
revoke all on public.external_capital_quote_handoffs from public,anon,authenticated,service_role;

alter table public.invoices
  add column source_external_capital_quote_id uuid references public.external_capital_quote_handoffs(id) on delete restrict,
  add column revision_of_capital_quote_id uuid references public.invoices(id) on delete restrict;
create unique index invoices_external_capital_final_unique on public.invoices(source_external_capital_quote_id)
  where source_external_capital_quote_id is not null and deleted_at is null;
create unique index invoices_capital_revision_draft_unique on public.invoices(revision_of_capital_quote_id)
  where revision_of_capital_quote_id is not null and state in ('draft','submitted','revised') and deleted_at is null;

create or replace function public.classify_staff_billing_document()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare v_work public.work_orders%rowtype; v_quote uuid; v_external uuid;
begin
  if tg_op='UPDATE' then
    if new.document_kind is distinct from old.document_kind
      or new.source_capital_quote_id is distinct from old.source_capital_quote_id
      or new.source_external_capital_quote_id is distinct from old.source_external_capital_quote_id
      or new.revision_of_capital_quote_id is distinct from old.revision_of_capital_quote_id then
      raise exception 'Billing document classification is immutable' using errcode='42501'; end if;
    if (old.document_kind='capital_quote' or old.source_external_capital_quote_id is not null
        or old.source_capital_quote_id is not null) and new.work_order_id is distinct from old.work_order_id then
      raise exception 'A capital document cannot be moved to another work order' using errcode='23514'; end if;
    return new;
  end if;
  new.document_kind:='invoice'; new.source_capital_quote_id:=null; new.source_external_capital_quote_id:=null;
  if new.revision_of_capital_quote_id is not null then
    if new.invoice_type<>'staff' or not exists(select 1 from public.work_order_lifecycle_transition_guards g
      where g.transaction_id=txid_current() and g.work_order_id=new.work_order_id and g.actor_id=auth.uid()
        and g.command_kind='capital_quote_revision') then
      raise exception 'Use the guarded capital quote revision action' using errcode='42501'; end if;
    new.document_kind:='capital_quote'; return new;
  end if;
  if new.invoice_type<>'staff' or new.work_order_id is null then return new; end if;
  select * into v_work from public.work_orders where id=new.work_order_id and deleted_at is null;
  if not found or not v_work.is_capital then return new; end if;
  if v_work.status='capital' then
    if exists(select 1 from public.external_capital_quote_handoffs h
      where h.work_order_id=v_work.id and h.workflow_cycle=v_work.workflow_cycle) then
      raise exception 'An external capital quote is already recorded' using errcode='23514'; end if;
    new.document_kind:='capital_quote'; return new;
  end if;
  if v_work.status='pending_capital_completion' then
    raise exception 'Mark the capital work completed before creating its final invoice' using errcode='23514'; end if;
  if v_work.status='pending_invoice' then
    select id into v_quote from public.invoices where work_order_id=v_work.id and invoice_type='staff'
      and document_kind='capital_quote' and state in ('approved','paid') and deleted_at is null
      order by updated_at desc,id desc limit 1;
    if v_quote is null then
      select id into v_external from public.external_capital_quote_handoffs
        where work_order_id=v_work.id and workflow_cycle=v_work.workflow_cycle and submitted_and_approved;
      if v_external is null then
        raise exception 'An approved capital quote is required before final billing' using errcode='23514'; end if;
      new.source_external_capital_quote_id:=v_external;
    else new.source_capital_quote_id:=v_quote; end if;
  end if;
  return new;
end; $$;

-- Accept an audited external quote handoff, and never complete while an
-- unsent revision exists. All existing checkout/role/stage guards survive.
do $$
declare v_def text; v_old text;
begin
  select pg_get_functiondef('public.complete_capital_work_lc_core(text)'::regprocedure) into v_def;
  v_old:='if v_quote_id is null then';
  if position(v_old in v_def)=0 then raise exception 'Missing capital completion quote guard'; end if;
  v_def:=replace(v_def,v_old,$patch$if exists(select 1 from public.invoices i where i.work_order_id=v_work_order.id
      and i.invoice_type='staff' and i.document_kind='capital_quote' and i.deleted_at is null
      and i.state in ('draft','submitted','revised')) then
    raise exception 'Submit the pending capital quote or revision before completion' using errcode='23514';
  end if;
  if v_quote_id is null and not exists(select 1 from public.external_capital_quote_handoffs h
    where h.work_order_id=v_work_order.id and h.workflow_cycle=v_work_order.workflow_cycle
      and h.submitted_and_approved) then$patch$);
  execute v_def;
end; $$;

create function public.run_capital_self_service_v1(
  p_work_order_id text,p_expected_assignment_version integer,p_expected_workflow_cycle integer,
  p_expected_lifecycle_version bigint,p_operation_id uuid,p_action text,p_payload jsonb
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare
  v_actor public.profiles%rowtype; v_work public.work_orders%rowtype; v_quote public.invoices%rowtype;
  v_replay jsonb; v_activity uuid; v_result jsonb; v_external uuid; v_new uuid;
  v_guard bigint; v_note text; v_reference text; v_event text; v_count integer;
begin
  v_actor:=public.require_linked_billing_actor();
  if p_action not in ('capital_external_handoff','capital_confirmed_completion','capital_quote_revision')
    or p_action is null or jsonb_typeof(p_payload) is distinct from 'object' then
    raise exception 'Invalid capital action' using errcode='22023'; end if;
  v_note:=btrim(coalesce(p_payload->>'note',''));
  if length(v_note) not between 5 and 1000 or v_note ~ '[[:cntrl:]]'
    or p_payload->'confirmed' is distinct from 'true'::jsonb then
    raise exception 'Confirm the facts and enter an audit note of 5–1,000 characters' using errcode='22023'; end if;
  if exists(select 1 from jsonb_object_keys(p_payload) k where k not in ('note','confirmed','reference','quoteId','invoiceVersion')) then
    raise exception 'Unexpected capital action fields' using errcode='22023'; end if;
  -- Financial commands lock the invoice before its parent. Keep that order.
  if p_action='capital_quote_revision' then
    select * into v_quote from public.invoices where id=(p_payload->>'quoteId')::uuid for update;
    if not found or v_quote.work_order_id is distinct from p_work_order_id then
      raise exception 'Capital quote not found' using errcode='P0002'; end if;
  end if;
  v_replay:=public.begin_work_order_lifecycle_command(p_work_order_id,p_expected_assignment_version,
    p_expected_workflow_cycle,p_expected_lifecycle_version,p_operation_id,p_action,p_payload);
  if v_replay is not null then
    if p_action='capital_quote_revision' and not exists(select 1 from public.invoices i
      where i.id=(v_replay->>'invoiceId')::uuid and i.deleted_at is null and i.state='draft'
        and i.invoice_version=(v_replay->>'invoiceVersion')::bigint) then
      raise exception 'Quote changed after this operation. Refresh and reconcile.' using errcode='PT409'; end if;
    return v_replay;
  end if;
  select * into strict v_work from public.work_orders where id=p_work_order_id;
  if not v_work.is_capital or v_work.billing_only then
    raise exception 'An active capital work order is required' using errcode='23514'; end if;
  if p_action='capital_external_handoff' then
    if v_work.status<>'capital' or exists(select 1 from public.invoices i
      where i.work_order_id=v_work.id and i.invoice_type='staff' and i.deleted_at is null) then
      raise exception 'Review existing portal documents before recording an external capital quote' using errcode='23514'; end if;
    v_reference:=btrim(coalesce(p_payload->>'reference',''));
    if length(v_reference) not between 1 and 120 or v_reference ~ '[[:cntrl:]]' then
      raise exception 'An external approved quote reference is required' using errcode='22023'; end if;
    insert into public.external_capital_quote_handoffs(work_order_id,workflow_cycle,operation_id,reference,note,actor_id,submitted_and_approved)
      values(v_work.id,v_work.workflow_cycle,p_operation_id,v_reference,v_note,v_actor.id,true) returning id into v_external;
    update public.work_orders set status='pending_capital_completion',
      functional_status=case when functional_status='Completed' then functional_status
        else 'Pending Capital Completion'::public.fsm_functional_status end,updated_at=now() where id=v_work.id;
    v_event:='capital_external_quote_recorded';
  elsif p_action='capital_confirmed_completion' then
    if v_work.status<>'pending_capital_completion' then
      raise exception 'Record the capital quote handoff before confirming installation' using errcode='23514'; end if;
    perform public.complete_capital_work(p_work_order_id);
    v_event:='capital_completion_confirmed';
  else
    if v_work.status<>'pending_capital_completion' or v_work.capital_status='Installed'
      or v_quote.invoice_type<>'staff' or v_quote.document_kind<>'capital_quote'
      or v_quote.deleted_at is not null or v_quote.state<>'approved'
      or v_quote.qbo_invoice_id is not null or v_quote.qbo_synced_at is not null
      or (p_payload->>'invoiceVersion')::bigint is distinct from v_quote.invoice_version
      or not exists(select 1 from public.activities a where a.work_order_id=v_work.id
        and a.deleted_at is null and a.event_key='capital_quote_submitted'
        and a.event_data->>'invoiceId'=v_quote.id::text and a.workflow_cycle=v_work.workflow_cycle)
      or exists(select 1 from public.invoices i where i.work_order_id=v_work.id and i.deleted_at is null
        and i.invoice_type='staff' and (i.document_kind='invoice' or i.state in ('draft','submitted','revised')))
    then raise exception 'Only a sent capital quote awaiting installation can be revised. Refresh and review existing documents.' using errcode='PT409'; end if;
    select count(*) into v_count from public.invoice_lines where invoice_id=v_quote.id;
    if v_count not between 1 and 1000 then
      raise exception 'A complete quote of 1–1,000 lines is required' using errcode='23514'; end if;
    v_new:=gen_random_uuid();
    v_guard:=public.open_invoice_financial_guard(v_actor.id,'staff_save',null,null,v_work.id,true,true,false,false,'staff_billing');
    insert into public.invoices(id,num,work_order_id,store_number,store_address,cme,invoice_date,service_date,due_date,
      terms,state,subtotal,sales_tax,total,created_by,invoice_type,tax_state,tax_rate,territory,equipment_tag,
      tax_rate_source,tax_rate_reference_id,tax_jurisdiction_snapshot,tax_rate_verified_at,revision_of_capital_quote_id)
    values(v_new,left(v_quote.num,60)||'-R'||left(v_new::text,8),v_work.id,v_quote.store_number,v_quote.store_address,
      v_quote.cme,current_date,v_quote.service_date,v_quote.due_date,v_quote.terms,'draft',v_quote.subtotal,
      v_quote.sales_tax,v_quote.total,v_actor.id,'staff',v_quote.tax_state,v_quote.tax_rate,v_quote.territory,
      v_quote.equipment_tag,v_quote.tax_rate_source,v_quote.tax_rate_reference_id,v_quote.tax_jurisdiction_snapshot,
      v_quote.tax_rate_verified_at,v_quote.id);
    insert into public.invoice_lines(invoice_id,position,type,description,qty,rate,is_taxable,source_unit_cost,markup_percent)
      select v_new,position,type,description,qty,rate,is_taxable,source_unit_cost,markup_percent
        from public.invoice_lines where invoice_id=v_quote.id order by position;
    perform public.close_invoice_financial_guard(v_guard);
    -- Source links stay on the original. They are not duplicated or claimed
    -- again; copied costs are a snapshot, not new contractor billing.
    update public.work_orders set updated_at=now() where id=v_work.id;
    v_event:='capital_quote_revision_created';
  end if;
  update public.work_order_lifecycle_transition_guards set event_key=v_event
    where transaction_id=txid_current() and work_order_id=v_work.id and operation_id=p_operation_id;
  insert into public.activities(work_order_id,author_id,author_name,text,type,is_staff_override,is_staff_only,
    event_key,event_data,lifecycle_operation_id,lifecycle_version)
  select v_work.id,v_actor.id,v_actor.name,
    case p_action when 'capital_external_handoff' then 'External capital quote submitted and approved: '||v_reference
      when 'capital_confirmed_completion' then 'Installation confirmed; moved to final billing.'
      else 'Capital quote revision created; original sent quote retained.' end||' '||v_note,
    'system',true,true,v_event,
    p_payload||jsonb_build_object('action',p_action,'externalQuoteId',v_external,'invoiceId',v_new,'originalQuoteId',v_quote.id,
      'operationId',p_operation_id,'lifecycleVersion',w.lifecycle_version),p_operation_id,w.lifecycle_version
    from public.work_orders w where w.id=v_work.id returning id into v_activity;
  v_result:=public.finish_work_order_lifecycle_command(v_work.id,p_operation_id,v_activity,null)
    ||jsonb_build_object('action',p_action,'externalQuoteId',v_external,'invoiceId',v_new,
      'invoiceVersion',(select invoice_version from public.invoices where id=v_new));
  update public.work_order_lifecycle_operations set result=v_result where operation_id=p_operation_id;
  return v_result;
end; $$;
revoke all on function public.run_capital_self_service_v1(text,integer,integer,bigint,uuid,text,jsonb)
  from public,anon,service_role;
grant execute on function public.run_capital_self_service_v1(text,integer,integer,bigint,uuid,text,jsonb) to authenticated;
notify pgrst,'reload schema';
commit;
