-- Capital-only closeout: completion plus a confirmed, existing billing outcome.
-- No new invoice, copied quote, provider call, export, or historical bulk update.
begin;

alter table public.work_order_lifecycle_operations
  drop constraint work_order_lifecycle_operations_command_kind_check;
alter table public.work_order_lifecycle_operations add constraint work_order_lifecycle_operations_command_kind_check
  check(command_kind in ('eta','start','resume','pause','complete','capital_external_handoff',
    'capital_confirmed_completion','capital_quote_revision','capital_close_out'));

-- Existing final-invoice handoffs normally run through the trusted server.
-- Admit the same immutable billing event only inside this capital command's
-- BOTH private guards; ordinary authenticated writes remain forbidden.
do $capital_billing_event_guard$
declare definition text; old_guard text; new_guard text;
begin
  select pg_get_functiondef('public.protect_authoritative_close_activity()'::regprocedure) into definition;
  old_guard:=$old$and coalesce(auth.role(), '') not in ('service_role', '') then
    raise exception 'Billed-to-7-Eleven activity must be created by the billing workflow'$old$;
  new_guard:=$new$and coalesce(auth.role(), '') not in ('service_role', '')
     and not exists (
       select 1 from public.work_order_lifecycle_transition_guards lifecycle
       join public.invoice_financial_transition_guards financial
         on financial.transaction_id=lifecycle.transaction_id and financial.work_order_id=lifecycle.work_order_id
           and financial.actor_id=lifecycle.actor_id
       join public.work_orders work on work.id=lifecycle.work_order_id
       join public.invoices invoice on invoice.id=financial.invoice_id
       where lifecycle.transaction_id=txid_current() and lifecycle.actor_id=auth.uid()
         and lifecycle.command_kind='capital_close_out' and lifecycle.work_order_id=new.work_order_id
         and financial.command_kind='compat:mark_staff_invoice_billed' and financial.event_key='staff_billing'
         and financial.invoice_id::text=new.event_data->>'invoiceId'
         and work.is_capital and work.status='closed' and invoice.invoice_type='staff'
         and invoice.document_kind='invoice' and invoice.state='approved' and invoice.deleted_at is null
     ) then
    raise exception 'Billed-to-7-Eleven activity must be created by the billing workflow'$new$;
  if position(old_guard in definition)>0 then
    execute replace(definition,old_guard,new_guard);
  elsif position(new_guard in definition)=0 then
    raise exception 'Missing authoritative billing event guard';
  end if;
end; $capital_billing_event_guard$;

