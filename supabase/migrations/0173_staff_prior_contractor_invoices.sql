-- Staff intake for a real bill received after a contractor assignment ended.
-- No reassignment, customer invoice, payment, export, or WO status transition.
begin;

alter table public.invoices
  add column prior_assignment_id uuid references public.work_order_assignment_history(id) on delete restrict,
  add column prior_assignment_note text;
alter table public.invoices add constraint invoice_prior_assignment_shape check (
  (prior_assignment_id is null and prior_assignment_note is null)
  or (prior_assignment_id is not null and invoice_type='contractor'
    and length(btrim(prior_assignment_note)) between 5 and 1000));
create index invoices_prior_assignment on public.invoices(prior_assignment_id) where prior_assignment_id is not null;

-- Add only the historical identity to the bounded list projection. The note
-- belongs to the authorized exact header, not every list row.
do $projection$
declare body text; args text; needle text;
begin
  select prosrc into body from pg_proc where oid='p1_invoice_reads.list_projection_v1(jsonb)'::regprocedure;
  needle:='''created_at'',''updated_at''';
  if position(needle in body)=0 then raise exception 'Invoice projection drifted'; end if;
  body:=replace(body,needle,needle||',''prior_assignment_id''');
  execute 'create or replace function p1_invoice_reads.list_projection_v1(p_row jsonb) returns jsonb language sql immutable security invoker set search_path=pg_catalog,public as '||quote_literal(body);
  select prosrc,pg_get_function_arguments(oid) into body,args from pg_proc where oid='p1_invoice_reads.contractor_rows_v2(text,text,text,text,integer,text,text)'::regprocedure;
  needle:='invoice.review_revision,invoice.invoice_version,';
  if position(needle in body)=0 then raise exception 'Invoice compact list drifted'; end if;
  body:=replace(body,needle,needle||'invoice.prior_assignment_id,');
  execute 'create or replace function p1_invoice_reads.contractor_rows_v2('||args||') returns jsonb language sql stable security invoker set search_path=pg_catalog,public as '||quote_literal(body);
  select prosrc into body from pg_proc where oid='public.get_invoice_summary_v1(uuid)'::regprocedure;
  needle:='''invoice_version'',v_invoice.invoice_version,';
  if position(needle in body)=0 then raise exception 'Invoice summary drifted'; end if;
  body:=replace(body,needle,needle||'''prior_assignment_id'',v_invoice.prior_assignment_id,''prior_assignment_note'',v_invoice.prior_assignment_note,');
  execute 'create or replace function public.get_invoice_summary_v1(p_invoice_id uuid) returns jsonb language plpgsql stable security invoker set search_path=pg_catalog,public as '||quote_literal(body);
end;
$projection$;

-- Defense in depth even if the same company is assigned again later.
create policy prior_invoice_staff_only on public.invoices as restrictive for select to authenticated
  using (prior_assignment_id is null or public.is_staff());

alter table public.invoice_financial_operations drop constraint invoice_financial_operations_command_kind_check;
alter table public.invoice_financial_operations add constraint invoice_financial_operations_command_kind_check
  check(command_kind in ('contractor_draft','contractor_submit','contractor_revise','contractor_delete',
    'staff_save','admin_delete','prior_draft','prior_submit'));

create function public.guard_prior_contractor_invoice()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare h public.work_order_assignment_history%rowtype;
begin
  if tg_op='UPDATE' and (new.prior_assignment_id is distinct from old.prior_assignment_id
    or (old.prior_assignment_id is not null and (new.contractor_id is distinct from old.contractor_id
      or new.work_order_id is distinct from old.work_order_id or new.created_by is distinct from old.created_by
      or new.invoice_type is distinct from old.invoice_type))) then
    raise exception 'Prior assignment identity is immutable' using errcode='42501'; end if;
  if new.prior_assignment_id is null then return new; end if;
  select * into h from public.work_order_assignment_history where id=new.prior_assignment_id;
  if not found or h.work_order_id is distinct from new.work_order_id or h.contractor_id is distinct from new.contractor_id then
    raise exception 'Invoice must match its recorded prior assignment' using errcode='23514'; end if;
  if public.invoice_financial_is_owner_maintenance() then return new; end if;
  if auth.uid() is not null and not public.is_staff() then
    raise exception 'Prior assignment invoices are staff-only' using errcode='42501'; end if;
  if tg_op='INSERT' and not exists(select 1 from public.invoice_financial_transition_guards g
    where g.transaction_id=txid_current() and g.invoice_id=new.id and g.work_order_id=new.work_order_id
      and g.actor_id=auth.uid() and g.command_kind='prior_draft' and g.header_allowed) then
    raise exception 'Use the staff prior-invoice command' using errcode='42501'; end if;
  return new;
