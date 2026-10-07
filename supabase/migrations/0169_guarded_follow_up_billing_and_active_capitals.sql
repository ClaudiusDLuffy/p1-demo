-- No historical rows are rewritten. An old billed invoice is not a new-cycle
-- invoice: retain it only when its own pre-reopen handoff is proven.
begin;

create function public.prior_billed_follow_up_context(p_work_order_id text, p_cycle integer)
returns jsonb language plpgsql stable security definer set search_path=public,pg_temp as $$
declare r public.activities%rowtype; preserved jsonb;
begin
  select * into r from public.activities where work_order_id=p_work_order_id
    and workflow_cycle=p_cycle and event_key='work_order_reopened' and deleted_at is null
    order by created_at desc,id desc limit 1;
  if not found or r.created_at>now() or (p_cycle>0 and coalesce(r.event_data->>'mode','')
    not in ('resume_work','billing_follow_up')) or (p_cycle=0 and coalesce(r.event_data->>'mode','')
    not in ('','resume_work','billing_follow_up')) then return null; end if;
  if not exists(select 1 from public.invoices where work_order_id=p_work_order_id
      and invoice_type='staff' and document_kind='invoice' and deleted_at is null)
    or exists(select 1 from public.invoices i where i.work_order_id=p_work_order_id
      and i.invoice_type='staff' and i.document_kind='invoice' and (
        i.deleted_at>=r.created_at or (i.deleted_at is null and (
          i.created_at>=r.created_at or i.state not in ('approved','paid') or not exists(
            select 1 from public.activities a where a.work_order_id=p_work_order_id
              and a.event_key='staff_billing' and a.event_data->>'action'='billed_to_7_eleven'
              and a.event_data->>'invoiceId'=i.id::text and a.deleted_at is null
              and a.created_at<r.created_at and (a.workflow_cycle<p_cycle
                or (p_cycle=0 and a.workflow_cycle=0))))))) then return null; end if;
  -- A prior header's creation date alone must not hide later financial work.
  if exists(select 1 from public.activities a join public.invoices i
    on a.event_data->>'invoiceId'=i.id::text where i.work_order_id=p_work_order_id
      and i.invoice_type='staff' and i.document_kind='invoice' and a.work_order_id=p_work_order_id
      and a.deleted_at is null and a.created_at>=r.created_at
      and a.event_key in ('staff_billing','staff_invoice_ready')) then return null; end if;
  select jsonb_agg(jsonb_build_object('id',id,'number',num,'state',state,'total',total,
    'invoiceVersion',invoice_version) order by id) into preserved from public.invoices
    where work_order_id=p_work_order_id and invoice_type='staff' and document_kind='invoice'
      and deleted_at is null;
  return jsonb_build_object('workflowCycle',p_cycle,'reopenActivityId',r.id,'reopenedAt',r.created_at,
    'legacyReopen',p_cycle=0,'preservedInvoices',preserved);
end; $$;
revoke all on function public.prior_billed_follow_up_context(text,integer) from public,anon,authenticated,service_role;

-- Replace only the over-broad source-invoice check. All actor, version, invoice
-- eligibility, checkout, pending-update, replay and contractor-review guards stay.
do $patch$
declare name text; f record; body text; before text; after text; marker text;
begin
  foreach name in array array['record_work_order_linked_billing_v1','record_work_order_external_billing_v1'] loop
    select p.oid,pg_get_function_arguments(p.oid) args,p.prosrc into strict f
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname=name;
    before:=case when name='record_work_order_linked_billing_v1' then
      'and invoice_type=''staff'' and document_kind=''invoice'') then' else
      'and i.invoice_type = ''staff'' and i.document_kind = ''invoice'') then' end;
    after:=replace(before,') then',') and public.prior_billed_follow_up_context(v_work.id,v_work.workflow_cycle) is null then');
    body:=replace(f.prosrc,before,after);
    marker:=case when name='record_work_order_linked_billing_v1' then
      'insert into public.work_order_billing_links(' else 'insert into public.work_order_external_billings(' end;
    body:=replace(body,marker,'v_result:=v_result||jsonb_build_object(''followUp'',public.prior_billed_follow_up_context(v_work.id,v_work.workflow_cycle)); '||marker);
    if body=f.prosrc or position(before in body)>0 or position(marker in body)=0
      or position('''followUp''' in body)=0 then raise exception 'Follow-up guard patch failed: %',name; end if;
    execute format('create or replace function public.%I(%s) returns jsonb language plpgsql security definer set search_path=public,pg_temp as %L',name,f.args,body);
  end loop;
end; $patch$;

