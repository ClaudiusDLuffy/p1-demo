import assert from 'node:assert/strict';
import { randomInt, randomUUID } from 'node:crypto';
import { linkedBillingSql as sql } from './linked-billing-test-support.mjs';

// Lifecycle replicas, not copies of customer PDFs or actual invoice lines.
// Only supplied dates, totals, states and audit semantics are reproduced.
// Identities, WO IDs, invoice numbers and line descriptions are synthetic.
export function reportedInvoiceFixture(kind) {
  assert.ok(['regular_billed_still_open', 'capital_different_company', 'capital_external_quote_unrecorded'].includes(kind));
  assert.equal(sql("select count(*) from auth.users where email not like '%@p1.invalid'"), '0');
  const actors = JSON.parse(sql(`select jsonb_object_agg(email,id) from public.profiles
    where active and email in ('e2e.manager@p1.invalid','e2e.company.admin@p1.invalid','e2e.direct@p1.invalid')`));
  for (const email of ['e2e.manager@p1.invalid','e2e.company.admin@p1.invalid','e2e.direct@p1.invalid']) assert.ok(actors[email]);
  const regular = kind === 'regular_billed_still_open';
  const externalQuoteUnrecorded = kind === 'capital_external_quote_unrecorded';
  const hasStaffInvoice = !externalQuoteUnrecorded;
  const work = `WOT99${String(randomInt(0, 10_000_000_000)).padStart(10, '0')}`;
  const staffInvoice = randomUUID(), contractorInvoice = randomUUID();
  const suffix = work.slice(5);
  const staffNumber = `SYNTHETIC-${regular ? 'P1-00040' : 'P1-M-2004'}-${suffix}`;
  const contractorNumber = `SYNTHETIC-${regular ? '405' : externalQuoteUnrecorded ? '3840' : '1429'}-${suffix}`;
  const contractor = actors[regular ? 'e2e.company.admin@p1.invalid' : 'e2e.direct@p1.invalid'];
  const staffActor = actors['e2e.manager@p1.invalid'];
  const staffTotal = regular ? 803.22 : externalQuoteUnrecorded ? null : 5542;
  const contractorTotal = regular ? 500 : externalQuoteUnrecorded ? 3170 : 420;
  const staffDate = regular ? '2026-08-06' : '2026-08-27';
  const staffCreated = regular ? '2026-08-06T21:57:29.694799Z' : '2026-08-27T22:31:07.172457Z';
  const staffUpdated = regular ? '2026-08-06T21:58:08.534079Z' : '2026-08-28T21:03:50.892297Z';
  const contractorDate = regular ? '2026-08-04' : externalQuoteUnrecorded ? '2026-10-05' : '2026-09-15';
  const contractorCreated = regular ? '2026-08-04T20:28:57.408826Z'
    : externalQuoteUnrecorded ? '2026-10-05T12:58:08.863816Z' : '2026-09-16T02:49:37.091747Z';
  const contractorUpdated = regular ? '2026-08-05T19:50:06.713931Z'
    : externalQuoteUnrecorded ? '2026-10-08T14:22:51.035048Z' : '2026-09-23T16:14:59.956568Z';
  const paidAt = regular ? "'2026-08-05T19:50:05.64Z'::timestamptz" : 'null';
  const syncedAt = regular ? 'null' : externalQuoteUnrecorded ? "'2026-10-08T14:22:51.035048Z'::timestamptz"
    : "'2026-09-23T16:14:59.956568Z'::timestamptz";
  const checkIn = regular ? '2026-08-04T15:15:00Z' : '2026-08-12T22:14:00Z';
  const checkOut = regular ? '2026-08-04T19:00:00Z' : '2026-08-13T00:53:00Z';
  const workUpdated = regular ? '2026-08-26T13:33:26.773178Z'
    : externalQuoteUnrecorded ? '2026-10-07T22:24:49.080451Z' : '2026-09-23T12:26:49.552073Z';
  const assignmentStarted = regular ? '2026-08-04T14:07:11.027739Z' : '2026-08-11T23:20:56.005777Z';
  const functionalStatus = regular ? 'Completed' : externalQuoteUnrecorded ? 'Work in Progress' : 'Pending Capital Completion';
  const staffInvoiceInsert = hasStaffInvoice
    ? `, ('${staffInvoice}','${staffNumber}','${work}',null,'staff','${regular ? 'invoice' : 'capital_quote'}','approved',
      '${staffDate}',${staffTotal},0,${staffTotal},'${staffCreated}','${staffUpdated}',null,null)` : '';
  const staffInvoiceLineInsert = hasStaffInvoice
    ? `, ('${staffInvoice}',1,'Labor','Synthetic total-only staff line; original lines unavailable',1,${staffTotal},false)` : '';
  const visitInsert = externalQuoteUnrecorded ? '' : `insert into public.work_order_visits(work_order_id,contractor_id,checked_in_by,checked_out_by,check_in_at,check_out_at)
      values('${work}','${contractor}','${contractor}','${contractor}','${checkIn}','${checkOut}');`;
  const preparedActivityInsert = hasStaffInvoice ? `insert into public.activities(work_order_id,author_id,author_name,text,type,event_key,event_data,
      workflow_cycle,contractor_assignment_version,is_staff_only,created_at)
    values('${work}','${staffActor}','Synthetic staff','Synthetic P1 document prepared.','system','staff_billing',
      jsonb_build_object('invoiceId','${staffInvoice}','action','created'),0,1,true,'${staffCreated}');` : '';
  sql(`begin;
    insert into public.work_orders(id,status,functional_status,is_capital,capital_status,billing_only,
      workflow_cycle,contractor_assignment_version,lifecycle_version,contractor_id,store_number,store_state,
      summary,start_time,end_time,contractor_assignment_started_at,updated_at)
    values('${work}','${regular ? 'pending_invoice' : 'capital'}',
      '${functionalStatus}',${!regular},null,false,0,1,0,
      '${contractor}','E2E001','TX','Synthetic reported-state replica: ${kind}',
      '${checkIn}','${checkOut}','${assignmentStarted}','${workUpdated}');
    insert into public.invoices(id,num,work_order_id,contractor_id,invoice_type,document_kind,state,
      invoice_date,subtotal,sales_tax,total,created_at,updated_at,paid_at,qbo_synced_at)
    values('${contractorInvoice}','${contractorNumber}','${work}','${contractor}','contractor','invoice','paid',
      '${contractorDate}',${contractorTotal},0,${contractorTotal},'${contractorCreated}','${contractorUpdated}',${paidAt},${syncedAt})${staffInvoiceInsert};
    insert into public.invoice_lines(invoice_id,position,type,description,qty,rate,is_taxable)
      values('${contractorInvoice}',1,'Labor','Synthetic total-only contractor line',1,${contractorTotal},false)${staffInvoiceLineInsert};
    ${regular ? `insert into public.staff_invoice_sources(staff_invoice_id,contractor_invoice_id,work_order_id,created_by)
      values('${staffInvoice}','${contractorInvoice}','${work}','${staffActor}');` : ''}
    ${visitInsert}
    ${preparedActivityInsert}
    ${regular ? `insert into public.activities(work_order_id,author_id,author_name,text,type,event_key,event_data,
      workflow_cycle,contractor_assignment_version,is_staff_only,created_at)
      values('${work}','${staffActor}','Synthetic staff','Synthetic P1 invoice billed to 7-Eleven. Work order closed.',
        'system','staff_billing',jsonb_build_object('invoiceId','${staffInvoice}','action','billed_to_7_eleven'),
        0,1,true,'${staffUpdated}');` : ''}
    update public.work_orders set status='${regular ? 'pending_invoice' : externalQuoteUnrecorded ? 'capital' : 'pending_capital_completion'}',
      functional_status='${functionalStatus}',
      capital_status=null,closed_at=null,workflow_cycle=0,contractor_assignment_version=1,lifecycle_version=0,
      contractor_invoicing_completed_at=${regular ? "'2026-08-11T12:56:40.760377Z'::timestamptz" : 'null'},
      contractor_invoicing_completed_by=${regular ? `'${contractor}'::uuid` : 'null'},
      contractor_invoicing_assignment_version=${regular ? 1 : 'null'},
      contractor_invoicing_workflow_cycle=${regular ? 0 : 'null'},
      contractor_invoicing_completion_source=${regular ? "'contractor'" : 'null'},
      updated_at='${workUpdated}' where id='${work}';
    commit;`);
  return { kind, work, staffInvoice: hasStaffInvoice ? staffInvoice : null, contractorInvoice,
    staffNumber: hasStaffInvoice ? staffNumber : null, contractorNumber, staffTotal, contractorTotal };
}

