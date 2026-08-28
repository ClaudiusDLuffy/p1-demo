-- Run after migrations 0091 through 0095. One row is returned; deployment is
-- complete only when every column, including all_checks_pass, is true.

with function_oids as (
  select
    to_regprocedure('public.can_access_contractor_work_order(text)') as access_rpc,
    to_regprocedure('public.list_p1_part_costs_for_work_order(text)') as cost_rpc,
    to_regprocedure('public.list_billable_p1_parts(text,uuid)') as billable_parts_rpc,
    to_regprocedure('public.set_p1_part_order_status_with_cost(uuid,text,numeric)') as part_status_rpc,
    to_regprocedure(
      'public.save_staff_billing_invoice_v2(uuid,uuid,text,text,text,text,text,date,date,date,text,text,numeric,text,numeric,text,jsonb,uuid[])'
    ) as billing_save_rpc,
    to_regprocedure(
      'public.list_work_orders_table_page(text,text,uuid,text,text,text,text,date,date,boolean,text,boolean,integer,text,text,uuid[],text,text,text,text,text,text,text,date,date,text)'
    ) as work_order_page_rpc,
    to_regprocedure(
      'public.list_staff_invoices_page(text,text,text,text,integer,text,text)'
    ) as staff_invoice_page_rpc,
    to_regprocedure('public.set_activity_contractor_attention(uuid,boolean)') as attention_rpc
),
definitions as (
  select
    function_oids.*,
    coalesce(pg_get_functiondef(access_rpc), '') as access_definition,
    coalesce(pg_get_functiondef(work_order_page_rpc), '') as work_order_page_definition,
    coalesce(pg_get_functiondef(staff_invoice_page_rpc), '') as staff_invoice_page_definition
  from function_oids
),
checks as (
  select
    access_rpc is not null
      and access_definition like '%assigned_technician_profile_id = viewer.id%'
      and access_definition not like '%work_order_assignment_history%'
      and access_definition not like '%work_order_visits%'
      and access_definition not like '%work_order_photos%'
      as migration_0091_strict_assignment_applied,

    to_regclass('public.p1_part_costs') is not null
      and to_regclass('public.p1_part_cost_audit') is not null
      and exists (
        select 1
        from information_schema.columns
        where table_schema = 'public'
          and table_name = 'invoice_lines'
          and column_name = 'source_work_order_part_id'
      )
      and cost_rpc is not null
      and billable_parts_rpc is not null
      and part_status_rpc is not null
      and billing_save_rpc is not null
      and exists (
        select 1
        from pg_trigger
        where tgrelid = 'public.invoice_lines'::regclass
          and tgname = 'protect_invoice_line_billing_metadata_trigger'
          and not tgisinternal
      )
      and not coalesce(
        has_table_privilege(
          'authenticated',
          to_regclass('public.p1_part_costs'),
          'SELECT'
        ),
        false
      )
      and not coalesce(
        has_table_privilege(
          'authenticated',
          to_regclass('public.p1_part_cost_audit'),
          'SELECT'
        ),
        false
      )
      and not coalesce(
        has_function_privilege('authenticated', billing_save_rpc, 'EXECUTE'),
        false
      )
      and coalesce(
        has_function_privilege('service_role', billing_save_rpc, 'EXECUTE'),
        false
      )
      as migration_0092_private_part_billing_applied,

    work_order_page_rpc is not null
      and work_order_page_definition like '%dashboard_p1_parts_to_order%'
      and work_order_page_definition like '%pendingRank%'
      and work_order_page_definition like '%pending_capital_completion%'
      as migration_0093_queue_pinning_applied,

    staff_invoice_page_rpc is not null
      and staff_invoice_page_definition like '%territory%'
      and staff_invoice_page_definition like '%work_order%'
      and staff_invoice_page_definition like '%status%'
      as migration_0094_billing_sorting_applied,

    exists (
      select 1
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'activities'
        and column_name = 'activity_channel'
        and is_nullable = 'NO'
    )
      and (
        select count(*) = 3
        from pg_constraint
        where conrelid = 'public.activities'::regclass
          and conname in (
            'activities_channel_check',
            'activities_channel_sync_check',
            'activities_internal_channel_check'
          )
      )
      and (
        select count(*) = 2
        from pg_trigger
        where tgrelid = 'public.activities'::regclass
          and tgname in (
            'enforce_activity_channel_update_trigger',
            'protect_activity_7eleven_sync_trigger'
          )
          and not tgisinternal
      )
      and attention_rpc is not null
      and not exists (
        select 1
        from public.activities
        where requires_7eleven_sync
          is distinct from (activity_channel = 'field_note')
      )
      and not exists (
        select 1
        from public.activities
        where activity_channel = 'internal_note'
          and (
            is_staff_only is distinct from true
            or requires_contractor_attention is distinct from false
          )
      )
      as migration_0095_activity_channels_applied
  from definitions
)
select
  migration_0091_strict_assignment_applied,
  migration_0092_private_part_billing_applied,
  migration_0093_queue_pinning_applied,
  migration_0094_billing_sorting_applied,
  migration_0095_activity_channels_applied,
  migration_0091_strict_assignment_applied
    and migration_0092_private_part_billing_applied
    and migration_0093_queue_pinning_applied
    and migration_0094_billing_sorting_applied
    and migration_0095_activity_channels_applied
    as all_checks_pass
from checks;