end;
$$;
create trigger a_guard_prior_contractor_invoice before insert or update on public.invoices
  for each row execute function public.guard_prior_contractor_invoice();

create function public.protect_prior_invoice_activity()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare v_event_key text; v_previous_key text;
begin
  v_event_key:=case when tg_op='DELETE' then old.event_key else new.event_key end;
  v_previous_key:=case when tg_op='INSERT' then null else old.event_key end;
  if coalesce(v_event_key,'') not in ('prior_contractor_invoice_saved','prior_contractor_invoice_submitted')
    and coalesce(v_previous_key,'') not in ('prior_contractor_invoice_saved','prior_contractor_invoice_submitted') then
    if tg_op='DELETE' then return old; else return new; end if;
  end if;
  if public.invoice_financial_is_owner_maintenance() then
    if tg_op='DELETE' then return old; else return new; end if;
  end if;
  if tg_op<>'INSERT' then raise exception 'Prior invoice evidence is immutable' using errcode='42501'; end if;
  if not new.is_staff_only or not exists(select 1 from public.invoice_financial_transition_guards g
    where g.transaction_id=txid_current() and g.work_order_id=new.work_order_id
      and g.invoice_id=nullif(new.event_data->>'invoiceId','')::uuid and g.actor_id=auth.uid()
      and g.actor_id=new.author_id and g.event_key=v_event_key and g.operation_id=nullif(new.event_data->>'operationId','')::uuid) then
    raise exception 'Use the authoritative prior invoice command' using errcode='42501'; end if;
  return new;
end;
$$;
create trigger protect_prior_invoice_activity_trigger before insert or update or delete on public.activities
  for each row execute function public.protect_prior_invoice_activity();

-- Preserve the existing current-assignment guard. Only this authenticated,
-- guarded historical intake gets an exception; caller-set metadata is not authority.
do $patch$
declare body text; needle text;
begin
  select prosrc into body from pg_proc where oid='public.guard_invoice_active_work_order()'::regprocedure;
  needle:='  if new.invoice_type = ''contractor''';
  if position(needle in body)=0 then raise exception 'Invoice parent guard drifted'; end if;
  body:=replace(body,needle,E'  if new.prior_assignment_id is not null then\n    return new;\n  end if;\n\n'||needle);
  execute 'create or replace function public.guard_invoice_active_work_order() returns trigger language plpgsql security definer set search_path=public,pg_temp as '||quote_literal(body);
  select prosrc into body from pg_proc where oid='public.reset_contractor_invoicing_on_invoice_change()'::regprocedure;
  needle:='  if new.invoice_type <> ''contractor''';
  if position(needle in body)=0 then raise exception 'Invoice completion guard drifted'; end if;
  body:=replace(body,needle,E'  if new.prior_assignment_id is not null then return new; end if;\n'||needle);
  execute 'create or replace function public.reset_contractor_invoicing_on_invoice_change() returns trigger language plpgsql security definer set search_path=public,pg_temp as '||quote_literal(body);
  select prosrc into body from pg_proc where oid='public.protect_contractor_invoice_review_lifecycle()'::regprocedure;
  needle:='  if old.invoice_type <> ''contractor'' then';
  if position(needle in body)=0 then raise exception 'Invoice review guard drifted'; end if;
  body:=replace(body,needle,$branch$
  if new.prior_assignment_id is not null and actor_is_staff and not public.is_invoice_controller()
    and old.state='rejected' and new.state='revised' and transition_kind='resubmit'
    and exists(select 1 from public.invoice_financial_transition_guards g where g.transaction_id=txid_current()
      and g.invoice_id=new.id and g.actor_id=auth.uid() and g.command_kind='prior_submit' and g.header_allowed)
    and new.review_revision=old.review_revision+1 then return new; end if;
$branch$||needle);
  execute 'create or replace function public.protect_contractor_invoice_review_lifecycle() returns trigger language plpgsql security definer set search_path=public,pg_temp as '||quote_literal(body);
  -- Security-definer operational aggregates must never count these bills as
  -- the receiving/returning contractor's current work.
  select prosrc into body from pg_proc where oid='public.contractor_invoice_work_order_status(text)'::regprocedure;
  needle:='invoice.invoice_type = ''contractor''';
  if position(needle in body)=0 then raise exception 'Invoice status aggregate drifted'; end if;
  body:=replace(body,needle,needle||' and invoice.prior_assignment_id is null');
  execute 'create or replace function public.contractor_invoice_work_order_status(p_work_order_id text) returns public.wo_status language sql stable security definer set search_path=public,pg_temp as '||quote_literal(body);
