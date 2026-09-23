-- Run after migration 0166. This read-only audit verifies the range guard and
-- preserves the correction RPC's existing security boundary.

with sample_clock as (
  select clock_timestamp() as as_of
), routines as (
  select
    p.proname,
    p.prosecdef,
    p.proconfig,
    p.prosrc
  from pg_proc p
  join pg_namespace namespace on namespace.oid = p.pronamespace
  where namespace.nspname = 'public'
    and p.proname in (
      'correct_work_order_visit',
      'correct_work_order_visit_lc_core'
    )
    and pg_get_function_identity_arguments(p.oid)
      = 'p_visit_id uuid, p_check_in_at timestamp with time zone, p_check_out_at timestamp with time zone, p_reason text'
), checks as (
  select
    count(*) = 2 as all_functions_exist,
    bool_and(prosecdef) as security_definers_preserved,
    bool_and(proconfig @> array['search_path=public, pg_temp']) as fixed_search_paths_preserved,
    bool_and(
      prosrc like '%greatest(other.check_in_at, coalesce(other.check_out_at, now()))%'
      and prosrc not like '%tstzrange(other.check_in_at, coalesce(other.check_out_at, now()),%'
    ) as safe_overlap_ranges_installed,
    bool_and(prosrc like '%The corrected time overlaps another visit for this technician%')
      as overlap_policy_preserved,
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
    ) as private_core_not_executable,
    bool_and(isempty(tstzrange(
      sample_clock.as_of + interval '1 hour',
      greatest(sample_clock.as_of + interval '1 hour', sample_clock.as_of),
      '[)'
    ))) as future_open_interval_is_safe
  from routines
  cross join sample_clock
)
select
  case when all_functions_exist
      and security_definers_preserved
      and fixed_search_paths_preserved
      and safe_overlap_ranges_installed
      and overlap_policy_preserved
      and authenticated_can_execute
      and anon_cannot_execute
      and private_core_not_executable
      and future_open_interval_is_safe
    then 'PASS_0166_INSTALLED'
    else 'FAIL_0166_NEEDS_REVIEW'
  end as deployment_status,
  checks.*
from checks;
