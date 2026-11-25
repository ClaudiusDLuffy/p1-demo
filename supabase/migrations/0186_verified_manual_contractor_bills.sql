-- Verified staff intake for earlier contractor work on manually entered WOs.
-- This is invoice provenance, NOT fabricated portal assignment history.
begin;

alter table public.invoices
  add column manual_contractor_bill boolean not null default false,
  add column manual_contractor_bill_note text;
alter table public.invoices add constraint invoice_manual_contractor_bill_shape check (
  (not manual_contractor_bill and manual_contractor_bill_note is null)
  or (manual_contractor_bill and invoice_type='contractor' and document_kind='invoice'
    and prior_assignment_id is null and prior_assignment_note is null
    and contractor_id is not null and manual_contractor_bill_note is not null
    and length(btrim(manual_contractor_bill_note)) between 5 and 1000
    and manual_contractor_bill_note ~ '[^[:space:]]')
);
comment on column public.invoices.manual_contractor_bill is
  'Staff-verified earlier-work bill without a recorded prior assignment. Staff-only; never current field work.';
create policy manual_contractor_bill_staff_only on public.invoices as restrictive for select to authenticated
  using (not manual_contractor_bill or public.is_staff());

create or replace function public.guard_prior_contractor_invoice()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare h public.work_order_assignment_history%rowtype;
begin
  if tg_op='UPDATE' and (new.prior_assignment_id is distinct from old.prior_assignment_id
    or new.manual_contractor_bill is distinct from old.manual_contractor_bill
    or ((old.prior_assignment_id is not null or old.manual_contractor_bill) and (
      new.contractor_id is distinct from old.contractor_id
      or new.work_order_id is distinct from old.work_order_id
      or new.created_by is distinct from old.created_by
      or new.invoice_type is distinct from old.invoice_type
      or new.document_kind is distinct from old.document_kind))) then
    raise exception 'Staff intake identity is immutable' using errcode='42501'; end if;
  if new.prior_assignment_id is null and not new.manual_contractor_bill then return new; end if;
  if new.prior_assignment_id is not null then
    select * into h from public.work_order_assignment_history where id=new.prior_assignment_id;
    if not found or h.work_order_id is distinct from new.work_order_id or h.contractor_id is distinct from new.contractor_id then
      raise exception 'Invoice must match its recorded prior assignment' using errcode='23514'; end if;
  end if;
  if public.invoice_financial_is_owner_maintenance() then return new; end if;
  if auth.uid() is not null and not public.is_staff() then
    raise exception 'Staff intake invoices require operational staff' using errcode='42501'; end if;
  if (tg_op='INSERT' or (tg_op='UPDATE' and new.manual_contractor_bill_note is distinct from old.manual_contractor_bill_note))
    and not exists(select 1 from public.invoice_financial_transition_guards g
      where g.transaction_id=txid_current() and g.invoice_id=new.id and g.work_order_id=new.work_order_id
        and g.actor_id=auth.uid() and g.command_kind='prior_draft' and g.header_allowed) then
    raise exception 'Use the guarded staff invoice intake command' using errcode='42501'; end if;
  return new;
end;
$$;