end;
$patch$;

-- Late AP intake is allowed on a closed job without reopening it. The
-- original ban on new current-work/customer invoices remains unchanged.
do $closed_prior$
declare body text; needle text:=E'begin\n';
begin
  select prosrc into body from pg_proc where oid='public.prevent_invoice_on_closed_work_order()'::regprocedure;
  if position(needle in body)=0 then raise exception 'Closed invoice guard drifted'; end if;
  body:=overlay(body placing needle||$branch$
  if new.prior_assignment_id is not null and public.is_staff() and not public.is_invoice_controller()
    and exists(select 1 from public.invoice_financial_transition_guards g where g.transaction_id=txid_current()
      and g.invoice_id=new.id and g.actor_id=auth.uid() and g.command_kind='prior_draft' and g.header_allowed)
    then return new; end if;
$branch$ from position(needle in body) for length(needle));
  execute 'create or replace function public.prevent_invoice_on_closed_work_order() returns trigger language plpgsql security definer set search_path=public,pg_temp as '||quote_literal(body);
end;
$closed_prior$;

do $operational_prior$
declare signature text; proc record; body text; needle text:='invoice.invoice_type = ''contractor''';
begin
  foreach signature in array array['public.contractor_invoicing_is_complete(text)',
    'public.finish_contractor_invoicing_financial_core(text)',
    'public.transition_work_order_contractor_assignment_core(text,uuid,integer)'] loop
    select p.prosrc,pg_get_function_arguments(p.oid) args,pg_get_function_result(p.oid) result,l.lanname,p.proname
      into strict proc from pg_proc p join pg_language l on l.oid=p.prolang where p.oid=signature::regprocedure;
    if position(needle in proc.prosrc)=0 then raise exception 'Current-work invoice aggregate drifted: %',signature; end if;
    body:=replace(proc.prosrc,needle,needle||' and invoice.prior_assignment_id is null');
    execute format('create or replace function public.%I(%s) returns %s language %I %s security definer set search_path=public,pg_temp as %L',
      proc.proname,proc.args,proc.result,proc.lanname,case when proc.lanname='sql' then 'stable' else '' end,body);
  end loop;
end;
$operational_prior$;

-- Existing canonical uploads/downloads remain authoritative. Block historical
-- PDFs for contractors even after the company becomes current again.
alter function public.private_object_assert_target(public.private_object_uploads,boolean) rename to private_object_assert_target_pre_prior;
create function public.private_object_assert_target(p_upload public.private_object_uploads,p_write boolean default true)
returns void language plpgsql security definer set search_path=pg_catalog,public as $$
begin
  if p_upload.purpose in ('invoice_original','invoice_generated') and exists(
    select 1 from public.invoices i join public.profiles p on p.id=p_upload.actor_id
    where i.id=p_upload.parent_id and i.prior_assignment_id is not null and p.role='contractor') then
    raise exception 'Prior invoice documents are staff-only' using errcode='42501'; end if;
  perform public.private_object_assert_target_pre_prior(p_upload,p_write);
end;
$$;
alter function public.private_object_binding_access(uuid,uuid) rename to private_object_binding_access_pre_prior;
create function public.private_object_binding_access(p_binding uuid,p_actor uuid)
returns boolean language plpgsql stable security definer set search_path=pg_catalog,public as $$
begin
  if exists(select 1 from public.private_object_bindings b join public.invoices i on i.id=b.parent_id
    join public.profiles p on p.id=p_actor where b.id=p_binding and b.purpose in ('invoice_original','invoice_generated')
      and i.prior_assignment_id is not null and p.role='contractor') then return false; end if;
  return public.private_object_binding_access_pre_prior(p_binding,p_actor);
end;
$$;

