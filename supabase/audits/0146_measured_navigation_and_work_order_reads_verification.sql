-- Read-only closeout catalog audit. Returns aggregate booleans only; no
-- customer rows, repairs, EXPLAIN execution, or authorization bypass.
with expected(schema_name,function_name) as (values
  ('public','get_portal_navigation_summary_v2'),
  ('public','list_work_orders_table_rows_v2'),
  ('public','count_work_orders_table_v2'),
  ('p1_portal_reads','navigation_staff_v2'),
  ('p1_portal_reads','navigation_contractor_v2'),
  ('p1_portal_reads','work_orders_table_v2'),
  ('p1_portal_reads','authorized_contractor_work_order_scope_v1')
), functions as (
  select p.*,n.nspname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  join expected e on e.schema_name=n.nspname and e.function_name=p.proname
), checks as (
  select count(*)=7 as expected_functions,
    bool_and(prosecdef=(proname='authorized_contractor_work_order_scope_v1') and provolatile='s') as expected_security_modes,
    bool_and(coalesce(proconfig@>array['search_path=pg_catalog, public'],false)) as pinned_paths,
    bool_and(not has_function_privilege('anon',oid,'EXECUTE') and not exists(
      select 1 from aclexplode(coalesce(proacl,acldefault('f',proowner))) a
      where a.grantee=0 and a.privilege_type='EXECUTE')) as public_execution_denied,
    bool_and(has_function_privilege('authenticated',oid,'EXECUTE')
      and has_function_privilege('service_role',oid,'EXECUTE')=(proname<>'authorized_contractor_work_order_scope_v1')) as intended_grants,
    bool_and(prosrc!~* '\m(insert|update|delete|truncate|execute)\M[[:space:]]+(into|from|public\.|format\()')
      as no_runtime_writes_or_dynamic_sql,
    bool_and(case when proname='work_orders_table_v2' then
      position('case when p_read_mode=''count''' in prosrc)>0
      and position('when p_read_mode=''rows''' in prosrc)>0
      and position('greatest(1, least(coalesce(p_limit, 25), 100))' in prosrc)>0
      and position('candidate as not materialized' in prosrc)>0
      and position('join candidate on candidate.id = work_order.id' in prosrc)=0
      else true end) as count_independent_bounded_rows,
    bool_and(case when proname in ('list_work_orders_table_rows_v2','count_work_orders_table_v2') then
      position('p1_read_contracts.validate_v1(' in prosrc)>0
      and position('p1_portal_reads.work_orders_table_v2(' in prosrc)>0
      else true end) as shared_unchanged_validation,
    bool_and(case when proname='navigation_staff_v2' then
      position('contractorInvoiceCount' in prosrc)=0
      and position('effective_sla(due_at,breached)' in prosrc)>0
      and position('staffWorkCount' in prosrc)>0
      when proname='navigation_contractor_v2' then
      position('slaBreachedCount' in prosrc)=0 and position('contractorActiveCount' in prosrc)>0
      and position('actor as materialized' in prosrc)>0
      when proname='get_portal_navigation_summary_v2' then
      position('p.active=true' in prosrc)>0 and position('auth.uid() is null' in prosrc)>0
      when proname='authorized_contractor_work_order_scope_v1' then
      position('auth.uid() is null' in prosrc)>0 and position('technician.is_active = true' in prosrc)>0
      and pronargs=0 and proowner=(select proowner from pg_proc where oid='public.can_access_contractor_work_order(text)'::regprocedure)
      else true end) as focused_navigation_and_active_actor
  from functions
), preservation as (
  select
    (select encode(sha256(convert_to(prosrc,'UTF8')),'hex')=
      'd13c2ba5a1d5f5849417cc0fb5ccaa9a19e5327b7782ac3650067431d1c87145'
      from pg_proc where pronamespace='p1_read_contracts'::regnamespace
      and proname='work_orders_table_v1') as old_table_source_preserved,
    (select encode(sha256(convert_to(prosrc,'UTF8')),'hex')=
      '6a50be971d0d6b9a581e74592928f9b136b8f11c8bc8365fff6cd2f17cca9660'
      from pg_proc where oid=to_regprocedure('public.get_portal_navigation_summary_v1()'))
      as old_navigation_source_preserved,
    (select encode(sha256(convert_to(prosrc,'UTF8')),'hex')=
      'c6673b497d247a94914b50ed357052915c2faa4d2ec7e9bedbe182839896acd5'
      from pg_proc where oid=to_regprocedure('public.evaluate_work_order_sla_v1(text,timestamptz,timestamptz,timestamptz,timestamptz,timestamptz)'))
      as canonical_sla_source_preserved,
    exists(select 1 from pg_policy where polrelid='public.work_orders'::regclass and polname='wo_read'
      and polcmd='r' and polpermissive and polroles=array[0::oid]
      and pg_get_expr(polqual,polrelid) like '%SELECT is_staff()%'
      and pg_get_expr(polqual,polrelid) like '%OR can_access_contractor_work_order(id)%')
      as unchanged_canonical_row_authorization,
    not has_schema_privilege('anon','p1_portal_reads','USAGE') as helper_schema_restricted,
    exists(select 1 from pg_index measured
      where measured.indexrelid=to_regclass('public.work_orders_contractor_created_key_cursor_idx')
      and measured.indisvalid and measured.indisready
      and position('COALESCE(created_at,' in pg_get_indexdef(measured.indexrelid))>0
      and (select count(*) from pg_index other where other.indrelid=measured.indrelid
        and other.indkey=measured.indkey and other.indclass=measured.indclass
        and other.indcollation=measured.indcollation and other.indoption=measured.indoption
        and coalesce(other.indexprs::text,'')=coalesce(measured.indexprs::text,'')
        and coalesce(other.indpred::text,'')=coalesce(measured.indpred::text,''))=1)
      as measured_index_without_duplicate,
    to_regclass('public.work_orders_contractor_created_cursor_idx') is not null as original_index_preserved
)
select checks.*,preservation.*,
  expected_functions and expected_security_modes and pinned_paths and public_execution_denied and intended_grants
  and no_runtime_writes_or_dynamic_sql and count_independent_bounded_rows and shared_unchanged_validation
  and focused_navigation_and_active_actor and old_table_source_preserved and old_navigation_source_preserved
  and canonical_sla_source_preserved and unchanged_canonical_row_authorization and helper_schema_restricted
  and measured_index_without_duplicate and original_index_preserved
  as all_checks_pass
from checks cross join preservation;
