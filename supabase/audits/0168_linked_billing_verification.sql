-- Read-only installation check; does not link invoices or close work orders.
with functions as (
  select unnest(array[
    to_regprocedure('public.record_work_order_linked_billing_v1(text,integer,integer,bigint,uuid,text,integer,integer,uuid,bigint,text)'),
    to_regprocedure('public.list_linked_billing_candidates_v1(text,text)'),
    to_regprocedure('public.get_work_order_billing_links_v1(text,timestamptz,uuid)')
  ]) as oid
), checks as (
  select
    to_regclass('public.work_order_billing_links') is not null as ledger_exists,
    coalesce((select relrowsecurity from pg_class where oid=to_regclass('public.work_order_billing_links')),false) as ledger_rls,
    (select count(*)=3 and bool_and(prosecdef and proconfig @> array['search_path=public, pg_temp'])
      from pg_proc where oid in (select oid from functions)) as protected_functions,
    (select bool_and(coalesce(has_function_privilege('authenticated',oid,'execute'),false)) from functions) as authenticated_execute,
    (select bool_and(coalesce(not has_function_privilege('anon',oid,'execute'),false)) from functions) as anon_denied,
    (select bool_and(coalesce(not has_function_privilege('service_role',oid,'execute'),false)) from functions) as service_role_denied,
    coalesce(not has_table_privilege('authenticated',to_regclass('public.work_order_billing_links'),'select,insert,update,delete'),false) as direct_ledger_access_denied,
    coalesce(not has_function_privilege('authenticated',to_regprocedure('public.require_linked_billing_actor()'),'execute'),false) as private_helper_denied,
    exists(select 1 from pg_trigger where tgrelid='public.activities'::regclass
      and tgname='zz_protect_linked_billing_activity' and tgenabled='O') as immutable_activity_guard,
    exists(select 1 from pg_trigger where tgrelid=to_regclass('public.work_order_billing_links')
      and tgname='protect_linked_billing_record' and tgenabled='O') as immutable_ledger_guard,
    exists(select 1 from pg_trigger where tgrelid='public.invoices'::regclass
      and tgname='protect_linked_billing_invoice' and tgenabled='O') as invoice_integrity_guard
)
select case when ledger_exists and ledger_rls and protected_functions and authenticated_execute and anon_denied
  and service_role_denied and direct_ledger_access_denied and private_helper_denied and immutable_activity_guard
  and immutable_ledger_guard and invoice_integrity_guard then 'PASS_0168_INSTALLED' else 'FAIL_0168_REVIEW_REQUIRED' end
  as deployment_status,checks.* from checks;