create function public.get_prior_contractor_invoice_context_v1(p_work_order_id text)
returns jsonb language plpgsql stable security definer set search_path=public,pg_temp as $$
declare a public.profiles%rowtype; w public.work_orders%rowtype; result jsonb;
begin
  a:=public.require_work_order_assignment_actor();
  select * into w from public.work_orders where id=p_work_order_id and deleted_at is null;
  if not found then raise exception 'Work order not found' using errcode='P0002'; end if;
  select jsonb_build_object('workOrderId',w.id,'assignmentVersion',w.contractor_assignment_version,
    'workflowCycle',w.workflow_cycle,'assignments',coalesce((select jsonb_agg(item order by ended desc,id) from (
      select h.id,h.assignment_ended_at ended,jsonb_build_object('id',h.id,'contractorId',h.contractor_id,
        'contractorName',p.name,'assignmentVersion',h.assignment_version,'startedAt',h.assignment_started_at,
        'endedAt',h.assignment_ended_at) item
      from public.work_order_assignment_history h join public.profiles p on p.id=h.contractor_id
      where h.work_order_id=w.id and h.assignment_version<w.contractor_assignment_version
      order by h.assignment_ended_at desc,h.id limit 100) rows),'[]'::jsonb),
    'drafts',coalesce((select jsonb_agg(item order by created desc,id) from (
      select i.id,i.created_at created,jsonb_build_object('id',i.id,'assignmentId',i.prior_assignment_id,'num',i.num,
        'invoiceDate',i.invoice_date,'total',i.total,'salesTax',i.sales_tax,'note',i.prior_assignment_note,
        'state',i.state,'invoiceVersion',i.invoice_version,'hasPdf',i.pdf_storage_path is not null) item
      from public.invoices i where i.work_order_id=w.id and i.prior_assignment_id is not null
        and i.deleted_at is null and i.state in ('draft','rejected') order by i.created_at desc,i.id limit 100) rows),'[]'::jsonb)) into result;
  return result;
end;
$$;

create function public.save_prior_contractor_invoice_v1(
  p_work_order_id text,p_expected_assignment_version integer,p_expected_workflow_cycle integer,
  p_assignment_id uuid,p_invoice_id uuid,p_expected_invoice_version bigint,p_operation_id uuid,p_payload jsonb
)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare a public.profiles%rowtype; w public.work_orders%rowtype; h public.work_order_assignment_history%rowtype;
  i public.invoices%rowtype; payload jsonb; replay jsonb; guard_id bigint; invoice_id uuid; event_id uuid;
  amount numeric; tax numeric; v_invoice_date date; v_number text; note text;
