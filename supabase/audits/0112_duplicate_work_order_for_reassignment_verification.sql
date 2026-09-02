with function_source as (
  select coalesce(
    pg_get_functiondef(
      to_regprocedure(
        'public.duplicate_work_order_for_reassignment(text)'
      )
    ),
    ''
  ) as definition
),
catalog_checks as (
  select
    (
      select count(*) = 3
      from information_schema.columns column_row
      where column_row.table_schema = 'public'
        and column_row.table_name = 'work_orders'
        and column_row.column_name in (
          'duplicated_from_work_order_id',
          'duplicate_root_work_order_id',
          'duplicate_sequence'
        )
    ) as provenance_columns_present,
    (
      select count(*) = 2
      from pg_constraint constraint_row
      where constraint_row.conrelid = 'public.work_orders'::regclass
        and constraint_row.contype = 'f'
        and constraint_row.confdeltype = 'r'
        and constraint_row.conname in (
          'work_orders_duplicated_from_work_order_id_fkey',
          'work_orders_duplicate_root_work_order_id_fkey'
        )
    ) as provenance_foreign_keys_restrict_delete,
    exists (
      select 1
      from pg_constraint constraint_row
      where constraint_row.conrelid = 'public.work_orders'::regclass
        and constraint_row.conname
          = 'work_orders_duplicate_provenance_check'
        and constraint_row.contype = 'c'
        and constraint_row.convalidated
    ) as provenance_shape_constrained,
    to_regclass(
      'public.work_orders_duplicate_root_sequence_key'
    ) is not null as root_sequence_unique,
    exists (
      select 1
      from pg_trigger trigger_row
      where trigger_row.tgrelid = 'public.work_orders'::regclass
        and trigger_row.tgname
          = 'protect_work_order_duplicate_provenance_trigger'
        and not trigger_row.tgisinternal
        and trigger_row.tgenabled <> 'D'
    ) as provenance_trigger_installed,
    exists (
      select 1
      from pg_proc proc_row
      join pg_namespace namespace_row
        on namespace_row.oid = proc_row.pronamespace
      where namespace_row.nspname = 'public'
        and proc_row.proname = 'duplicate_work_order_for_reassignment'
        and proc_row.prosecdef
        and 'search_path=public, pg_temp' = any(proc_row.proconfig)
    ) as duplicate_function_guarded,
    exists (
      select 1
      from pg_proc proc_row
      join pg_namespace namespace_row
        on namespace_row.oid = proc_row.pronamespace
      where namespace_row.nspname = 'public'
        and proc_row.proname = 'duplicate_work_order_for_reassignment'
        and proc_row.prorettype = 'jsonb'::regtype
    ) as duplicate_function_returns_json
),
function_checks as (
  select
    function_source.definition ~
      'profile\.active = true' as active_staff_required,
    function_source.definition ~
      'profile\.role in \(' as operational_staff_roles_required,
    function_source.definition ~
      'not public\.profile_has_staff_permission\([[:space:][:print:]]*invoice_controller'
      as invoice_controller_blocked,
    function_source.definition ~
      'work_order\.deleted_at is null' as active_source_required,
    function_source.definition ~
      'v_source\.billing_only' as billing_source_blocked,
    function_source.definition ~
      'v_source\.is_capital' as capital_source_blocked,
    function_source.definition ~
      'v_source\.contractor_id is null' as contractor_assignment_required,
    function_source.definition ~
      'pending_payment' as operational_status_allowlist_present,
    position(
      '^WOT[0-9]{6,12}$' in function_source.definition
    ) > 0 as canonical_wot_root_required,
    position(
      'pg_advisory_xact_lock' in function_source.definition
    ) > 0 as root_allocation_locked,
    function_source.definition ~
      'where existing_work_order\.id = v_duplicate_work_order_id'
      as archived_ids_not_recycled,
    function_source.definition ~
      'on conflict \(id\) do nothing' as id_race_retried,
    position(
      'from public.work_order_financials' in function_source.definition
    ) > 0 as private_nte_copied,
    position(
      'insert into public.work_order_afm_contacts' in function_source.definition
    ) > 0 as private_afm_contact_copied,
    position(
      'insert into public.activities' in function_source.definition
    ) > 0
      and position(
        'work_order_duplicated' in function_source.definition
      ) > 0
      and position(
        'system_event' in function_source.definition
      ) > 0 as staff_audit_inserted,
    position('workOrderId' in function_source.definition) > 0
      and position('sourceWorkOrderId' in function_source.definition) > 0
      and position('rootWorkOrderId' in function_source.definition) > 0
      and position('duplicateSequence' in function_source.definition) > 0
      and position('applied' in function_source.definition) > 0
      and position('reason' in function_source.definition) > 0
      as structured_result_returned,
    function_source.definition !~* (
      'insert[[:space:]]+into[[:space:]]+public\.'
      || '(photos|invoices|invoice_lines|service_notes|wo_parts|work_reports|'
      || 'work_order_visits|work_order_assignment_history|'
      || 'work_order_technician_assignments|staff_work_order_todos|'
      || 'staff_work_order_notification_reads|contractor_estimates|'
      || 'staff_invoice_sources|controller_invoice_export_items|'
      || 'contractor_invoice_payment_hold_events|'
      || 'work_order_visit_corrections|email_intake_log)'
    ) as child_copy_absent,
    function_source.definition !~*
      'update[[:space:]]+public\.work_orders'
      and function_source.definition !~*
        'delete[[:space:]]+from[[:space:]]+public\.work_orders'
      as source_mutation_absent
  from function_source
),
privilege_checks as (
  select
    not has_function_privilege(
      'anon',
      'public.duplicate_work_order_for_reassignment(text)',
      'EXECUTE'
    ) as anonymous_execute_blocked,
    has_function_privilege(
      'authenticated',
      'public.duplicate_work_order_for_reassignment(text)',
      'EXECUTE'
    ) as authenticated_execute_enabled,
    has_function_privilege(
      'service_role',
      'public.duplicate_work_order_for_reassignment(text)',
      'EXECUTE'
    ) as service_role_execute_enabled
),
duplicate_rows as (
  select duplicate_work_order.*
  from public.work_orders duplicate_work_order
  where duplicate_work_order.duplicated_from_work_order_id is not null
     or duplicate_work_order.duplicate_root_work_order_id is not null
     or duplicate_work_order.duplicate_sequence is not null
),
fresh_duplicate_rows as (
  -- Reset/copy invariants describe the instant the duplicate is created, not
  -- its legitimate future lifecycle. Once it has any operational activity or
  -- assignment, only the permanent provenance/audit invariants apply.
  select duplicate_work_order.*
  from duplicate_rows duplicate_work_order
  where duplicate_work_order.status::text = 'unassigned'
    and duplicate_work_order.contractor_id is null
    and duplicate_work_order.contractor_assignment_version = 0
    and not exists (
      select 1
      from public.activities activity
      where activity.work_order_id = duplicate_work_order.id
        and activity.deleted_at is null
        and activity.event_key <> 'work_order_duplicated'
    )
),
data_issue_counts as (
  select
    count(*) filter (
      where duplicate_work_order.duplicated_from_work_order_id is null
        or duplicate_work_order.duplicate_root_work_order_id is null
        or duplicate_work_order.duplicate_sequence is null
        or duplicate_work_order.duplicate_sequence <= 0
        or duplicate_work_order.id <>
          duplicate_work_order.duplicate_root_work_order_id
          || '-'
          || duplicate_work_order.duplicate_sequence::text
        or source_work_order.id is null
        or root_work_order.id is null
    ) as provenance_issue_count,
    count(*) filter (
      where duplicate_work_order.contractor_id is not null
        or duplicate_work_order.assigned_technician_profile_id is not null
        or duplicate_work_order.technician_on_job is not null
        or duplicate_work_order.technician_assigned_at is not null
        or duplicate_work_order.technician_assigned_by is not null
        or duplicate_work_order.contractor_assignment_started_at is not null
        or duplicate_work_order.contractor_assignment_version <> 0
        or duplicate_work_order.status::text <> 'unassigned'
        or duplicate_work_order.functional_status::text <> 'New'
        or duplicate_work_order.eta is not null
        or duplicate_work_order.dispatched_at is not null
        or duplicate_work_order.start_time is not null
        or duplicate_work_order.end_time is not null
        or duplicate_work_order.closed_at is not null
        or duplicate_work_order.asset_make is not null
        or duplicate_work_order.asset_model is not null
        or duplicate_work_order.asset_serial is not null
        or duplicate_work_order.asset_year is not null
        or duplicate_work_order.invoice_total is not null
        or duplicate_work_order.billing_only
        or duplicate_work_order.billing_ready_at is not null
        or duplicate_work_order.billing_ready_by is not null
        or duplicate_work_order.contractor_invoicing_completed_at is not null
        or duplicate_work_order.contractor_invoicing_completed_by is not null
        or duplicate_work_order.contractor_invoicing_assignment_version is not null
        or duplicate_work_order.contractor_invoicing_workflow_cycle is not null
        or duplicate_work_order.contractor_invoicing_completion_source is not null
        or coalesce(duplicate_work_order.is_capital, false)
        or duplicate_work_order.capital_status is not null
        or duplicate_work_order.repair_quote is not null
        or duplicate_work_order.install_quote is not null
        or duplicate_work_order.capital_notes is not null
        or duplicate_work_order.part_needed is not null
        or duplicate_work_order.part_eta is not null
        or duplicate_work_order.resolution_code is not null
        or duplicate_work_order.resolution_notes is not null
        or duplicate_work_order.staff_notes_seen_at is not null
        or duplicate_work_order.workflow_cycle <> 0
        or duplicate_work_order.deleted_at is not null
        or duplicate_work_order.deleted_by is not null
        or duplicate_work_order.afm_email is not null
        or duplicate_work_order.nte_flag_threshold is not null
        or duplicate_work_order.nte_flagged is distinct from false
        or duplicate_work_order.nte_flag_amount is not null
    ) as reset_state_issue_count,
    count(*) filter (
      where duplicate_work_order.incident_id
          is distinct from source_work_order.incident_id
        or duplicate_work_order.store_number
          is distinct from source_work_order.store_number
        or duplicate_work_order.city is distinct from source_work_order.city
        or duplicate_work_order.address
          is distinct from source_work_order.address
        or duplicate_work_order.store_state
          is distinct from source_work_order.store_state
        or duplicate_work_order.store_timezone
          is distinct from source_work_order.store_timezone
        or duplicate_work_order.store_county
          is distinct from source_work_order.store_county
        or duplicate_work_order.store_postal_code
          is distinct from source_work_order.store_postal_code
        or duplicate_work_order.line_of_service
          is distinct from source_work_order.line_of_service
        or duplicate_work_order.business_service
          is distinct from source_work_order.business_service
        or duplicate_work_order.category
          is distinct from source_work_order.category
        or duplicate_work_order.sub_category
          is distinct from source_work_order.sub_category
        or duplicate_work_order.summary
          is distinct from source_work_order.summary
        or duplicate_work_order.description
          is distinct from source_work_order.description
        or duplicate_work_order.priority
          is distinct from source_work_order.priority
        or duplicate_work_order.afm_id
          is distinct from source_work_order.afm_id
        or duplicate_work_order.afm_name
          is distinct from source_work_order.afm_name
        or duplicate_work_order.source
          is distinct from source_work_order.source
        or duplicate_work_order.sla_started_at
          is distinct from source_work_order.sla_started_at
        or duplicate_work_order.response_breach_at
          is distinct from source_work_order.response_breach_at
        or duplicate_work_order.resolution_breach_at
          is distinct from source_work_order.resolution_breach_at
        or duplicate_financial.nte is distinct from source_financial.nte
        or (duplicate_contact.work_order_id is null)
          is distinct from (source_contact.work_order_id is null)
        or duplicate_contact.afm_email
          is distinct from source_contact.afm_email
    ) as copied_source_issue_count
  from fresh_duplicate_rows duplicate_work_order
  left join public.work_orders source_work_order
    on source_work_order.id
      = duplicate_work_order.duplicated_from_work_order_id
  left join public.work_orders root_work_order
    on root_work_order.id
      = duplicate_work_order.duplicate_root_work_order_id
  left join public.work_order_financials duplicate_financial
    on duplicate_financial.work_order_id = duplicate_work_order.id
  left join public.work_order_financials source_financial
    on source_financial.work_order_id = source_work_order.id
  left join public.work_order_afm_contacts duplicate_contact
    on duplicate_contact.work_order_id = duplicate_work_order.id
  left join public.work_order_afm_contacts source_contact
    on source_contact.work_order_id = source_work_order.id
),
duplicate_audit_issue_count as (
  select count(*) as issue_count
  from duplicate_rows duplicate_work_order
  where (
    select count(*)
    from public.activities activity
    where activity.work_order_id = duplicate_work_order.id
      and activity.deleted_at is null
      and activity.event_key = 'work_order_duplicated'
      and activity.activity_channel = 'system_event'
      and activity.type = 'system'
      and activity.is_staff_only = true
      and activity.requires_7eleven_sync = false
      and activity.requires_contractor_attention = false
  ) <> 1
),
unexpected_child_artifacts as (
  select photo.work_order_id
  from public.photos photo
  join fresh_duplicate_rows duplicate_work_order
    on duplicate_work_order.id = photo.work_order_id
  union all
  select invoice.work_order_id
  from public.invoices invoice
  join fresh_duplicate_rows duplicate_work_order
    on duplicate_work_order.id = invoice.work_order_id
  union all
  select service_note.work_order_id
  from public.service_notes service_note
  join fresh_duplicate_rows duplicate_work_order
    on duplicate_work_order.id = service_note.work_order_id
  union all
  select part.work_order_id
  from public.wo_parts part
  join fresh_duplicate_rows duplicate_work_order
    on duplicate_work_order.id = part.work_order_id
  union all
  select report.work_order_id
  from public.work_reports report
  join fresh_duplicate_rows duplicate_work_order
    on duplicate_work_order.id = report.work_order_id
  union all
  select visit.work_order_id
  from public.work_order_visits visit
  join fresh_duplicate_rows duplicate_work_order
    on duplicate_work_order.id = visit.work_order_id
  union all
  select history.work_order_id
  from public.work_order_assignment_history history
  join fresh_duplicate_rows duplicate_work_order
    on duplicate_work_order.id = history.work_order_id
  union all
  select technician.work_order_id
  from public.work_order_technician_assignments technician
  join fresh_duplicate_rows duplicate_work_order
    on duplicate_work_order.id = technician.work_order_id
  union all
  select todo.work_order_id
  from public.staff_work_order_todos todo
  join fresh_duplicate_rows duplicate_work_order
    on duplicate_work_order.id = todo.work_order_id
  union all
  select read_state.work_order_id
  from public.staff_work_order_notification_reads read_state
  join fresh_duplicate_rows duplicate_work_order
    on duplicate_work_order.id = read_state.work_order_id
  union all
  select estimate.work_order_id
  from public.contractor_estimates estimate
  join fresh_duplicate_rows duplicate_work_order
    on duplicate_work_order.id = estimate.work_order_id
  union all
  select delivery.work_order_id
  from public.contractor_activity_alert_deliveries delivery
  join fresh_duplicate_rows duplicate_work_order
    on duplicate_work_order.id = delivery.work_order_id
  union all
  select source_link.work_order_id
  from public.staff_invoice_sources source_link
  join fresh_duplicate_rows duplicate_work_order
    on duplicate_work_order.id = source_link.work_order_id
  union all
  select export_item.work_order_id
  from public.controller_invoice_export_items export_item
  join fresh_duplicate_rows duplicate_work_order
    on duplicate_work_order.id = export_item.work_order_id
  union all
  select hold_event.work_order_id
  from public.contractor_invoice_payment_hold_events hold_event
  join fresh_duplicate_rows duplicate_work_order
    on duplicate_work_order.id = hold_event.work_order_id
  union all
  select correction.work_order_id
  from public.work_order_visit_corrections correction
  join fresh_duplicate_rows duplicate_work_order
    on duplicate_work_order.id = correction.work_order_id
  union all
  select reopen_guard.work_order_id
  from public.work_order_reopen_transition_guards reopen_guard
  join fresh_duplicate_rows duplicate_work_order
    on duplicate_work_order.id = reopen_guard.work_order_id
  union all
  select intake.work_order_id
  from public.email_intake_log intake
  join fresh_duplicate_rows duplicate_work_order
    on duplicate_work_order.id = intake.work_order_id
  union all
  select activity.work_order_id
  from public.activities activity
  join fresh_duplicate_rows duplicate_work_order
    on duplicate_work_order.id = activity.work_order_id
  where activity.deleted_at is null
    and activity.event_key <> 'work_order_duplicated'
),
artifact_issue_count as (
  select count(*) as issue_count
  from unexpected_child_artifacts
)
select
  catalog_checks.provenance_columns_present,
  catalog_checks.provenance_foreign_keys_restrict_delete,
  catalog_checks.provenance_shape_constrained,
  catalog_checks.root_sequence_unique,
  catalog_checks.provenance_trigger_installed,
  catalog_checks.duplicate_function_guarded,
  catalog_checks.duplicate_function_returns_json,
  function_checks.active_staff_required,
  function_checks.operational_staff_roles_required,
  function_checks.invoice_controller_blocked,
  function_checks.active_source_required,
  function_checks.billing_source_blocked,
  function_checks.capital_source_blocked,
  function_checks.contractor_assignment_required,
  function_checks.operational_status_allowlist_present,
  function_checks.canonical_wot_root_required,
  function_checks.root_allocation_locked,
  function_checks.archived_ids_not_recycled,
  function_checks.id_race_retried,
  function_checks.private_nte_copied,
  function_checks.private_afm_contact_copied,
  function_checks.staff_audit_inserted,
  function_checks.structured_result_returned,
  function_checks.child_copy_absent,
  function_checks.source_mutation_absent,
  privilege_checks.anonymous_execute_blocked,
  privilege_checks.authenticated_execute_enabled,
  privilege_checks.service_role_execute_enabled,
  data_issue_counts.provenance_issue_count,
  data_issue_counts.reset_state_issue_count,
  data_issue_counts.copied_source_issue_count,
  duplicate_audit_issue_count.issue_count
    as duplicate_audit_issue_count,
  artifact_issue_count.issue_count
    as unexpected_child_artifact_count,
  catalog_checks.provenance_columns_present
    and catalog_checks.provenance_foreign_keys_restrict_delete
    and catalog_checks.provenance_shape_constrained
    and catalog_checks.root_sequence_unique
    and catalog_checks.provenance_trigger_installed
    and catalog_checks.duplicate_function_guarded
    and catalog_checks.duplicate_function_returns_json
    and function_checks.active_staff_required
    and function_checks.operational_staff_roles_required
    and function_checks.invoice_controller_blocked
    and function_checks.active_source_required
    and function_checks.billing_source_blocked
    and function_checks.capital_source_blocked
    and function_checks.contractor_assignment_required
    and function_checks.operational_status_allowlist_present
    and function_checks.canonical_wot_root_required
    and function_checks.root_allocation_locked
    and function_checks.archived_ids_not_recycled
    and function_checks.id_race_retried
    and function_checks.private_nte_copied
    and function_checks.private_afm_contact_copied
    and function_checks.staff_audit_inserted
    and function_checks.structured_result_returned
    and function_checks.child_copy_absent
    and function_checks.source_mutation_absent
    and privilege_checks.anonymous_execute_blocked
    and privilege_checks.authenticated_execute_enabled
    and privilege_checks.service_role_execute_enabled
    and data_issue_counts.provenance_issue_count = 0
    and data_issue_counts.reset_state_issue_count = 0
    and data_issue_counts.copied_source_issue_count = 0
    and duplicate_audit_issue_count.issue_count = 0
    and artifact_issue_count.issue_count = 0
    as all_checks_pass
from catalog_checks
cross join function_checks
cross join privilege_checks
cross join data_issue_counts
cross join duplicate_audit_issue_count
cross join artifact_issue_count;
