with function_checks as (
  select
    exists (
      select 1
      from pg_proc proc_row
      join pg_namespace namespace_row
        on namespace_row.oid = proc_row.pronamespace
      where namespace_row.nspname = 'public'
        and proc_row.proname = 'claim_contractor_activity_alert_delivery'
        and proc_row.prosecdef
        and 'search_path=public, pg_temp' = any(proc_row.proconfig)
    ) as claim_function_guarded,
    exists (
      select 1
      from pg_proc proc_row
      join pg_namespace namespace_row
        on namespace_row.oid = proc_row.pronamespace
      where namespace_row.nspname = 'public'
        and proc_row.proname = 'complete_contractor_activity_alert_delivery'
        and proc_row.prosecdef
        and 'search_path=public, pg_temp' = any(proc_row.proconfig)
    ) as completion_function_guarded
),
privilege_checks as (
  select
    not coalesce(has_table_privilege(
      'anon', 'public.contractor_activity_alert_deliveries', 'SELECT'
    ), false)
      and not coalesce(has_table_privilege(
        'anon', 'public.contractor_activity_alert_deliveries', 'INSERT'
      ), false)
      and not coalesce(has_table_privilege(
        'anon', 'public.contractor_activity_alert_deliveries', 'UPDATE'
      ), false)
      and not coalesce(has_table_privilege(
        'anon', 'public.contractor_activity_alert_deliveries', 'DELETE'
      ), false) as anonymous_table_access_blocked,
    not coalesce(has_table_privilege(
      'authenticated', 'public.contractor_activity_alert_deliveries', 'SELECT'
    ), false)
      and not coalesce(has_table_privilege(
        'authenticated', 'public.contractor_activity_alert_deliveries', 'INSERT'
      ), false)
      and not coalesce(has_table_privilege(
        'authenticated', 'public.contractor_activity_alert_deliveries', 'UPDATE'
      ), false)
      and not coalesce(has_table_privilege(
        'authenticated', 'public.contractor_activity_alert_deliveries', 'DELETE'
      ), false) as authenticated_table_access_blocked,
    coalesce(has_table_privilege(
      'service_role', 'public.contractor_activity_alert_deliveries', 'SELECT'
    ), false)
      and coalesce(has_table_privilege(
        'service_role', 'public.contractor_activity_alert_deliveries', 'INSERT'
      ), false)
      and coalesce(has_table_privilege(
        'service_role', 'public.contractor_activity_alert_deliveries', 'UPDATE'
      ), false)
      and coalesce(has_table_privilege(
        'service_role', 'public.contractor_activity_alert_deliveries', 'DELETE'
      ), false) as service_role_table_access_enabled,
    not has_function_privilege(
      'anon',
      'public.claim_contractor_activity_alert_delivery(uuid,text,uuid)',
      'EXECUTE'
    ) as anonymous_claim_execute_blocked,
    not has_function_privilege(
      'anon',
      'public.complete_contractor_activity_alert_delivery(uuid,text,text)',
      'EXECUTE'
    ) as anonymous_completion_execute_blocked,
    not has_function_privilege(
      'authenticated',
      'public.claim_contractor_activity_alert_delivery(uuid,text,uuid)',
      'EXECUTE'
    ) as authenticated_claim_execute_blocked,
    not has_function_privilege(
      'authenticated',
      'public.complete_contractor_activity_alert_delivery(uuid,text,text)',
      'EXECUTE'
    ) as authenticated_completion_execute_blocked,
    has_function_privilege(
      'service_role',
      'public.claim_contractor_activity_alert_delivery(uuid,text,uuid)',
      'EXECUTE'
    ) as service_role_claim_execute_enabled,
    has_function_privilege(
      'service_role',
      'public.complete_contractor_activity_alert_delivery(uuid,text,text)',
      'EXECUTE'
    ) as service_role_completion_execute_enabled
),
table_checks as (
  select
    coalesce(table_row.relrowsecurity, false) as delivery_table_rls_enabled,
    exists (
      select 1
      from pg_constraint constraint_row
      where constraint_row.conrelid
          = 'public.contractor_activity_alert_deliveries'::regclass
        and constraint_row.contype = 'p'
        and pg_get_constraintdef(constraint_row.oid)
          = 'PRIMARY KEY (activity_id)'
    ) as one_delivery_per_activity
  from pg_class table_row
  join pg_namespace namespace_row
    on namespace_row.oid = table_row.relnamespace
  where namespace_row.nspname = 'public'
    and table_row.relname = 'contractor_activity_alert_deliveries'
),
issue_counts as (
  select
    count(*) filter (
      where activity.id is null
        or work_order.id is null
        or delivery.work_order_id <> activity.work_order_id
        or delivery.contractor_assignment_version
          <> activity.contractor_assignment_version
        or not (
          (
            delivery.contractor_assignment_version
              = work_order.contractor_assignment_version
            and delivery.contractor_id = work_order.contractor_id
          )
          or exists (
            select 1
            from public.work_order_assignment_history history
            where history.work_order_id = delivery.work_order_id
              and history.assignment_version
                = delivery.contractor_assignment_version
              and history.contractor_id = delivery.contractor_id
          )
        )
    ) as delivery_scope_issue_count,
    count(*) filter (
      where (delivery.status = 'claimed' and delivery.completed_at is not null)
        or (delivery.status in ('sent', 'unknown') and delivery.completed_at is null)
        or (delivery.status = 'sent' and delivery.error_message is not null)
        or (delivery.status = 'unknown' and delivery.error_message is null)
    ) as delivery_state_issue_count
  from public.contractor_activity_alert_deliveries delivery
  left join public.activities activity
    on activity.id = delivery.activity_id
  left join public.work_orders work_order
    on work_order.id = delivery.work_order_id
)
select
  function_checks.claim_function_guarded,
  function_checks.completion_function_guarded,
  privilege_checks.anonymous_table_access_blocked,
  privilege_checks.authenticated_table_access_blocked,
  privilege_checks.service_role_table_access_enabled,
  privilege_checks.anonymous_claim_execute_blocked,
  privilege_checks.anonymous_completion_execute_blocked,
  privilege_checks.authenticated_claim_execute_blocked,
  privilege_checks.authenticated_completion_execute_blocked,
  privilege_checks.service_role_claim_execute_enabled,
  privilege_checks.service_role_completion_execute_enabled,
  table_checks.delivery_table_rls_enabled,
  table_checks.one_delivery_per_activity,
  issue_counts.delivery_scope_issue_count,
  issue_counts.delivery_state_issue_count,
  function_checks.claim_function_guarded
    and function_checks.completion_function_guarded
    and privilege_checks.anonymous_table_access_blocked
    and privilege_checks.authenticated_table_access_blocked
    and privilege_checks.service_role_table_access_enabled
    and privilege_checks.anonymous_claim_execute_blocked
    and privilege_checks.anonymous_completion_execute_blocked
    and privilege_checks.authenticated_claim_execute_blocked
    and privilege_checks.authenticated_completion_execute_blocked
    and privilege_checks.service_role_claim_execute_enabled
    and privilege_checks.service_role_completion_execute_enabled
    and table_checks.delivery_table_rls_enabled
    and table_checks.one_delivery_per_activity
    and issue_counts.delivery_scope_issue_count = 0
    and issue_counts.delivery_state_issue_count = 0
    as all_checks_pass
from function_checks
cross join privilege_checks
cross join table_checks
cross join issue_counts;
