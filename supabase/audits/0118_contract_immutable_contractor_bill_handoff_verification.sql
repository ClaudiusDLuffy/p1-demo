-- Run only after the 0118 contract migration. The new application must already
-- be stable and the legacy-app rollback window must be closed. One row is
-- returned; all_checks_pass must be true.

with checks as (
  select
    to_regprocedure(
      'public.stage_contractor_bill_handoff(uuid,uuid,text,jsonb,text,bigint,text)'
    ) is not null as protected_stage_function_present,
    coalesce((
      select procedure.prosecdef
        and coalesce(
          procedure.proconfig @> array['search_path=public, pg_temp'],
          false
        )
      from pg_proc procedure
      where procedure.oid = to_regprocedure(
        'public.stage_contractor_bill_handoff(uuid,uuid,text,jsonb,text,bigint,text)'
      )
    ), false) as protected_stage_guarded,
    not has_function_privilege(
      'anon',
      'public.stage_contractor_bill_handoff(uuid,uuid,text,jsonb,text,bigint,text)',
      'EXECUTE'
    )
      and not has_function_privilege(
        'authenticated',
        'public.stage_contractor_bill_handoff(uuid,uuid,text,jsonb,text,bigint,text)',
        'EXECUTE'
      )
      and has_function_privilege(
        'service_role',
        'public.stage_contractor_bill_handoff(uuid,uuid,text,jsonb,text,bigint,text)',
        'EXECUTE'
      ) as protected_stage_access_guarded,
    coalesce((
      select procedure.prosecdef
        and coalesce(
          procedure.proconfig @> array['search_path=public, pg_temp'],
          false
        )
        and pg_get_functiondef(procedure.oid)
          ilike '%Legacy contractor-bill staging is disabled%'
        and pg_get_functiondef(procedure.oid) ilike '%errcode = ''55000''%'
      from pg_proc procedure
      where procedure.oid = to_regprocedure(
        'public.stage_controller_invoice_export(uuid,uuid,text,uuid[])'
      )
    ), false) as legacy_stage_disabled,
    coalesce((
      select procedure.prosecdef
        and coalesce(
          procedure.proconfig @> array['search_path=public, pg_temp'],
          false
        )
        and pg_get_functiondef(procedure.oid)
          ilike '%Legacy contractor-bill staging is disabled%'
        and pg_get_functiondef(procedure.oid) ilike '%errcode = ''55000''%'
      from pg_proc procedure
      where procedure.oid = to_regprocedure(
        'public.complete_controller_invoice_export(uuid,uuid,text,uuid[])'
      )
    ), false) as legacy_complete_disabled,
    not has_function_privilege(
      'anon',
      'public.stage_controller_invoice_export(uuid,uuid,text,uuid[])',
      'EXECUTE'
    )
      and not has_function_privilege(
        'authenticated',
        'public.stage_controller_invoice_export(uuid,uuid,text,uuid[])',
        'EXECUTE'
      )
      and not has_function_privilege(
        'anon',
        'public.complete_controller_invoice_export(uuid,uuid,text,uuid[])',
        'EXECUTE'
      )
      and not has_function_privilege(
        'authenticated',
        'public.complete_controller_invoice_export(uuid,uuid,text,uuid[])',
        'EXECUTE'
      ) as untrusted_legacy_execute_blocked,
    has_function_privilege(
      'service_role',
      'public.stage_controller_invoice_export(uuid,uuid,text,uuid[])',
      'EXECUTE'
    )
      and has_function_privilege(
        'service_role',
        'public.complete_controller_invoice_export(uuid,uuid,text,uuid[])',
        'EXECUTE'
      ) as service_role_legacy_signatures_preserved,
    coalesce((
      select pg_get_constraintdef(constraint_row.oid)
          ilike '%status <> ''pending''%'
        and pg_get_constraintdef(constraint_row.oid)
          ilike '%archive_format = ''reference_manifest_v2''%'
        and pg_get_constraintdef(constraint_row.oid)
          ilike '%archive_sha256 is not null%'
        and pg_get_constraintdef(constraint_row.oid)
          ilike '%archive_bytes is not null%'
      from pg_constraint constraint_row
      where constraint_row.conrelid =
        'public.controller_invoice_export_batches'::regclass
        and constraint_row.conname =
          'controller_export_pending_verified_check'
    ), false) as verified_pending_constraint_present,
    (select count(*)
     from public.controller_invoice_export_batches batch
     where batch.status = 'pending'
       and (
         batch.archive_format is distinct from 'reference_manifest_v2'
         or batch.archive_sha256 is null
         or batch.archive_bytes is null
       )) as unverified_pending_batch_count,
    (select count(*)
     from public.controller_invoice_export_batches batch
     join public.controller_invoice_export_items item
       on item.batch_id = batch.id
     join public.invoices invoice on invoice.id = item.invoice_id
     where batch.status = 'pending'
       and batch.archive_format = 'reference_manifest_v2'
       and (
         item.source_updated_at is null
         or invoice.updated_at is distinct from item.source_updated_at
         or invoice.pdf_storage_path is distinct from item.source_pdf_path
         or round(coalesce(invoice.total, 0), 2)
           is distinct from round(item.total, 2)
       )) as pending_snapshot_issue_count
), summarized as (
  select checks.*,
    protected_stage_function_present
      and protected_stage_guarded
      and protected_stage_access_guarded
      and legacy_stage_disabled
      and legacy_complete_disabled
      and untrusted_legacy_execute_blocked
      and service_role_legacy_signatures_preserved
      and verified_pending_constraint_present
      and unverified_pending_batch_count = 0
      and pending_snapshot_issue_count = 0 as all_checks_pass
  from checks
)
select * from summarized;
