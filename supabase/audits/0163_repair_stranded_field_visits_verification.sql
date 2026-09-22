-- Run after migration 0163. This is a read-only structural verification; it
-- does not repair or otherwise change production data.

with definitions as (
  select
    to_regprocedure(
      'public.record_missed_work_order_visit_checkout_v1(uuid,integer,integer,bigint,uuid,timestamp with time zone,text)'
    ) as repair_function,
    to_regprocedure('public.assert_offsite_work_order_has_no_open_visit()') as invariant_function
), details as (
  select
    definitions.*,
    coalesce(pg_get_functiondef(definitions.repair_function), '') as repair_definition,
    coalesce(pg_get_functiondef(definitions.invariant_function), '') as invariant_definition
  from definitions
), checks as (
  select
    to_regclass('public.work_order_visit_checkout_repairs') is not null as audit_table_exists,
    repair_function is not null as repair_function_exists,
    invariant_function is not null as invariant_function_exists,
    repair_definition ilike '%security definer%' as repair_security_definer,
    repair_definition ilike '%set search_path to ''public'', ''pg_temp''%'
      or repair_definition ilike '%set search_path to public, pg_temp%'
      or repair_definition ilike '%set search_path = public, pg_temp%' as repair_fixed_search_path,
    repair_definition like '%p_expected_assignment_version%'
      and repair_definition like '%p_expected_workflow_cycle%'
      and repair_definition like '%p_expected_lifecycle_version%' as current_versions_required,
    repair_definition like '%visit_time_corrected%'
      and repair_definition like '%repairKind%'
      and repair_definition like '%missed_checkout%' as immutable_audit_installed,
    invariant_definition like '%Awaiting Parts%'
      and invariant_definition like '%Completed%' as offsite_states_guarded,
    exists (
      select 1 from pg_trigger trigger
      where trigger.tgname = 'work_orders_offsite_visit_closed'
        and trigger.tgconstraint <> 0
        and not trigger.tgisinternal
    ) as parent_constraint_trigger_exists,
    exists (
      select 1 from pg_trigger trigger
      where trigger.tgname = 'work_order_visits_offsite_parent_consistent'
        and trigger.tgconstraint <> 0
        and not trigger.tgisinternal
    ) as visit_constraint_trigger_exists,
    has_function_privilege(
      'authenticated',
      'public.record_missed_work_order_visit_checkout_v1(uuid,integer,integer,bigint,uuid,timestamp with time zone,text)',
      'EXECUTE'
    ) as authenticated_can_execute,
    not has_function_privilege(
      'anon',
      'public.record_missed_work_order_visit_checkout_v1(uuid,integer,integer,bigint,uuid,timestamp with time zone,text)',
      'EXECUTE'
    ) as anon_cannot_execute,
    not has_function_privilege(
      'service_role',
      'public.record_missed_work_order_visit_checkout_v1(uuid,integer,integer,bigint,uuid,timestamp with time zone,text)',
      'EXECUTE'
    ) as service_role_cannot_execute
  from details
)
select
  case when audit_table_exists
      and repair_function_exists
      and invariant_function_exists
      and repair_security_definer
      and repair_fixed_search_path
      and current_versions_required
      and immutable_audit_installed
      and offsite_states_guarded
      and parent_constraint_trigger_exists
      and visit_constraint_trigger_exists
      and authenticated_can_execute
      and anon_cannot_execute
      and service_role_cannot_execute
    then 'PASS_0163_INSTALLED'
    else 'FAIL_0163_NEEDS_REVIEW'
  end as deployment_status,
  checks.*
from checks;
