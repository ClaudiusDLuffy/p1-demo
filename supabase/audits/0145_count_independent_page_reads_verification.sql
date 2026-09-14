-- Read-only aggregate/catalog checks only. No data, customer identifiers,
-- names, contacts, query payloads, or repairs. Gateway authorization and query
-- plans remain separately executed promotion gates.
with expected(row_name,count_name,helper_name) as (values
  ('list_work_orders_rows_v1','count_work_orders_v1','work_orders_v1'),
  ('list_work_orders_table_rows_v1','count_work_orders_table_v1','work_orders_table_v1'),
  ('list_work_order_activities_rows_v1','count_work_order_activities_v1','work_order_activities_v1'),
  ('list_work_order_photos_rows_v1','count_work_order_photos_v1','work_order_photos_v1'),
  ('list_work_order_visits_rows_v1','count_work_order_visits_v1','work_order_visits_v1'),
  ('list_contractor_invoices_rows_v1','count_contractor_invoices_v1','contractor_invoices_v1'),
  ('list_staff_invoices_rows_v1','count_staff_invoices_v1','staff_invoices_v1')
), functions as (
  select p.*,n.nspname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where (n.nspname='public' and p.proname in (select row_name from expected union all select count_name from expected))
    or (n.nspname='p1_read_contracts' and p.proname in (select helper_name from expected))
), checks as (
  select count(*)=21 as all_functions_present,
    bool_and(not prosecdef and provolatile='s') as invoker_stable,
    bool_and(coalesce(proconfig@>array['search_path=pg_catalog, public'],false)) as pinned_paths,
    bool_and(not has_function_privilege('anon',oid,'EXECUTE') and not exists(
      select 1 from aclexplode(coalesce(proacl,acldefault('f',proowner))) a where a.grantee=0 and a.privilege_type='EXECUTE')) as no_public_execute,
    bool_and(has_function_privilege('authenticated',oid,'EXECUTE') and has_function_privilege('service_role',oid,'EXECUTE')) as intended_read_grants,
    bool_and(case when nspname='p1_read_contracts' then
      position('case when p_read_mode=''count''' in prosrc)>0
      and position('when p_read_mode=''rows''' in prosrc)>0
      and position('page_size' in prosrc)>0
      else true end) as distinct_count_branch,
    bool_and(prosrc!~* '\m(insert|update|delete|truncate|execute)\M[[:space:]]+(into|from|public\.|format\()') as no_runtime_writes_or_dynamic_sql
  from functions
), schema_state as (
  select not has_schema_privilege('anon','p1_read_contracts','USAGE') as anonymous_helper_schema_blocked,
    exists(select 1 from pg_proc where oid=to_regprocedure('public.get_portal_navigation_summary_v1()')
      and not prosecdef and provolatile='s' and proconfig@>array['search_path=pg_catalog, public']
      and not has_function_privilege('anon',oid,'EXECUTE')
      and has_function_privilege('authenticated',oid,'EXECUTE') and has_function_privilege('service_role',oid,'EXECUTE')
      and not exists(select 1 from aclexplode(coalesce(proacl,acldefault('f',proowner))) a
        where a.grantee=0 and a.privilege_type='EXECUTE')
      and position('evaluate_work_order_sla_v1(' in prosrc)>0
      and position('(select public.is_staff())' in prosrc)>0) as navigation_read_preserves_sla_and_grants,
    exists(select 1 from pg_policy where polrelid='public.work_orders'::regclass and polname='wo_read'
      and polcmd='r' and polpermissive and polroles=array[0::oid]
      and pg_get_expr(polqual,polrelid) like '%SELECT is_staff()%'
      and pg_get_expr(polqual,polrelid) like '%OR can_access_contractor_work_order(id)%') as staff_initplan_same_row_helper,
    exists(select 1 from pg_proc where oid=to_regprocedure('p1_read_contracts.validate_v1(text,jsonb)')
      and not prosecdef and provolatile='s' and proconfig@>array['search_path=pg_catalog, public']
      and not has_function_privilege('anon',oid,'EXECUTE')) as validator_restricted,
    to_regprocedure('public.list_contractor_invoice_payment_holds_page_v1(integer,text)') is not null
      and to_regprocedure('public.list_directory_page_v1(text,text,uuid,integer,text)') is not null as prior_bounded_reads_present
)
select checks.*,schema_state.*,
  all_functions_present and invoker_stable and pinned_paths and no_public_execute and intended_read_grants
    and distinct_count_branch and no_runtime_writes_or_dynamic_sql and anonymous_helper_schema_blocked
    and validator_restricted and staff_initplan_same_row_helper and navigation_read_preserves_sla_and_grants
    and prior_bounded_reads_present as all_checks_pass
from checks cross join schema_state;
