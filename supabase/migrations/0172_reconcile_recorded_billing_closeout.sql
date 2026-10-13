-- Reconcile a finished, billed legacy regular WO whose terminal status drifted.
-- No bulk repair, new invoice, payment, billing handoff, export or reassignment.
begin;

alter table public.work_order_lifecycle_operations
  drop constraint work_order_lifecycle_operations_command_kind_check;
alter table public.work_order_lifecycle_operations
  add constraint work_order_lifecycle_operations_command_kind_check
  check (command_kind in ('eta','start','resume','pause','complete','capital_external_handoff',
    'capital_confirmed_completion','capital_quote_revision','capital_close_out','reconcile_recorded_billing'));
alter table public.work_order_close_transition_guards
  drop constraint work_order_close_transition_guards_transition_kind_check;
alter table public.work_order_close_transition_guards
  add constraint work_order_close_transition_guards_transition_kind_check
  check (transition_kind in ('without_invoice','reopened_without_additional_billing',
    'external_billing','linked_billing','recorded_billing'));

create function public.recorded_billing_closeout_evidence(p_work_order_id text)
returns jsonb language plpgsql stable security definer set search_path=public,pg_temp as $$
declare v_work public.work_orders%rowtype; v_invoice public.invoices%rowtype; v_bill public.activities%rowtype;
begin
  perform public.require_external_billing_actor();
  if p_work_order_id is null or length(p_work_order_id) not between 1 and 128 then
    raise exception 'RECORDED_BILLING_INVALID_INPUT' using errcode='22023'; end if;
  select * into v_work from public.work_orders where id=p_work_order_id and deleted_at is null;
  if not found then raise exception 'RECORDED_BILLING_NOT_FOUND' using errcode='P0002'; end if;
  if v_work.is_capital or v_work.billing_only or v_work.workflow_cycle<>0
    or v_work.status::text not in ('completed','pending_invoice','pending_payment')
    or v_work.functional_status::text is distinct from 'Completed' then
    raise exception 'RECORDED_BILLING_NOT_ELIGIBLE' using errcode='23514'; end if;
  if exists(select 1 from public.activities where work_order_id=v_work.id and deleted_at is null
    and event_key='work_order_reopened') then
    raise exception 'RECORDED_BILLING_REOPENED' using errcode='23514'; end if;
  if exists(select 1 from public.work_order_visits where work_order_id=v_work.id and check_out_at is null) then
    raise exception 'RECORDED_BILLING_OPEN_VISIT' using errcode='23514'; end if;
  if exists(select 1 from public.activities where work_order_id=v_work.id and deleted_at is null
    and ((requires_7eleven_sync and synced_to_7eleven_at is null)
      or (requires_contractor_attention and contractor_attention_acknowledged_at is null))) then
    raise exception 'RECORDED_BILLING_PENDING_UPDATES' using errcode='23514'; end if;
  if exists(select 1 from public.invoices where work_order_id=v_work.id and deleted_at is null
    and invoice_type='contractor' and state not in ('approved','paid')) then
    raise exception 'RECORDED_BILLING_UNRESOLVED_INVOICES' using errcode='23514'; end if;
  if (select count(*) from public.invoices where work_order_id=v_work.id and deleted_at is null
      and invoice_type='staff')<>1 then
    raise exception 'RECORDED_BILLING_DOCUMENT_CONFLICT' using errcode='23514'; end if;
  select * into v_invoice from public.invoices where work_order_id=v_work.id and deleted_at is null
    and invoice_type='staff' and document_kind='invoice' and state in ('approved','paid');
  if not found then raise exception 'RECORDED_BILLING_NO_EVIDENCE' using errcode='23514'; end if;
  select * into v_bill from public.activities where work_order_id=v_work.id and deleted_at is null
    and event_key='staff_billing' and event_data->>'action'='billed_to_7_eleven'
    and event_data->>'invoiceId'=v_invoice.id::text
    and workflow_cycle=v_work.workflow_cycle and contractor_assignment_version=v_work.contractor_assignment_version
    and created_at>=v_invoice.created_at order by created_at desc,id desc limit 1;
  if not found then raise exception 'RECORDED_BILLING_NO_EVIDENCE' using errcode='23514'; end if;
  if exists(select 1 from public.work_order_visits where work_order_id=v_work.id
      and (check_in_at>v_bill.created_at or check_out_at>v_bill.created_at))
    or exists(select 1 from public.invoices where work_order_id=v_work.id and deleted_at is null
      and invoice_type='contractor' and created_at>v_bill.created_at) then
    raise exception 'RECORDED_BILLING_LATER_WORK' using errcode='23514'; end if;
  if exists(select 1 from public.work_order_external_billings where work_order_id=v_work.id)
    or exists(select 1 from public.work_order_billing_links where work_order_id=v_work.id) then
    raise exception 'RECORDED_BILLING_DOCUMENT_CONFLICT' using errcode='23514'; end if;
  return jsonb_build_object('workOrderId',v_work.id,'assignmentVersion',v_work.contractor_assignment_version,
    'workflowCycle',v_work.workflow_cycle,'lifecycleVersion',v_work.lifecycle_version,
    'invoiceId',v_invoice.id,'invoiceVersion',v_invoice.invoice_version,'invoiceNumber',v_invoice.num,
    'billingActivityId',v_bill.id,'billedAt',v_bill.created_at);
