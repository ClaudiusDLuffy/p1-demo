-- Run after 0115_capital_work_orders_remain_operational.sql.
-- Every boolean must be true, every issue count must be zero, and
-- all_checks_pass must be true before releasing the migration.

with function_sources as (
  select
    lower(coalesce(pg_get_functiondef(to_regprocedure(
      'public.protect_work_order_assignment_boundary()'
    )), '')) as boundary_definition,
    lower(coalesce(pg_get_functiondef(to_regprocedure(
      'public.transition_work_order_contractor(text,uuid,integer)'
    )), '')) as transition_definition,
    lower(coalesce(pg_get_functiondef(to_regprocedure(
      'public.decline_capital_work_order(text,integer)'
    )), '')) as decline_definition,
    lower(coalesce(pg_get_functiondef(to_regprocedure(
      'public.guard_invoice_active_work_order()'
    )), '')) as invoice_guard_definition
),
catalog_checks as (
  select
    to_regclass('public.work_order_assignment_transition_guards')
      is not null as transition_guard_table_present,
    coalesce((
      select relation.relrowsecurity
      from pg_class relation
      where relation.oid = to_regclass(
        'public.work_order_assignment_transition_guards'
      )
    ), false) as transition_guard_rls_enabled,
    not exists (
      select 1
      from pg_policies policy_row
      where policy_row.schemaname = 'public'
        and policy_row.tablename =
          'work_order_assignment_transition_guards'
    ) as transition_guard_has_no_policies,
    not coalesce(has_table_privilege(
      'anon',
      'public.work_order_assignment_transition_guards',
      'SELECT'
    ), false)
      and not coalesce(has_table_privilege(
        'anon',
        'public.work_order_assignment_transition_guards',
        'INSERT'
      ), false)
      and not coalesce(has_table_privilege(
        'anon',
        'public.work_order_assignment_transition_guards',
        'UPDATE'
      ), false)
      and not coalesce(has_table_privilege(
        'anon',
        'public.work_order_assignment_transition_guards',
        'DELETE'
      ), false)
      and not coalesce(has_table_privilege(
        'authenticated',
        'public.work_order_assignment_transition_guards',
        'SELECT'
      ), false)
      and not coalesce(has_table_privilege(
        'authenticated',
        'public.work_order_assignment_transition_guards',
        'INSERT'
      ), false)
      and not coalesce(has_table_privilege(
        'authenticated',
        'public.work_order_assignment_transition_guards',
        'UPDATE'
      ), false)
      and not coalesce(has_table_privilege(
        'authenticated',
        'public.work_order_assignment_transition_guards',
        'DELETE'
      ), false)
      and not coalesce(has_table_privilege(
        'service_role',
        'public.work_order_assignment_transition_guards',
        'SELECT'
      ), false)
      and not coalesce(has_table_privilege(
        'service_role',
        'public.work_order_assignment_transition_guards',
        'INSERT'
      ), false)
      and not coalesce(has_table_privilege(
        'service_role',
        'public.work_order_assignment_transition_guards',
        'UPDATE'
      ), false)
      and not coalesce(has_table_privilege(
        'service_role',
        'public.work_order_assignment_transition_guards',
        'DELETE'
      ), false)
      as transition_guard_table_private,
    exists (
      select 1
      from pg_trigger trigger_row
      where trigger_row.tgrelid = 'public.work_orders'::regclass
        and trigger_row.tgname =
          'protect_work_order_assignment_boundary_trigger'
        and trigger_row.tgfoid = to_regprocedure(
          'public.protect_work_order_assignment_boundary()'
        )
        and not trigger_row.tgisinternal
        and trigger_row.tgenabled <> 'D'
    ) as assignment_boundary_trigger_enabled,
    (
      select count(*) = 5
      from pg_trigger trigger_row
      where trigger_row.tgrelid = 'public.work_orders'::regclass
        and trigger_row.tgname in (
          'archive_assignment_financials_trigger',
          'clear_technician_on_contractor_change_trigger',
          'preserve_operational_work_order_status_trigger',
          'protect_work_order_assignment_boundary_trigger',
          'queue_contractor_assignment_transition_delivery_trigger'
        )
        and not trigger_row.tgisinternal
        and trigger_row.tgenabled <> 'D'
        and (trigger_row.tgtype & 1) = 1
        and (trigger_row.tgtype & 16) = 16
        and trigger_row.tgfoid = case trigger_row.tgname
          when 'archive_assignment_financials_trigger' then
            to_regprocedure('public.archive_assignment_financials()')
          when 'clear_technician_on_contractor_change_trigger' then
            to_regprocedure(
              'public.clear_technician_on_contractor_change()'
            )
          when 'preserve_operational_work_order_status_trigger' then
            to_regprocedure(
              'public.preserve_operational_work_order_status()'
            )
          when 'protect_work_order_assignment_boundary_trigger' then
            to_regprocedure(
              'public.protect_work_order_assignment_boundary()'
            )
          when 'queue_contractor_assignment_transition_delivery_trigger' then
            to_regprocedure(
              'public.queue_contractor_assignment_transition_delivery()'
            )
        end
        and (
          (
            trigger_row.tgname in (
              'clear_technician_on_contractor_change_trigger',
              'preserve_operational_work_order_status_trigger',
              'protect_work_order_assignment_boundary_trigger'
            )
            and (trigger_row.tgtype & 2) = 2
          )
          or (
            trigger_row.tgname in (
              'archive_assignment_financials_trigger',
              'queue_contractor_assignment_transition_delivery_trigger'
            )
            and (trigger_row.tgtype & 2) = 0
          )
        )
    ) as companion_assignment_triggers_enabled,
    exists (
      select 1
      from pg_trigger trigger_row
      where trigger_row.tgrelid = 'public.invoices'::regclass
        and trigger_row.tgname = 'guard_invoice_active_work_order_trigger'
        and trigger_row.tgfoid = to_regprocedure(
          'public.guard_invoice_active_work_order()'
        )
        and not trigger_row.tgisinternal
        and trigger_row.tgenabled <> 'D'
        and pg_get_triggerdef(trigger_row.oid) ilike
          '%work_order_id, contractor_id, deleted_at%'
    ) as invoice_assignment_guard_trigger_enabled,
    exists (
      select 1
      from pg_policies policy_row
      where policy_row.schemaname = 'public'
        and policy_row.tablename = 'work_order_technician_assignments'
        and policy_row.policyname =
          'work_order_technician_assignments_read'
        and lower(coalesce(policy_row.qual, '')) like
          '%can_manage_work_order_technician%'
        and lower(coalesce(policy_row.qual, '')) like
          '%contractor_assignment_started_at%'
        and lower(coalesce(policy_row.qual, '')) like '%assigned_at%'
        and lower(coalesce(policy_row.qual, '')) like
          '%technician.contractor_id = work_order.contractor_id%'
    ) as technician_history_current_assignment_scoped
),
function_catalog_checks as (
  select
    coalesce((
      select function_row.prosecdef
        and coalesce(
          'search_path=public, pg_temp' = any(function_row.proconfig),
          false
        )
      from pg_proc function_row
      where function_row.oid = to_regprocedure(
        'public.protect_work_order_assignment_boundary()'
      )
    ), false) as boundary_function_guarded,
    coalesce((
      select function_row.prosecdef
        and coalesce(
          'search_path=public, pg_temp' = any(function_row.proconfig),
          false
        )
      from pg_proc function_row
      where function_row.oid = to_regprocedure(
        'public.transition_work_order_contractor(text,uuid,integer)'
      )
    ), false) as transition_function_guarded,
    coalesce((
      select function_row.prosecdef
        and coalesce(
          'search_path=public, pg_temp' = any(function_row.proconfig),
          false
        )
      from pg_proc function_row
      where function_row.oid = to_regprocedure(
        'public.decline_capital_work_order(text,integer)'
      )
    ), false) as decline_function_guarded,
    coalesce((
      select function_row.prosecdef
        and coalesce(
          'search_path=public, pg_temp' = any(function_row.proconfig),
          false
        )
      from pg_proc function_row
      where function_row.oid = to_regprocedure(
        'public.guard_invoice_active_work_order()'
      )
    ), false) as invoice_guard_function_guarded
),
permission_checks as (
  select
    not coalesce(has_function_privilege(
      'anon',
      to_regprocedure(
        'public.transition_work_order_contractor(text,uuid,integer)'
      ),
      'EXECUTE'
    ), false) as anonymous_transition_blocked,
    coalesce(has_function_privilege(
      'authenticated',
      to_regprocedure(
        'public.transition_work_order_contractor(text,uuid,integer)'
      ),
      'EXECUTE'
    ), false) as authenticated_transition_enabled,
    not coalesce(has_function_privilege(
      'anon',
      to_regprocedure('public.decline_capital_work_order(text,integer)'),
      'EXECUTE'
    ), false) as anonymous_decline_blocked,
    coalesce(has_function_privilege(
      'authenticated',
      to_regprocedure('public.decline_capital_work_order(text,integer)'),
      'EXECUTE'
    ), false) as authenticated_decline_enabled,
    not coalesce(has_function_privilege(
      'anon',
      to_regprocedure('public.protect_work_order_assignment_boundary()'),
      'EXECUTE'
    ), false)
      and not coalesce(has_function_privilege(
        'anon',
        to_regprocedure('public.guard_invoice_active_work_order()'),
        'EXECUTE'
      ), false)
      and not coalesce(has_function_privilege(
        'authenticated',
        to_regprocedure('public.protect_work_order_assignment_boundary()'),
        'EXECUTE'
      ), false)
      and not coalesce(has_function_privilege(
        'authenticated',
        to_regprocedure('public.guard_invoice_active_work_order()'),
        'EXECUTE'
      ), false)
      as trigger_helpers_not_directly_executable
),
function_checks as (
  select
    position('preserve_capital_identity' in boundary_definition) > 0
      and position('preserve_capital_stage' in boundary_definition) > 0
      and position('new.is_capital := preserve_capital_identity' in
        boundary_definition) > 0
      and position('new.capital_status := case' in boundary_definition) > 0
      and position('new.status := old.status' in boundary_definition) > 0
      as capital_lifecycle_preserved,
    position('new.status := ''assigned''' in boundary_definition) > 0
      and position('new.status := ''unassigned''' in boundary_definition) > 0
      and position('new.functional_status := ''dispatched''' in
        boundary_definition) > 0
      and position('new.functional_status := ''new''' in
        boundary_definition) > 0
      as ordinary_assignment_behavior_preserved,
    position('new.eta := null' in boundary_definition) > 0
      and position('new.start_time := null' in boundary_definition) > 0
      and position('new.end_time := null' in boundary_definition) > 0
      and position('new.technician_on_job := null' in
        boundary_definition) > 0
      and position('new.asset_model := null' in boundary_definition) > 0
      and position('new.resolution_notes := null' in
        boundary_definition) > 0
      and position('new.capital_notes := null' in boundary_definition) > 0
      and position('new.nte_flagged := false' in boundary_definition) > 0
      as outgoing_contractor_fields_cleared,
    position('for update' in transition_definition) > 0
      and position('p_expected_assignment_version' in
        transition_definition) > 0
      and position('work-order assignment changed' in
        transition_definition) > 0
      as transition_locked_and_versioned,
    position('''capital''' in transition_definition) > 0
      and position('''pending_capital_completion''' in
        transition_definition) > 0
      and position('active field or capital work order' in
        transition_definition) > 0
      as capital_assignment_states_allowed,
    position('update public.invoices' in boundary_definition) = 0
      and position('delete from public.invoices' in boundary_definition) = 0
      and position('update public.invoices' in transition_definition) = 0
      and position('delete from public.invoices' in transition_definition) = 0
      as linked_staff_billing_untouched,
    position('work_order_assignment_transition_guards' in
        boundary_definition) > 0
      and position('txid_current()' in boundary_definition) > 0
      and position('insert into public.work_order_assignment_transition_guards' in
        transition_definition) > 0
      and position('delete from public.work_order_assignment_transition_guards' in
        transition_definition) > 0
      and position('work-order assignments must use the guarded transition workflow'
        in boundary_definition) > 0
      as direct_assignment_mutations_blocked,
    position('for share' in invoice_guard_definition) > 0
      and position('new.contractor_id is distinct from' in
        invoice_guard_definition) > 0
      and position('contractor_assignment_started_at' in
        invoice_guard_definition) > 0
      and position('invoice.state not in (''approved'', ''paid'')' in
        transition_definition) > 0
      as invoice_assignment_race_guarded,
    position('invoice_controller' in transition_definition) > 0
      and position('profile.active = true' in transition_definition) > 0
      and position('profile.is_assignable = true' in
        transition_definition) > 0
      and position('outgoing contractor notification was not queued' in
        transition_definition) > 0
      and position('is_staff_only' in transition_definition) > 0
      as operational_transition_authorized_and_notified,
    position('''assignmentstartedat''' in transition_definition) > 0
      and position('''dispatchedat''' in transition_definition) > 0
      and position('''status''' in transition_definition) > 0
      and position('''functionalstatus''' in transition_definition) > 0
      and position('''iscapital''' in transition_definition) > 0
      and position('''capitalstatus''' in transition_definition) > 0
      as canonical_transition_state_returned,
    position('for update' in decline_definition) > 0
      and position('p_expected_assignment_version' in
        decline_definition) > 0
      and position('v_work_order.contractor_id is null' in
        decline_definition) > 0
      and position('v_next_status := ''unassigned''' in
        decline_definition) > 0
      and position('v_next_status := ''assigned''' in
        decline_definition) > 0
      and position('''capital_declined''' in decline_definition) > 0
      as capital_decline_atomic_and_assignment_safe
  from function_sources
),
data_checks as (
  select
    count(*) filter (
      where work_order.deleted_at is null
        and work_order.status::text in (
          'capital',
          'pending_capital_completion'
        )
        and not coalesce(work_order.is_capital, false)
    )::integer as capital_identity_issue_count,
    count(*) filter (
      where work_order.deleted_at is null
        and work_order.contractor_id is not null
        and (
          work_order.contractor_assignment_version < 1
          or work_order.contractor_assignment_started_at is null
        )
    )::integer as active_assignment_boundary_issue_count,
    count(*) filter (
      where work_order.deleted_at is null
        and work_order.contractor_id is null
        and work_order.contractor_assignment_started_at is not null
    )::integer as unassigned_boundary_issue_count
  from public.work_orders work_order
),
technician_scope_issues as (
  select count(*)::integer as current_technician_scope_issue_count
  from public.work_order_technician_assignments assignment
  join public.work_orders work_order
    on work_order.id = assignment.work_order_id
  left join public.contractor_technicians technician
    on technician.profile_id = assignment.technician_profile_id
   and technician.contractor_id = work_order.contractor_id
   and technician.is_active = true
  where assignment.ended_at is null
    and work_order.deleted_at is null
    and (
      work_order.contractor_id is null
      or work_order.contractor_assignment_started_at is null
      or assignment.assigned_at <
        work_order.contractor_assignment_started_at
      or technician.profile_id is null
    )
),
guard_residue as (
  select count(*)::integer as transition_guard_residue_count
  from public.work_order_assignment_transition_guards
)
select
  catalog_checks.transition_guard_table_present,
  catalog_checks.transition_guard_rls_enabled,
  catalog_checks.transition_guard_has_no_policies,
  catalog_checks.transition_guard_table_private,
  catalog_checks.assignment_boundary_trigger_enabled,
  catalog_checks.companion_assignment_triggers_enabled,
  catalog_checks.invoice_assignment_guard_trigger_enabled,
  catalog_checks.technician_history_current_assignment_scoped,
  function_catalog_checks.boundary_function_guarded,
  function_catalog_checks.transition_function_guarded,
  function_catalog_checks.decline_function_guarded,
  function_catalog_checks.invoice_guard_function_guarded,
  permission_checks.anonymous_transition_blocked,
  permission_checks.authenticated_transition_enabled,
  permission_checks.anonymous_decline_blocked,
  permission_checks.authenticated_decline_enabled,
  permission_checks.trigger_helpers_not_directly_executable,
  function_checks.capital_lifecycle_preserved,
  function_checks.ordinary_assignment_behavior_preserved,
  function_checks.outgoing_contractor_fields_cleared,
  function_checks.transition_locked_and_versioned,
  function_checks.capital_assignment_states_allowed,
  function_checks.linked_staff_billing_untouched,
  function_checks.direct_assignment_mutations_blocked,
  function_checks.invoice_assignment_race_guarded,
  function_checks.operational_transition_authorized_and_notified,
  function_checks.canonical_transition_state_returned,
  function_checks.capital_decline_atomic_and_assignment_safe,
  data_checks.capital_identity_issue_count,
  data_checks.active_assignment_boundary_issue_count,
  data_checks.unassigned_boundary_issue_count,
  technician_scope_issues.current_technician_scope_issue_count,
  guard_residue.transition_guard_residue_count,
  (
    catalog_checks.transition_guard_table_present
    and catalog_checks.transition_guard_rls_enabled
    and catalog_checks.transition_guard_has_no_policies
    and catalog_checks.transition_guard_table_private
    and catalog_checks.assignment_boundary_trigger_enabled
    and catalog_checks.companion_assignment_triggers_enabled
    and catalog_checks.invoice_assignment_guard_trigger_enabled
    and catalog_checks.technician_history_current_assignment_scoped
    and function_catalog_checks.boundary_function_guarded
    and function_catalog_checks.transition_function_guarded
    and function_catalog_checks.decline_function_guarded
    and function_catalog_checks.invoice_guard_function_guarded
    and permission_checks.anonymous_transition_blocked
    and permission_checks.authenticated_transition_enabled
    and permission_checks.anonymous_decline_blocked
    and permission_checks.authenticated_decline_enabled
    and permission_checks.trigger_helpers_not_directly_executable
    and function_checks.capital_lifecycle_preserved
    and function_checks.ordinary_assignment_behavior_preserved
    and function_checks.outgoing_contractor_fields_cleared
    and function_checks.transition_locked_and_versioned
    and function_checks.capital_assignment_states_allowed
    and function_checks.linked_staff_billing_untouched
    and function_checks.direct_assignment_mutations_blocked
    and function_checks.invoice_assignment_race_guarded
    and function_checks.operational_transition_authorized_and_notified
    and function_checks.canonical_transition_state_returned
    and function_checks.capital_decline_atomic_and_assignment_safe
    and data_checks.capital_identity_issue_count = 0
    and data_checks.active_assignment_boundary_issue_count = 0
    and data_checks.unassigned_boundary_issue_count = 0
    and technician_scope_issues.current_technician_scope_issue_count = 0
    and guard_residue.transition_guard_residue_count = 0
  ) as all_checks_pass
from catalog_checks
cross join function_catalog_checks
cross join permission_checks
cross join function_checks
cross join data_checks
cross join technician_scope_issues
cross join guard_residue;
