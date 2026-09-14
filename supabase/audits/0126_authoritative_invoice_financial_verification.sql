-- Read-only Batch 1C verification. This report never repairs or reclassifies
-- historical invoices. Run after 0125 and review the second result set as a
-- legacy-data work queue rather than an installation failure.

with expected_functions(signature) as (
  values
    ('public.save_contractor_invoice_draft_v1(text,integer,integer,uuid,bigint,uuid,jsonb)'),
    ('public.submit_contractor_invoice_v1(text,integer,integer,uuid,bigint,uuid,jsonb)'),
    ('public.revise_contractor_invoice_v1(text,integer,integer,uuid,bigint,uuid,jsonb)'),
    ('public.delete_own_contractor_invoice_v1(text,integer,integer,uuid,bigint,uuid)'),
    ('public.save_staff_billing_invoice_v4(uuid,text,integer,integer,uuid,bigint,uuid,jsonb)'),
    ('public.delete_invoice_admin_v1(uuid,uuid,text,bigint,uuid,integer,integer,text)'),
    ('public.mark_work_order_ready_for_billing_v1(text,integer,integer,bigint,uuid)')
), function_state as (
  select
    count(*) filter (where to_regprocedure(signature) is not null) = count(*)
      as all_commands_present,
    count(*) filter (
      where to_regprocedure(signature) is not null
        and (select procedure.prosecdef from pg_proc procedure
             where procedure.oid = to_regprocedure(signature))
        and (select procedure.proconfig @> array['search_path=public, pg_temp']
             from pg_proc procedure
             where procedure.oid = to_regprocedure(signature))
    ) = count(*) as all_commands_guarded
  from expected_functions
), table_state as (
  select
    to_regclass('public.invoice_financial_control') is not null
      and to_regclass('public.invoice_financial_operations') is not null
      and to_regclass('public.invoice_financial_transition_guards') is not null
      and to_regclass('public.financial_operation_claims') is not null
      and to_regclass('public.work_order_billing_operations') is not null
      as private_tables_present,
    (
      select count(*) = 5
      from pg_class relation
      join pg_namespace namespace on namespace.oid = relation.relnamespace
      where namespace.nspname = 'public'
        and relation.relname in (
          'invoice_financial_control',
          'invoice_financial_operations',
          'invoice_financial_transition_guards',
          'financial_operation_claims',
          'work_order_billing_operations'
        )
        and relation.relrowsecurity
    ) as private_tables_rls_enabled,
    not has_table_privilege('anon','public.invoice_financial_control','SELECT,INSERT,UPDATE,DELETE')
      and not has_table_privilege('authenticated','public.invoice_financial_control','SELECT,INSERT,UPDATE,DELETE')
      and not has_table_privilege('service_role','public.invoice_financial_control','SELECT,INSERT,UPDATE,DELETE')
      and not has_table_privilege('anon','public.invoice_financial_operations','SELECT,INSERT,UPDATE,DELETE')
      and not has_table_privilege('authenticated','public.invoice_financial_operations','SELECT,INSERT,UPDATE,DELETE')
      and not has_table_privilege('service_role','public.invoice_financial_operations','SELECT,INSERT,UPDATE,DELETE')
      and not has_table_privilege('anon','public.invoice_financial_transition_guards','SELECT,INSERT,UPDATE,DELETE')
      and not has_table_privilege('authenticated','public.invoice_financial_transition_guards','SELECT,INSERT,UPDATE,DELETE')
      and not has_table_privilege('service_role','public.invoice_financial_transition_guards','SELECT,INSERT,UPDATE,DELETE')
      and not has_table_privilege('anon','public.financial_operation_claims','SELECT,INSERT,UPDATE,DELETE')
      and not has_table_privilege('authenticated','public.financial_operation_claims','SELECT,INSERT,UPDATE,DELETE')
      and not has_table_privilege('service_role','public.financial_operation_claims','SELECT,INSERT,UPDATE,DELETE')
      and not has_table_privilege('anon','public.work_order_billing_operations','SELECT,INSERT,UPDATE,DELETE')
      and not has_table_privilege('authenticated','public.work_order_billing_operations','SELECT,INSERT,UPDATE,DELETE')
      and not has_table_privilege('service_role','public.work_order_billing_operations','SELECT,INSERT,UPDATE,DELETE')
      as private_tables_blocked,
    not has_table_privilege('anon','public.invoices','INSERT,UPDATE,DELETE')
      and not has_table_privilege('authenticated','public.invoices','INSERT,UPDATE,DELETE')
      and not has_table_privilege('service_role','public.invoices','INSERT,UPDATE,DELETE')
      and not has_table_privilege('anon','public.invoice_lines','INSERT,UPDATE,DELETE')
      and not has_table_privilege('authenticated','public.invoice_lines','INSERT,UPDATE,DELETE')
      and not has_table_privilege('service_role','public.invoice_lines','INSERT,UPDATE,DELETE')
      and not has_table_privilege('anon','public.staff_invoice_sources','INSERT,UPDATE,DELETE')
      and not has_table_privilege('authenticated','public.staff_invoice_sources','INSERT,UPDATE,DELETE')
      and not has_table_privilege('service_role','public.staff_invoice_sources','INSERT,UPDATE,DELETE')
      as raw_financial_tables_blocked,
    not has_sequence_privilege('anon',
        'public.invoice_financial_transition_guards_id_seq','USAGE')
      and not has_sequence_privilege('authenticated',
        'public.invoice_financial_transition_guards_id_seq','USAGE')
      and not has_sequence_privilege('service_role',
        'public.invoice_financial_transition_guards_id_seq','USAGE')
      as private_sequence_blocked
), trigger_state as (
  select count(*) = 7 as all_financial_guards_installed
  from pg_trigger trigger_info
  join pg_class relation on relation.oid = trigger_info.tgrelid
  join pg_namespace namespace on namespace.oid = relation.relnamespace
  where namespace.nspname = 'public'
    and trigger_info.tgenabled <> 'D'
    and (
      (relation.relname = 'invoices'
        and trigger_info.tgname = 'zzz_protect_invoice_financial_row_trigger')
      or (relation.relname = 'invoice_lines'
        and trigger_info.tgname = 'zzz_protect_invoice_financial_line_trigger')
      or (relation.relname = 'invoice_lines'
        and trigger_info.tgname = 'touch_invoice_after_line_change_trigger')
      or (relation.relname = 'staff_invoice_sources'
        and trigger_info.tgname = 'zzz_protect_staff_invoice_source_trigger')
      or (relation.relname = 'staff_invoice_sources'
        and trigger_info.tgname = 'touch_invoice_after_source_change_trigger')
      or (relation.relname = 'work_orders'
        and trigger_info.tgname = 'zzzz_protect_invoice_financial_parent_trigger')
      or (relation.relname = 'activities'
        and trigger_info.tgname = 'zzzz_protect_invoice_financial_activity_trigger')
    )
), execute_surface as (
  select
    not has_function_privilege('anon', signature, 'EXECUTE')
      as anonymous_blocked,
    case when family = 'browser'
      then has_function_privilege('authenticated', signature, 'EXECUTE')
      else not has_function_privilege('authenticated', signature, 'EXECUTE')
    end as authenticated_surface_correct,
    case when family = 'service'
      then has_function_privilege('service_role', signature, 'EXECUTE')
      else not has_function_privilege('service_role', signature, 'EXECUTE')
    end as service_surface_correct
  from (values
    ('public.save_contractor_invoice_draft_v1(text,integer,integer,uuid,bigint,uuid,jsonb)', 'browser'),
    ('public.submit_contractor_invoice_v1(text,integer,integer,uuid,bigint,uuid,jsonb)', 'browser'),
    ('public.revise_contractor_invoice_v1(text,integer,integer,uuid,bigint,uuid,jsonb)', 'browser'),
    ('public.delete_own_contractor_invoice_v1(text,integer,integer,uuid,bigint,uuid)', 'browser'),
    ('public.mark_work_order_ready_for_billing_v1(text,integer,integer,bigint,uuid)', 'browser'),
    ('public.save_staff_billing_invoice_v4(uuid,text,integer,integer,uuid,bigint,uuid,jsonb)', 'service'),
    ('public.delete_invoice_admin_v1(uuid,uuid,text,bigint,uuid,integer,integer,text)', 'service')
  ) expected(signature, family)
), execute_state as (
  select bool_and(anonymous_blocked) as anonymous_commands_blocked,
    bool_and(authenticated_surface_correct) as authenticated_surface_minimized,
    bool_and(service_surface_correct) as service_surface_minimized
  from execute_surface
), policy_state as (
  select not exists (
    select 1 from pg_policies policy
    where policy.schemaname = 'public'
      and policy.tablename in ('invoices','invoice_lines','staff_invoice_sources')
      and policy.policyname in (
        'inv_insert','inv_update','inv_delete','line_write',
        'staff_invoice_sources_insert','staff_invoice_sources_update',
        'staff_invoice_sources_delete'
      )
  ) as alternate_write_policies_removed
), operation_issues as (
  select count(*)::integer as issue_count
  from public.invoice_financial_operations operation
  left join public.financial_operation_claims claim
    on claim.operation_id = operation.operation_id
  where operation.result is null
     or operation.invoice_id is null
     or operation.invoice_snapshot is null
     or operation.line_snapshot is null
     or operation.source_snapshot is null
     or operation.result ->> 'operationId' is distinct from
       operation.operation_id::text
     or operation.result ->> 'invoiceId' is distinct from
       operation.invoice_id::text
     or operation.invoice_snapshot ->> 'id' is distinct from
       operation.invoice_id::text
     or (
       operation.activity_snapshot is not null
       and operation.activity_snapshot -> 'event_data' ->> 'operationId'
         is distinct from operation.operation_id::text
     )
     or (
       operation.command_kind in (
         'contractor_draft','contractor_submit','contractor_revise'
       )
       and (
         operation.payload ->> 'mode' is null
         or operation.payload ->> 'mode' not in (
           'line_items','manual_pdf_total'
         )
       )
     )
     or (
       operation.command_kind = 'staff_save'
       and (
         operation.payload ->> 'taxMode' is null
         or operation.payload ->> 'taxMode' not in (
           'none','manual_amount','manual_rate','active_db_rate'
         )
       )
     )
     or (
       operation.command_kind in (
         'contractor_draft','contractor_submit','contractor_revise'
       )
       and operation.payload ->> 'mode' = 'manual_pdf_total'
       and (
         operation.activity_snapshot is null
         or operation.activity_snapshot -> 'event_data' ->> 'mode'
           is distinct from 'manual_pdf_total'
         or operation.activity_snapshot -> 'event_data' -> 'totalOverride'
           is distinct from operation.payload -> 'totalOverride'
       )
     )
     or claim.actor_id is distinct from operation.actor_id
     or claim.command_kind is distinct from operation.command_kind
), billing_operation_issues as (
  select count(*)::integer as issue_count
  from public.work_order_billing_operations operation
  left join public.financial_operation_claims claim
    on claim.operation_id = operation.operation_id
  where operation.result is null
     or operation.parent_snapshot is null
     or operation.activity_snapshot is null
     or operation.result ->> 'operationId' is distinct from
       operation.operation_id::text
     or operation.result ->> 'workOrderId' is distinct from
       operation.work_order_id
     or operation.activity_snapshot -> 'event_data' ->> 'operationId'
       is distinct from operation.operation_id::text
     or claim.actor_id is distinct from operation.actor_id
     or claim.command_kind is distinct from 'work_order_ready'
), claim_issues as (
  select count(*)::integer as issue_count
  from public.financial_operation_claims claim
  where not exists (
      select 1 from public.invoice_financial_operations operation
      where operation.operation_id = claim.operation_id
    )
    and not exists (
      select 1 from public.work_order_billing_operations operation
      where operation.operation_id = claim.operation_id
    )
), guard_issues as (
  select count(*)::integer as issue_count
  from public.invoice_financial_transition_guards
), version_issues as (
  select count(*)::integer as issue_count
  from public.invoices invoice
  where invoice.invoice_version is null or invoice.invoice_version < 0
), obsolete_access as (
  select
    has_function_privilege('authenticated',
      'public.submit_contractor_invoice_once(uuid,text,text,boolean,text,text,date,date,date,text,numeric,numeric,jsonb)',
      'EXECUTE')
    or has_function_privilege('service_role',
      'public.submit_contractor_invoice_once(uuid,text,text,boolean,text,text,date,date,date,text,numeric,numeric,jsonb)',
      'EXECUTE')
    or has_function_privilege('authenticated',
      'public.delete_own_contractor_invoice(uuid)', 'EXECUTE')
    or has_function_privilege('service_role',
      'public.save_staff_billing_invoice_v3(uuid,uuid,text,text,text,text,text,date,date,date,text,text,numeric,text,numeric,text,text,jsonb,uuid[])',
      'EXECUTE') as any_obsolete_execute
)
select
  (select contracted from public.invoice_financial_control where singleton)
    as financial_contraction_enabled,
  exists (
    select 1 from information_schema.columns column_info
    where column_info.table_schema='public'
      and column_info.table_name='invoices'
      and column_info.column_name='invoice_version'
      and column_info.is_nullable='NO'
  ) as invoice_version_present,
  function_state.all_commands_present,
  function_state.all_commands_guarded,
  table_state.private_tables_present,
  table_state.private_tables_rls_enabled,
  table_state.private_tables_blocked,
  table_state.raw_financial_tables_blocked,
  table_state.private_sequence_blocked,
  trigger_state.all_financial_guards_installed,
  execute_state.anonymous_commands_blocked,
  execute_state.authenticated_surface_minimized,
  execute_state.service_surface_minimized,
  policy_state.alternate_write_policies_removed,
  operation_issues.issue_count as operation_issue_count,
  billing_operation_issues.issue_count as billing_operation_issue_count,
  claim_issues.issue_count as operation_claim_issue_count,
  guard_issues.issue_count as lingering_guard_issue_count,
  version_issues.issue_count as invoice_version_issue_count,
  not obsolete_access.any_obsolete_execute as obsolete_execute_blocked,
  (
    (select contracted from public.invoice_financial_control where singleton)
    and exists (
      select 1 from information_schema.columns column_info
      where column_info.table_schema='public'
        and column_info.table_name='invoices'
        and column_info.column_name='invoice_version'
        and column_info.is_nullable='NO'
    )
    and function_state.all_commands_present
    and function_state.all_commands_guarded
    and table_state.private_tables_present
    and table_state.private_tables_rls_enabled
    and table_state.private_tables_blocked
    and table_state.raw_financial_tables_blocked
    and table_state.private_sequence_blocked
    and trigger_state.all_financial_guards_installed
    and execute_state.anonymous_commands_blocked
    and execute_state.authenticated_surface_minimized
    and execute_state.service_surface_minimized
    and policy_state.alternate_write_policies_removed
    and operation_issues.issue_count = 0
    and billing_operation_issues.issue_count = 0
    and claim_issues.issue_count = 0
    and guard_issues.issue_count = 0
    and version_issues.issue_count = 0
    and not obsolete_access.any_obsolete_execute
  ) as all_checks_pass
