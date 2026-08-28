-- Run after migrations 0096 through 0099. One row is returned; deployment is
-- complete only when every migration column and all_checks_pass are true.

with function_oids as (
  select
    to_regprocedure(
      'public.stage_controller_invoice_export(uuid,uuid,text,uuid[])'
    ) as stage_handoff_rpc,
    to_regprocedure(
      'public.confirm_controller_invoice_export(uuid,uuid)'
    ) as confirm_handoff_rpc,
    to_regprocedure(
      'public.cancel_controller_invoice_export(uuid,uuid,text)'
    ) as cancel_handoff_rpc,
    to_regprocedure(
      'public.save_staff_billing_invoice_v3(uuid,uuid,text,text,text,text,text,date,date,date,text,text,numeric,text,numeric,text,text,jsonb,uuid[])'
    ) as billing_save_v3_rpc,
    to_regprocedure(
      'public.mark_staff_invoice_ready(uuid,uuid)'
    ) as mark_ready_rpc,
    to_regprocedure(
      'public.attach_contractor_estimate_file(uuid,text,text,text,bigint)'
    ) as attach_estimate_file_rpc,
    to_regprocedure(
      'public.remove_contractor_estimate_file(uuid)'
    ) as remove_estimate_file_rpc
),
definitions as (
  select
    function_oids.*,
    coalesce(pg_get_functiondef(stage_handoff_rpc), '') as stage_definition,
    coalesce(pg_get_functiondef(confirm_handoff_rpc), '') as confirm_definition,
    coalesce(pg_get_functiondef(mark_ready_rpc), '') as ready_definition,
    coalesce(pg_get_functiondef(attach_estimate_file_rpc), '') as attach_definition
  from function_oids
),
checks as (
  select
    (
      select count(*) = 6
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'controller_invoice_export_batches'
        and column_name in (
          'status',
          'confirmed_at',
          'confirmed_by',
          'cancelled_at',
          'cancelled_by',
          'cancellation_reason'
        )
    )
      and (
        select count(*) = 2
        from pg_constraint
        where conrelid = 'public.controller_invoice_export_batches'::regclass
          and conname in (
            'controller_export_batch_status_check',
            'controller_export_batch_resolution_check'
          )
      )
      and stage_handoff_rpc is not null
      and confirm_handoff_rpc is not null
      and cancel_handoff_rpc is not null
      and stage_definition like '%quickbooks_handoff%'
      and stage_definition like '%status%pending%'
      and confirm_definition like '%quickbooks_handoff_transition%'
      and confirm_definition like '%state = ''paid''%'
      and exists (
        select 1
        from pg_trigger
        where tgrelid = 'public.invoices'::regclass
          and tgname = 'protect_quickbooks_handoff_transition_trigger'
          and not tgisinternal
      )
      and not coalesce(
        has_function_privilege('authenticated', stage_handoff_rpc, 'EXECUTE'),
        false
      )
      and coalesce(
        has_function_privilege('service_role', stage_handoff_rpc, 'EXECUTE'),
        false
      )
      as migration_0096_guarded_handoff_applied,

    exists (
      select 1
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'invoices'
        and column_name = 'equipment_tag'
    )
      and exists (
        select 1
        from pg_constraint
        where conrelid = 'public.invoices'::regclass
          and conname = 'invoices_equipment_tag_check'
      )
      and billing_save_v3_rpc is not null
      and not coalesce(
        has_function_privilege('authenticated', billing_save_v3_rpc, 'EXECUTE'),
        false
      )
      and coalesce(
        has_function_privilege('service_role', billing_save_v3_rpc, 'EXECUTE'),
        false
      )
      as migration_0097_equipment_tags_applied,

    mark_ready_rpc is not null
      and ready_definition like '%invoice_type = ''staff''%'
      and ready_definition like '%state = ''submitted''%'
      and not coalesce(
        has_function_privilege('authenticated', mark_ready_rpc, 'EXECUTE'),
        false
      )
      and coalesce(
        has_function_privilege('service_role', mark_ready_rpc, 'EXECUTE'),
        false
      )
      as migration_0098_invoice_ready_applied,

    to_regclass('public.contractor_estimate_attachments') is not null
      and exists (
        select 1
        from pg_class table_class
        where table_class.oid = 'public.contractor_estimate_attachments'::regclass
          and table_class.relrowsecurity
      )
      and exists (
        select 1
        from storage.buckets bucket
        where bucket.id = 'contractor-estimate-attachments'
          and bucket.public = false
          and bucket.file_size_limit = 15728640
      )
      and (
        select count(*) = 4
        from pg_policies
        where (
          schemaname = 'public'
          and tablename = 'contractor_estimate_attachments'
          and policyname = 'contractor_estimate_attachments_read'
        )
        or (
          schemaname = 'storage'
          and tablename = 'objects'
          and policyname in (
            'contractor_estimate_attachments_storage_read',
            'contractor_estimate_attachments_storage_insert',
            'contractor_estimate_attachments_storage_delete'
          )
        )
      )
      and attach_estimate_file_rpc is not null
      and remove_estimate_file_rpc is not null
      and attach_definition like '%contractor_assignment_version%'
      and attach_definition like '%can_access_contractor_work_order%'
      and coalesce(
        has_function_privilege('authenticated', attach_estimate_file_rpc, 'EXECUTE'),
        false
      )
      and not coalesce(
        has_function_privilege('anon', attach_estimate_file_rpc, 'EXECUTE'),
        false
      )
      as migration_0099_estimate_attachments_applied,

    (
      select count(*) = 7
      from pg_proc procedure
      where procedure.oid in (
        stage_handoff_rpc,
        confirm_handoff_rpc,
        cancel_handoff_rpc,
        billing_save_v3_rpc,
        mark_ready_rpc,
        attach_estimate_file_rpc,
        remove_estimate_file_rpc
      )
        and procedure.prosecdef
    ) as security_definer_preserved
  from definitions
)
select
  migration_0096_guarded_handoff_applied,
  migration_0097_equipment_tags_applied,
  migration_0098_invoice_ready_applied,
  migration_0099_estimate_attachments_applied,
  security_definer_preserved,
  migration_0096_guarded_handoff_applied
    and migration_0097_equipment_tags_applied
    and migration_0098_invoice_ready_applied
    and migration_0099_estimate_attachments_applied
    and security_definer_preserved
    as all_checks_pass
from checks;

-- Human authorization check: this result should contain Emily and, once
-- approved, only the named backup. Remove any unexpected grant before go-live.
select
  profile.id,
  profile.name,
  profile.email,
  profile.role,
  profile.active,
  permission_grant.created_at as granted_at
from public.staff_permission_grants permission_grant
join public.profiles profile on profile.id = permission_grant.profile_id
where permission_grant.permission = 'quickbooks_handoff'
order by profile.active desc, profile.name, profile.id;
