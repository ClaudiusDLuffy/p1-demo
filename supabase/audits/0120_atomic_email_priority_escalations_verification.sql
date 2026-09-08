-- Read-only verification for 0120_atomic_email_priority_escalations.sql.

with catalog_checks as (
  select
    to_regclass('public.email_priority_escalation_events') is not null
      as event_table_present,
    to_regclass('public.work_order_priority_family_transition_guards') is not null
      as family_transition_guard_table_present,
    coalesce((
      select cls.relrowsecurity
      from pg_class cls
      where cls.oid = to_regclass('public.email_priority_escalation_events')
    ), false) as event_table_rls_enabled,
    coalesce((
      select cls.relrowsecurity
      from pg_class cls
      where cls.oid = to_regclass(
        'public.work_order_priority_family_transition_guards'
      )
    ), false) as family_transition_guard_table_rls_enabled,
    exists (
      select 1
      from pg_constraint constraint_row
      where constraint_row.conrelid =
          to_regclass('public.email_priority_escalation_events')
        and constraint_row.contype = 'u'
        and pg_get_constraintdef(constraint_row.oid)
          ilike '%source_message_id%'
    ) as source_message_unique,
    exists (
      select 1
      from pg_attribute attribute_row
      where attribute_row.attrelid = 'public.work_orders'::regclass
        and attribute_row.attname = 'priority_source_message_id'
        and not attribute_row.attisdropped
    )
    and exists (
      select 1
      from pg_attribute attribute_row
      where attribute_row.attrelid = 'public.work_orders'::regclass
        and attribute_row.attname = 'priority_source_received_at'
        and not attribute_row.attisdropped
    ) as provenance_columns_present,
    to_regprocedure(
      'public.apply_email_work_order_priority_escalation(text,text,text,timestamp with time zone,text,timestamp with time zone,timestamp with time zone,timestamp with time zone)'
    ) is not null as apply_function_present,
    to_regprocedure(
      'public.duplicate_work_order_for_reassignment_notified(text)'
    ) is not null as duplication_wrapper_present,
    to_regprocedure(
      'public.claim_email_priority_escalation_delivery(uuid)'
    ) is not null as claim_function_present,
    to_regprocedure(
      'public.complete_email_priority_escalation_delivery(uuid,text,text)'
    ) is not null as complete_function_present,
    to_regprocedure(
      'public.retry_email_priority_escalation_delivery(uuid,text,integer)'
    ) is not null as retry_function_present,
    to_regprocedure(
      'public.work_order_accepts_email_priority_escalation(public.wo_status,public.fsm_functional_status)'
    ) is not null as eligibility_function_present,
    exists (
      select 1
      from pg_trigger trigger_row
      where trigger_row.tgrelid = 'public.work_orders'::regclass
        and trigger_row.tgname =
          'protect_work_order_priority_email_provenance_trigger'
        and trigger_row.tgenabled <> 'D'
    ) as provenance_guard_trigger_enabled,
    exists (
      select 1
      from pg_trigger trigger_row
      where trigger_row.tgrelid = 'public.activities'::regclass
        and trigger_row.tgname =
          'protect_work_order_priority_escalation_activity_trigger'
        and trigger_row.tgenabled <> 'D'
    ) as priority_activity_guard_trigger_enabled,
    (
      select count(*) = 7
      from pg_proc proc_row
      join pg_namespace namespace_row
        on namespace_row.oid = proc_row.pronamespace
      where namespace_row.nspname = 'public'
        and proc_row.proname in (
          'protect_work_order_priority_email_provenance',
          'protect_work_order_priority_escalation_activity',
          'apply_email_work_order_priority_escalation',
          'duplicate_work_order_for_reassignment_notified',
          'claim_email_priority_escalation_delivery',
          'complete_email_priority_escalation_delivery',
          'retry_email_priority_escalation_delivery'
        )
        and proc_row.prosecdef
        and 'search_path=public, pg_temp' = any(proc_row.proconfig)
    ) as all_privileged_functions_guarded
),
function_checks as (
  select
    coalesce(
      pg_get_functiondef(to_regprocedure(
        'public.apply_email_work_order_priority_escalation(text,text,text,timestamp with time zone,text,timestamp with time zone,timestamp with time zone,timestamp with time zone)'
      )) ilike '%auth.role() <> ''service_role''%'
      and pg_get_functiondef(to_regprocedure(
        'public.apply_email_work_order_priority_escalation(text,text,text,timestamp with time zone,text,timestamp with time zone,timestamp with time zone,timestamp with time zone)'
      )) ilike '%for update%'
      and pg_get_functiondef(to_regprocedure(
        'public.apply_email_work_order_priority_escalation(text,text,text,timestamp with time zone,text,timestamp with time zone,timestamp with time zone,timestamp with time zone)'
      )) ilike '%pg_advisory_xact_lock%'
      and pg_get_functiondef(to_regprocedure(
        'public.apply_email_work_order_priority_escalation(text,text,text,timestamp with time zone,text,timestamp with time zone,timestamp with time zone,timestamp with time zone)'
      )) ilike '%work_order_priority_rank(v_reported_priority)%'
      and pg_get_functiondef(to_regprocedure(
        'public.apply_email_work_order_priority_escalation(text,text,text,timestamp with time zone,text,timestamp with time zone,timestamp with time zone,timestamp with time zone)'
      )) ilike '%work_order_accepts_email_priority_escalation%'
      and pg_get_functiondef(to_regprocedure(
        'public.apply_email_work_order_priority_escalation(text,text,text,timestamp with time zone,text,timestamp with time zone,timestamp with time zone,timestamp with time zone)'
      )) ilike '%work_order_priority_escalated%',
      false
    ) as apply_function_guarded,
    coalesce(
      pg_get_functiondef(to_regprocedure(
        'public.apply_email_work_order_priority_escalation(text,text,text,timestamp with time zone,text,timestamp with time zone,timestamp with time zone,timestamp with time zone)'
      )) ilike '%work-order-priority:%'
      and pg_get_functiondef(to_regprocedure(
        'public.apply_email_work_order_priority_escalation(text,text,text,timestamp with time zone,text,timestamp with time zone,timestamp with time zone,timestamp with time zone)'
      )) ilike '%coalesce(family.duplicate_sequence, 0) desc%'
      and pg_get_functiondef(to_regprocedure(
        'public.duplicate_work_order_for_reassignment_notified(text)'
      )) ilike '%work-order-priority:%'
      and pg_get_functiondef(to_regprocedure(
        'public.duplicate_work_order_for_reassignment_notified(text)'
      )) ilike '%newer reassignment continuation exists%'
      and pg_get_functiondef(to_regprocedure(
        'public.protect_work_order_priority_email_provenance()'
      )) ilike '%reassignment copy priority or SLA state is stale%',
      false
    ) as reassignment_family_concurrency_guarded,
    coalesce(
      pg_get_functiondef(to_regprocedure(
        'public.claim_email_priority_escalation_delivery(uuid)'
      )) ilike '%auth.role() <> ''service_role''%'
      and pg_get_functiondef(to_regprocedure(
        'public.claim_email_priority_escalation_delivery(uuid)'
      )) ilike '%for update%',
      false
    ) as claim_function_guarded,
    coalesce(
      pg_get_functiondef(to_regprocedure(
        'public.complete_email_priority_escalation_delivery(uuid,text,text)'
      )) ilike '%auth.role() <> ''service_role''%'
      and pg_get_functiondef(to_regprocedure(
        'public.complete_email_priority_escalation_delivery(uuid,text,text)'
      )) ilike '%delivery_status = ''claimed''%',
      false
    ) as complete_function_guarded,
    coalesce(
      pg_get_functiondef(to_regprocedure(
        'public.protect_work_order_priority_email_provenance()'
      )) ilike '%new.priority is distinct from old.priority%'
      and pg_get_functiondef(to_regprocedure(
        'public.protect_work_order_priority_email_provenance()'
      )) ilike '%new.sla_started_at is distinct from old.sla_started_at%'
      and pg_get_functiondef(to_regprocedure(
        'public.protect_work_order_priority_email_provenance()'
      )) ilike '%public.is_staff()%'
      and pg_get_functiondef(to_regprocedure(
        'public.protect_work_order_priority_email_provenance()'
      )) ilike '%not public.is_invoice_controller()%',
      false
    ) as priority_sla_write_guarded,
    coalesce(
      pg_get_functiondef(to_regprocedure(
        'public.retry_email_priority_escalation_delivery(uuid,text,integer)'
      )) ilike '%auth.role() <> ''service_role''%'
      and pg_get_functiondef(to_regprocedure(
        'public.retry_email_priority_escalation_delivery(uuid,text,integer)'
      )) ilike '%for update%'
      and pg_get_functiondef(to_regprocedure(
        'public.retry_email_priority_escalation_delivery(uuid,text,integer)'
      )) ilike '%delivery_attempt_count >= 3%',
      false
    ) as retry_function_guarded,
    coalesce(
      pg_get_functiondef(to_regprocedure(
        'public.apply_email_work_order_priority_escalation(text,text,text,timestamp with time zone,text,timestamp with time zone,timestamp with time zone,timestamp with time zone)'
      )) ilike '%priority source message payload changed%'
      and pg_get_functiondef(to_regprocedure(
        'public.apply_email_work_order_priority_escalation(text,text,text,timestamp with time zone,text,timestamp with time zone,timestamp with time zone,timestamp with time zone)'
      )) ilike '%v_existing.source_received_at is distinct from p_source_received_at%'
      and pg_get_functiondef(to_regprocedure(
        'public.apply_email_work_order_priority_escalation(text,text,text,timestamp with time zone,text,timestamp with time zone,timestamp with time zone,timestamp with time zone)'
      )) ilike '%v_existing.external_work_order_id%'
      and pg_get_functiondef(to_regprocedure(
        'public.apply_email_work_order_priority_escalation(text,text,text,timestamp with time zone,text,timestamp with time zone,timestamp with time zone,timestamp with time zone)'
      )) ilike '%priority source message work order changed%'
      and pg_get_functiondef(to_regprocedure(
        'public.apply_email_work_order_priority_escalation(text,text,text,timestamp with time zone,text,timestamp with time zone,timestamp with time zone,timestamp with time zone)'
      )) ilike '%coalesce(family.duplicate_sequence, 0) desc%',
      false
    ) as replay_identity_and_head_guarded,
    coalesce(
      pg_get_functiondef(to_regprocedure(
        'public.protect_work_order_priority_email_provenance()'
      )) ilike '%work_order_priority_family_transition_guards%'
      and pg_get_functiondef(to_regprocedure(
        'public.protect_work_order_priority_email_provenance()'
      )) ilike '%get diagnostics v_guard_consumed = row_count%'
      and pg_get_functiondef(to_regprocedure(
        'public.duplicate_work_order_for_reassignment_notified(text)'
      )) ilike '%insert into public.work_order_priority_family_transition_guards%'
      and pg_get_functiondef(to_regprocedure(
        'public.duplicate_work_order_for_reassignment_notified(text)'
      )) ilike '%transition guard was not consumed safely%',
      false
    ) as duplicate_transition_guard_consumed,
    coalesce(
      pg_get_functiondef(to_regprocedure(
        'public.protect_work_order_priority_email_provenance()'
      )) ilike '%newer reassignment continuation exists; refresh before changing priority or SLA fields%',
      false
    ) as manual_priority_current_head_enforced,
    coalesce(
      pg_get_functiondef(to_regprocedure(
        'public.protect_work_order_priority_escalation_activity()'
      )) ilike '%priority escalation activity is service-managed and immutable%'
      and pg_get_functiondef(to_regprocedure(
        'public.protect_work_order_priority_escalation_activity()'
      )) ilike '%tg_op in (''update'', ''delete'')%'
      and pg_get_functiondef(to_regprocedure(
        'public.protect_work_order_priority_escalation_activity()'
      )) ilike '%tg_op in (''insert'', ''update'')%',
      false
    ) as priority_activity_immutable
),
access_checks as (
  select
    not has_table_privilege('anon', 'public.email_priority_escalation_events', 'select')
    and not has_table_privilege('anon', 'public.email_priority_escalation_events', 'insert')
    and not has_table_privilege('anon', 'public.email_priority_escalation_events', 'update')
    and not has_table_privilege('anon', 'public.email_priority_escalation_events', 'delete')
    and not has_table_privilege('authenticated', 'public.email_priority_escalation_events', 'select')
    and not has_table_privilege('authenticated', 'public.email_priority_escalation_events', 'insert')
    and not has_table_privilege('authenticated', 'public.email_priority_escalation_events', 'update')
    and not has_table_privilege('authenticated', 'public.email_priority_escalation_events', 'delete')
      as browser_table_access_blocked,
    has_table_privilege(
      'service_role',
      'public.email_priority_escalation_events',
      'select'
    )
    and has_table_privilege('service_role', 'public.email_priority_escalation_events', 'insert')
    and has_table_privilege('service_role', 'public.email_priority_escalation_events', 'update')
    and has_table_privilege('service_role', 'public.email_priority_escalation_events', 'delete')
      as service_role_table_access_enabled,
    not has_function_privilege(
      'anon',
      'public.apply_email_work_order_priority_escalation(text,text,text,timestamp with time zone,text,timestamp with time zone,timestamp with time zone,timestamp with time zone)',
      'execute'
    )
    and not has_function_privilege(
      'authenticated',
      'public.apply_email_work_order_priority_escalation(text,text,text,timestamp with time zone,text,timestamp with time zone,timestamp with time zone,timestamp with time zone)',
      'execute'
    )
    and not has_function_privilege(
      'anon',
      'public.claim_email_priority_escalation_delivery(uuid)',
      'execute'
    )
    and not has_function_privilege(
      'authenticated',
      'public.claim_email_priority_escalation_delivery(uuid)',
      'execute'
    )
    and not has_function_privilege(
      'anon',
      'public.complete_email_priority_escalation_delivery(uuid,text,text)',
      'execute'
    )
    and not has_function_privilege(
      'authenticated',
      'public.complete_email_priority_escalation_delivery(uuid,text,text)',
      'execute'
    )
    and not has_function_privilege(
      'anon',
      'public.retry_email_priority_escalation_delivery(uuid,text,integer)',
      'execute'
    )
    and not has_function_privilege(
      'authenticated',
      'public.retry_email_priority_escalation_delivery(uuid,text,integer)',
      'execute'
    ) as browser_function_execute_blocked,
    has_function_privilege(
      'service_role',
      'public.apply_email_work_order_priority_escalation(text,text,text,timestamp with time zone,text,timestamp with time zone,timestamp with time zone,timestamp with time zone)',
      'execute'
    )
    and has_function_privilege(
      'service_role',
      'public.claim_email_priority_escalation_delivery(uuid)',
      'execute'
    )
    and has_function_privilege(
      'service_role',
      'public.complete_email_priority_escalation_delivery(uuid,text,text)',
      'execute'
    )
    and has_function_privilege(
      'service_role',
      'public.retry_email_priority_escalation_delivery(uuid,text,integer)',
      'execute'
    ) as service_role_function_execute_enabled,
    not has_function_privilege(
      'anon',
      'public.duplicate_work_order_for_reassignment(text)',
      'execute'
    )
    and not has_function_privilege(
      'authenticated',
      'public.duplicate_work_order_for_reassignment(text)',
      'execute'
    )
    and not has_function_privilege(
      'service_role',
      'public.duplicate_work_order_for_reassignment(text)',
      'execute'
    )
    and not has_function_privilege(
      'anon',
      'public.duplicate_work_order_for_reassignment_notified(text)',
      'execute'
    )
    and has_function_privilege(
      'authenticated',
      'public.duplicate_work_order_for_reassignment_notified(text)',
      'execute'
    )
    and has_function_privilege(
      'service_role',
      'public.duplicate_work_order_for_reassignment_notified(text)',
      'execute'
    ) as duplication_execute_surface_guarded,
    not has_function_privilege(
      'anon',
      'public.work_order_accepts_email_priority_escalation(public.wo_status,public.fsm_functional_status)',
      'execute'
    )
    and not has_function_privilege(
      'authenticated',
      'public.work_order_accepts_email_priority_escalation(public.wo_status,public.fsm_functional_status)',
      'execute'
    )
    and has_function_privilege(
      'service_role',
      'public.work_order_accepts_email_priority_escalation(public.wo_status,public.fsm_functional_status)',
      'execute'
    ) as eligibility_function_access_guarded,
    not has_table_privilege(
      'anon',
      'public.work_order_priority_family_transition_guards',
      'select'
    )
    and not has_table_privilege(
      'authenticated',
      'public.work_order_priority_family_transition_guards',
      'select'
    )
    and not has_table_privilege(
      'service_role',
      'public.work_order_priority_family_transition_guards',
      'select'
    ) as family_transition_guard_table_private
),
data_checks as (
  select
    (
      select count(*)
      from public.work_orders work_order
      where (
        work_order.priority_source_message_id is null
      ) <> (
        work_order.priority_source_received_at is null
      )
    ) as provenance_issue_count,
    (
      select count(*)
      from (
        select event.source_message_id
        from public.email_priority_escalation_events event
        group by event.source_message_id
        having count(*) > 1
      ) duplicate_source
    ) as duplicate_source_count,
    (
      select count(*)
      from public.email_priority_escalation_events event
      where event.outcome = 'escalated'
        and (
          public.work_order_priority_rank(event.reported_priority)
            >= public.work_order_priority_rank(event.previous_priority)
          or event.activity_id is null
          or event.delivery_status = 'not_required'
        )
    ) as escalation_shape_issue_count,
    (
      select count(*)
      from public.email_priority_escalation_events event
      where (
        event.outcome = 'non_operational'
      ) = public.work_order_accepts_email_priority_escalation(
        event.work_order_status,
        event.functional_status
      )
    ) as eligibility_shape_issue_count,
    (
      select count(*)
      from public.email_priority_escalation_events event
      where (
        event.delivery_status = 'pending'
        and (
          event.delivery_attempt_count not between 0 and 2
          or event.next_attempt_at is null
          or event.claimed_at is not null
          or event.completed_at is not null
          or (
            event.delivery_attempt_count = 0
            and event.error_message is not null
          )
          or (
            event.delivery_attempt_count > 0
            and event.error_message is null
          )
        )
      ) or (
        event.delivery_status = 'claimed'
        and (
          event.delivery_attempt_count not between 1 and 3
          or event.next_attempt_at is not null
          or event.claimed_at is null
          or event.completed_at is not null
          or event.error_message is not null
        )
      ) or (
        event.delivery_status = 'sent'
        and (
          event.delivery_attempt_count not between 1 and 3
          or event.next_attempt_at is not null
          or event.claimed_at is null
          or event.completed_at is null
          or event.error_message is not null
        )
      ) or (
        event.delivery_status = 'unknown'
        and (
          event.delivery_attempt_count not between 1 and 3
          or event.next_attempt_at is not null
          or event.claimed_at is null
          or event.completed_at is null
          or nullif(trim(coalesce(event.error_message, '')), '') is null
        )
      ) or (
        event.delivery_status = 'failed'
        and (
          event.delivery_attempt_count not between 1 and 3
          or event.next_attempt_at is not null
          or event.claimed_at is null
          or event.completed_at is null
          or nullif(trim(coalesce(event.error_message, '')), '') is null
        )
      ) or (
        event.delivery_status = 'not_required'
        and (
          event.delivery_attempt_count <> 0
          or event.next_attempt_at is not null
          or event.claimed_at is not null
          or event.completed_at is null
          or event.error_message is not null
        )
      )
    ) as delivery_shape_issue_count,
    (
      select count(*)
      from public.email_priority_escalation_events event
      where (
        event.delivery_status = 'claimed'
        and event.claimed_at < now() - interval '15 minutes'
      )
      or event.delivery_status in ('unknown', 'failed')
    ) as delivery_attention_count,
    (
      select count(*)
      from public.work_order_priority_family_transition_guards
    ) as orphan_family_transition_guard_count,
    (
      select count(*)
      from public.email_priority_escalation_events event
      join public.activities activity on activity.id = event.activity_id
      where event.outcome = 'escalated'
        and (
          activity.deleted_at is not null
          or activity.event_key <> 'work_order_priority_escalated'
          or activity.event_data ->> 'sourceMessageId'
            is distinct from event.source_message_id
        )
    ) as priority_activity_issue_count
)
select
  catalog_checks.event_table_present,
  catalog_checks.family_transition_guard_table_present,
  catalog_checks.event_table_rls_enabled,
  catalog_checks.family_transition_guard_table_rls_enabled,
  catalog_checks.source_message_unique,
  catalog_checks.provenance_columns_present,
  catalog_checks.apply_function_present,
  catalog_checks.duplication_wrapper_present,
  catalog_checks.claim_function_present,
  catalog_checks.complete_function_present,
  catalog_checks.retry_function_present,
  catalog_checks.eligibility_function_present,
  catalog_checks.provenance_guard_trigger_enabled,
  catalog_checks.priority_activity_guard_trigger_enabled,
  catalog_checks.all_privileged_functions_guarded,
  function_checks.apply_function_guarded,
  function_checks.reassignment_family_concurrency_guarded,
  function_checks.claim_function_guarded,
  function_checks.complete_function_guarded,
  function_checks.priority_sla_write_guarded,
  function_checks.retry_function_guarded,
  function_checks.replay_identity_and_head_guarded,
  function_checks.duplicate_transition_guard_consumed,
  function_checks.manual_priority_current_head_enforced,
  function_checks.priority_activity_immutable,
  access_checks.browser_table_access_blocked,
  access_checks.service_role_table_access_enabled,
  access_checks.browser_function_execute_blocked,
  access_checks.service_role_function_execute_enabled,
  access_checks.duplication_execute_surface_guarded,
  access_checks.eligibility_function_access_guarded,
  access_checks.family_transition_guard_table_private,
  data_checks.provenance_issue_count,
  data_checks.duplicate_source_count,
  data_checks.escalation_shape_issue_count,
  data_checks.eligibility_shape_issue_count,
  data_checks.delivery_shape_issue_count,
  data_checks.delivery_attention_count,
  data_checks.orphan_family_transition_guard_count,
  data_checks.priority_activity_issue_count,
  catalog_checks.event_table_present
    and catalog_checks.family_transition_guard_table_present
    and catalog_checks.event_table_rls_enabled
    and catalog_checks.family_transition_guard_table_rls_enabled
    and catalog_checks.source_message_unique
    and catalog_checks.provenance_columns_present
    and catalog_checks.apply_function_present
    and catalog_checks.duplication_wrapper_present
    and catalog_checks.claim_function_present
    and catalog_checks.complete_function_present
    and catalog_checks.retry_function_present
    and catalog_checks.eligibility_function_present
    and catalog_checks.provenance_guard_trigger_enabled
    and catalog_checks.priority_activity_guard_trigger_enabled
    and catalog_checks.all_privileged_functions_guarded
    and function_checks.apply_function_guarded
    and function_checks.reassignment_family_concurrency_guarded
    and function_checks.claim_function_guarded
    and function_checks.complete_function_guarded
    and function_checks.priority_sla_write_guarded
    and function_checks.retry_function_guarded
    and function_checks.replay_identity_and_head_guarded
    and function_checks.duplicate_transition_guard_consumed
    and function_checks.manual_priority_current_head_enforced
    and function_checks.priority_activity_immutable
    and access_checks.browser_table_access_blocked
    and access_checks.service_role_table_access_enabled
    and access_checks.browser_function_execute_blocked
    and access_checks.service_role_function_execute_enabled
    and access_checks.duplication_execute_surface_guarded
    and access_checks.eligibility_function_access_guarded
    and access_checks.family_transition_guard_table_private
    and data_checks.provenance_issue_count = 0
    and data_checks.duplicate_source_count = 0
    and data_checks.escalation_shape_issue_count = 0
    and data_checks.eligibility_shape_issue_count = 0
    and data_checks.delivery_shape_issue_count = 0
    and data_checks.delivery_attention_count = 0
    and data_checks.orphan_family_transition_guard_count = 0
    and data_checks.priority_activity_issue_count = 0
      as all_checks_pass
from catalog_checks
cross join function_checks
cross join access_checks
cross join data_checks;