from function_state, table_state, trigger_state, execute_state, policy_state, operation_issues,
  billing_operation_issues, claim_issues, guard_issues, version_issues,
  obsolete_access;

-- Historical review only. Counts can be non-zero on an upgraded database and
-- are deliberately excluded from all_checks_pass. They expose a bounded work
-- queue without returning invoice numbers, work-order IDs, people, or amounts.
with line_totals as (
  select invoice.id,
    count(line.id)::integer as line_count,
    round(coalesce(sum(
      round(line.qty,2) * round(line.rate,2)
    ),0),2) as calculated_subtotal
  from public.invoices invoice
  left join public.invoice_lines line on line.invoice_id=invoice.id
  group by invoice.id
), explicit_override_evidence as (
  select operation.invoice_id::text as invoice_id
  from public.invoice_financial_operations operation
  where operation.result is not null
    and operation.command_kind in (
      'contractor_draft','contractor_submit','contractor_revise'
    )
    and operation.payload ->> 'mode' = 'manual_pdf_total'
  union
  select activity.event_data ->> 'invoiceId'
  from public.activities activity
  where activity.deleted_at is null
    and activity.event_key in (
      'invoice_draft','invoice_submitted','invoice_resubmitted'
    )
    and activity.event_data ->> 'mode' = 'manual_pdf_total'
), event_evidence as (
  select activity.event_data ->> 'invoiceId' as invoice_id,
    bool_or(activity.event_key in (
      'invoice_submitted','invoice_resubmitted'
    )) as has_submission,
    bool_or(
      activity.event_key in (
        'invoice_deleted','invoice_deleted_by_contractor'
      )
      or (
        activity.event_key = 'staff_billing'
        and activity.event_data ->> 'action' = 'deleted'
      )
    ) as has_deletion
  from public.activities activity
  where activity.deleted_at is null
    and nullif(activity.event_data ->> 'invoiceId','') is not null
  group by activity.event_data ->> 'invoiceId'
), operation_evidence as (
  select operation.invoice_id::text as invoice_id,
    bool_or(operation.command_kind in (
      'contractor_submit','contractor_revise'
    ) and operation.result is not null) as has_submission,
    bool_or(operation.command_kind in (
      'contractor_delete','admin_delete'
    ) and operation.result is not null) as has_deletion
  from public.invoice_financial_operations operation
  where operation.invoice_id is not null
  group by operation.invoice_id
), invoice_review as (
  select invoice.*,
    line_totals.line_count,
    line_totals.calculated_subtotal,
    override_evidence.invoice_id is not null as has_override_evidence,
    coalesce(event_evidence.has_submission,false)
      or coalesce(operation_evidence.has_submission,false)
      as has_submission_evidence,
    coalesce(event_evidence.has_deletion,false)
      or coalesce(operation_evidence.has_deletion,false)
      as has_deletion_evidence
  from public.invoices invoice
  join line_totals on line_totals.id=invoice.id
  left join explicit_override_evidence override_evidence
    on override_evidence.invoice_id=invoice.id::text
  left join event_evidence on event_evidence.invoice_id=invoice.id::text
  left join operation_evidence on operation_evidence.invoice_id=invoice.id::text
), bad_sources as (
  select count(*)::integer as issue_count
  from public.staff_invoice_sources source
  join public.invoices staff_invoice on staff_invoice.id=source.staff_invoice_id
  left join public.invoices contractor_invoice
    on contractor_invoice.id=source.contractor_invoice_id
  where staff_invoice.deleted_at is null
    and (
      staff_invoice.invoice_type <> 'staff'
      or contractor_invoice.id is null
      or contractor_invoice.invoice_type <> 'contractor'
      or contractor_invoice.deleted_at is not null
      or contractor_invoice.state in ('draft','rejected')
      or contractor_invoice.work_order_id is distinct from
        staff_invoice.work_order_id
    )
), invoice_line_source_issues as (
  select count(*)::integer as issue_count
  from public.invoice_lines line
  join public.invoices invoice on invoice.id=line.invoice_id
  left join public.invoice_lines source_line
    on source_line.id=line.source_invoice_line_id
  left join public.invoices source_invoice
    on source_invoice.id=source_line.invoice_id
  left join public.wo_parts source_part
    on source_part.id=line.source_work_order_part_id
  left join public.p1_part_costs source_cost
    on source_cost.part_id=source_part.id
  where invoice.deleted_at is null
    and (
      (
        line.source_invoice_line_id is not null
        and (
          source_line.id is null
          or source_invoice.invoice_type is distinct from 'contractor'
          or source_invoice.deleted_at is not null
          or source_invoice.work_order_id is distinct from invoice.work_order_id
        )
      )
      or (
        line.source_work_order_part_id is not null
        and (
          source_part.id is null
          or source_part.work_order_id is distinct from invoice.work_order_id
          or source_part.ordering_responsibility is distinct from 'p1'
          or source_part.p1_order_status not in ('ordered','received')
          or source_cost.part_id is null
          or source_cost.unit_cost <= 0
        )
      )
    )
), duplicate_line_positions as (
  select coalesce(sum(position_count-1),0)::integer as issue_count
  from (
    select count(*)::integer as position_count
    from public.invoice_lines line
    group by line.invoice_id,line.position
    having count(*) > 1
  ) duplicate
), new_submission_key_issues as (
  select count(distinct invoice.id)::integer as issue_count
  from public.invoices invoice
  join public.invoice_financial_operations operation
    on operation.invoice_id=invoice.id
   and operation.result is not null
   and operation.command_kind in ('contractor_submit','contractor_revise')
  where invoice.invoice_type='contractor'
    and invoice.deleted_at is null
    and invoice.state in ('submitted','revised')
    and invoice.submission_key is null
), duplicate_identities as (
  select coalesce(sum(identity_count-1),0)::integer as issue_count
  from (
    select count(*)::integer as identity_count
    from public.invoices invoice
    group by invoice.invoice_type,
      case when invoice.invoice_type='staff' then null
        else invoice.contractor_id end,
      invoice.num
    having count(*) > 1
  ) duplicate
), duplicate_operation_events as (
  select coalesce(sum(event_count-1),0)::integer as issue_count
  from (
    select activity.event_data ->> 'operationId', count(*)::integer event_count
    from public.activities activity
    where activity.deleted_at is null
      and activity.event_key in (
        'invoice_draft','invoice_submitted','invoice_resubmitted',
        'invoice_deleted','invoice_deleted_by_contractor','staff_billing'
      )
      and activity.event_data ->> 'operationId'
        ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    group by activity.event_data ->> 'operationId'
    having count(*) > 1
  ) duplicate
), malformed_event_identities as (
  select count(*)::integer as issue_count
  from public.activities activity
  where activity.deleted_at is null
    and activity.event_key in (
      'invoice_draft','invoice_submitted','invoice_resubmitted',
      'invoice_deleted','invoice_deleted_by_contractor','staff_billing'
    )
    and (
      (
        nullif(activity.event_data ->> 'invoiceId','') is not null
        and activity.event_data ->> 'invoiceId'
          !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      )
      or (
        nullif(activity.event_data ->> 'operationId','') is not null
        and activity.event_data ->> 'operationId'
          !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      )
    )
), parent_status_issues as (
  select count(*)::integer as issue_count
  from public.work_orders work_order
  where work_order.deleted_at is null
    and work_order.status = 'pending_approval'
    and not exists (
      select 1 from public.invoices invoice
      where invoice.work_order_id=work_order.id
        and invoice.invoice_type='contractor'
        and invoice.deleted_at is null
        and invoice.state in ('submitted','revised','rejected')
    )
)
select
  count(*) filter (
    where invoice.deleted_at is null
      and invoice.state <> 'draft'
      and (
        (
          invoice.has_override_evidence
          and invoice.subtotal is distinct from greatest(
            invoice.total-invoice.sales_tax,0
          )
        )
        or (
          not invoice.has_override_evidence
          and (
            invoice.line_count=0
            or invoice.subtotal is distinct from invoice.calculated_subtotal
          )
        )
      )
  )::integer as legacy_subtotal_review_count,
  count(*) filter (
    where invoice.deleted_at is null
      and invoice.invoice_type='contractor'
      and invoice.state <> 'draft'
      and invoice.line_count=0
      and not invoice.has_override_evidence
  )::integer as zero_line_without_override_evidence_review_count,
  count(*) filter (
    where invoice.deleted_at is null
      and invoice.invoice_type='contractor'
      and invoice.state in (
        'submitted','approved','rejected','revised','paid'
      )
      and not invoice.has_submission_evidence
  )::integer as contractor_submission_evidence_review_count,
  count(*) filter (
    where invoice.deleted_at is not null
      and not invoice.has_deletion_evidence
  )::integer as legacy_delete_without_evidence_count,
  count(*) filter (
    where invoice.deleted_at is null
      and invoice.state <> 'draft'
      and (
        (
          invoice.has_override_evidence
          and invoice.subtotal is distinct from greatest(
            invoice.total-invoice.sales_tax,0
          )
        )
        or (
          not invoice.has_override_evidence
          and invoice.total is distinct from round(
            invoice.subtotal+invoice.sales_tax,2
          )
        )
      )
  )::integer as legacy_total_review_count,
  bad_sources.issue_count as active_staff_source_issue_count,
  invoice_line_source_issues.issue_count as invoice_line_source_issue_count,
  duplicate_line_positions.issue_count as duplicate_line_position_count,
  new_submission_key_issues.issue_count as new_submission_key_issue_count,
  duplicate_identities.issue_count as duplicate_invoice_identity_count,
  duplicate_operation_events.issue_count as duplicate_operation_event_count,
  malformed_event_identities.issue_count as malformed_financial_event_id_count,
  parent_status_issues.issue_count as financial_parent_status_issue_count
from bad_sources
cross join invoice_line_source_issues
cross join duplicate_line_positions
cross join new_submission_key_issues
cross join duplicate_identities
cross join duplicate_operation_events
cross join malformed_event_identities
cross join parent_status_issues
left join invoice_review invoice on true
group by bad_sources.issue_count, invoice_line_source_issues.issue_count,
  duplicate_line_positions.issue_count, new_submission_key_issues.issue_count,
  duplicate_identities.issue_count,
  duplicate_operation_events.issue_count,
  malformed_event_identities.issue_count, parent_status_issues.issue_count;
