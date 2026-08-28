-- Run after migration 0100. The first result must be all true.

with checks as (
  select
    to_regclass('public.contractor_invoice_payment_holds') is not null
      as active_hold_table_present,
    exists (
      select 1
      from pg_class table_class
      where table_class.oid = 'public.contractor_invoice_payment_holds'::regclass
        and table_class.relrowsecurity
    ) as active_hold_rls_enabled,
    not exists (
      select 1
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'invoices'
        and column_name in (
          'payment_hold_at',
          'payment_hold_by',
          'payment_hold_reason'
        )
    ) as invoice_hold_fields_not_exposed,
    to_regclass('public.contractor_invoice_payment_hold_events') is not null
      as immutable_hold_audit_present,
    to_regprocedure('public.place_contractor_invoice_payment_hold(uuid,uuid,text)') is not null
      as place_hold_rpc_present,
    to_regprocedure('public.release_contractor_invoice_payment_hold(uuid,uuid,text)') is not null
      as release_hold_rpc_present,
    to_regprocedure('public.confirm_controller_invoice_export(uuid,uuid)') is not null
      as confirm_handoff_rpc_present,
    exists (
      select 1
      from pg_trigger
      where tgrelid = 'public.controller_invoice_export_items'::regclass
        and tgname = 'reject_ineligible_quickbooks_handoff_item_trigger'
        and not tgisinternal
    ) as held_export_guard_present,
    coalesce((
      select prosecdef
      from pg_proc
      where oid = 'public.place_contractor_invoice_payment_hold(uuid,uuid,text)'::regprocedure
    ), false) as place_hold_security_definer,
    coalesce((
      select prosecdef
      from pg_proc
      where oid = 'public.release_contractor_invoice_payment_hold(uuid,uuid,text)'::regprocedure
    ), false) as release_hold_security_definer,
    position(
      'quickbooks_handoff' in pg_get_functiondef(
        'public.release_contractor_invoice_payment_hold(uuid,uuid,text)'::regprocedure
      )
    ) > 0 as controller_release_required,
    position(
      'qbo_synced_at = now()' in pg_get_functiondef(
        'public.confirm_controller_invoice_export(uuid,uuid)'::regprocedure
      )
    ) > 0 as confirmation_records_qbo_sync,
    position(
      'paid_at = null' in lower(pg_get_functiondef(
        'public.confirm_controller_invoice_export(uuid,uuid)'::regprocedure
      ))
    ) > 0 as confirmation_does_not_claim_payment,
    not has_function_privilege(
      'authenticated',
      'public.place_contractor_invoice_payment_hold(uuid,uuid,text)',
      'EXECUTE'
    ) as authenticated_direct_hold_blocked,
    not has_function_privilege(
      'anon',
      'public.release_contractor_invoice_payment_hold(uuid,uuid,text)',
      'EXECUTE'
    ) as anonymous_direct_release_blocked
)
select
  checks.*,
  (
    active_hold_table_present
    and active_hold_rls_enabled
    and invoice_hold_fields_not_exposed
    and immutable_hold_audit_present
    and place_hold_rpc_present
    and release_hold_rpc_present
    and confirm_handoff_rpc_present
    and held_export_guard_present
    and place_hold_security_definer
    and release_hold_security_definer
    and controller_release_required
    and confirmation_records_qbo_sync
    and confirmation_does_not_claim_payment
    and authenticated_direct_hold_blocked
    and anonymous_direct_release_blocked
  ) as all_checks_pass
from checks;

-- Reconciliation list: review these historical "Sent to QuickBooks" events
-- with accounting. This is read-only and intentionally changes no invoice.
select
  invoice.id,
  invoice.num as invoice_number,
  invoice.work_order_id,
  contractor.company as contractor,
  invoice.total,
  invoice.state,
  invoice.qbo_synced_at,
  invoice.paid_at,
  activity.author_name as marked_by,
  activity.created_at as marked_at
from public.invoices invoice
left join public.profiles contractor on contractor.id = invoice.contractor_id
left join lateral (
  select candidate.author_name, candidate.created_at
  from public.activities candidate
  where candidate.work_order_id = invoice.work_order_id
    and candidate.event_key = 'invoice_sent_to_quickbooks'
    and candidate.event_data ->> 'invoiceId' = invoice.id::text
    and candidate.deleted_at is null
  order by candidate.created_at desc, candidate.id desc
  limit 1
) activity on true
where invoice.invoice_type = 'contractor'
  and invoice.deleted_at is null
  and invoice.state = 'paid'
order by activity.created_at desc nulls last, invoice.updated_at desc;