begin
  a:=public.require_work_order_assignment_actor();
  if p_operation_id is null or p_assignment_id is null or p_expected_assignment_version is null
    or p_expected_workflow_cycle is null or ((p_invoice_id is null)<>(p_expected_invoice_version is null))
    or p_payload is null or jsonb_typeof(p_payload)<>'object'
    or (p_payload-array['num','invoiceDate','total','salesTax','note'])<>'{}'::jsonb
    or not(p_payload ?& array['num','invoiceDate','total','salesTax','note'])
    or jsonb_typeof(p_payload->'num')<>'string' or jsonb_typeof(p_payload->'invoiceDate')<>'string'
    or jsonb_typeof(p_payload->'note')<>'string' or jsonb_typeof(p_payload->'total')<>'number'
    or jsonb_typeof(p_payload->'salesTax')<>'number' then
    raise exception 'Invalid prior invoice input' using errcode='22023'; end if;
  v_number:=btrim(p_payload->>'num');note:=btrim(p_payload->>'note');
  amount:=(p_payload->>'total')::numeric;tax:=(p_payload->>'salesTax')::numeric;
  if (p_payload->>'invoiceDate')!~'^\d{4}-\d{2}-\d{2}$' then raise exception 'Invalid invoice date' using errcode='22023'; end if;
  v_invoice_date:=(p_payload->>'invoiceDate')::date;
  if length(v_number) not between 1 and 100 or v_number ~ '[[:cntrl:]]' or length(note) not between 5 and 1000
    or amount<=0 or amount>99999999.99 or round(amount,2)<>amount or tax<0 or tax>amount or round(tax,2)<>tax
    or v_invoice_date>(clock_timestamp() at time zone 'America/New_York')::date then
    raise exception 'Invalid invoice number, date, amount, tax or note' using errcode='22023'; end if;
  payload:=jsonb_build_object('assignmentId',p_assignment_id,'num',v_number,'invoiceDate',v_invoice_date,'total',amount,'salesTax',tax,'note',note);
  select * into w from public.work_orders where id=p_work_order_id and deleted_at is null for update;
  if not found then raise exception 'Work order not found' using errcode='P0002'; end if;
  a:=public.require_work_order_assignment_actor();
  select * into h from public.work_order_assignment_history where id=p_assignment_id and work_order_id=w.id for share;
  if not found or h.assignment_version>=w.contractor_assignment_version then
    raise exception 'Select a recorded past assignment on this work order' using errcode='22023'; end if;
  replay:=public.begin_invoice_financial_operation(p_operation_id,a.id,'prior_draft',p_invoice_id,'contractor',w.id,
    p_expected_assignment_version,p_expected_workflow_cycle,p_expected_invoice_version,payload);
  if replay is not null then return replay; end if;
  if w.contractor_assignment_version<>p_expected_assignment_version or w.workflow_cycle<>p_expected_workflow_cycle then
    raise exception 'Work order changed; reopen the form' using errcode='PT409'; end if;
  invoice_id:=coalesce(p_invoice_id,gen_random_uuid());
  if p_invoice_id is not null then
    select * into i from public.invoices where id=p_invoice_id and deleted_at is null for update;
    if not found or i.work_order_id is distinct from w.id or i.prior_assignment_id is distinct from h.id
      or i.invoice_version is distinct from p_expected_invoice_version or i.state not in ('draft','rejected')
      or i.qbo_synced_at is not null or i.qbo_invoice_id is not null then
      raise exception 'Invoice changed; reopen the form' using errcode='PT409'; end if;
    if exists(select 1 from public.staff_invoice_sources s join public.invoices b on b.id=s.staff_invoice_id
      where s.contractor_invoice_id=i.id and b.deleted_at is null) then
      raise exception 'Invoice is already used in P1 billing' using errcode='PT409'; end if;
  end if;
  guard_id:=public.open_invoice_financial_guard(a.id,'prior_draft',p_operation_id,invoice_id,w.id,true,false,false,false,'prior_contractor_invoice_saved');
  if p_invoice_id is null then
    insert into public.invoices(id,work_order_id,store_number,contractor_id,created_by,invoice_type,document_kind,
      num,invoice_date,state,subtotal,sales_tax,total,prior_assignment_id,prior_assignment_note)
    values(invoice_id,w.id,w.store_number,h.contractor_id,a.id,'contractor','invoice',v_number,v_invoice_date,'draft',amount-tax,tax,amount,h.id,note)
    returning * into i;
  else
    update public.invoices set num=v_number,invoice_date=v_invoice_date,
      subtotal=amount-tax,sales_tax=tax,total=amount,prior_assignment_note=note,updated_at=clock_timestamp(),
      invoice_version=invoices.invoice_version+1
      where id=invoice_id returning * into i;
  end if;
  insert into public.activities(work_order_id,author_id,author_name,text,type,event_key,event_data,is_staff_only,activity_channel)
  values(w.id,a.id,a.name,format('Prior contractor invoice #%s recorded by %s for assignment %s; current assignment unchanged.',i.num,a.name,h.assignment_version),
    'system','prior_contractor_invoice_saved',jsonb_build_object('invoiceId',i.id,'assignmentId',h.id,'contractorId',h.contractor_id,
      'note',note,'operationId',p_operation_id),true,'internal_note') returning id into event_id;
  return public.finish_invoice_financial_operation(p_operation_id,i.id,jsonb_build_object('invoiceId',i.id,'invoiceNum',i.num,
    'workOrderId',w.id,'assignmentId',h.id,'assignmentVersion',w.contractor_assignment_version,'workflowCycle',w.workflow_cycle,
    'invoiceVersion',i.invoice_version,'state',i.state,'total',i.total),event_id);
end;
$$;

create function public.submit_prior_contractor_invoice_v1(p_invoice_id uuid,p_expected_invoice_version bigint,
  p_expected_assignment_version integer,p_expected_workflow_cycle integer,p_operation_id uuid)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare a public.profiles%rowtype; w public.work_orders%rowtype; i public.invoices%rowtype;
  replay jsonb; event_id uuid; guard_id bigint; target text;
