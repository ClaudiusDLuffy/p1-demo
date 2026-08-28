-- Run after migration 0102 and the template publisher. Deployment is complete
-- only when every column and all_checks_pass return true.

with policy_definitions as (
  select
    coalesce((
      select policy.qual
      from pg_policies policy
      where policy.schemaname = 'public'
        and policy.tablename = 'contractor_estimate_templates'
        and policy.policyname = 'contractor_estimate_templates_read'
    ), '') as table_read_qual,
    coalesce((
      select policy.qual
      from pg_policies policy
      where policy.schemaname = 'storage'
        and policy.tablename = 'objects'
        and policy.policyname = 'contractor_estimate_templates_storage_read'
    ), '') as storage_read_qual
),
checks as (
  select
    to_regclass('public.contractor_estimate_templates') is not null
      and exists (
        select 1
        from pg_class table_class
        where table_class.oid = 'public.contractor_estimate_templates'::regclass
          and table_class.relrowsecurity
      )
      as private_template_table_present,

    exists (
      select 1
      from storage.buckets bucket
      where bucket.id = 'contractor-estimate-templates'
        and bucket.public = false
        and bucket.file_size_limit = 15728640
        and bucket.allowed_mime_types = array[
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        ]
    ) as private_xlsx_bucket_present,

    table_read_qual like '%is_active%'
      and table_read_qual like '%is_staff%'
      and table_read_qual like '%is_invoice_controller%'
      and table_read_qual like '%current_contractor_account_id%'
      and table_read_qual like '%can_invoice_for_contractor%'
      as active_authorized_read_scoped,

    storage_read_qual like '%contractor-estimate-templates%'
      and storage_read_qual like '%contractor_estimate_templates%'
      and storage_read_qual like '%is_active%'
      as private_storage_read_scoped,

    coalesce(
      has_table_privilege(
        'authenticated',
        'public.contractor_estimate_templates',
        'SELECT'
      ),
      false
    )
      and not coalesce(
        has_table_privilege(
          'authenticated',
          'public.contractor_estimate_templates',
          'INSERT'
        ),
        false
      )
      and not coalesce(
        has_table_privilege(
          'authenticated',
          'public.contractor_estimate_templates',
          'UPDATE'
        ),
        false
      )
      and not coalesce(
        has_table_privilege(
          'authenticated',
          'public.contractor_estimate_templates',
          'DELETE'
        ),
        false
      )
      as authenticated_download_only,

    not coalesce(
      has_table_privilege(
        'anon',
        'public.contractor_estimate_templates',
        'SELECT'
      ),
      false
    ) as anonymous_metadata_blocked,

    not exists (
      select 1
      from pg_policies policy
      where policy.schemaname = 'storage'
        and policy.tablename = 'objects'
        and policy.cmd in ('INSERT', 'UPDATE', 'DELETE', 'ALL')
        and concat(coalesce(policy.qual, ''), ' ', coalesce(policy.with_check, ''))
          like '%contractor-estimate-templates%'
    ) as authenticated_storage_publish_blocked,

    (
      select count(*) = 2
        and count(*) filter (where template_key = 'heatcraft') = 1
        and count(*) filter (where template_key = 'carrier') = 1
        and bool_and(is_active)
        and bool_and(lower(original_name) like '%.xlsx')
        and bool_and(size_bytes between 1 and 15728640)
      from public.contractor_estimate_templates
    ) as approved_metadata_published,

    (
      select count(*) = 2
      from public.contractor_estimate_templates template
      join storage.objects object
        on object.bucket_id = 'contractor-estimate-templates'
       and object.name = template.storage_path
      where template.is_active
    ) as approved_objects_published,

    not exists (
      select 1
      from public.contractor_estimate_templates template
      where template.template_key not in ('heatcraft', 'carrier')
         or lower(template.display_name) like '%square footage%'
         or lower(template.display_name) like '%load calculator%'
    ) as private_workbooks_excluded
  from policy_definitions
)
select
  private_template_table_present,
  private_xlsx_bucket_present,
  active_authorized_read_scoped,
  private_storage_read_scoped,
  authenticated_download_only,
  anonymous_metadata_blocked,
  authenticated_storage_publish_blocked,
  approved_metadata_published,
  approved_objects_published,
  private_workbooks_excluded,
  private_template_table_present
    and private_xlsx_bucket_present
    and active_authorized_read_scoped
    and private_storage_read_scoped
    and authenticated_download_only
    and anonymous_metadata_blocked
    and authenticated_storage_publish_blocked
    and approved_metadata_published
    and approved_objects_published
    and private_workbooks_excluded
    as all_checks_pass
from checks;