end; $$;

create function public.get_recorded_billing_closeout_v1(p_work_order_id text)
returns jsonb language plpgsql stable security definer set search_path=public,pg_temp as $$
begin
  return public.recorded_billing_closeout_evidence(p_work_order_id);
exception when check_violation then return null;
end; $$;

create function public.protect_recorded_billing_closeout_activity()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if tg_op='INSERT' then
    if new.event_key is distinct from 'work_order_billing_closeout_reconciled' then return new; end if;
  elsif tg_op='UPDATE' then
    if old.event_key is distinct from 'work_order_billing_closeout_reconciled'
      and new.event_key is distinct from 'work_order_billing_closeout_reconciled' then return new; end if;
  elsif old.event_key is distinct from 'work_order_billing_closeout_reconciled' then return old;
  end if;
  if tg_op<>'INSERT' then raise exception 'Recorded billing reconciliation is immutable' using errcode='42501'; end if;
  if new.author_id is distinct from auth.uid() or new.lifecycle_operation_id is null
    or not new.is_staff_only or new.requires_7eleven_sync or new.requires_contractor_attention
    or not exists(select 1 from public.work_order_lifecycle_transition_guards l
      join public.work_order_close_transition_guards c
        on c.transaction_id=l.transaction_id and c.work_order_id=l.work_order_id and c.actor_id=l.actor_id
      where l.transaction_id=txid_current() and l.work_order_id=new.work_order_id and l.actor_id=auth.uid()
        and l.operation_id=new.lifecycle_operation_id and l.command_kind='reconcile_recorded_billing'
        and c.transition_kind='recorded_billing') then
    raise exception 'Recorded billing reconciliation requires its owning command' using errcode='42501'; end if;
  return new;
end; $$;
create trigger zz_protect_recorded_billing_closeout_activity before insert or update or delete on public.activities
  for each row execute function public.protect_recorded_billing_closeout_activity();

