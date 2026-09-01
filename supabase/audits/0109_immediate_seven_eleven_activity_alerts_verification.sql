-- Run after migration 0109. This audit is read-only and returns exactly one
-- row. Every boolean should be true, every issue count should be zero, and
-- all_checks_pass should be true. active_pending_work_order_count is
-- informational and may be greater than zero.

with function_state as (
  select
    procedure.oid,
    procedure.proname,
    procedure.prosecdef,
    lower(pg_get_functiondef(procedure.oid)) as body,
    coalesce(procedure.proconfig, '{}'::text[]) as config,
    has_function_privilege('anon', procedure.oid, 'EXECUTE')
      as anonymous_can_execute,
    has_function_privilege('authenticated', procedure.oid, 'EXECUTE')
      as authenticated_can_execute,
    has_function_privilege('service_role', procedure.oid, 'EXECUTE')
      as service_role_can_execute
  from pg_proc procedure
  join pg_namespace namespace on namespace.oid = procedure.pronamespace
  where namespace.nspname = 'public'
    and procedure.proname in (
      'stamp_activity_actor_audit',
      'enforce_activity_channel_update',
      'get_portal_work_order',
      'get_portal_navigation_summary',
      'list_work_orders_page',
      'list_work_orders_table_page'
    )
), trigger_state as (
  select
    count(*) filter (
      where trigger.tgname = 'stamp_activity_actor_audit_trigger'
        and procedure.proname = 'stamp_activity_actor_audit'
        and not trigger.tgisinternal
    ) as insert_trigger_count,
    count(*) filter (
      where trigger.tgname = 'enforce_activity_channel_update_trigger'
        and procedure.proname = 'enforce_activity_channel_update'
        and not trigger.tgisinternal
    ) as update_trigger_count,
    coalesce(bool_or(
      trigger.tgname = 'enforce_activity_channel_update_trigger'
      and pg_get_triggerdef(trigger.oid) ilike '%event_key%'
      and pg_get_triggerdef(trigger.oid) ilike '%type%'
    ), false) as update_trigger_covers_identity
  from pg_trigger trigger
  join pg_proc procedure on procedure.oid = trigger.tgfoid
  where trigger.tgrelid = 'public.activities'::regclass
), constraint_state as (
  select
    count(*) filter (
      where constraint.conname = 'activities_channel_sync_check'
        and pg_get_constraintdef(constraint.oid) ilike
          '%requires_7eleven_sync%activity_channel%field_note%'
    ) as sync_constraint_count,
    count(*) filter (
      where constraint.conname = 'activities_internal_channel_check'
    ) as internal_constraint_count
  from pg_constraint constraint
  where constraint.conrelid = 'public.activities'::regclass
), realtime_state as (
  select exists (
    select 1
    from pg_publication_tables publication_table
    where publication_table.pubname = 'supabase_realtime'
      and publication_table.schemaname = 'public'
      and publication_table.tablename = 'activities'
  ) as activities_realtime_enabled
), current_cycle_lifecycle_issues as (
  select count(*)::bigint as issue_count
  from public.activities activity
  join public.work_orders work_order on work_order.id = activity.work_order_id
  where work_order.deleted_at is null
    and work_order.status::text <> 'closed'
    and activity.deleted_at is null
    and activity.workflow_cycle = work_order.workflow_cycle
    and activity.contractor_assignment_version
      = work_order.contractor_assignment_version
    and (
      work_order.contractor_assignment_started_at is null
      or activity.created_at >= work_order.contractor_assignment_started_at
    )
    and activity.synced_to_7eleven_at is null
    and activity.event_key in (
      'check_in', 'check_out', 'job_paused', 'job_completed'
    )
    and (
      activity.activity_channel <> 'field_note'
      or activity.requires_7eleven_sync is distinct from true
      or activity.is_staff_only is distinct from false
    )
), forbidden_pending_activities as (
  select count(*)::bigint as issue_count
  from public.activities activity
  where activity.deleted_at is null
    and activity.requires_7eleven_sync = true
    and activity.synced_to_7eleven_at is null
    and (
      activity.activity_channel in (
        'internal_note', 'contractor_message', 'system_event', 'legacy'
      )
      or coalesce(activity.event_key, '') ~ '^invoice_'
      or (
        activity.type = 'system'
        and activity.event_key not in (
          'check_in', 'check_out', 'job_paused', 'job_completed'
        )
      )
    )
), channel_invariant_issues as (
  select count(*)::bigint as issue_count
  from public.activities activity
  where activity.requires_7eleven_sync
    is distinct from (activity.activity_channel = 'field_note')
), active_pending_work_orders as (
  select
    count(distinct work_order.id)::bigint as work_order_count,
    coalesce(jsonb_agg(distinct jsonb_build_object(
      'workOrderId', work_order.id,
      'status', work_order.status,
      'functionalStatus', work_order.functional_status
    )), '[]'::jsonb) as rows
  from public.work_orders work_order
  join public.activities activity on activity.work_order_id = work_order.id
  where work_order.deleted_at is null
    and work_order.status::text <> 'closed'
    and activity.deleted_at is null
    and activity.requires_7eleven_sync = true
    and activity.synced_to_7eleven_at is null
), function_checks as (
  select
    count(*) filter (
      where function_state.proname = 'stamp_activity_actor_audit'
    ) = 1
      and coalesce(bool_and(function_state.prosecdef) filter (
        where function_state.proname = 'stamp_activity_actor_audit'
      ), false)
      and coalesce(bool_and(
        'search_path=public, pg_temp' = any(function_state.config)
      ) filter (
        where function_state.proname = 'stamp_activity_actor_audit'
      ), false)
      and coalesce(bool_and(
        function_state.body like
          '%''check_in'', ''check_out'', ''job_paused'', ''job_completed''%'
        and function_state.body like
          '%if lifecycle_event then%requested_channel := ''field_note''%'
        and function_state.body like
          '%new.requires_7eleven_sync := requested_channel = ''field_note''%'
      ) filter (
        where function_state.proname = 'stamp_activity_actor_audit'
      ), false)
      as lifecycle_insert_canonicalized,

    count(*) filter (
      where function_state.proname = 'enforce_activity_channel_update'
    ) = 1
      and coalesce(bool_and(function_state.prosecdef) filter (
        where function_state.proname = 'enforce_activity_channel_update'
      ), false)
      and coalesce(bool_and(
        'search_path=public, pg_temp' = any(function_state.config)
      ) filter (
        where function_state.proname = 'enforce_activity_channel_update'
      ), false)
      and coalesce(bool_and(
        function_state.body like
          '%if lifecycle_event then%new.activity_channel := ''field_note''%'
        and function_state.body like
          '%elsif invoice_event or new.type = ''system'' then%'
        and function_state.body like
          '%new.requires_7eleven_sync := new.activity_channel = ''field_note''%'
      ) filter (
        where function_state.proname = 'enforce_activity_channel_update'
      ), false)
      as lifecycle_update_canonicalized,

    coalesce(bool_and(
      function_state.body like
        '%new.activity_channel is distinct from old.activity_channel%'
      and function_state.body like
        '%new.event_key is distinct from old.event_key%'
      and function_state.body like
        '%new.type is distinct from old.type%'
      and function_state.body like
        '%only staff can change activity classification%'
    ) filter (
      where function_state.proname = 'enforce_activity_channel_update'
    ), false) as activity_identity_update_staff_only,

    coalesce(bool_and(
      function_state.body like '%invoice_event%'
      and function_state.body like '%requested_channel = ''contractor_message''%'
      and function_state.body like '%requested_channel = ''internal_note''%'
      and function_state.body like '%requested_channel := ''system_event''%'
    ) filter (
      where function_state.proname = 'stamp_activity_actor_audit'
    ), false) as non_queue_channels_excluded,

    count(*) filter (
      where function_state.proname in (
        'get_portal_work_order',
        'get_portal_navigation_summary',
        'list_work_orders_page',
        'list_work_orders_table_page'
      )
    ) = 4
      and coalesce(bool_and(not function_state.prosecdef) filter (
        where function_state.proname in (
          'get_portal_work_order',
          'get_portal_navigation_summary',
          'list_work_orders_page',
          'list_work_orders_table_page'
        )
      ), false)
      and coalesce(bool_and(
        'search_path=public, pg_temp' = any(function_state.config)
      ) filter (
        where function_state.proname in (
          'get_portal_work_order',
          'get_portal_navigation_summary',
          'list_work_orders_page',
          'list_work_orders_table_page'
        )
      ), false)
      as read_rpcs_preserve_rls,

    coalesce(bool_and(
      function_state.authenticated_can_execute
      and function_state.service_role_can_execute
    ) filter (
      where function_state.proname in (
        'get_portal_work_order',
        'get_portal_navigation_summary',
        'list_work_orders_page',
        'list_work_orders_table_page'
      )
    ), false) as authenticated_read_execute_enabled,

    coalesce(bool_and(not function_state.anonymous_can_execute), false)
      as anonymous_execute_blocked,

    coalesce(bool_and(
      function_state.body like
        '%''pending_7eleven_sync_count'',%coalesce(summary.pending_7eleven_sync_count, 0)%'
      and function_state.body not like
        '%when work_order.functional_status::text = ''completed''%'
    ) filter (
      where function_state.proname = 'get_portal_work_order'
    ), false) as detail_surfaces_active_alerts,

    coalesce(bool_and(
      function_state.body like
        '%coalesce(activity.pending_7eleven_sync_count, 0)%as pending_7eleven_sync_count%'
      and function_state.body like
        '%or annotated.pending_7eleven_sync_count > 0%'
      and function_state.body not like
        '%when work_order.functional_status::text = ''completed''%'
    ) filter (
      where function_state.proname = 'get_portal_navigation_summary'
    ), false) as navigation_surfaces_active_alerts,

    coalesce(bool_and(
      function_state.body like
        '%when ''dashboard_seven_eleven_updates'' then%coalesce(summary.pending_7eleven_sync_count, 0) > 0%'
      and function_state.body like
        '%or coalesce(summary.pending_7eleven_sync_count, 0) > 0%'
      and function_state.body like '%_pending_rank%'
      and function_state.body like '%''pendingrank''%'
      and function_state.body like '%portal_decode_cursor%'
      and function_state.body like '%portal_encode_cursor%'
      and function_state.body not like
        '%work_order.functional_status::text = ''completed''%'
    ) filter (
      where function_state.proname = 'list_work_orders_table_page'
    ), false) as sortable_queue_surfaces_active_alerts,

    coalesce(bool_and(
      function_state.body like
        '%when ''dashboard_seven_eleven_updates'' then%coalesce(summary.pending_7eleven_sync_count, 0) > 0%'
      and function_state.body like '%_pending_rank%'
      and function_state.body like '%portal_decode_cursor%'
      and function_state.body like '%portal_encode_cursor%'
    ) filter (
      where function_state.proname = 'list_work_orders_page'
    ), false) as legacy_queue_preserves_active_pagination
  from function_state
), checks as (
  select
    functions.lifecycle_insert_canonicalized,
    functions.lifecycle_update_canonicalized,
    functions.activity_identity_update_staff_only,
    triggers.insert_trigger_count = 1
      and triggers.update_trigger_count = 1
      and triggers.update_trigger_covers_identity
      as lifecycle_triggers_installed,
    functions.non_queue_channels_excluded,
    constraints.sync_constraint_count = 1
      and constraints.internal_constraint_count = 1
      as channel_constraints_preserved,
    functions.detail_surfaces_active_alerts,
    functions.navigation_surfaces_active_alerts,
    functions.sortable_queue_surfaces_active_alerts,
    functions.legacy_queue_preserves_active_pagination,
    functions.read_rpcs_preserve_rls,
    functions.authenticated_read_execute_enabled,
    functions.anonymous_execute_blocked,
    realtime.activities_realtime_enabled,
    lifecycle.issue_count = 0 as current_cycle_lifecycle_repaired,
    forbidden.issue_count = 0 as forbidden_activity_queue_clean,
    invariant.issue_count = 0 as channel_sync_invariant_valid,
    lifecycle.issue_count as current_cycle_lifecycle_issue_count,
    forbidden.issue_count as forbidden_pending_activity_count,
    invariant.issue_count as channel_sync_invariant_issue_count,
    active.work_order_count as active_pending_work_order_count,
    active.rows as active_pending_work_orders
  from function_checks functions
  cross join trigger_state triggers
  cross join constraint_state constraints
  cross join realtime_state realtime
  cross join current_cycle_lifecycle_issues lifecycle
  cross join forbidden_pending_activities forbidden
  cross join channel_invariant_issues invariant
  cross join active_pending_work_orders active
)
select
  checks.*,
  lifecycle_insert_canonicalized
    and lifecycle_update_canonicalized
    and activity_identity_update_staff_only
    and lifecycle_triggers_installed
    and non_queue_channels_excluded
    and channel_constraints_preserved
    and detail_surfaces_active_alerts
    and navigation_surfaces_active_alerts
    and sortable_queue_surfaces_active_alerts
    and legacy_queue_preserves_active_pagination
    and read_rpcs_preserve_rls
    and authenticated_read_execute_enabled
    and anonymous_execute_blocked
    and activities_realtime_enabled
    and current_cycle_lifecycle_repaired
    and forbidden_activity_queue_clean
    and channel_sync_invariant_valid
    as all_checks_pass
from checks;