-- Carefully recognize a legacy cycle-0 reopen. Do not renumber its invoices or
-- fabricate a historical cycle. Its closure records the actual reopen identity.
do $legacy$
declare f record; body text; before text; after text;
begin
  select p.oid,pg_get_function_arguments(p.oid) args,p.prosrc into strict f from pg_proc p
    where p.oid='public.close_reopened_work_order_without_additional_billing_lc_core(text,integer,integer,timestamptz,text)'::regprocedure;
  body:=replace(f.prosrc,'p_expected_workflow_cycle <= 0','p_expected_workflow_cycle < 0');
  body:=replace(body,'v_work_order.workflow_cycle <= 0','v_work_order.workflow_cycle < 0');
  body:=replace(body,'''unassigned'', ''assigned'', ''wip'', ''parts'', ''completed''',
    '''unassigned'', ''assigned'', ''wip'', ''parts'', ''completed'', ''pending_invoice''');
  before:='if coalesce(v_reopen_activity.event_data ->> ''mode'', '''') <> ''resume_work'' then';
  after:='if coalesce(v_reopen_activity.event_data ->> ''mode'', '''') <> ''resume_work'' and not (v_work_order.workflow_cycle=0 and coalesce(v_reopen_activity.event_data->>''mode'','''')='''') then';
  if position(before in body)=0 then raise exception 'Legacy mode boundary changed'; end if;
  body:=replace(body,before,after);
  body:=replace(body,'and billing_activity.workflow_cycle < v_work_order.workflow_cycle',
    'and (billing_activity.workflow_cycle < v_work_order.workflow_cycle or (v_work_order.workflow_cycle=0 and billing_activity.workflow_cycle=0))');
  body:=replace(body,'and submission_activity.workflow_cycle < v_work_order.workflow_cycle',
    'and (submission_activity.workflow_cycle < v_work_order.workflow_cycle or (v_work_order.workflow_cycle=0 and submission_activity.workflow_cycle=0))');
  body:=replace(body,'and activity.workflow_cycle < v_work_order.workflow_cycle',
    'and (activity.workflow_cycle < v_work_order.workflow_cycle or (v_work_order.workflow_cycle=0 and activity.workflow_cycle=0))');
  -- Never invent a checkout time just to close a billing follow-up.
  before:=$old$update public.work_order_visits visit
  set check_out_at = v_now,
      checked_out_by = v_actor.id,
      updated_at = v_now
  where visit.work_order_id = v_work_order.id
    and visit.check_out_at is null;
  get diagnostics v_visits_closed = row_count;$old$;
  after:=$new$if exists(select 1 from public.work_order_visits where work_order_id=v_work_order.id and check_out_at is null) then
    raise exception 'Record the actual visit checkout before closing this follow-up' using errcode='23514';
  end if;
  if v_work_order.status='pending_invoice' and v_work_order.functional_status::text is distinct from 'Completed' then
    raise exception 'Finish field work before closing this billing follow-up' using errcode='23514';
  end if;
  v_visits_closed:=0;$new$;
  if position(before in body)=0 then raise exception 'Legacy checkout guard boundary changed'; end if;
  body:=replace(body,before,after);
  body:=replace(body,'''reopenedAt'', v_reopen_activity.created_at,',
    '''legacyReopenReconciled'', v_work_order.workflow_cycle=0, ''reopenedAt'', v_reopen_activity.created_at,');
  if body=f.prosrc then raise exception 'Legacy follow-up transformation failed'; end if;
  execute format('create or replace function public.close_reopened_work_order_without_additional_billing_lc_core(%s) returns jsonb language plpgsql security definer set search_path=public,pg_temp as %L',f.args,body);
end; $legacy$;

-- Active excludes installed at the authoritative read boundary, before counts,
-- cursor pagination and exports. Installed records remain accessible explicitly.
do $active$
declare f record; body text; signature text;
begin
  select p.oid,pg_get_function_arguments(p.oid) args,p.prosrc into strict f from pg_proc p
    where p.oid='p1_read_contracts.validate_v1(text,jsonb)'::regprocedure;
  body:=replace(f.prosrc,'''capital_waiting_quote'',''capital_quote_submitted''',
    '''capital_active'',''capital_waiting_quote'',''capital_quote_submitted''');
  if body=f.prosrc then raise exception 'Capital validation boundary changed'; end if;
  execute format('create or replace function p1_read_contracts.validate_v1(%s) returns void language plpgsql stable security invoker set search_path=pg_catalog,public as %L',f.args,body);
  foreach signature in array array['p1_read_contracts.work_orders_v1','p1_portal_reads.work_orders_table_v2'] loop
    select p.oid,pg_get_function_arguments(p.oid) args,p.prosrc into strict f from pg_proc p
      join pg_namespace n on n.oid=p.pronamespace where n.nspname=split_part(signature,'.',1) and p.proname=split_part(signature,'.',2);
    body:=replace(f.prosrc,'when p_status = ''capital_waiting_quote'' then',
      'when p_status = ''capital_active'' then work_order.capital_status::text is distinct from ''Installed'' and work_order.status::text <> ''closed'' when p_status = ''capital_waiting_quote'' then');
    if body=f.prosrc then raise exception 'Capital read boundary changed: %',signature; end if;
    execute format('create or replace function %s(%s) returns jsonb language sql stable security invoker set search_path=pg_catalog,public as %L',signature,f.args,body);
  end loop;
end; $active$;
notify pgrst,'reload schema';
commit;
