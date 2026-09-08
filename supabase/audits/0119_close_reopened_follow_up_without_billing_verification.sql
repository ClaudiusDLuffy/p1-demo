-- Run after migration 0119. This script is read-only and returns one row;
-- all_checks_pass must be true before the application change is released.

with checks as (
  select
    to_regprocedure(
      'public.close_reopened_work_order_without_additional_billing(text,integer,integer,timestamp with time zone,text)'
    ) is not null as close_function_present,
    coalesce((
      select procedure.prosecdef
        and coalesce(
          procedure.proconfig @> array['search_path=public, pg_temp'],
          false
        )
        and pg_get_functiondef(procedure.oid)
          ilike '%workflow_cycle is distinct from p_expected_workflow_cycle%'
        and pg_get_functiondef(procedure.oid)
          ilike '%contractor_assignment_version%p_expected_contractor_assignment_version%'
        and pg_get_functiondef(procedure.oid)
          ilike '%updated_at is distinct from p_expected_updated_at%'
        and pg_get_functiondef(procedure.oid)
          ilike '%Every prior P1 invoice must be billed to 7-Eleven%'
        and pg_get_functiondef(procedure.oid)
          ilike '%Every prior contractor bill must have submission evidence%'
        and pg_get_functiondef(procedure.oid)
          ilike '%staff_invoice_ready%created_at >= v_reopen_activity.created_at%'
      from pg_proc procedure
      where procedure.oid = to_regprocedure(
        'public.close_reopened_work_order_without_additional_billing(text,integer,integer,timestamp with time zone,text)'
      )
    ), false) as close_function_guarded,
    not has_function_privilege(
      'anon',
      'public.close_reopened_work_order_without_additional_billing(text,integer,integer,timestamp with time zone,text)',
      'EXECUTE'
    )
      and has_function_privilege(
        'authenticated',
        'public.close_reopened_work_order_without_additional_billing(text,integer,integer,timestamp with time zone,text)',
        'EXECUTE'
      ) as close_execute_surface_correct,
    to_regclass('public.work_order_close_transition_guards') is not null
      and not has_table_privilege(
        'authenticated',
        'public.work_order_close_transition_guards',
        'SELECT,INSERT,UPDATE,DELETE'
      ) as close_guard_private,
    coalesce((
      select trigger_row.tgenabled in ('O', 'A')
        and (trigger_row.tgtype::integer & 23) = 23
        and pg_get_functiondef(procedure.oid)
          ilike '%Work orders cannot be created in a closed state%'
        and pg_get_functiondef(procedure.oid)
          ilike '%new.closed_at is distinct from old.closed_at%'
        and pg_get_functiondef(procedure.oid)
          ilike '%work_order_close_transition_guards%'
      from pg_trigger trigger_row
      join pg_proc procedure on procedure.oid = trigger_row.tgfoid
      where trigger_row.tgrelid = 'public.work_orders'::regclass
        and trigger_row.tgname =
          'zz_prevent_direct_work_order_close_trigger'
        and not trigger_row.tgisinternal
    ), false) as direct_close_guard_enabled,
    coalesce((
      select index_definition.indexdef ilike
        '%(work_order_id, workflow_cycle)%work_order_follow_up_closed_without_additional_billing%'
      from pg_indexes index_definition
      where index_definition.schemaname = 'public'
        and index_definition.indexname =
          'activities_follow_up_close_cycle_unique'
    ), false) as one_close_per_cycle,
    coalesce((
      select pg_get_triggerdef(trigger_row.oid) ilike
          '%before insert or update of work_order_id, deleted_at, invoice_type%'
      from pg_trigger trigger_row
      where trigger_row.tgrelid = 'public.invoices'::regclass
        and trigger_row.tgname =
          'prevent_invoice_on_closed_work_order_trigger'
        and not trigger_row.tgisinternal
    ), false) as invoice_restore_guard_enabled,
    coalesce((
      select trigger_row.tgenabled in ('O', 'A')
        and (trigger_row.tgtype::integer & 23) = 23
        and pg_get_functiondef(procedure.oid)
          ilike '%from public.work_orders work_order%for key share%'
        and pg_get_functiondef(procedure.oid)
          ilike '%new.requires_7eleven_sync = true%'
        and pg_get_functiondef(procedure.oid)
          ilike '%new.requires_contractor_attention = true%'
      from pg_trigger trigger_row
      join pg_proc procedure on procedure.oid = trigger_row.tgfoid
      where trigger_row.tgrelid = 'public.activities'::regclass
        and trigger_row.tgname =
          'zz_guard_terminal_work_order_activity_trigger'
        and not trigger_row.tgisinternal
    ), false) as terminal_activity_guard_enabled,
    coalesce((
      select trigger_row.tgenabled in ('O', 'A')
        and (trigger_row.tgtype::integer & 23) = 23
        and pg_get_functiondef(procedure.oid)
          ilike '%from public.work_orders work_order%for key share%'
        and pg_get_functiondef(procedure.oid)
          ilike '%v_work_order_status = ''closed''%'
        and pg_get_functiondef(procedure.oid)
          ilike '%old.check_out_at is not null and new.check_out_at is null%'
      from pg_trigger trigger_row
      join pg_proc procedure on procedure.oid = trigger_row.tgfoid
      where trigger_row.tgrelid = 'public.work_order_visits'::regclass
        and trigger_row.tgname =
          'zz_guard_terminal_work_order_visit_mutation_trigger'
        and not trigger_row.tgisinternal
    ), false) as terminal_visit_guard_enabled,
    coalesce((
      select trigger_row.tgenabled in ('O', 'A')
        and (trigger_row.tgtype::integer & 31) = 31
        and pg_get_functiondef(procedure.oid)
          ilike '%Authoritative work-order lifecycle activity is immutable%'
        and pg_get_functiondef(procedure.oid)
          ilike '%Billed-to-7-Eleven activity must be created by the billing workflow%'
        and pg_get_functiondef(procedure.oid)
          ilike '%Terminal close activity must be created by its owning workflow%'
      from pg_trigger trigger_row
      join pg_proc procedure on procedure.oid = trigger_row.tgfoid
      where trigger_row.tgrelid = 'public.activities'::regclass
        and trigger_row.tgname =
          'zy_protect_authoritative_close_activity_trigger'
        and not trigger_row.tgisinternal
    ), false) as authoritative_activity_guard_enabled,
    coalesce((
      select index_definition.indexdef ilike
        '%(work_order_id, workflow_cycle)%work_order_reopened%'
      from pg_indexes index_definition
      where index_definition.schemaname = 'public'
        and index_definition.indexname =
          'activities_one_reopen_per_workflow_cycle'
    ), false) as one_reopen_per_cycle,
    coalesce((
      select pg_get_functiondef(procedure.oid)
          ilike '%work_order_close_transition_guards%without_invoice%'
        and pg_get_functiondef(procedure.oid)
          ilike '%workflow_cycle is distinct from p_expected_workflow_cycle%'
        and pg_get_functiondef(procedure.oid)
          ilike '%updated_at is distinct from p_expected_updated_at%'
      from pg_proc procedure
      where procedure.oid =
        to_regprocedure('public.close_work_order_without_invoice(text,integer,integer,timestamp with time zone)')
    ), false) as no_invoice_close_guarded,
    not has_function_privilege('authenticated',
      'public.close_work_order_without_invoice(text)', 'EXECUTE')
      and not has_function_privilege('anon',
        'public.close_work_order_without_invoice(text,integer,integer,timestamp with time zone)', 'EXECUTE')
      and has_function_privilege('authenticated',
        'public.close_work_order_without_invoice(text,integer,integer,timestamp with time zone)', 'EXECUTE')
      as no_invoice_close_surface_guarded,
    to_regprocedure(
      'public.save_staff_billing_invoice_v3_core(uuid,uuid,text,text,text,text,text,date,date,date,text,text,numeric,text,numeric,text,text,jsonb,uuid[])'
    ) is not null as staff_invoice_core_present,
    coalesce((
      select procedure.prosecdef
        and pg_get_functiondef(procedure.oid)
          ilike '%from public.work_orders work_order%for update%'
        and pg_get_functiondef(procedure.oid)
          ilike '%work_order_follow_up_closed_without_additional_billing%'
      from pg_proc procedure
      where procedure.oid = to_regprocedure(
        'public.save_staff_billing_invoice_v3(uuid,uuid,text,text,text,text,text,date,date,date,text,text,numeric,text,numeric,text,text,jsonb,uuid[])'
      )
    ), false) as staff_invoice_save_serialized,
    not has_function_privilege(
      'service_role',
      'public.save_staff_billing_invoice_v3_core(uuid,uuid,text,text,text,text,text,date,date,date,text,text,numeric,text,numeric,text,text,jsonb,uuid[])',
      'EXECUTE'
    )
      and has_function_privilege(
        'service_role',
        'public.save_staff_billing_invoice_v3(uuid,uuid,text,text,text,text,text,date,date,date,text,text,numeric,text,numeric,text,text,jsonb,uuid[])',
        'EXECUTE'
      ) as staff_invoice_surface_guarded,
    coalesce((
      select pg_get_functiondef(procedure.oid)
          ilike '%v_already_finalized%already_billed%'
        and pg_get_functiondef(procedure.oid)
          ilike '%v_invoice.created_at < v_reopen_activity.created_at%'
        and pg_get_functiondef(procedure.oid)
          ilike '%v_work_order.status = ''closed''%work_order_follow_up_closed_without_additional_billing%reopen it before billing another invoice%'
      from pg_proc procedure
      where procedure.oid =
        to_regprocedure('public.mark_staff_invoice_billed(uuid,uuid)')
    ), false) as stale_billing_replay_guarded,
    coalesce((
      select pg_get_functiondef(procedure.oid)
        ilike '%quickbooks_transition = ''confirm'' then%return null%'
      from pg_proc procedure
      where procedure.oid =
        to_regprocedure('public.preserve_operational_work_order_status()')
    ), false) as quickbooks_parent_update_skipped,
    (select count(*)
     from public.activities close_activity
     join public.work_orders work_order
       on work_order.id = close_activity.work_order_id
     where close_activity.event_key =
         'work_order_follow_up_closed_without_additional_billing'
       and close_activity.deleted_at is null
       and work_order.workflow_cycle = close_activity.workflow_cycle
       and (
         work_order.status <> 'closed'
         or work_order.functional_status::text <> 'Completed'
         or work_order.closed_at is null
         or not exists (
           select 1 from public.activities reopen_activity
           where reopen_activity.id::text = close_activity.event_data ->> 'reopenActivityId'
             and reopen_activity.work_order_id = close_activity.work_order_id
             and reopen_activity.workflow_cycle = close_activity.workflow_cycle
             and reopen_activity.event_key = 'work_order_reopened'
             and reopen_activity.deleted_at is null
         )
       )) as invalid_closed_follow_up_count,
    (select count(*)
     from (
       select close_activity.work_order_id, close_activity.workflow_cycle
       from public.activities close_activity
       where close_activity.event_key =
           'work_order_follow_up_closed_without_additional_billing'
         and close_activity.deleted_at is null
       group by close_activity.work_order_id, close_activity.workflow_cycle
       having count(*) > 1
     ) duplicate_close) as duplicate_close_cycle_count,
    (select count(*)
     from public.activities close_activity
     join public.work_orders work_order
       on work_order.id = close_activity.work_order_id
      and work_order.status = 'closed'
      and (
        work_order.closed_at is null
        or close_activity.created_at >= work_order.closed_at
      )
     join public.invoices invoice
       on invoice.work_order_id = close_activity.work_order_id
      and invoice.deleted_at is null
      and invoice.created_at >= close_activity.created_at
     where close_activity.event_key =
         'work_order_follow_up_closed_without_additional_billing'
       and close_activity.deleted_at is null) as post_close_invoice_count,
    (select count(*)
      from public.activities close_activity
      join public.activities reopen_activity
        on reopen_activity.id::text = close_activity.event_data ->> 'reopenActivityId'
       and reopen_activity.work_order_id = close_activity.work_order_id
       and reopen_activity.workflow_cycle = close_activity.workflow_cycle
      join public.invoices invoice
        on invoice.work_order_id = close_activity.work_order_id
       and invoice.invoice_type = 'staff'
       and invoice.document_kind = 'invoice'
       and invoice.deleted_at is null
       and invoice.created_at < reopen_activity.created_at
      where close_activity.event_key =
          'work_order_follow_up_closed_without_additional_billing'
        and close_activity.deleted_at is null
        and not exists (
          select 1
          from public.activities billing_activity
          where billing_activity.work_order_id = close_activity.work_order_id
            and billing_activity.event_key = 'staff_billing'
            and billing_activity.event_data ->> 'action' =
              'billed_to_7_eleven'
            and billing_activity.event_data ->> 'invoiceId' = invoice.id::text
            and billing_activity.created_at < reopen_activity.created_at
            and billing_activity.deleted_at is null
        )) as unbilled_prior_staff_invoice_count,
    (select count(*)
     from public.activities close_activity
     join public.activities reopen_activity
       on reopen_activity.id::text = close_activity.event_data ->> 'reopenActivityId'
      and reopen_activity.work_order_id = close_activity.work_order_id
      and reopen_activity.workflow_cycle = close_activity.workflow_cycle
     join public.activities billing_activity
       on billing_activity.work_order_id = close_activity.work_order_id
      and billing_activity.event_key in (
        'staff_invoice_ready',
        'staff_billing',
        'invoice_draft',
        'invoice_submitted',
        'invoice_resubmitted',
        'invoice_uploaded',
        'invoice_approved',
        'invoice_rejected',
        'invoice_rejection_retracted',
        'invoice_deleted',
        'invoice_deleted_by_contractor'
      )
      and billing_activity.created_at >= reopen_activity.created_at
      and billing_activity.created_at < close_activity.created_at
      and billing_activity.deleted_at is null
     where close_activity.event_key =
         'work_order_follow_up_closed_without_additional_billing'
       and close_activity.deleted_at is null) as reopened_cycle_billing_event_count,
    (select count(*)
     from public.work_order_close_transition_guards) as unresolved_close_guard_count
), summarized as (
  select checks.*,
    close_function_present
      and close_function_guarded
      and close_execute_surface_correct
      and close_guard_private
      and direct_close_guard_enabled
      and one_close_per_cycle
      and one_reopen_per_cycle
      and invoice_restore_guard_enabled
      and terminal_activity_guard_enabled
      and terminal_visit_guard_enabled
      and authoritative_activity_guard_enabled
      and no_invoice_close_guarded
      and no_invoice_close_surface_guarded
      and staff_invoice_core_present
      and staff_invoice_save_serialized
      and staff_invoice_surface_guarded
      and stale_billing_replay_guarded
      and quickbooks_parent_update_skipped
      and invalid_closed_follow_up_count = 0
      and duplicate_close_cycle_count = 0
      and post_close_invoice_count = 0
      and unbilled_prior_staff_invoice_count = 0
      and reopened_cycle_billing_event_count = 0
      and unresolved_close_guard_count = 0 as all_checks_pass
  from checks
)
select * from summarized;