begin
  a:=public.require_work_order_assignment_actor();
  select work_order_id into target from public.invoices where id=p_invoice_id;
  select * into w from public.work_orders where id=target and deleted_at is null for update;
  select * into i from public.invoices where id=p_invoice_id and invoice_type='contractor' and prior_assignment_id is not null and deleted_at is null for update;
  if not found or w.id is null or i.work_order_id is distinct from w.id then raise exception 'Prior invoice not found' using errcode='P0002'; end if;
  replay:=public.begin_invoice_financial_operation(p_operation_id,a.id,'prior_submit',i.id,'contractor',w.id,
    p_expected_assignment_version,p_expected_workflow_cycle,p_expected_invoice_version,jsonb_build_object('invoiceId',i.id));
  if replay is not null then return replay; end if;
  if i.invoice_version is distinct from p_expected_invoice_version or w.contractor_assignment_version is distinct from p_expected_assignment_version
    or w.workflow_cycle is distinct from p_expected_workflow_cycle or i.state not in ('draft','rejected') then
    raise exception 'Invoice or work order changed; reopen the form' using errcode='PT409'; end if;
  if not exists(select 1 from public.private_object_bindings b join storage.objects o on o.id=b.storage_object_id
    and o.bucket_id=b.bucket and o.name=b.object_path where b.parent_id=i.id and b.work_order_id=w.id and b.state='finalized'
      and b.purpose='invoice_original' and b.object_path=i.pdf_storage_path and b.attached_at is not null) then
    raise exception 'Attach a verified original invoice PDF before submitting' using errcode='22023'; end if;
  guard_id:=public.open_invoice_financial_guard(a.id,'prior_submit',p_operation_id,i.id,w.id,true,false,false,false,'prior_contractor_invoice_submitted');
  perform set_config('app.contractor_invoice_transition','resubmit',true);
  update public.invoices set state=case when i.state='rejected' then 'revised'::public.invoice_state else 'submitted'::public.invoice_state end,
    review_revision=case when i.state='rejected' then i.review_revision+1 else i.review_revision end,
    resubmitted_at=case when i.state='rejected' then clock_timestamp() else resubmitted_at end,
    resubmitted_by=case when i.state='rejected' then a.id else resubmitted_by end,updated_at=clock_timestamp()
    where id=i.id returning * into i;
  insert into public.activities(work_order_id,author_id,author_name,text,type,event_key,event_data,is_staff_only,activity_channel)
  values(w.id,a.id,a.name,format('Prior contractor invoice #%s submitted for P1 review; current contractor work remains unchanged.',i.num),
    'system','prior_contractor_invoice_submitted',jsonb_build_object('invoiceId',i.id,'assignmentId',i.prior_assignment_id,
      'operationId',p_operation_id),true,'internal_note') returning id into event_id;
  return public.finish_invoice_financial_operation(p_operation_id,i.id,jsonb_build_object('invoiceId',i.id,'invoiceNum',i.num,
    'workOrderId',w.id,'assignmentId',i.prior_assignment_id,'assignmentVersion',w.contractor_assignment_version,
    'workflowCycle',w.workflow_cycle,'invoiceVersion',i.invoice_version,'state',i.state,'total',i.total),event_id);
end;
$$;

