-- Read-only deployment check for migration 0164.
with definitions as (
  select
    coalesce((select p.prosrc from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='p1_read_contracts' and p.proname='validate_v1'),'') validation_source,
    coalesce((select p.prosrc from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='p1_read_contracts' and p.proname='work_orders_v1'),'') generic_source,
    coalesce((select p.prosrc from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='p1_portal_reads' and p.proname='work_orders_table_v2'),'') table_source
), checks as (
  select
    validation_source like '%capital_waiting_quote%'
      and validation_source like '%capital_installed%' as filter_vocabulary_installed,
    generic_source like '%coalesce(work_order.is_capital,false)%'
      and table_source like '%coalesce(work_order.is_capital,false)%' as capital_identity_scope_installed,
    generic_source like '%capital_quote_submitted%'
      and table_source like '%capital_quote_submitted%' as stage_filters_installed,
    generic_source like '%work_order.status::text <> ''closed''%'
      and table_source like '%work_order.status::text <> ''closed''%' as closed_work_excluded,
    not exists (
      select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where (n.nspname,p.proname) in (('p1_read_contracts','validate_v1'),
        ('p1_read_contracts','work_orders_v1'),('p1_portal_reads','work_orders_table_v2'))
        and (p.prosecdef or p.provolatile<>'s')
    ) as security_shape_preserved,
    has_function_privilege('authenticated','public.list_work_orders_rows_v1(text,text,uuid,text,text,text,text,date,date,boolean,text,boolean,integer,text,text,uuid[])','EXECUTE')
      and has_function_privilege('authenticated','public.list_work_orders_table_rows_v2(text,text,uuid,text,text,text,text,date,date,boolean,text,boolean,integer,text,text,uuid[],text,text,text,text,text,text,text,date,date,text)','EXECUTE')
      as authenticated_execute_preserved
  from definitions
)
select case when filter_vocabulary_installed and capital_identity_scope_installed
    and stage_filters_installed and closed_work_excluded and security_shape_preserved
    and authenticated_execute_preserved
  then 'PASS_0164_INSTALLED' else 'FAIL_0164_NEEDS_REVIEW' end deployment_status,
  checks.* from checks;