create function public.reconcile_recorded_billing_closeout_v1(
  p_work_order_id text,p_expected_assignment_version integer,p_expected_workflow_cycle integer,
  p_expected_lifecycle_version bigint,p_operation_id uuid,p_invoice_id uuid,
  p_expected_invoice_version bigint,p_billing_activity_id uuid,p_confirmed boolean
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_actor public.profiles%rowtype; v_work public.work_orders%rowtype; v_invoice public.invoices%rowtype;
  v_evidence jsonb; v_replay jsonb; v_payload jsonb; v_result jsonb; v_activity uuid; v_now timestamptz:=clock_timestamp();
begin
  v_actor:=public.require_external_billing_actor();
  if p_confirmed is distinct from true or p_invoice_id is null or p_billing_activity_id is null
    or p_expected_invoice_version is null or p_expected_invoice_version<0 then
    raise exception 'RECORDED_BILLING_INVALID_INPUT' using errcode='22023'; end if;
  v_payload:=jsonb_build_object('invoiceId',p_invoice_id,'invoiceVersion',p_expected_invoice_version,
    'billingActivityId',p_billing_activity_id,'confirmed',p_confirmed);
  v_replay:=public.begin_work_order_lifecycle_command(p_work_order_id,p_expected_assignment_version,
    p_expected_workflow_cycle,p_expected_lifecycle_version,p_operation_id,'reconcile_recorded_billing',v_payload);
  v_actor:=public.require_external_billing_actor();
  select * into v_invoice from public.invoices where id=p_invoice_id and work_order_id=p_work_order_id
    and invoice_type='staff' and document_kind='invoice' and deleted_at is null for update;
  if not found or v_invoice.invoice_version is distinct from p_expected_invoice_version
    or v_invoice.state not in ('approved','paid') then
    raise exception 'RECORDED_BILLING_STALE' using errcode='PT409'; end if;
  if v_replay is not null then
    if not exists(select 1 from public.work_orders where id=p_work_order_id and status='closed'
        and closed_at=(v_replay->>'closedAt')::timestamptz)
      or not exists(select 1 from public.activities where id=p_billing_activity_id and work_order_id=p_work_order_id
        and deleted_at is null and event_key='staff_billing' and event_data->>'action'='billed_to_7_eleven'
        and event_data->>'invoiceId'=p_invoice_id::text
        and created_at=(v_replay->>'billedAt')::timestamptz) then
      raise exception 'RECORDED_BILLING_STALE' using errcode='PT409'; end if;
    return v_replay;
  end if;
  v_evidence:=public.recorded_billing_closeout_evidence(p_work_order_id);
  if v_evidence->>'invoiceId' is distinct from p_invoice_id::text
    or v_evidence->>'billingActivityId' is distinct from p_billing_activity_id::text then
    raise exception 'RECORDED_BILLING_STALE' using errcode='PT409'; end if;
  update public.work_order_lifecycle_transition_guards set event_key='work_order_billing_closeout_reconciled',visit_allowed=false
    where transaction_id=txid_current() and work_order_id=p_work_order_id and operation_id=p_operation_id;
  insert into public.work_order_close_transition_guards(transaction_id,work_order_id,actor_id,transition_kind)
    values(txid_current(),p_work_order_id,v_actor.id,'recorded_billing');
  update public.work_orders set status='closed',closed_at=v_now,updated_at=v_now
    where id=p_work_order_id returning * into v_work;
  insert into public.activities(work_order_id,author_id,author_name,text,type,is_staff_only,
    requires_7eleven_sync,requires_contractor_attention,event_key,event_data,lifecycle_operation_id,lifecycle_version)
  values(p_work_order_id,v_actor.id,v_actor.name,
    format('Closed already billed work order using existing P1 invoice #%s. Staff confirmed finished work and no additional billing. Original invoice and billing handoff remain unchanged.',v_invoice.num),
    'system',true,false,false,'work_order_billing_closeout_reconciled',
    v_evidence||jsonb_build_object('operationId',p_operation_id,'invoiceCreated',false,'billingRecorded',false,
      'paymentRecorded',false,'csvExported',false),p_operation_id,v_work.lifecycle_version)
    returning id into v_activity;
  v_result:=public.finish_work_order_lifecycle_command(p_work_order_id,p_operation_id,v_activity,null)
    ||v_evidence||jsonb_build_object('lifecycleVersion',v_work.lifecycle_version,'closedAt',v_work.closed_at,
      'invoiceCreated',false,'billingRecorded',false,'paymentRecorded',false,'csvExported',false);
  update public.work_order_lifecycle_operations set result=v_result where operation_id=p_operation_id;
  delete from public.work_order_close_transition_guards where transaction_id=txid_current()
    and work_order_id=p_work_order_id and actor_id=v_actor.id and transition_kind='recorded_billing';
  return v_result;
end; $$;

revoke all on function public.recorded_billing_closeout_evidence(text),public.protect_recorded_billing_closeout_activity()
  from public,anon,authenticated,service_role;
revoke all on function public.get_recorded_billing_closeout_v1(text),
  public.reconcile_recorded_billing_closeout_v1(text,integer,integer,bigint,uuid,uuid,bigint,uuid,boolean)
  from public,anon,authenticated,service_role;
grant execute on function public.get_recorded_billing_closeout_v1(text),
  public.reconcile_recorded_billing_closeout_v1(text,integer,integer,bigint,uuid,uuid,bigint,uuid,boolean)
  to authenticated;
notify pgrst,'reload schema';
commit;