-- Stay inside the established review/notification/versioning wrapper. Only
-- explicitly staff-recorded prior bills take this branch; old unmarked rows
-- retain all original assignment checks.
alter function public.review_contractor_invoice_financial_core(uuid,text,text) rename to review_current_contractor_invoice_core;
alter function public.retract_contractor_invoice_rejection_financial_core(uuid) rename to retract_current_contractor_invoice_core;
create function public.review_prior_contractor_invoice_core(p_invoice_id uuid,p_action text,p_reason text,p_retract boolean default false)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare a public.profiles%rowtype; w public.work_orders%rowtype; i public.invoices%rowtype; target text; action text:=lower(btrim(p_action));
begin
  a:=public.require_work_order_assignment_actor();
  select work_order_id into target from public.invoices where id=p_invoice_id;
  select * into w from public.work_orders where id=target and deleted_at is null for update;
  select * into i from public.invoices where id=p_invoice_id and prior_assignment_id is not null and invoice_type='contractor' and deleted_at is null for update;
  if not found or w.id is null or not exists(select 1 from public.work_order_assignment_history h
    where h.id=i.prior_assignment_id and h.work_order_id=w.id and h.contractor_id=i.contractor_id) then
    raise exception 'Prior invoice not found' using errcode='P0002'; end if;
  if (not p_retract and (action not in ('approve','reject') or i.state not in ('submitted','revised')))
    or (p_retract and i.state<>'rejected') then raise exception 'Invoice changed before review' using errcode='PT409'; end if;
  if action='reject' and (p_reason is null or length(btrim(p_reason)) not between 1 and 1000) then
    raise exception 'A rejection reason is required' using errcode='22023'; end if;
  perform set_config('app.contractor_invoice_transition',case when p_retract then 'undo_rejection' else 'review' end,true);
  update public.invoices set state=case when action='reject' then 'rejected'::public.invoice_state else 'approved'::public.invoice_state end,
    rejection_reason=case when action='reject' then btrim(p_reason) else rejection_reason end,
    rejected_at=case when action='reject' then clock_timestamp() else rejected_at end,
    rejected_by=case when action='reject' then a.id else rejected_by end,updated_at=clock_timestamp()
    where id=i.id returning * into i;
  insert into public.activities(work_order_id,author_id,author_name,text,type,event_key,event_data,is_staff_only,activity_channel,requires_contractor_attention)
  values(w.id,a.id,a.name,format('Prior contractor invoice #%s %s by %s; current assignment unchanged.',i.num,
    case when p_retract then 'rejection retracted' else action end,a.name),'system',
    case when p_retract then 'invoice_rejection_retracted' when action='approve' then 'invoice_approved' else 'invoice_rejected' end,
    jsonb_build_object('invoiceId',i.id,'invoiceNum',i.num,'reason',nullif(btrim(p_reason),''),'revision',i.review_revision,
      'assignmentId',i.prior_assignment_id,'newState',i.state,'outcome',action),true,'internal_note',false);
  return jsonb_build_object('invoiceId',i.id,'invoiceNum',i.num,'invoiceState',i.state,'workOrderId',w.id,
    'workOrderStatus',w.status,'reviewRevision',i.review_revision,'rejectionReason',i.rejection_reason);
end;
$$;
create function public.review_contractor_invoice_financial_core(p_invoice_id uuid,p_action text,p_reason text default null)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if exists(select 1 from public.invoices where id=p_invoice_id and prior_assignment_id is not null) then
    return public.review_prior_contractor_invoice_core(p_invoice_id,p_action,p_reason,false); end if;
  return public.review_current_contractor_invoice_core(p_invoice_id,p_action,p_reason);
end;
$$;
create function public.retract_contractor_invoice_rejection_financial_core(p_invoice_id uuid)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if exists(select 1 from public.invoices where id=p_invoice_id and prior_assignment_id is not null) then
    return public.review_prior_contractor_invoice_core(p_invoice_id,'approve',null,true); end if;
  return public.retract_current_contractor_invoice_core(p_invoice_id);
end;
$$;

revoke all on function public.guard_prior_contractor_invoice(),public.protect_prior_invoice_activity(),public.private_object_assert_target_pre_prior(public.private_object_uploads,boolean),
  public.private_object_assert_target(public.private_object_uploads,boolean),public.private_object_binding_access_pre_prior(uuid,uuid),
  public.private_object_binding_access(uuid,uuid),public.review_current_contractor_invoice_core(uuid,text,text),
  public.retract_current_contractor_invoice_core(uuid),public.review_prior_contractor_invoice_core(uuid,text,text,boolean),
  public.review_contractor_invoice_financial_core(uuid,text,text),public.retract_contractor_invoice_rejection_financial_core(uuid)
  from public,anon,authenticated,service_role;
revoke all on function public.get_prior_contractor_invoice_context_v1(text),
  public.save_prior_contractor_invoice_v1(text,integer,integer,uuid,uuid,bigint,uuid,jsonb),
  public.submit_prior_contractor_invoice_v1(uuid,bigint,integer,integer,uuid) from public,anon,authenticated,service_role;
grant execute on function public.get_prior_contractor_invoice_context_v1(text),
  public.save_prior_contractor_invoice_v1(text,integer,integer,uuid,uuid,bigint,uuid,jsonb),
  public.submit_prior_contractor_invoice_v1(uuid,bigint,integer,integer,uuid) to authenticated;
notify pgrst,'reload schema';
commit;
