-- Run after the 0117 expand migration and before the 0118 contract migration.
-- One row is returned; all_checks_pass must be true. Legacy pending rows are
-- intentionally allowed during this compatibility window.

with checks as (
  select
    to_regprocedure('public.stage_contractor_bill_handoff(uuid,uuid,text,jsonb,text,bigint,text)') is not null
      as protected_stage_function_present,
    coalesce((
      select procedure.prosecdef
      from pg_proc procedure
      where procedure.oid = to_regprocedure('public.stage_contractor_bill_handoff(uuid,uuid,text,jsonb,text,bigint,text)')
    ), false) as protected_stage_security_definer,
    coalesce((
      select procedure.proconfig @> array['search_path=public, pg_temp']
      from pg_proc procedure
      where procedure.oid = to_regprocedure('public.stage_contractor_bill_handoff(uuid,uuid,text,jsonb,text,bigint,text)')
    ), false) as protected_stage_search_path_pinned,
    coalesce((
      select pg_get_functiondef(procedure.oid) ~ 'order by line.invoice_id, line.id[[:space:]]+for update of line'
      from pg_proc procedure
      where procedure.oid = to_regprocedure('public.stage_contractor_bill_handoff(uuid,uuid,text,jsonb,text,bigint,text)')
    ), false) as invoice_lines_locked_during_stage,
    not has_function_privilege('anon', 'public.stage_contractor_bill_handoff(uuid,uuid,text,jsonb,text,bigint,text)', 'EXECUTE')
      as anonymous_stage_blocked,
    not has_function_privilege('authenticated', 'public.stage_contractor_bill_handoff(uuid,uuid,text,jsonb,text,bigint,text)', 'EXECUTE')
      as authenticated_stage_blocked,
    has_function_privilege('service_role', 'public.stage_contractor_bill_handoff(uuid,uuid,text,jsonb,text,bigint,text)', 'EXECUTE')
      as service_role_stage_enabled,
    coalesce((
      select procedure.prosecdef
        and coalesce(
          procedure.proconfig @> array['search_path=public, pg_temp'],
          false
        )
        and pg_get_functiondef(procedure.oid) ilike '%insert into public.controller_invoice_export_batches%'
        and pg_get_functiondef(procedure.oid) not ilike '%Legacy contractor-bill staging is disabled%'
      from pg_proc procedure
      where procedure.oid = to_regprocedure('public.stage_controller_invoice_export(uuid,uuid,text,uuid[])')
    ), false)
      and not has_function_privilege('anon', 'public.stage_controller_invoice_export(uuid,uuid,text,uuid[])', 'EXECUTE')
      and not has_function_privilege('authenticated', 'public.stage_controller_invoice_export(uuid,uuid,text,uuid[])', 'EXECUTE')
      and has_function_privilege('service_role', 'public.stage_controller_invoice_export(uuid,uuid,text,uuid[])', 'EXECUTE')
      as legacy_stage_compatibility_preserved,
    coalesce((
      select procedure.prosecdef
        and coalesce(
          procedure.proconfig @> array['search_path=public, pg_temp'],
          false
        )
        and pg_get_functiondef(procedure.oid) ilike '%stage_controller_invoice_export%'
        and pg_get_functiondef(procedure.oid) not ilike '%Legacy contractor-bill staging is disabled%'
      from pg_proc procedure
      where procedure.oid = to_regprocedure('public.complete_controller_invoice_export(uuid,uuid,text,uuid[])')
    ), false)
      and not has_function_privilege('anon', 'public.complete_controller_invoice_export(uuid,uuid,text,uuid[])', 'EXECUTE')
      and not has_function_privilege('authenticated', 'public.complete_controller_invoice_export(uuid,uuid,text,uuid[])', 'EXECUTE')
      and has_function_privilege('service_role', 'public.complete_controller_invoice_export(uuid,uuid,text,uuid[])', 'EXECUTE')
      as legacy_complete_compatibility_preserved,
    exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'controller_invoice_export_batches'
        and column_name = 'archive_sha256'
    ) and exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'controller_invoice_export_batches'
        and column_name = 'archive_bytes'
    ) and exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'controller_invoice_export_batches'
        and column_name = 'archive_format'
    ) as archive_fingerprint_columns_present,
    exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'controller_invoice_export_items'
        and column_name = 'source_updated_at'
    ) and exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'controller_invoice_export_items'
        and column_name = 'source_pdf_path'
    ) as item_snapshot_columns_present,
    not exists (
      select 1 from pg_constraint constraint_row
      where constraint_row.conrelid = 'public.controller_invoice_export_batches'::regclass
        and constraint_row.conname = 'controller_export_pending_verified_check'
    ) as verified_pending_constraint_deferred,
    exists (
      select 1 from pg_trigger trigger_row
      where trigger_row.tgrelid = 'public.invoices'::regclass
        and trigger_row.tgname = 'guard_pending_contractor_bill_invoice_trigger'
        and not trigger_row.tgisinternal
    ) as pending_invoice_guard_installed,
    coalesce((
      select count(*) = 5
        and bool_and(
          procedure.prosecdef
          and coalesce(
            procedure.proconfig @> array['search_path=public, pg_temp'],
            false
          )
        )
      from pg_proc procedure
      where procedure.oid in (
        to_regprocedure('public.guard_pending_contractor_bill_invoice()'),
        to_regprocedure('public.guard_pending_contractor_bill_lines()'),
        to_regprocedure('public.touch_invoice_after_line_change()'),
        to_regprocedure('public.guard_contractor_bill_handoff_batch()'),
        to_regprocedure('public.guard_contractor_bill_handoff_item()')
      )
    ), false) as trigger_guards_security_definer,
    exists (
      select 1 from pg_trigger trigger_row
      where trigger_row.tgrelid = 'public.invoice_lines'::regclass
        and trigger_row.tgname = 'guard_pending_contractor_bill_lines_trigger'
        and not trigger_row.tgisinternal
    ) as pending_line_guard_installed,
    exists (
      select 1 from pg_trigger trigger_row
      where trigger_row.tgrelid = 'public.invoice_lines'::regclass
        and trigger_row.tgname = 'touch_invoice_after_line_change_trigger'
        and not trigger_row.tgisinternal
    ) as line_revision_trigger_installed,
    exists (
      select 1 from pg_trigger trigger_row
      where trigger_row.tgrelid = 'public.controller_invoice_export_batches'::regclass
        and trigger_row.tgname = 'guard_contractor_bill_handoff_batch_trigger'
        and not trigger_row.tgisinternal
    ) as batch_metadata_guard_installed,
    exists (
      select 1 from pg_trigger trigger_row
      where trigger_row.tgrelid = 'public.controller_invoice_export_items'::regclass
        and trigger_row.tgname = 'guard_contractor_bill_handoff_item_trigger'
        and not trigger_row.tgisinternal
    ) as item_snapshot_guard_installed,
    (select count(*)
     from public.controller_invoice_export_batches batch
     where (batch.archive_format is null) <> (batch.archive_sha256 is null)
        or (batch.archive_format is null) <> (batch.archive_bytes is null)
        or (batch.archive_format is not null and (
          batch.archive_format not in ('reference_manifest_v2', 'legacy_saas_ant_v1')
          or batch.archive_sha256 !~ '^[0-9a-f]{64}$'
          or batch.archive_bytes <= 0
          or batch.archive_bytes > 104857600
        ))) as archive_metadata_issue_count,
    (select count(*)
     from public.controller_invoice_export_batches batch
     join public.controller_invoice_export_items item on item.batch_id = batch.id
     join public.invoices invoice on invoice.id = item.invoice_id
     where batch.status = 'pending'
       and batch.archive_format = 'reference_manifest_v2'
       and (item.source_updated_at is null
         or invoice.updated_at is distinct from item.source_updated_at
         or invoice.pdf_storage_path is distinct from item.source_pdf_path
         or round(coalesce(invoice.total, 0), 2) is distinct from round(item.total, 2)))
      as pending_snapshot_issue_count
    ,(select count(*)
      from public.controller_invoice_export_batches batch
      where batch.status = 'pending'
        and batch.archive_format is distinct from 'reference_manifest_v2')
      as legacy_pending_batch_count
), summarized as (
  select checks.*,
    protected_stage_function_present
      and protected_stage_security_definer
      and protected_stage_search_path_pinned
      and invoice_lines_locked_during_stage
      and anonymous_stage_blocked
      and authenticated_stage_blocked
      and service_role_stage_enabled
      and legacy_stage_compatibility_preserved
      and legacy_complete_compatibility_preserved
      and archive_fingerprint_columns_present
      and item_snapshot_columns_present
      and verified_pending_constraint_deferred
      and pending_invoice_guard_installed
      and trigger_guards_security_definer
      and pending_line_guard_installed
      and line_revision_trigger_installed
      and batch_metadata_guard_installed
      and item_snapshot_guard_installed
      and archive_metadata_issue_count = 0
      and pending_snapshot_issue_count = 0 as all_checks_pass
  from checks
)
select * from summarized;
