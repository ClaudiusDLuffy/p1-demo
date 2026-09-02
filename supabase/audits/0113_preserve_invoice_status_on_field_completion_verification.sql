-- Run after migration 0113. Deployment is complete only when every check and
-- all_checks_pass return true.

with definition as (
  select
    coalesce(pg_get_functiondef(function_row.oid), '') as source,
    function_row.prosecdef as security_definer,
    coalesce(function_row.proconfig, array[]::text[]) as settings
  from pg_proc function_row
  where function_row.oid = to_regprocedure(
    'public.complete_work_order_once(text,timestamptz,text,text,text,integer,text,text,text)'
  )
),
reopen_guard_definition as (
  select
    coalesce(pg_get_functiondef(function_row.oid), '') as source,
    function_row.prosecdef as security_definer,
    coalesce(function_row.proconfig, array[]::text[]) as settings
  from pg_proc function_row
  where function_row.oid = to_regprocedure(
    'public.prevent_direct_work_order_reopen()'
  )
),
checks as (
  select
    exists (select 1 from definition)
      as completion_function_present,

    coalesce((select security_definer from definition), false)
      as security_definer_preserved,

    coalesce((
      select settings @> array['search_path=public, pg_temp']::text[]
      from definition
    ), false) as search_path_pinned,

    coalesce((
      select source like '%profile.active = true%'
        and source like '%if not found%'
        and source like '%Active portal profile required%'
      from definition
    ), false) as active_profile_required,

    coalesce((
      select source like '%can_access_contractor_work_order%'
        and source like '%for update%'
        and source like '%profile_has_staff_permission%'
        and source like '%invoice_controller%'
      from definition
    ), false) as assignment_scope_and_row_lock_preserved,

    coalesce((
      select source like '%v_work_order.functional_status::text = ''Completed''%'
        and source like '%''already_completed''%'
      from definition
    ), false) as functional_completion_replay_safe,

    coalesce((
      select source like '%v_work_order.billing_only%'
        and source like '%status::text not in%'
        and source like '%''wip''%'
        and source like '%''pending_invoice''%'
        and source like '%''pending_approval''%'
        and source like '%''pending_payment''%'
        and source like '%Completion time is required%'
        and source like '%Equipment make, model, and serial number are required%'
      from definition
    ), false) as server_completion_inputs_guarded,

    coalesce((
      select lower(source) like '%''pending_invoice''%'
        and lower(source) like '%''pending_approval''%'
        and lower(source) like '%''pending_payment''%'
        and lower(source) like '%then v_work_order.status%'
        and lower(source) like '%status = v_result_status%'
      from definition
    ), false) as invoice_workflow_status_preserved,

    coalesce((
      select source like '%functional_status = ''Completed''%'
        and source like '%event_key%'
        and source like '%''job_completed''%'
      from definition
    ), false) as field_completion_and_activity_preserved,

    coalesce(has_function_privilege(
      'authenticated',
      'public.complete_work_order_once(text,timestamptz,text,text,text,integer,text,text,text)',
      'EXECUTE'
    ), false) as authenticated_execute_enabled,

    not coalesce(has_function_privilege(
      'anon',
      'public.complete_work_order_once(text,timestamptz,text,text,text,integer,text,text,text)',
      'EXECUTE'
    ), false) as anonymous_execute_blocked
    ,
    coalesce((
      select security_definer
        and settings @> array['search_path=public, pg_temp']::text[]
        and source like '%old.functional_status::text = ''Completed''%'
        and source like '%new.functional_status::text is distinct from ''Completed''%'
        and source like '%work_order_reopen_transition_guards%'
        and source like '%Completed field work must be reopened%'
      from reopen_guard_definition
    ), false) as completed_lifecycle_regression_blocked,

    exists (
      select 1
      from pg_trigger trigger_row
      where trigger_row.tgrelid = 'public.work_orders'::regclass
        and trigger_row.tgname = 'prevent_direct_work_order_reopen_trigger'
        and not trigger_row.tgisinternal
        and trigger_row.tgenabled <> 'D'
    ) as lifecycle_guard_trigger_enabled
)
select
  completion_function_present,
  security_definer_preserved,
  search_path_pinned,
  active_profile_required,
  assignment_scope_and_row_lock_preserved,
  functional_completion_replay_safe,
  server_completion_inputs_guarded,
  invoice_workflow_status_preserved,
  field_completion_and_activity_preserved,
  authenticated_execute_enabled,
  anonymous_execute_blocked,
  completed_lifecycle_regression_blocked,
  lifecycle_guard_trigger_enabled,
  completion_function_present
    and security_definer_preserved
    and search_path_pinned
    and active_profile_required
    and assignment_scope_and_row_lock_preserved
    and functional_completion_replay_safe
    and server_completion_inputs_guarded
    and invoice_workflow_status_preserved
    and field_completion_and_activity_preserved
    and authenticated_execute_enabled
    and anonymous_execute_blocked
    and completed_lifecycle_regression_blocked
    and lifecycle_guard_trigger_enabled
    as all_checks_pass
from checks;
