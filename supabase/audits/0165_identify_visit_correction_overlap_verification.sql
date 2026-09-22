-- Read-only deployment check for migration 0165.
with routine as (
  select
    p.oid,
    p.prosecdef,
    p.proconfig,
    p.prosrc
  from pg_proc p
  join pg_namespace namespace on namespace.oid = p.pronamespace
  where namespace.nspname = 'public'
    and p.proname = 'correct_work_order_visit'
    and pg_get_function_identity_arguments(p.oid)
      = 'p_visit_id uuid, p_check_in_at timestamp with time zone, p_check_out_at timestamp with time zone, p_reason text'
), checks as (
  select
    count(*) = 1 as function_exists,
    bool_and(prosecdef) as security_definer,
    bool_and(proconfig @> array['search_path=public, pg_temp']) as fixed_search_path,
    bool_and(prosrc like '%conflictingWorkOrderIds%'
      and prosrc like '%VISIT_TIME_OVERLAP%'
      and prosrc like '%can_access_contractor_work_order(other.work_order_id)%')
      as bounded_conflict_guidance_installed,
    has_function_privilege(
      'authenticated',
      'public.correct_work_order_visit(uuid,timestamp with time zone,timestamp with time zone,text)',
      'EXECUTE'
    ) as authenticated_can_execute,
    not has_function_privilege(
      'anon',
      'public.correct_work_order_visit(uuid,timestamp with time zone,timestamp with time zone,text)',
      'EXECUTE'
    ) as anon_cannot_execute,
    not has_function_privilege(
      'authenticated',
      'public.correct_work_order_visit_lc_core(uuid,timestamp with time zone,timestamp with time zone,text)',
      'EXECUTE'
    ) as private_core_not_executable
  from routine
)
select
  case when function_exists and security_definer and fixed_search_path
      and bounded_conflict_guidance_installed and authenticated_can_execute
      and anon_cannot_execute and private_core_not_executable
    then 'PASS_0165_INSTALLED'
    else 'FAIL_0165_NEEDS_REVIEW'
  end as deployment_status,
  checks.*
from checks;
