-- Batch 4B.1: additive measured reads. No historical routine, policy, data,
-- deadline, or financial state is replaced. Existing v1 callers remain valid.
begin;
create schema p1_portal_reads;
revoke all on schema p1_portal_reads from public,anon;
grant usage on schema p1_portal_reads to authenticated,service_role;

-- One candidate record rather than a second work-order/RLS lookup. The
-- authorization and filter source is the exact reviewed 0144 implementation.
do $table_reads$
declare
  routine record;
  wrapper record;
  body text;
begin
  select p.*, pg_get_function_arguments(p.oid) arguments,
    pg_get_function_identity_arguments(p.oid) identity_arguments
    into strict routine from pg_proc p
    where p.pronamespace='p1_read_contracts'::regnamespace
      and p.proname='work_orders_table_v1';
  if routine.prosecdef or routine.provolatile<>'s'
    or encode(sha256(convert_to(routine.prosrc,'UTF8')),'hex')
      <> 'd13c2ba5a1d5f5849417cc0fb5ccaa9a19e5327b7782ac3650067431d1c87145' then
    raise exception 'Reviewed table read source changed' using errcode='23514';
  end if;
  body:=replace(routine.prosrc,
    E'      work_order.id,\n      lower(coalesce(contractor.company, contractor.name, '''')) as contractor_name',
    E'      work_order.id, work_order as _work_order,\n      lower(coalesce(contractor.company, contractor.name, '''')) as contractor_name');
  body:=replace(body,
    E'    from public.work_orders work_order\n    join candidate on candidate.id = work_order.id',
    E'    from candidate\n    cross join lateral (select (candidate._work_order).*) work_order');
  -- These are necessary (not sufficient) predicates from the unchanged
  -- canonical company helper. They reduce candidate RLS calls; RLS still
  -- independently validates active organization, link, and current assignment.
  -- Non-authenticated/service contexts retain their existing behavior.
  body:=replace(body,'with args as (',E'with actor_context as materialized (\n'
    ||E'    select p.id,p.contractor_organization_id,p.contractor_access_level,\n'
    ||E'      public.current_contractor_account_id() account_id,\n'
    ||E'      coalesce(auth.role()=''authenticated'' and p.role::text=''contractor'',false) restrict_company\n'
    ||E'    from (select auth.uid() id) identity left join public.profiles p on p.id=identity.id\n'
    ||E'  ), args as not materialized (');
  -- Removing these fences lets PostgreSQL prune unused full-row projections
  -- for count mode and push selective, already validated scope predicates
  -- before RLS. Activity-dependent filters retain their exact shared source.
  body:=replace(body,'candidate as materialized (','candidate as not materialized (');
  body:=replace(body,E'    from public.work_orders work_order\n    left join public.profiles contractor on contractor.id = work_order.contractor_id\n    cross join args',
    E'    from public.work_orders work_order\n    cross join args\n'
    ||E'    left join public.profiles contractor on contractor.id = work_order.contractor_id\n'
    ||E'      and (args.search_text is not null or nullif(trim(coalesce(p_contractor_filter, '''')), '''') is not null\n'
    ||E'        or args.sort_column = ''contractor'')');
  body:=replace(body,E'    where work_order.deleted_at is null\n      and case args.scope_name',
    E'    where work_order.deleted_at is null\n'
    ||E'      and (not (select restrict_company from actor_context)\n'
    ||E'        or (work_order.contractor_id=(select account_id from actor_context)\n'
    ||E'        and ((select contractor_organization_id from actor_context) is null\n'
    ||E'          or (select contractor_access_level from actor_context)=''company_admin''\n'
    ||E'          or work_order.assigned_technician_profile_id=(select id from actor_context))))\n'
    ||E'      and case args.scope_name');
  body:=replace(body,'''contractor_name'', page_rows._contractor_name',
    '''contractor_name'', lower(coalesce(page_contractor.company,page_contractor.name,''''))');
  body:=replace(body,E'    from page_rows\n    left join lateral (',
    E'    from page_rows\n    left join lateral (select company,name from public.profiles\n'
      ||E'      where id=page_rows.contractor_id limit 1) page_contractor on true\n    left join lateral (');
  if body=routine.prosrc or position('join candidate on candidate.id = work_order.id' in body)>0 then
    raise exception 'Table read transformation incomplete' using errcode='23514';
  end if;
  execute format('create function p1_portal_reads.work_orders_table_v2(%s) returns jsonb
    language sql stable security invoker set search_path=pg_catalog,public as %L',routine.arguments,body);
  execute format('revoke all on function p1_portal_reads.work_orders_table_v2(%s) from public,anon',routine.identity_arguments);
  execute format('grant execute on function p1_portal_reads.work_orders_table_v2(%s) to authenticated,service_role',routine.identity_arguments);
  for wrapper in select p.*,pg_get_function_arguments(p.oid) arguments,
    pg_get_function_identity_arguments(p.oid) identity_arguments
    from pg_proc p where p.pronamespace='public'::regnamespace
    and p.proname in ('list_work_orders_table_rows_v1','count_work_orders_table_v1') loop
    body:=replace(wrapper.prosrc,'p1_read_contracts.work_orders_table_v1(','p1_portal_reads.work_orders_table_v2(');
    if body=wrapper.prosrc then raise exception 'Reviewed wrapper source changed' using errcode='23514'; end if;
    execute format('create function public.%I(%s) returns jsonb language plpgsql stable security invoker
      set search_path=pg_catalog,public as %L',replace(wrapper.proname,'_v1','_v2'),wrapper.arguments,body);
    execute format('revoke all on function public.%I(%s) from public,anon',replace(wrapper.proname,'_v1','_v2'),wrapper.identity_arguments);
    execute format('grant execute on function public.%I(%s) to authenticated,service_role',replace(wrapper.proname,'_v1','_v2'),wrapper.identity_arguments);
  end loop;
end $table_reads$;

-- Derive the optimized staff expression from the unchanged canonical evaluator.
-- This is migration-time specialization, not a separately authored SLA policy.
-- Enclosing invoker routines retain their pinned pg_catalog/public search path.
do $navigation_reads$
declare
  source record;
  evaluator record;
  body text;
  canonical_expression text;
  piece text;
  key text;
  metric_arguments text;
  staff_keys constant text[]:=array['openCount','p1UnassignedCount','capitalCount',
    'pendingApprovalCount','historyCount','slaBreachedCount','staffUnreadCount',
    'myTodoCount','readyToBillCount','staffWorkCount'];
begin
  select p.* into strict source from pg_proc p
    where p.oid='public.get_portal_navigation_summary_v1()'::regprocedure;
  select p.* into strict evaluator from pg_proc p
    where p.oid='public.evaluate_work_order_sla_v1(text,timestamptz,timestamptz,timestamptz,timestamptz,timestamptz)'::regprocedure;
  if source.prosecdef or evaluator.prosecdef or evaluator.provolatile<>'i'
    or encode(sha256(convert_to(source.prosrc,'UTF8')),'hex')
      <> '6a50be971d0d6b9a581e74592928f9b136b8f11c8bc8365fff6cd2f17cca9660'
    or encode(sha256(convert_to(evaluator.prosrc,'UTF8')),'hex')
      <> 'c6673b497d247a94914b50ed357052915c2faa4d2ec7e9bedbe182839896acd5' then
    raise exception 'Reviewed navigation or canonical SLA source changed' using errcode='23514';
  end if;
  body:=source.prosrc;
  -- Each field starts on a dedicated, hash-verified line in the source. Keep
  -- only the ten numeric fields actually rendered by operational staff.
  metric_arguments:=split_part(split_part(body,E'  select jsonb_build_object(\n',2),E'\n  )\n  from annotated;',1);
  body:=split_part(body,E'  select jsonb_build_object(\n',1);
  foreach piece in array regexp_split_to_array(metric_arguments,E'\n    (?=''[A-Za-z]+Count'',)') loop
    key:=substring(piece from '''([A-Za-z]+Count)'',');
    if key=any(staff_keys) then
      body:=body||case when position('  select jsonb_build_object(' in body)=0
        then E'  select jsonb_build_object(\n' else E'\n' end
        ||regexp_replace(piece,',[[:space:]]*$','')||',';
    end if;
  end loop;
  body:=regexp_replace(body,',[[:space:]]*$','')||E'\n  )\n  from annotated;';
  canonical_expression:=rtrim(evaluator.prosrc,E' ;\n\r\t');
  canonical_expression:=replace(canonical_expression,'p_response_breach_at','annotated.response_breach_at');
  canonical_expression:=replace(canonical_expression,'p_resolution_breach_at','annotated.resolution_breach_at');
  canonical_expression:=replace(canonical_expression,'p_dispatched_at','annotated.dispatched_at');
  canonical_expression:=replace(canonical_expression,'p_start_time','annotated.start_time');
  canonical_expression:=replace(canonical_expression,'p_priority','annotated.priority::text');
  canonical_expression:=replace(canonical_expression,'p_now','now()');
  body:=replace(body,E'public.evaluate_work_order_sla_v1(\n              annotated.priority::text, annotated.dispatched_at,\n              annotated.response_breach_at, annotated.resolution_breach_at,\n              annotated.start_time, now()\n            ) effective_sla',
    'lateral ('||canonical_expression||') effective_sla(due_at,breached)');
  if position('public.evaluate_work_order_sla_v1(' in body)>0
    or position('contractorInvoiceCount' in body)>0 or position('staffWorkCount' in body)=0 then
    raise exception 'Navigation specialization incomplete' using errcode='23514';
  end if;
  execute format('create function p1_portal_reads.navigation_staff_v2() returns jsonb
    language sql stable security invoker set search_path=pg_catalog,public as %L',body);
end $navigation_reads$;

-- Measured necessity: the unchanged per-record company helper costs about
-- 0.5 seconds over 20k authorized rows. Generate its contractor EXISTS branch
-- once as a set. This is an explicit SECURITY DEFINER authorization boundary,
-- not an RLS bypass claim: same owner, exact hash-pinned canonical predicates,
-- no caller scope arguments, no row content beyond authorized ID/status.
do $contractor_scope$
declare source record; body text; canonical_set text;
begin
  select p.* into strict source from pg_proc p
    where p.oid='public.can_access_contractor_work_order(text)'::regprocedure;
  if not source.prosecdef or source.provolatile<>'s'
    or source.proowner<>(select oid from pg_roles where rolname=current_user)
    or encode(sha256(convert_to(source.prosrc,'UTF8')),'hex')
      <> '0dbc7d837bdd4cd0f3b7c00fe9775d7a3de23eeb7f1555ecd4f9c2efcbfa4d13' then
    raise exception 'Reviewed contractor authorization source changed' using errcode='23514';
  end if;
  canonical_set:=substring(source.prosrc from position(E'      select 1\n' in source.prosrc));
  canonical_set:=regexp_replace(canonical_set,E'\n    \\)[[:space:]]*$','');
  canonical_set:=regexp_replace(canonical_set,'select 1','select work_order.id,work_order.status');
  canonical_set:=replace(canonical_set,E'where work_order.id = p_work_order_id\n        and work_order.deleted_at is null',
    'where work_order.deleted_at is null');
  if position('p_work_order_id' in canonical_set)>0 or position('select work_order.id,work_order.status' in canonical_set)=0
    or position('technician.is_active = true' in canonical_set)=0 then
    raise exception 'Canonical contractor scope transformation incomplete' using errcode='23514';
  end if;
  body:=E'begin\n'
    ||E'  if coalesce(auth.role(),'''')<>''authenticated'' or auth.uid() is null or not exists(\n'
    ||E'    select 1 from public.profiles p where p.id=auth.uid() and p.active=true and p.role=''contractor'') then\n'
    ||E'    raise exception ''Active contractor authentication required'' using errcode=''42501'';\n'
    ||E'  end if;\n  return query\n'||canonical_set||E';\nend';
  execute format('create function p1_portal_reads.authorized_contractor_work_order_scope_v1()
    returns table(id text,status public.wo_status) language plpgsql stable security definer
    set search_path=pg_catalog,public as %L',body);
  execute 'revoke all on function p1_portal_reads.authorized_contractor_work_order_scope_v1() from public,anon,service_role';
  execute 'grant execute on function p1_portal_reads.authorized_contractor_work_order_scope_v1() to authenticated';
end $contractor_scope$;

create function p1_portal_reads.navigation_contractor_v2()
returns jsonb language sql stable security invoker set search_path=pg_catalog,public as $$
  with actor as materialized (
    select p.id,p.contractor_organization_id,p.contractor_access_level,
      public.current_contractor_account_id() as account_id
    from public.profiles p where p.id=auth.uid() and p.active=true and p.role='contractor'
  ), visible_work_orders as materialized (
    select scoped.id,scoped.status from p1_portal_reads.authorized_contractor_work_order_scope_v1() scoped
  ), attention as materialized (
    select a.work_order_id,count(*) as count from public.activities a
    where a.deleted_at is null and a.requires_contractor_attention
      and a.contractor_attention_acknowledged_at is null
    group by a.work_order_id
  )
  select jsonb_build_object(
    'contractorActiveCount',count(*) filter(where w.status::text in ('unassigned','assigned','wip','parts')),
    'historyCount',count(*) filter(where w.status::text='closed'),
    'contractorAttentionCount',coalesce(sum(attention.count),0))
    || case when public.can_invoice_for_contractor((select account_id from actor))
      then jsonb_build_object('contractorInvoiceCount',(select count(*) from public.invoices i
      where i.invoice_type='contractor' and i.deleted_at is null
        and i.contractor_id=(select account_id from actor)
        and i.state::text in ('submitted','revised','rejected')))
      else '{}'::jsonb end
  from visible_work_orders w left join attention on attention.work_order_id=w.id;
$$;

create function public.get_portal_navigation_summary_v2()
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog,public as $$
declare actor_role text;
begin
  if coalesce(auth.role(),'')<>'authenticated' or auth.uid() is null then
    raise exception 'Active authentication required' using errcode='42501';
  end if;
  select p.role::text into actor_role from public.profiles p where p.id=auth.uid() and p.active=true;
  if not found then raise exception 'Active authentication required' using errcode='42501'; end if;
  if actor_role='contractor' then
    return jsonb_build_object('scope','contractor','metrics',p1_portal_reads.navigation_contractor_v2());
  elsif public.is_staff() then
    return jsonb_build_object('scope','staff','metrics',p1_portal_reads.navigation_staff_v2());
  end if;
  raise exception 'Portal access required' using errcode='42501';
end $$;

revoke all on function p1_portal_reads.navigation_staff_v2(),
  p1_portal_reads.navigation_contractor_v2(),public.get_portal_navigation_summary_v2() from public,anon;
grant execute on function p1_portal_reads.navigation_staff_v2(),
  p1_portal_reads.navigation_contractor_v2(),public.get_portal_navigation_summary_v2() to authenticated,service_role;

-- Selected only after the same50k fixture,20 measured samples and actual RLS
-- plans: company first/continuation559.654/544.962ms ->35.174/13.720ms.
-- Existing raw-created index cannot order the nullable canonical COALESCE key.
-- The new plan visits26 authorized rows instead of sorting19,802. Synthetic
-- index size3,284,992 bytes; key-only1000-row insert p95+1.111ms and indexed
-- update p95+0.703ms. These are local, not hosted/WAL/workflow write guarantees.
-- Keep the existing index for its old raw-date consumers. No indexes removed.
create index work_orders_contractor_created_key_cursor_idx
  on public.work_orders(contractor_id,coalesce(created_at,'epoch'::timestamptz) desc,id desc)
  where deleted_at is null;
commit;
