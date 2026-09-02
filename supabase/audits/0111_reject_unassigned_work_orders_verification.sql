with function_checks as (
  select
    exists (
      select 1
      from pg_proc proc_row
      join pg_namespace namespace_row
        on namespace_row.oid = proc_row.pronamespace
      where namespace_row.nspname = 'public'
        and proc_row.proname = 'reject_unassigned_work_order'
        and proc_row.prosecdef
        and 'search_path=public, pg_temp' = any(proc_row.proconfig)
    ) as rejection_function_guarded,
    exists (
      select 1
      from pg_proc proc_row
      join pg_namespace namespace_row
        on namespace_row.oid = proc_row.pronamespace
      where namespace_row.nspname = 'public'
        and proc_row.proname = 'guard_work_order_archive_mutations'
        and proc_row.prosecdef
        and 'search_path=public, pg_temp' = any(proc_row.proconfig)
    ) as archive_guard_function_guarded
    ,
    exists (
      select 1
      from pg_proc proc_row
      join pg_namespace namespace_row
        on namespace_row.oid = proc_row.pronamespace
      where namespace_row.nspname = 'public'
        and proc_row.proname = 'guard_invoice_active_work_order'
        and proc_row.prosecdef
        and 'search_path=public, pg_temp' = any(proc_row.proconfig)
    ) as invoice_parent_guard_function_guarded
),
definition_checks as (
  select
    position('for update' in lower(pg_get_functiondef(proc_row.oid))) > 0
      as rejection_locks_work_order,
    position('contractor_assignment_version <> 0' in pg_get_functiondef(proc_row.oid)) > 0
      and position('billing_only' in pg_get_functiondef(proc_row.oid)) > 0
      and position('work_order_assignment_history' in pg_get_functiondef(proc_row.oid)) > 0
      and position('public.invoices' in pg_get_functiondef(proc_row.oid)) > 0
      as never_assigned_state_enforced,
    position('profile.active = true' in pg_get_functiondef(proc_row.oid)) > 0
      and position('invoice_controller' in pg_get_functiondef(proc_row.oid)) > 0
      as operational_staff_enforced,
    position('work_order_rejected' in pg_get_functiondef(proc_row.oid)) > 0
      and position('deleted_at = v_now' in pg_get_functiondef(proc_row.oid)) > 0
      and position(
        'delete ' || 'from public.work_orders'
        in lower(pg_get_functiondef(proc_row.oid))
      ) = 0
      as audited_soft_removal_only
  from pg_proc proc_row
  join pg_namespace namespace_row
    on namespace_row.oid = proc_row.pronamespace
  where namespace_row.nspname = 'public'
    and proc_row.proname = 'reject_unassigned_work_order'
),
trigger_checks as (
  select
    exists (
      select 1
      from pg_trigger trigger_row
      where trigger_row.tgrelid = 'public.work_orders'::regclass
        and trigger_row.tgname = 'guard_work_order_archive_mutations_trigger'
        and not trigger_row.tgisinternal
        and trigger_row.tgenabled <> 'D'
    ) as archive_guard_trigger_enabled,
    exists (
      select 1
      from pg_trigger trigger_row
      where trigger_row.tgrelid = 'public.invoices'::regclass
        and trigger_row.tgname = 'guard_invoice_active_work_order_trigger'
        and not trigger_row.tgisinternal
        and trigger_row.tgenabled <> 'D'
        and position(
          'deleted_at' in lower(pg_get_triggerdef(trigger_row.oid))
        ) > 0
    ) as invoice_parent_guard_trigger_enabled,
    coalesce((
      select position('for share' in lower(pg_get_functiondef(proc_row.oid))) > 0
        and position(
          'work_order.deleted_at is null'
          in lower(pg_get_functiondef(proc_row.oid))
        ) > 0
      from pg_proc proc_row
      join pg_namespace namespace_row
        on namespace_row.oid = proc_row.pronamespace
      where namespace_row.nspname = 'public'
        and proc_row.proname = 'guard_invoice_active_work_order'
    ), false) as invoice_parent_lock_guarded,
    coalesce((
      select position(
          'old.deleted_at is not null'
          in lower(pg_get_functiondef(proc_row.oid))
        ) > 0
        and position(
          'new.deleted_at is null'
          in lower(pg_get_functiondef(proc_row.oid))
        ) > 0
      from pg_proc proc_row
      join pg_namespace namespace_row
        on namespace_row.oid = proc_row.pronamespace
      where namespace_row.nspname = 'public'
        and proc_row.proname = 'guard_invoice_active_work_order'
    ), false) as invoice_restore_guarded,
    coalesce((
      select position(
          'service_role'
          in lower(pg_get_functiondef(proc_row.oid))
        ) = 0
      from pg_proc proc_row
      join pg_namespace namespace_row
        on namespace_row.oid = proc_row.pronamespace
      where namespace_row.nspname = 'public'
        and proc_row.proname = 'guard_invoice_active_work_order'
    ), false) as service_role_invoice_parent_guarded
),
privilege_checks as (
  select
    not has_function_privilege(
      'anon',
      'public.reject_unassigned_work_order(text,text)',
      'EXECUTE'
    ) as anonymous_rejection_blocked,
    has_function_privilege(
      'authenticated',
      'public.reject_unassigned_work_order(text,text)',
      'EXECUTE'
    ) as authenticated_rejection_enabled,
    has_function_privilege(
      'service_role',
      'public.reject_unassigned_work_order(text,text)',
      'EXECUTE'
    ) as service_role_rejection_enabled,
    not has_function_privilege(
      'authenticated',
      'public.guard_work_order_archive_mutations()',
      'EXECUTE'
    ) as archive_guard_not_directly_executable,
    not has_function_privilege(
      'authenticated',
      'public.guard_invoice_active_work_order()',
      'EXECUTE'
    ) as invoice_parent_guard_not_directly_executable
),
issue_counts as (
  select
    count(*) filter (
      where activity.activity_channel <> 'system_event'
        or not activity.is_staff_only
        or activity.requires_7eleven_sync
        or activity.requires_contractor_attention
    ) as rejection_activity_scope_issue_count,
    count(*) filter (
      where work_order.id is null
        or work_order.deleted_at is null
        or work_order.deleted_by is distinct from activity.author_id
        or work_order.status <> 'unassigned'
        or work_order.contractor_id is not null
        or work_order.contractor_assignment_version <> 0
    ) as rejected_work_order_state_issue_count,
    count(*) filter (
      where exists (
        select 1
        from public.invoices invoice
        where invoice.work_order_id = activity.work_order_id
          and invoice.deleted_at is null
      )
    ) as rejected_work_order_invoice_issue_count
  from public.activities activity
  left join public.work_orders work_order
    on work_order.id = activity.work_order_id
  where activity.event_key = 'work_order_rejected'
    and activity.deleted_at is null
)
select
  function_checks.rejection_function_guarded,
  function_checks.archive_guard_function_guarded,
  function_checks.invoice_parent_guard_function_guarded,
  definition_checks.rejection_locks_work_order,
  definition_checks.never_assigned_state_enforced,
  definition_checks.operational_staff_enforced,
  definition_checks.audited_soft_removal_only,
  trigger_checks.archive_guard_trigger_enabled,
  trigger_checks.invoice_parent_guard_trigger_enabled,
  trigger_checks.invoice_parent_lock_guarded,
  trigger_checks.invoice_restore_guarded,
  trigger_checks.service_role_invoice_parent_guarded,
  privilege_checks.anonymous_rejection_blocked,
  privilege_checks.authenticated_rejection_enabled,
  privilege_checks.service_role_rejection_enabled,
  privilege_checks.archive_guard_not_directly_executable,
  privilege_checks.invoice_parent_guard_not_directly_executable,
  issue_counts.rejection_activity_scope_issue_count,
  issue_counts.rejected_work_order_state_issue_count,
  issue_counts.rejected_work_order_invoice_issue_count,
  function_checks.rejection_function_guarded
    and function_checks.archive_guard_function_guarded
    and function_checks.invoice_parent_guard_function_guarded
    and definition_checks.rejection_locks_work_order
    and definition_checks.never_assigned_state_enforced
    and definition_checks.operational_staff_enforced
    and definition_checks.audited_soft_removal_only
    and trigger_checks.archive_guard_trigger_enabled
    and trigger_checks.invoice_parent_guard_trigger_enabled
    and trigger_checks.invoice_parent_lock_guarded
    and trigger_checks.invoice_restore_guarded
    and trigger_checks.service_role_invoice_parent_guarded
    and privilege_checks.anonymous_rejection_blocked
    and privilege_checks.authenticated_rejection_enabled
    and privilege_checks.service_role_rejection_enabled
    and privilege_checks.archive_guard_not_directly_executable
    and privilege_checks.invoice_parent_guard_not_directly_executable
    and issue_counts.rejection_activity_scope_issue_count = 0
    and issue_counts.rejected_work_order_state_issue_count = 0
    and issue_counts.rejected_work_order_invoice_issue_count = 0
    as all_checks_pass
from function_checks
cross join definition_checks
cross join trigger_checks
cross join privilege_checks
cross join issue_counts;
