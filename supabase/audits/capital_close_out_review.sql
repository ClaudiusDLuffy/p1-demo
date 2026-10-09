-- Read-only operator export for Mandy's capital backlog review. No bulk clear.
-- Run only through the approved database operator; this file does not connect.
-- Export the result as CSV and have Mandy fill the confirmation columns.
-- A quote marked submitted is NOT evidence that installation is done or billed.
-- Missing QBO IDs do NOT prove that a manual CSV import never happened.
-- All open capital identities are included, including Installed awaiting billing.
-- total_open_capitals / active_board_capitals explain the board count, which may
-- differ from the previously reported 82. No fixed 82-row limit hides records.
begin transaction read only;

with capitals as (
  select w.*,
    case w.capital_status::text
      when 'Approved - work authorized' then 'Approved - work authorized'
      when 'Equipment ordered' then 'Equipment ordered'
      when 'Equipment received' then 'Equipment received'
      when 'Installation scheduled' then 'Installation scheduled'
      when 'Installed' then 'Installed - awaiting billing'
      when 'Pending approval' then 'Quote submitted - pending capital approval'
      else case when w.status::text = 'pending_capital_completion'
        then 'Quote submitted - pending capital approval' else 'Waiting for quote' end
    end as board_stage,
    (select max(a.created_at) from public.activities a
      where a.work_order_id = w.id and a.deleted_at is null
        and a.workflow_cycle = w.workflow_cycle and a.event_key = 'work_order_reopened') as reopened_at
  from public.work_orders w
  where w.deleted_at is null and w.status::text <> 'closed'
    and (coalesce(w.is_capital, false) or w.status::text in ('capital', 'pending_capital_completion'))
), review as (
  select w.id as work_order_id, w.store_number, w.city, w.store_state,
    w.summary, w.status as portal_status, w.functional_status, w.capital_status,
    w.board_stage, w.workflow_cycle, w.contractor_assignment_version,
    w.lifecycle_version, w.updated_at, w.reopened_at,
    coalesce(w.is_capital, false) as capital_identity_flag,
    count(*) over () as total_open_capitals,
    count(*) filter (where w.capital_status::text is distinct from 'Installed') over () as active_board_capitals,
    q.quote_count, q.editable_quote_count, q.quotes,
    f.final_invoice_count, f.final_invoices,
    (select count(*) from public.invoices i where i.work_order_id = w.id and i.deleted_at is null
      and i.invoice_type = 'contractor' and i.state::text not in ('approved', 'paid')) as unresolved_contractor_invoices,
    (select count(*) from public.work_order_visits v
      where v.work_order_id = w.id and v.check_out_at is null) as open_visits,
    (select count(*) from public.activities a where a.work_order_id = w.id and a.deleted_at is null
      and ((a.requires_7eleven_sync and a.synced_to_7eleven_at is null)
        or (a.requires_contractor_attention and a.contractor_attention_acknowledged_at is null))) as pending_updates,
    (select max(a.created_at) from public.activities a where a.work_order_id = w.id
      and a.deleted_at is null and a.workflow_cycle = w.workflow_cycle
      and a.event_key in ('capital_completion_confirmed','capital_close_out_recorded')) as recorded_capital_completion_at,
    (select count(*) from public.activities a where a.work_order_id = w.id
      and a.deleted_at is null and a.workflow_cycle = w.workflow_cycle
      and (a.event_key in ('staff_billing', 'work_order_billed_externally', 'work_order_billed_under_another')
        or (a.event_key='capital_close_out_recorded' and a.event_data->>'outcome'='billed'))) as billing_event_count,
    (select coalesce(jsonb_agg(jsonb_build_object('reference',h.reference,'recordedAt',h.created_at)),'[]'::jsonb)
      from public.external_capital_quote_handoffs h
      where h.work_order_id=w.id and h.workflow_cycle=w.workflow_cycle) as external_quote_references,
    null::text as mandy_confirms_quote_submitted,
    null::text as mandy_confirms_job_completed,
    null::text as mandy_confirms_already_billed,
    null::text as mandy_billed_invoice_reference,
    null::date as mandy_billed_on,
    null::text as mandy_requested_outcome,
    'review_only_no_writes'::text as action
  from capitals w
  cross join lateral (
    select count(*) as quote_count,
      count(*) filter (where i.state::text in ('draft', 'submitted', 'revised')) as editable_quote_count,
      coalesce(jsonb_agg(jsonb_build_object('id', i.id, 'number', i.num, 'state', i.state,
        'createdAt', i.created_at, 'invoiceDate', i.invoice_date,
        'qboInvoiceId', i.qbo_invoice_id, 'qboSyncedAt', i.qbo_synced_at,
        'currentCycleSubmissionRecorded', exists(select 1 from public.activities a
          where a.work_order_id = w.id and a.deleted_at is null and a.workflow_cycle = w.workflow_cycle
            and a.event_key = 'capital_quote_submitted' and a.event_data->>'invoiceId' = i.id::text),
        'currentCycleEligibility', case when w.workflow_cycle = 0 then 'review_current_cycle'
          when w.reopened_at is null then 'missing_reopen_evidence'
          when i.created_at >= w.reopened_at then 'review_current_cycle' else 'prior_cycle_do_not_reuse' end
      ) order by i.created_at desc, i.id), '[]'::jsonb) as quotes
    from public.invoices i where i.work_order_id = w.id and i.deleted_at is null
      and i.invoice_type = 'staff' and i.document_kind = 'capital_quote'
  ) q
  cross join lateral (
    select count(*) as final_invoice_count,
      coalesce(jsonb_agg(jsonb_build_object('id', i.id, 'number', i.num, 'state', i.state,
        'createdAt', i.created_at, 'qboInvoiceId', i.qbo_invoice_id, 'qboSyncedAt', i.qbo_synced_at)
        order by i.created_at desc, i.id), '[]'::jsonb) as final_invoices
    from public.invoices i where i.work_order_id = w.id and i.deleted_at is null
      and i.invoice_type = 'staff' and i.document_kind = 'invoice'
  ) f
)
select * from review
order by (board_stage = 'Waiting for quote') desc, updated_at, work_order_id;

rollback;