-- Extend exactly the established historical-invoice exceptions. Function
-- definitions retain their volatility, search_path, security and ACLs.
do $staff_intake$
declare signature text; original text; definition text; qualifier text;
begin
  foreach signature in array array[
    'public.guard_invoice_active_work_order()',
    'public.reset_contractor_invoicing_on_invoice_change()',
    'public.protect_contractor_invoice_review_lifecycle()',
    'public.prevent_invoice_on_closed_work_order()',
    'public.contractor_invoice_work_order_status(text)',
    'public.contractor_invoicing_is_complete(text)',
    'public.finish_contractor_invoicing_financial_core(text)',
    'public.transition_work_order_contractor_assignment_core(text,uuid,integer)',
    'public.private_object_assert_target(public.private_object_uploads,boolean)',
    'public.private_object_binding_access(uuid,uuid)',
    'public.submit_prior_contractor_invoice_v1(uuid,bigint,integer,integer,uuid)',
    'public.review_prior_contractor_invoice_core(uuid,text,text,boolean)',
    'public.review_contractor_invoice_financial_core(uuid,text,text)',
    'public.retract_contractor_invoice_rejection_financial_core(uuid)'
  ] loop
    select replace(pg_get_functiondef(signature::regprocedure),chr(13),'') into strict original;
    definition:=original;
    foreach qualifier in array array['new','i'] loop
      definition:=replace(definition,qualifier||'.prior_assignment_id is not null',
        '('||qualifier||'.prior_assignment_id is not null or '||qualifier||'.manual_contractor_bill)');
    end loop;
    definition:=replace(definition,'invoice.prior_assignment_id is null',
      '(invoice.prior_assignment_id is null and not invoice.manual_contractor_bill)');
    definition:=replace(definition,'and prior_assignment_id is not null',
      'and (prior_assignment_id is not null or manual_contractor_bill)');
    if signature='public.review_prior_contractor_invoice_core(uuid,text,text,boolean)' then
      if position(E'or not exists(select 1 from public.work_order_assignment_history h\n    where h.id=i.prior_assignment_id and h.work_order_id=w.id and h.contractor_id=i.contractor_id) then' in definition)=0 then
        raise exception 'Historical review identity anchor drifted'; end if;
      definition:=replace(definition,
        E'or not exists(select 1 from public.work_order_assignment_history h\n    where h.id=i.prior_assignment_id and h.work_order_id=w.id and h.contractor_id=i.contractor_id) then',
        E'or (not i.manual_contractor_bill and not exists(select 1 from public.work_order_assignment_history h\n    where h.id=i.prior_assignment_id and h.work_order_id=w.id and h.contractor_id=i.contractor_id)) then');
    end if;
    if signature='public.submit_prior_contractor_invoice_v1(uuid,bigint,integer,integer,uuid)' then
      definition:=replace(definition,'''assignmentId'',i.prior_assignment_id,',
        '''assignmentId'',i.prior_assignment_id,''manualContractorId'',case when i.manual_contractor_bill then i.contractor_id else null end,');
    end if;
    if definition=original then raise exception 'Historical intake anchor drifted: %',signature; end if;
    execute definition;
  end loop;
end;
$staff_intake$;

create or replace function public.get_prior_contractor_invoice_context_v1(p_work_order_id text)
returns jsonb language plpgsql stable security definer set search_path=public,pg_temp as $$
declare a public.profiles%rowtype; w public.work_orders%rowtype; assignments jsonb; drafts jsonb;
begin
  a:=public.require_work_order_assignment_actor();
  select * into w from public.work_orders where id=p_work_order_id and deleted_at is null;
  if not found then raise exception 'Work order not found' using errcode='P0002'; end if;
  select coalesce(jsonb_agg(item order by ended desc,id),'[]'::jsonb) into assignments from (
    select h.id,h.assignment_ended_at ended,jsonb_build_object('id',h.id,'contractorId',h.contractor_id,
      'contractorName',p.name,'assignmentVersion',h.assignment_version,'startedAt',h.assignment_started_at,
      'endedAt',h.assignment_ended_at) item
    from public.work_order_assignment_history h join public.profiles p on p.id=h.contractor_id
    where h.work_order_id=w.id and h.assignment_version<w.contractor_assignment_version
    order by h.assignment_ended_at desc,h.id limit 100
  ) rows;
  select coalesce(jsonb_agg(item order by created desc,id),'[]'::jsonb) into drafts from (
    select i.id,i.created_at created,jsonb_build_object('id',i.id,'assignmentId',i.prior_assignment_id,
      'manualContractorId',case when i.manual_contractor_bill then i.contractor_id else null end,
      'contractorName',p.name,'num',i.num,'invoiceDate',i.invoice_date,'total',i.total,'salesTax',i.sales_tax,
      'note',coalesce(i.manual_contractor_bill_note,i.prior_assignment_note),'state',i.state,
      'invoiceVersion',i.invoice_version,'hasPdf',i.pdf_storage_path is not null) item
    from public.invoices i left join public.profiles p on p.id=i.contractor_id
    where i.work_order_id=w.id and (i.prior_assignment_id is not null or i.manual_contractor_bill)
      and i.deleted_at is null and i.state in ('draft','rejected')
    order by i.created_at desc,i.id limit 100
  ) rows;
  return jsonb_build_object('workOrderId',w.id,'assignmentVersion',w.contractor_assignment_version,
    'workflowCycle',w.workflow_cycle,'assignments',assignments,'drafts',drafts,
    'manualIntake',jsonb_build_object('eligible',coalesce(w.source='manual',false) and jsonb_array_length(assignments)=0,
      'currentContractorId',w.contractor_id));
end;
$$;

create function public.save_verified_manual_contractor_invoice_v1(
  p_work_order_id text,p_expected_assignment_version integer,p_expected_workflow_cycle integer,
  p_contractor_id uuid,p_invoice_id uuid,p_expected_invoice_version bigint,p_operation_id uuid,p_payload jsonb
)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare a public.profiles%rowtype; w public.work_orders%rowtype; i public.invoices%rowtype;
  payload jsonb; replay jsonb; guard_id bigint; invoice_id uuid; event_id uuid;
  amount numeric; tax numeric; v_invoice_date date; v_number text; note text;
begin
  a:=public.require_work_order_assignment_actor();
  if p_operation_id is null or p_contractor_id is null or p_expected_assignment_version is null
    or p_expected_workflow_cycle is null or p_expected_assignment_version<0 or p_expected_workflow_cycle<0
    or ((p_invoice_id is null)<>(p_expected_invoice_version is null))
    or p_payload is null or jsonb_typeof(p_payload)<>'object'
    or (p_payload-array['num','invoiceDate','total','salesTax','note','verified'])<>'{}'::jsonb
    or not(p_payload ?& array['num','invoiceDate','total','salesTax','note','verified'])
    or jsonb_typeof(p_payload->'num')<>'string' or jsonb_typeof(p_payload->'invoiceDate')<>'string'
    or jsonb_typeof(p_payload->'note')<>'string' or jsonb_typeof(p_payload->'total')<>'number'
    or jsonb_typeof(p_payload->'salesTax')<>'number' or p_payload->'verified' is distinct from 'true'::jsonb then
    raise exception 'Verified manual invoice fields are required' using errcode='22023'; end if;
  v_number:=btrim(p_payload->>'num'); note:=btrim(p_payload->>'note');
  amount:=(p_payload->>'total')::numeric; tax:=(p_payload->>'salesTax')::numeric;
  if (p_payload->>'invoiceDate')!~'^\d{4}-\d{2}-\d{2}$' then
    raise exception 'Invalid invoice date' using errcode='22023'; end if;
  v_invoice_date:=(p_payload->>'invoiceDate')::date;
  if length(v_number) not between 1 and 100 or v_number ~ '[[:cntrl:]]'
    or length(note) not between 5 and 1000 or note !~ '[^[:space:]]'
    or amount<=0 or amount>99999999.99 or round(amount,2)<>amount
    or tax<0 or tax>amount or round(tax,2)<>tax
    or v_invoice_date>(clock_timestamp() at time zone 'America/New_York')::date then
    raise exception 'Invalid manual invoice identity, date, amount, tax or verification note' using errcode='22023'; end if;
  select * into w from public.work_orders where id=p_work_order_id and deleted_at is null for update;
  if not found then raise exception 'Work order not found' using errcode='P0002'; end if;
  a:=public.require_work_order_assignment_actor();
  payload:=jsonb_build_object('intakeSource','staff_verified_manual','contractorId',p_contractor_id,
    'num',v_number,'invoiceDate',v_invoice_date,'total',amount,'salesTax',tax,'note',note,'verified',true);
  replay:=public.begin_invoice_financial_operation(p_operation_id,a.id,'prior_draft',p_invoice_id,'contractor',w.id,
    p_expected_assignment_version,p_expected_workflow_cycle,p_expected_invoice_version,payload);
  if replay is not null then return replay; end if;
  if w.contractor_assignment_version<>p_expected_assignment_version or w.workflow_cycle<>p_expected_workflow_cycle then
    raise exception 'Work order changed; reopen the form' using errcode='PT409'; end if;
  invoice_id:=coalesce(p_invoice_id,gen_random_uuid());
  if p_invoice_id is null then
    if w.source is distinct from 'manual' or p_contractor_id is not distinct from w.contractor_id
      or exists(select 1 from public.work_order_assignment_history h where h.work_order_id=w.id
        and h.assignment_version<w.contractor_assignment_version) then
      raise exception 'Use the current contractor or recorded past-assignment workflow' using errcode='22023'; end if;
    perform public.require_assignable_contractor(p_contractor_id);
  else
    select * into i from public.invoices where id=p_invoice_id and deleted_at is null for update;
    if not found or not i.manual_contractor_bill or i.contractor_id is distinct from p_contractor_id
      or i.work_order_id is distinct from w.id or i.invoice_version is distinct from p_expected_invoice_version
      or i.state not in ('draft','rejected') or i.qbo_synced_at is not null or i.qbo_invoice_id is not null then
      raise exception 'Manual invoice changed; reopen the form' using errcode='PT409'; end if;
    if exists(select 1 from public.staff_invoice_sources s join public.invoices b on b.id=s.staff_invoice_id
      where s.contractor_invoice_id=i.id and b.deleted_at is null) then
      raise exception 'Invoice is already used in P1 billing' using errcode='PT409'; end if;
  end if;
  guard_id:=public.open_invoice_financial_guard(a.id,'prior_draft',p_operation_id,invoice_id,w.id,
    true,false,false,false,'prior_contractor_invoice_saved');
  if p_invoice_id is null then
    insert into public.invoices(id,work_order_id,store_number,contractor_id,created_by,invoice_type,document_kind,
      num,invoice_date,state,subtotal,sales_tax,total,manual_contractor_bill,manual_contractor_bill_note)
    values(invoice_id,w.id,w.store_number,p_contractor_id,a.id,'contractor','invoice',
      v_number,v_invoice_date,'draft',amount-tax,tax,amount,true,note) returning * into i;
  else
    update public.invoices set num=v_number,invoice_date=v_invoice_date,subtotal=amount-tax,sales_tax=tax,
      total=amount,manual_contractor_bill_note=note,updated_at=clock_timestamp(),invoice_version=invoices.invoice_version+1
      where id=invoice_id returning * into i;
  end if;
  insert into public.activities(work_order_id,author_id,author_name,text,type,event_key,event_data,is_staff_only,activity_channel)
  values(w.id,a.id,a.name,format('Staff-verified manual contractor invoice #%s recorded; no prior portal assignment claimed. Current work unchanged.',i.num),
    'system','prior_contractor_invoice_saved',jsonb_build_object('invoiceId',i.id,'contractorId',i.contractor_id,
      'intakeSource','staff_verified_manual','verified',true,'note',note,'operationId',p_operation_id),true,'internal_note')
    returning id into event_id;
  return public.finish_invoice_financial_operation(p_operation_id,i.id,jsonb_build_object('invoiceId',i.id,'invoiceNum',i.num,
    'workOrderId',w.id,'assignmentId',null,'manualContractorId',i.contractor_id,
    'assignmentVersion',w.contractor_assignment_version,'workflowCycle',w.workflow_cycle,
    'invoiceVersion',i.invoice_version,'state',i.state,'total',i.total),event_id);
end;
$$;

-- Compact lists carry only the marker. The verification note is exact-header
-- and staff-context data, not an unbounded addition to every list row.
do $projection$
declare definition text; needle text; signature text;
begin
  signature:='p1_invoice_reads.list_projection_v1(jsonb)';
  select pg_get_functiondef(signature::regprocedure) into definition;
  needle:='''prior_assignment_id''';
  if position(needle in definition)=0 then raise exception 'Invoice list projection drifted'; end if;
  execute replace(definition,needle,needle||',''manual_contractor_bill''');
  signature:='p1_invoice_reads.contractor_rows_v2(text,text,text,text,integer,text,text)';
  select pg_get_functiondef(signature::regprocedure) into definition;
  needle:='invoice.prior_assignment_id,';
  if position(needle in definition)=0 then raise exception 'Contractor list projection drifted'; end if;
  execute replace(definition,needle,needle||'invoice.manual_contractor_bill,');
  signature:='public.get_invoice_summary_v1(uuid)';
  select pg_get_functiondef(signature::regprocedure) into definition;
  needle:='''prior_assignment_note'',v_invoice.prior_assignment_note,';
  if position(needle in definition)=0 then raise exception 'Invoice exact projection drifted'; end if;
  execute replace(definition,needle,needle||'''manual_contractor_bill'',v_invoice.manual_contractor_bill,''manual_contractor_bill_note'',v_invoice.manual_contractor_bill_note,');
end;
$projection$;

revoke all on function public.save_verified_manual_contractor_invoice_v1(text,integer,integer,uuid,uuid,bigint,uuid,jsonb)
  from public,anon,authenticated,service_role;
grant execute on function public.save_verified_manual_contractor_invoice_v1(text,integer,integer,uuid,uuid,bigint,uuid,jsonb)
  to authenticated;
notify pgrst,'reload schema';
commit;
