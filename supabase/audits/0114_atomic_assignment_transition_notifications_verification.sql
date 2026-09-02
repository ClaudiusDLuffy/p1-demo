with function_sources as (
  select
    coalesce(pg_get_functiondef(to_regprocedure(
      'public.transition_work_order_contractor(text,uuid,integer)'
    )), '') as transition_definition,
    coalesce(pg_get_functiondef(to_regprocedure(
      'public.queue_contractor_assignment_transition_delivery()'
    )), '') as assignment_queue_definition,
    coalesce(pg_get_functiondef(to_regprocedure(
      'public.queue_duplicate_reassignment_transition_delivery()'
    )), '') as duplicate_queue_definition,
    coalesce(pg_get_functiondef(to_regprocedure(
      'public.duplicate_work_order_for_reassignment_notified(text)'
    )), '') as duplicate_wrapper_definition,
    coalesce(pg_get_functiondef(to_regprocedure(
      'public.claim_contractor_assignment_transition_delivery(uuid,uuid)'
    )), '') as claim_definition,
    coalesce(pg_get_functiondef(to_regprocedure(
      'public.complete_contractor_assignment_transition_delivery(uuid,text,text)'
    )), '') as completion_definition
),
catalog_checks as (
  select
    to_regclass(
      'public.contractor_assignment_transition_deliveries'
    ) is not null as delivery_table_present,
    coalesce(delivery_table.relrowsecurity, false)
      as delivery_table_rls_enabled,
    exists (
      select 1
      from pg_constraint constraint_row
      where constraint_row.conrelid =
          'public.contractor_assignment_transition_deliveries'::regclass
        and constraint_row.contype = 'u'
        and pg_get_constraintdef(constraint_row.oid) = 'UNIQUE (event_key)'
    ) as event_key_unique,
    exists (
      select 1
      from pg_constraint constraint_row
      where constraint_row.conrelid =
          'public.contractor_assignment_transition_deliveries'::regclass
        and constraint_row.conname =
          'contractor_assignment_transition_shape_check'
        and constraint_row.convalidated
    ) as transition_shape_constrained,
    exists (
      select 1
      from pg_constraint constraint_row
      where constraint_row.conrelid =
          'public.contractor_assignment_transition_deliveries'::regclass
        and constraint_row.conname =
          'contractor_assignment_transition_delivery_state_check'
        and constraint_row.convalidated
    ) as delivery_state_constrained,
    not exists (
      select 1
      from information_schema.columns column_row
      where column_row.table_schema = 'public'
        and column_row.table_name =
          'contractor_assignment_transition_deliveries'
        and column_row.column_name in (
          'new_contractor_id',
          'new_contractor_name',
          'new_contractor_email',
          'receiving_contractor_id',
          'receiving_contractor_name',
          'receiving_contractor_email'
        )
    ) as receiving_contractor_absent,
    exists (
      select 1
      from pg_trigger trigger_row
      where trigger_row.tgrelid = 'public.work_orders'::regclass
        and trigger_row.tgname =
          'queue_contractor_assignment_transition_delivery_trigger'
        and not trigger_row.tgisinternal
        and trigger_row.tgenabled <> 'D'
    ) as assignment_queue_trigger_enabled,
    exists (
      select 1
      from pg_trigger trigger_row
      where trigger_row.tgrelid = 'public.work_orders'::regclass
        and trigger_row.tgname =
          'queue_duplicate_reassignment_transition_delivery_trigger'
        and not trigger_row.tgisinternal
        and trigger_row.tgenabled <> 'D'
    ) as duplicate_queue_trigger_enabled
  from pg_class delivery_table
  join pg_namespace namespace_row
    on namespace_row.oid = delivery_table.relnamespace
  where namespace_row.nspname = 'public'
    and delivery_table.relname =
      'contractor_assignment_transition_deliveries'
),
function_catalog_checks as (
  select
    count(*) filter (
      where proc_row.proname in (
        'transition_work_order_contractor',
        'queue_contractor_assignment_transition_delivery',
        'queue_duplicate_reassignment_transition_delivery',
        'duplicate_work_order_for_reassignment_notified',
        'claim_contractor_assignment_transition_delivery',
        'complete_contractor_assignment_transition_delivery'
      )
        and proc_row.prosecdef
        and 'search_path=public, pg_temp' = any(proc_row.proconfig)
    ) = 6 as all_functions_guarded
  from pg_proc proc_row
  join pg_namespace namespace_row
    on namespace_row.oid = proc_row.pronamespace
  where namespace_row.nspname = 'public'
),
function_checks as (
  select
    function_sources.transition_definition ~
      'profile\.active = true' as active_staff_required,
    function_sources.transition_definition ~
      'profile\.role in \(' as operational_staff_required,
    position(
      'invoice_controller' in function_sources.transition_definition
    ) > 0 as invoice_controller_blocked,
    function_sources.transition_definition ~
      'for update' as work_order_row_locked,
    position(
      'p_expected_assignment_version' in
      function_sources.transition_definition
    ) > 0
      and position(
        'Work-order assignment changed' in
        function_sources.transition_definition
      ) > 0 as stale_assignment_blocked,
    function_sources.transition_definition ~
      'profile\.is_assignable = true' as assignable_target_required,
    function_sources.transition_definition ~
      'update public\.work_orders work_order' as transition_is_atomic,
    position(
      'insert into public.activities' in
      function_sources.transition_definition
    ) > 0
      and position(
        'work_order_reassigned' in
        function_sources.transition_definition
      ) > 0
      and position(
        'work_order_unassigned' in
        function_sources.transition_definition
      ) > 0
      and position(
        'entered_by_role' in
        function_sources.transition_definition
      ) > 0
      and position(
        'v_actor.role::text' in
        function_sources.transition_definition
      ) > 0 as staff_activity_written,
    position(
      'old.contractor_id' in
      function_sources.assignment_queue_definition
    ) > 0
      and position(
        'old.contractor_assignment_version' in
        function_sources.assignment_queue_definition
      ) > 0 as outgoing_assignment_snapshotted,
    position(
      'new.contractor_id is null' in
      function_sources.assignment_queue_definition
    ) > 0
      and position(
        '''unassigned''' in
        function_sources.assignment_queue_definition
      ) > 0
      and position(
        '''reassigned''' in
        function_sources.assignment_queue_definition
      ) > 0 as direct_transitions_distinguished,
    position(
      '''duplicated_for_reassignment''' in
      function_sources.duplicate_queue_definition
    ) > 0
      and position(
        'v_source.contractor_id' in
        function_sources.duplicate_queue_definition
      ) > 0
      and function_sources.duplicate_queue_definition !~*
        'update[[:space:]]+public\.work_orders'
      as duplicate_notice_preserves_source,
    position(
      'duplicate_work_order_for_reassignment(' in
      function_sources.duplicate_wrapper_definition
    ) > 0
      and position(
        '''deliveryId''' in
        function_sources.duplicate_wrapper_definition
      ) > 0 as duplicate_wrapper_returns_delivery,
    position(
      'Service role required' in function_sources.claim_definition
    ) > 0
      and position(
        'for update' in function_sources.claim_definition
      ) > 0 as claim_service_only_and_locked,
    position(
      '''new_claim''' in function_sources.claim_definition
    ) > 0
      and position(
        '''already_sent''' in function_sources.claim_definition
      ) > 0
      and position(
        '''delivery_unknown''' in function_sources.claim_definition
      ) > 0
      and position(
        '''pending_or_unknown''' in function_sources.claim_definition
      ) > 0
      and position(
        '''not_deliverable''' in function_sources.claim_definition
      ) > 0 as claim_states_distinct,
    position(
      '''outgoingContractorEmail''' in function_sources.claim_definition
    ) > 0
      and position(
        '''transitionType''' in function_sources.claim_definition
      ) > 0
      and position(
        'newContractor' in function_sources.claim_definition
      ) = 0
      and position(
        'receivingContractor' in function_sources.claim_definition
      ) = 0 as claim_excludes_receiving_contractor,
    position(
      'Service role required' in function_sources.completion_definition
    ) > 0
      and position(
        'p_status not in (''sent'', ''unknown'')' in
        function_sources.completion_definition
      ) > 0 as completion_terminal_only
  from function_sources
),
privilege_checks as (
  select
    not coalesce(has_table_privilege(
      'anon',
      'public.contractor_assignment_transition_deliveries',
      'SELECT,INSERT,UPDATE,DELETE'
    ), false) as anonymous_table_access_blocked,
    not coalesce(has_table_privilege(
      'authenticated',
      'public.contractor_assignment_transition_deliveries',
      'SELECT,INSERT,UPDATE,DELETE'
    ), false) as authenticated_table_access_blocked,
    coalesce(has_table_privilege(
      'service_role',
      'public.contractor_assignment_transition_deliveries',
      'SELECT,INSERT,UPDATE,DELETE'
    ), false) as service_role_table_access_enabled,
    not has_function_privilege(
      'anon',
      'public.transition_work_order_contractor(text,uuid,integer)',
      'EXECUTE'
    ) as anonymous_transition_blocked,
    has_function_privilege(
      'authenticated',
      'public.transition_work_order_contractor(text,uuid,integer)',
      'EXECUTE'
    ) as authenticated_transition_enabled,
    not has_function_privilege(
      'anon',
      'public.duplicate_work_order_for_reassignment_notified(text)',
      'EXECUTE'
    ) as anonymous_duplicate_wrapper_blocked,
    has_function_privilege(
      'authenticated',
      'public.duplicate_work_order_for_reassignment_notified(text)',
      'EXECUTE'
    ) as authenticated_duplicate_wrapper_enabled,
    not has_function_privilege(
      'anon',
      'public.claim_contractor_assignment_transition_delivery(uuid,uuid)',
      'EXECUTE'
    )
      and not has_function_privilege(
        'authenticated',
        'public.claim_contractor_assignment_transition_delivery(uuid,uuid)',
        'EXECUTE'
      ) as untrusted_claim_execute_blocked,
    has_function_privilege(
      'service_role',
      'public.claim_contractor_assignment_transition_delivery(uuid,uuid)',
      'EXECUTE'
    ) as service_role_claim_enabled,
    not has_function_privilege(
      'anon',
      'public.complete_contractor_assignment_transition_delivery(uuid,text,text)',
      'EXECUTE'
    )
      and not has_function_privilege(
        'authenticated',
        'public.complete_contractor_assignment_transition_delivery(uuid,text,text)',
        'EXECUTE'
      ) as untrusted_completion_execute_blocked,
    has_function_privilege(
      'service_role',
      'public.complete_contractor_assignment_transition_delivery(uuid,text,text)',
      'EXECUTE'
    ) as service_role_completion_enabled
),
data_issue_counts as (
  select
    count(*) filter (
      where work_order.id is null
        or contractor.id is null
        or delivery.external_work_order_id is distinct from coalesce(
          work_order.duplicate_root_work_order_id,
          work_order.id
        )
        or delivery.outgoing_assignment_version <= 0
        or not (
          (
            delivery.outgoing_contractor_id = work_order.contractor_id
            and delivery.outgoing_assignment_version =
              work_order.contractor_assignment_version
          )
          or exists (
            select 1
            from public.work_order_assignment_history history
            where history.work_order_id = delivery.work_order_id
              and history.contractor_id = delivery.outgoing_contractor_id
              and history.assignment_version =
                delivery.outgoing_assignment_version
          )
        )
    ) as outgoing_scope_issue_count,
    count(*) filter (
      where (
        delivery.transition_type in ('reassigned', 'unassigned')
        and not exists (
          select 1
          from public.work_order_assignment_history history
          where history.work_order_id = delivery.work_order_id
            and history.contractor_id = delivery.outgoing_contractor_id
            and history.assignment_version =
              delivery.outgoing_assignment_version
            and (
              (
                delivery.transition_type = 'reassigned'
                and history.next_contractor_id is not null
              )
              or (
                delivery.transition_type = 'unassigned'
                and history.next_contractor_id is null
              )
            )
        )
      )
      or (
        delivery.transition_type = 'duplicated_for_reassignment'
        and (
          related_work_order.id is null
          or related_work_order.duplicated_from_work_order_id
            is distinct from delivery.work_order_id
        )
      )
    ) as transition_provenance_issue_count,
    count(*) filter (
      where (delivery.status = 'pending' and (
          delivery.claimed_at is not null
          or delivery.completed_at is not null
          or delivery.error_message is not null
          or nullif(trim(coalesce(
            delivery.outgoing_contractor_email,
            ''
          )), '') is null
        ))
        or (delivery.status = 'claimed' and (
          delivery.claimed_at is null
          or delivery.completed_at is not null
          or delivery.error_message is not null
        ))
        or (delivery.status = 'sent' and (
          delivery.claimed_at is null
          or delivery.completed_at is null
          or delivery.error_message is not null
        ))
        or (delivery.status = 'unknown' and (
          delivery.claimed_at is null
          or delivery.completed_at is null
          or nullif(trim(coalesce(delivery.error_message, '')), '') is null
        ))
        or (delivery.status = 'skipped' and (
          delivery.claimed_at is not null
          or delivery.completed_at is null
          or nullif(trim(coalesce(delivery.error_message, '')), '') is null
          or nullif(trim(coalesce(
            delivery.outgoing_contractor_email,
            ''
          )), '') is not null
        ))
    ) as delivery_state_issue_count
  from public.contractor_assignment_transition_deliveries delivery
  left join public.work_orders work_order
    on work_order.id = delivery.work_order_id
  left join public.work_orders related_work_order
    on related_work_order.id = delivery.related_work_order_id
  left join public.profiles contractor
    on contractor.id = delivery.outgoing_contractor_id
)
select
  catalog_checks.delivery_table_present,
  catalog_checks.delivery_table_rls_enabled,
  catalog_checks.event_key_unique,
  catalog_checks.transition_shape_constrained,
  catalog_checks.delivery_state_constrained,
  catalog_checks.receiving_contractor_absent,
  catalog_checks.assignment_queue_trigger_enabled,
  catalog_checks.duplicate_queue_trigger_enabled,
  function_catalog_checks.all_functions_guarded,
  function_checks.active_staff_required,
  function_checks.operational_staff_required,
  function_checks.invoice_controller_blocked,
  function_checks.work_order_row_locked,
  function_checks.stale_assignment_blocked,
  function_checks.assignable_target_required,
  function_checks.transition_is_atomic,
  function_checks.staff_activity_written,
  function_checks.outgoing_assignment_snapshotted,
  function_checks.direct_transitions_distinguished,
  function_checks.duplicate_notice_preserves_source,
  function_checks.duplicate_wrapper_returns_delivery,
  function_checks.claim_service_only_and_locked,
  function_checks.claim_states_distinct,
  function_checks.claim_excludes_receiving_contractor,
  function_checks.completion_terminal_only,
  privilege_checks.anonymous_table_access_blocked,
  privilege_checks.authenticated_table_access_blocked,
  privilege_checks.service_role_table_access_enabled,
  privilege_checks.anonymous_transition_blocked,
  privilege_checks.authenticated_transition_enabled,
  privilege_checks.anonymous_duplicate_wrapper_blocked,
  privilege_checks.authenticated_duplicate_wrapper_enabled,
  privilege_checks.untrusted_claim_execute_blocked,
  privilege_checks.service_role_claim_enabled,
  privilege_checks.untrusted_completion_execute_blocked,
  privilege_checks.service_role_completion_enabled,
  data_issue_counts.outgoing_scope_issue_count,
  data_issue_counts.transition_provenance_issue_count,
  data_issue_counts.delivery_state_issue_count,
  catalog_checks.delivery_table_present
    and catalog_checks.delivery_table_rls_enabled
    and catalog_checks.event_key_unique
    and catalog_checks.transition_shape_constrained
    and catalog_checks.delivery_state_constrained
    and catalog_checks.receiving_contractor_absent
    and catalog_checks.assignment_queue_trigger_enabled
    and catalog_checks.duplicate_queue_trigger_enabled
    and function_catalog_checks.all_functions_guarded
    and function_checks.active_staff_required
    and function_checks.operational_staff_required
    and function_checks.invoice_controller_blocked
    and function_checks.work_order_row_locked
    and function_checks.stale_assignment_blocked
    and function_checks.assignable_target_required
    and function_checks.transition_is_atomic
    and function_checks.staff_activity_written
    and function_checks.outgoing_assignment_snapshotted
    and function_checks.direct_transitions_distinguished
    and function_checks.duplicate_notice_preserves_source
    and function_checks.duplicate_wrapper_returns_delivery
    and function_checks.claim_service_only_and_locked
    and function_checks.claim_states_distinct
    and function_checks.claim_excludes_receiving_contractor
    and function_checks.completion_terminal_only
    and privilege_checks.anonymous_table_access_blocked
    and privilege_checks.authenticated_table_access_blocked
    and privilege_checks.service_role_table_access_enabled
    and privilege_checks.anonymous_transition_blocked
    and privilege_checks.authenticated_transition_enabled
    and privilege_checks.anonymous_duplicate_wrapper_blocked
    and privilege_checks.authenticated_duplicate_wrapper_enabled
    and privilege_checks.untrusted_claim_execute_blocked
    and privilege_checks.service_role_claim_enabled
    and privilege_checks.untrusted_completion_execute_blocked
    and privilege_checks.service_role_completion_enabled
    and data_issue_counts.outgoing_scope_issue_count = 0
    and data_issue_counts.transition_provenance_issue_count = 0
    and data_issue_counts.delivery_state_issue_count = 0
    as all_checks_pass
from catalog_checks
cross join function_catalog_checks
cross join function_checks
cross join privilege_checks
cross join data_issue_counts;