export function reportedInvoiceSnapshot(fixture) {
  assert.match(fixture.work, /^WOT99\d{10}$/);
  return JSON.parse(sql(`select jsonb_build_object(
    'status',w.status,'functionalStatus',w.functional_status,'capitalStatus',w.capital_status,
    'contractorId',w.contractor_id,'closedAt',w.closed_at,'workflowCycle',w.workflow_cycle,
    'openVisits',(select count(*) from public.work_order_visits where work_order_id=w.id and check_out_at is null),
    'invoices',(select jsonb_agg(to_jsonb(i) order by i.id) from public.invoices i where i.work_order_id=w.id),
    'billedEvents',(select count(*) from public.activities where work_order_id=w.id and event_key='staff_billing' and event_data->>'action'='billed_to_7_eleven'),
    'quoteSubmissionEvents',(select count(*) from public.activities where work_order_id=w.id and event_key='capital_quote_submitted'),
    'reopenEvents',(select count(*) from public.activities where work_order_id=w.id and event_key='work_order_reopened'),
    'links',(select count(*) from public.work_order_billing_links where work_order_id=w.id),
    'externalBillings',(select count(*) from public.work_order_external_billings where work_order_id=w.id),
    'externalQuoteHandoffs',(select count(*) from public.external_capital_quote_handoffs where work_order_id=w.id),
    'capitalCloseOutEvents',(select count(*) from public.activities where work_order_id=w.id and event_key='capital_close_out_recorded'))
    from public.work_orders w where w.id='${fixture.work}'`));
}