create or replace function public.close_out_capital_v1(
  p_work_order_id text,p_expected_assignment_version integer,p_expected_workflow_cycle integer,
  p_expected_lifecycle_version bigint,p_operation_id uuid,p_payload jsonb
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare
  v_actor public.profiles%rowtype; v_work public.work_orders%rowtype; v_doc public.invoices%rowtype;
  v_replay jsonb; v_result jsonb; v_activity uuid; v_guard bigint;
  v_outcome text; v_document uuid; v_version bigint; v_mark boolean;
  v_quote_ref text; v_bill_ref text; v_billed_on date; v_reopened_at timestamptz;
  v_submitted boolean; v_external uuid; v_now timestamptz:=clock_timestamp();
begin
  v_actor:=public.require_external_billing_actor();
  if jsonb_typeof(p_payload) is distinct from 'object'
    or exists(select 1 from jsonb_object_keys(p_payload) k where k not in
      ('outcome','confirmed','documentId','invoiceVersion','markQuoteSubmitted','quoteReference','invoiceReference','billedOn'))
    or p_payload->'confirmed' is distinct from 'true'::jsonb
    or jsonb_typeof(p_payload->'outcome') is distinct from 'string'
    or coalesce(p_payload->>'outcome','') not in ('billed','send_to_billing')
    or jsonb_typeof(p_payload->'markQuoteSubmitted') is distinct from 'boolean'
    or jsonb_typeof(p_payload->'documentId') not in ('string','null')
    or not (p_payload ? 'documentId' and p_payload ? 'invoiceVersion') then
    raise exception 'CAPITAL_CLOSE_INVALID_INPUT' using errcode='22023'; end if;
  v_outcome:=p_payload->>'outcome'; v_mark:=(p_payload->>'markQuoteSubmitted')::boolean;
  begin
    v_document:=(p_payload->>'documentId')::uuid;
    if v_document is not null and (jsonb_typeof(p_payload->'invoiceVersion') is distinct from 'number'
      or (p_payload->>'invoiceVersion') !~ '^[0-9]+$') then
      raise exception 'CAPITAL_CLOSE_INVALID_INPUT' using errcode='22023'; end if;
    v_version:=(p_payload->>'invoiceVersion')::bigint;
    if (v_document is null) <> (v_version is null) or coalesce(v_version,0)<0 then
      raise exception 'CAPITAL_CLOSE_INVALID_INPUT' using errcode='22023'; end if;
  exception when invalid_text_representation or numeric_value_out_of_range then
    raise exception 'CAPITAL_CLOSE_INVALID_INPUT' using errcode='22023'; end;
  v_quote_ref:=btrim(coalesce(p_payload->>'quoteReference',''));
  v_bill_ref:=btrim(coalesce(p_payload->>'invoiceReference',''));
  if length(v_quote_ref)>100 or v_quote_ref ~ '[[:cntrl:]]' or length(v_bill_ref)>100 or v_bill_ref ~ '[[:cntrl:]]'
    or jsonb_typeof(p_payload->'quoteReference') is distinct from 'string'
    or jsonb_typeof(p_payload->'invoiceReference') is distinct from 'string' then
    raise exception 'CAPITAL_CLOSE_INVALID_INPUT' using errcode='22023'; end if;
  if v_outcome='billed' then
    if v_bill_ref='' or jsonb_typeof(p_payload->'billedOn') is distinct from 'string'
      or (p_payload->>'billedOn') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
      raise exception 'CAPITAL_CLOSE_BILLING_REQUIRED' using errcode='22023'; end if;
    begin v_billed_on:=(p_payload->>'billedOn')::date;
    exception when datetime_field_overflow or invalid_datetime_format then
      raise exception 'CAPITAL_CLOSE_BILLING_REQUIRED' using errcode='22023'; end;
    if not isfinite(v_billed_on) or v_billed_on>(clock_timestamp() at time zone 'America/New_York')::date then
      raise exception 'CAPITAL_CLOSE_BILLING_REQUIRED' using errcode='22023'; end if;
  elsif v_bill_ref<>'' or p_payload->'billedOn' is distinct from 'null'::jsonb then
    raise exception 'CAPITAL_CLOSE_INVALID_INPUT' using errcode='22023';
  end if;

  -- Parent before invoice, as in authoritative staff financial commands.
  v_replay:=public.begin_work_order_lifecycle_command(p_work_order_id,p_expected_assignment_version,
    p_expected_workflow_cycle,p_expected_lifecycle_version,p_operation_id,'capital_close_out',p_payload);
  v_actor:=public.require_external_billing_actor();
  if v_replay is not null then
    if v_document is not null and not exists(select 1 from public.invoices i where i.id=v_document
      and i.work_order_id=p_work_order_id and i.deleted_at is null
      and i.invoice_version=(v_replay->>'invoiceVersion')::bigint) then
      raise exception 'CAPITAL_CLOSE_STALE' using errcode='PT409'; end if;
    return v_replay;
  end if;
  select * into strict v_work from public.work_orders where id=p_work_order_id;
  if not (coalesce(v_work.is_capital,false) or v_work.status::text in ('capital','pending_capital_completion'))
    or v_work.billing_only then
    raise exception 'CAPITAL_CLOSE_CAPITAL_ONLY' using errcode='23514'; end if;
  if exists(select 1 from public.work_order_visits v where v.work_order_id=v_work.id and v.check_out_at is null) then
    raise exception 'CAPITAL_CLOSE_OPEN_VISIT' using errcode='23514'; end if;
  if v_outcome='billed' then
    if exists(select 1 from public.activities a where a.work_order_id=v_work.id and a.deleted_at is null
      and ((a.requires_7eleven_sync and a.synced_to_7eleven_at is null)
        or (a.requires_contractor_attention and a.contractor_attention_acknowledged_at is null))) then
      raise exception 'CAPITAL_CLOSE_PENDING_UPDATES' using errcode='23514'; end if;
    if exists(select 1 from public.invoices i where i.work_order_id=v_work.id and i.deleted_at is null
      and i.invoice_type='contractor' and i.state not in ('approved','paid')) then
      raise exception 'CAPITAL_CLOSE_UNRESOLVED_INVOICES' using errcode='23514'; end if;
  end if;
  if exists(select 1 from public.invoices i where i.work_order_id=v_work.id and i.deleted_at is null
    and i.invoice_type='staff' and i.document_kind='capital_quote'
    and i.id is distinct from v_document and i.state in ('draft','submitted','revised')) then
    raise exception 'CAPITAL_CLOSE_PENDING_REVISION' using errcode='23514'; end if;
  if v_document is not null then
    select * into v_doc from public.invoices where id=v_document for update;
    if not found or v_doc.deleted_at is not null or v_doc.work_order_id is distinct from v_work.id
      or v_doc.invoice_type<>'staff' or v_doc.document_kind not in ('capital_quote','invoice')
      or v_doc.invoice_version is distinct from v_version then
      raise exception 'CAPITAL_CLOSE_STALE' using errcode='PT409'; end if;
    if v_work.workflow_cycle>0 then
      select max(a.created_at) into v_reopened_at from public.activities a where a.work_order_id=v_work.id
        and a.deleted_at is null and a.workflow_cycle=v_work.workflow_cycle and a.event_key='work_order_reopened';
      if v_reopened_at is null or v_doc.created_at is null or v_doc.created_at<v_reopened_at then
        raise exception 'CAPITAL_CLOSE_PRIOR_CYCLE' using errcode='23514'; end if;
    end if;
    if v_doc.document_kind='capital_quote' then
      select exists(select 1 from public.activities a where a.work_order_id=v_work.id and a.deleted_at is null
        and a.workflow_cycle=v_work.workflow_cycle and a.event_key='capital_quote_submitted'
        and a.event_data->>'invoiceId'=v_doc.id::text) into v_submitted;
      if not v_submitted or v_doc.state not in ('approved','paid') then
        if not v_mark or v_doc.state not in ('draft','submitted','approved') then
          raise exception 'CAPITAL_CLOSE_SUBMISSION_REQUIRED' using errcode='23514'; end if;
        if v_doc.state='draft' then
          v_guard:=public.open_invoice_financial_guard(v_actor.id,'compat:mark_staff_invoice_ready',null,
            v_doc.id,v_work.id,true,false,false,false,'staff_invoice_ready');
          perform public.mark_staff_invoice_ready_financial_core(v_doc.id,v_actor.id);
          perform public.close_invoice_financial_guard(v_guard);
        end if;
        v_guard:=public.open_invoice_financial_guard(v_actor.id,'compat:mark_staff_invoice_billed',null,
          v_doc.id,v_work.id,true,false,false,true,'capital_quote_submitted');
        perform public.mark_staff_invoice_billed_financial_core(v_doc.id,v_actor.id);
        perform public.close_invoice_financial_guard(v_guard);
        if not exists(select 1 from public.activities a where a.work_order_id=v_work.id and a.deleted_at is null
          and a.workflow_cycle=v_work.workflow_cycle and a.event_key='capital_quote_submitted'
          and a.event_data->>'invoiceId'=v_doc.id::text) then
          raise exception 'CAPITAL_CLOSE_PRIOR_CYCLE' using errcode='23514'; end if;
      end if;
    elsif v_mark or v_quote_ref<>'' then
      raise exception 'CAPITAL_CLOSE_INVALID_INPUT' using errcode='22023';
    end if;
  else
    if exists(select 1 from public.invoices i where i.work_order_id=v_work.id and i.deleted_at is null
      and i.invoice_type='staff') then
      raise exception 'CAPITAL_CLOSE_REVIEW_DOCUMENTS' using errcode='23514'; end if;
    select h.id into v_external from public.external_capital_quote_handoffs h
      where h.work_order_id=v_work.id and h.workflow_cycle=v_work.workflow_cycle and h.submitted_and_approved;
    if v_external is null then
      if not v_mark or v_quote_ref='' then
        raise exception 'CAPITAL_CLOSE_SUBMISSION_REQUIRED' using errcode='23514'; end if;
      insert into public.external_capital_quote_handoffs(work_order_id,workflow_cycle,operation_id,reference,note,actor_id,submitted_and_approved)
        values(v_work.id,v_work.workflow_cycle,p_operation_id,v_quote_ref,
          'Staff confirmed the external quote was submitted and approved during capital closeout.',v_actor.id,true)
        returning id into v_external;
    end if;
  end if;
  update public.work_orders set status='pending_invoice',functional_status='Completed',capital_status='Installed',
    is_capital=true,billing_ready_at=coalesce(billing_ready_at,v_now),billing_ready_by=coalesce(billing_ready_by,v_actor.id),
    updated_at=v_now where id=v_work.id returning * into v_work;
  if v_outcome='billed' then
    if v_doc.document_kind='invoice' then
      if v_bill_ref is distinct from btrim(v_doc.num)
        or exists(select 1 from public.invoices i where i.work_order_id=v_work.id and i.deleted_at is null
          and i.invoice_type='staff' and i.document_kind='invoice' and i.id<>v_doc.id) then
        raise exception 'CAPITAL_CLOSE_REVIEW_DOCUMENTS' using errcode='23514'; end if;
      insert into public.work_order_close_transition_guards(transaction_id,work_order_id,actor_id,transition_kind)
        values(txid_current(),v_work.id,v_actor.id,'external_billing');
      if v_doc.state='draft' then
        v_guard:=public.open_invoice_financial_guard(v_actor.id,'compat:mark_staff_invoice_ready',null,
          v_doc.id,v_work.id,true,false,false,false,'staff_invoice_ready');
        perform public.mark_staff_invoice_ready_financial_core(v_doc.id,v_actor.id);
        perform public.close_invoice_financial_guard(v_guard);
      end if;
      if v_doc.state<>'paid' then
        v_guard:=public.open_invoice_financial_guard(v_actor.id,'compat:mark_staff_invoice_billed',null,
          v_doc.id,v_work.id,true,false,false,true,'staff_billing');
        perform public.mark_staff_invoice_billed_financial_core(v_doc.id,v_actor.id);
        perform public.close_invoice_financial_guard(v_guard);
      end if;
      if not exists(select 1 from public.activities a where a.work_order_id=v_work.id and a.deleted_at is null
        and a.workflow_cycle=v_work.workflow_cycle and a.event_key='staff_billing'
        and a.event_data->>'action'='billed_to_7_eleven' and a.event_data->>'invoiceId'=v_doc.id::text) then
        raise exception 'CAPITAL_CLOSE_BILLING_REQUIRED' using errcode='23514'; end if;
      update public.work_orders set status='closed',closed_at=coalesce(closed_at,v_now),updated_at=v_now
        where id=v_work.id and status<>'closed';
      delete from public.work_order_close_transition_guards where transaction_id=txid_current()
        and work_order_id=v_work.id and actor_id=v_actor.id;
    else
      perform public.record_work_order_external_billing_v1(v_work.id,v_work.contractor_assignment_version,
        v_work.workflow_cycle,v_work.lifecycle_version,p_operation_id,'7-Eleven / QuickBooks',v_bill_ref,v_billed_on,
        'Capital completed and already billed. Staff confirmed the existing invoice; no additional portal invoice or CSV export.');
    end if;
  end if;
  update public.work_order_lifecycle_transition_guards set event_key='capital_close_out_recorded'
    where transaction_id=txid_current() and work_order_id=v_work.id and operation_id=p_operation_id;
  insert into public.activities(work_order_id,author_id,author_name,text,type,is_staff_override,is_staff_only,
    event_key,event_data,lifecycle_operation_id,lifecycle_version)
  select v_work.id,v_actor.id,v_actor.name,
    case when v_outcome='billed' then 'Capital completed and billed. Existing invoice '||v_bill_ref||', billed '||v_billed_on||'. Moved to History.'
      else 'Capital completed; sent to billing and remains open. No billing or closure recorded.' end,
    'system',true,true,'capital_close_out_recorded',p_payload||jsonb_build_object('action','capital_close_out',
      'operationId',p_operation_id,'externalQuoteId',v_external,'invoiceCreated',false,'csvExported',false),
    p_operation_id,w.lifecycle_version from public.work_orders w where w.id=v_work.id returning id into v_activity;
  v_result:=public.finish_work_order_lifecycle_command(v_work.id,p_operation_id,v_activity,null)
    ||jsonb_build_object('outcome',v_outcome,'documentId',v_document,
      'invoiceVersion',(select invoice_version from public.invoices where id=v_document),
      'invoiceCreated',false,'csvExported',false);
  update public.work_order_lifecycle_operations set result=v_result where operation_id=p_operation_id;
  return v_result;
end; $$;

revoke all on function public.close_out_capital_v1(text,integer,integer,bigint,uuid,jsonb)
  from public,anon,authenticated,service_role;
grant execute on function public.close_out_capital_v1(text,integer,integer,bigint,uuid,jsonb) to authenticated;
notify pgrst,'reload schema';
commit;
