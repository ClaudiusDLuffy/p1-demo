-- Read-only installation check. This does not close work orders or confirm
-- customer invoices; execute separately from the migration when deploying.
with checks as (
  select
    to_regclass('public.work_order_external_billings') is not null as ledger_exists,
    coalesce((select relrowsecurity from pg_class where oid=to_regclass('public.work_order_external_billings')),false) as ledger_rls,
    (select count(*)=2 and bool_and(prosecdef and proconfig @> array['search_path=public, pg_temp'])
      from pg_proc where oid in (
        to_regprocedure('public.record_work_order_external_billing_v1(text,integer,integer,bigint,uuid,text,text,date,text)'),
        to_regprocedure('public.get_work_order_external_billing_v1(text)')
      )) as protected_functions,
    coalesce(has_function_privilege('authenticated',to_regprocedure('public.record_work_order_external_billing_v1(text,integer,integer,bigint,uuid,text,text,date,text)'),'execute'),false) as authenticated_execute,
    coalesce(not has_function_privilege('anon',to_regprocedure('public.record_work_order_external_billing_v1(text,integer,integer,bigint,uuid,text,text,date,text)'),'execute'),false) as anon_denied,
    coalesce(not has_function_privilege('service_role',to_regprocedure('public.record_work_order_external_billing_v1(text,integer,integer,bigint,uuid,text,text,date,text)'),'execute'),false) as service_role_denied,
    coalesce(not has_table_privilege('authenticated',to_regclass('public.work_order_external_billings'),'select,insert,update,delete'),false) as direct_ledger_access_denied,
    exists(select 1 from pg_trigger where tgrelid='public.activities'::regclass
      and tgname='zz_protect_external_billing_activity' and tgenabled='O') as immutable_activity_guard,
    exists(select 1 from pg_trigger where tgrelid=to_regclass('public.work_order_external_billings')
      and tgname='protect_external_billing_record' and tgenabled='O') as immutable_ledger_guard,
    exists(select 1 from pg_trigger where tgrelid='public.invoices'::regclass
      and tgname='prevent_invoice_after_external_billing' and tgenabled='O') as duplicate_invoice_guard
)
select case when ledger_exists and ledger_rls and protected_functions and authenticated_execute and anon_denied
  and service_role_denied and direct_ledger_access_denied and immutable_activity_guard and immutable_ledger_guard and duplicate_invoice_guard
  then 'PASS_0167_INSTALLED' else 'FAIL_0167_REVIEW_REQUIRED' end as deployment_status, checks.* from checks;
