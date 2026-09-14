import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createLifecycleFixtures } from '../lifecycle-test-support/command-fixtures.mjs';

export const CONTRACTOR_COMMANDS = {
  draft: 'save_contractor_invoice_draft_v1',
  submit: 'submit_contractor_invoice_v1',
  revise: 'revise_contractor_invoice_v1',
};

export async function createInvoiceCommandFixtures({ db, as, actors }) {
  const lifecycle = await createLifecycleFixtures({ db, as, ...actors });
  let documentSequence = 0;
  const allActors = lifecycle.actors;
  for (const [name,id] of Object.entries(allActors)) {
    await db.query('update public.profiles set name=$2 where id=$1',[id,`Synthetic ${name}`]);
  }
  await db.query("update public.profiles set contractor_access_level='invoice' where id=any($1::uuid[])",
    [[allActors.unassigned,allActors.former]]);
  const handoff = '62000000-0000-4000-8000-000000000008';
  await db.query('insert into auth.users(id,email) values ($1,$2)', [handoff, 'synthetic-handoff@invoice.example.invalid']);
  await db.query("update public.profiles set role='back_office',name='Synthetic handoff',active=true where id=$1", [handoff]);
  await db.query("insert into public.staff_permission_grants(profile_id,permission) values ($1,'quickbooks_handoff')", [handoff]);
  allActors.handoff = handoff;
  async function workOrder(options = {}) {
    const id = await lifecycle.workOrder({ status: 'completed', functional: 'Completed', ...options });
    await db.query("update public.work_orders set store_number='99999',address='Synthetic billing address' where id=$1", [id]);
    return id;
  }
  function payload(patch = {}) {
    return {
      num: `SYNTHETIC-${String(++documentSequence).padStart(5, '0')}`,
      userTypedNum: true,
      cme: null, storeAddress: 'Synthetic billing address',
      invoiceDate: '2026-09-08', serviceDate: '2026-09-07', dueDate: null,
      terms: 'Net 30', mode: 'line_items', salesTax: 1.25, totalOverride: null,pdfStoragePath: null,
      lines: [
        { type: 'Labor', description: 'Synthetic repair labor', qty: 1.25, rate: 10.11 },
        { type: 'Travel', description: '', qty: 1, rate: 5 },
      ],
      ...patch,
    };
  }
  async function context(workOrderId, invoiceId = null, operationId = randomUUID()) {
    const parent = (await db.query(`select contractor_assignment_version,workflow_cycle
      from public.work_orders where id=$1`, [workOrderId])).rows[0];
    assert.ok(parent, 'Fixture parent must exist');
    let version = null;
    if (invoiceId) {
      const invoice = (await db.query('select invoice_version from public.invoices where id=$1', [invoiceId])).rows[0];
      assert.ok(invoice, 'Fixture invoice must exist');
      version = Number(invoice.invoice_version);
    }
    return [workOrderId,parent.contractor_assignment_version,parent.workflow_cycle,invoiceId,version,operationId];
  }
  function query(tx, family, args, input) {
    assert.ok(Object.hasOwn(CONTRACTOR_COMMANDS, family));
    return tx.query(`select public.${CONTRACTOR_COMMANDS[family]}($1,$2,$3,$4,$5,$6,$7) result`, [...args,JSON.stringify(input)]);
  }
  async function command(family, actor, args, input, role = 'authenticated') {
    return (await as(role,actor,tx => query(tx,family,args,input))).rows[0].result;
  }
  function staffPayload(patch = {}) {
    return {
      num: `P1-SYNTHETIC-${String(++documentSequence).padStart(5, '0')}`,userTypedNum: true,
      storeNumber: '99999',storeAddress: 'Synthetic billing address',cme: null,
      invoiceDate: '2026-09-08',serviceDate: '2026-09-07',dueDate: null,terms: 'Net 30',
      state: 'draft',taxMode: 'none',salesTaxOverride: null,taxRateOverride: null,taxState: null,
      territory: 'Synthetic territory',equipmentTag: '7-ELEVEN: Miscellaneous',
      lines: [
        { type: 'Labor',description: 'Synthetic staff work',qty: 1.25,rate: 10.11,isTaxable: false,
          sourceInvoiceLineId: null,sourceWorkOrderPartId: null,sourceUnitCost: null,markupPercent: null },
        { type: 'Travel',description: '',qty: 1,rate: 5,isTaxable: false,
          sourceInvoiceLineId: null,sourceWorkOrderPartId: null,sourceUnitCost: null,markupPercent: null },
      ],sourceInvoiceIds: [],...patch,
    };
  }
  function staffQuery(tx, actor, args, input) {
    return tx.query('select public.save_staff_billing_invoice_v4($1,$2,$3,$4,$5,$6,$7,$8) result',
      [actor,...args,JSON.stringify(input)]);
  }
  async function staffCommand(actor, args, input, role = 'service_role', identity = null) {
    return (await as(role,identity,tx => staffQuery(tx,actor,args,input))).rows[0].result;
  }
  async function snapshot(workOrderId) {
    return (await db.query(`select
      (select to_jsonb(w) from public.work_orders w where id=$1) parent,
      (select coalesce(jsonb_agg(to_jsonb(i) order by i.id),'[]') from public.invoices i where i.work_order_id=$1) invoices,
      (select coalesce(jsonb_agg(to_jsonb(l) order by l.id),'[]') from public.invoice_lines l join public.invoices i on i.id=l.invoice_id where i.work_order_id=$1) lines,
      (select coalesce(jsonb_agg(to_jsonb(a) order by a.id),'[]') from public.activities a where a.work_order_id=$1) activities,
      (select coalesce(jsonb_agg(to_jsonb(s) order by s.staff_invoice_id,s.contractor_invoice_id),'[]') from public.staff_invoice_sources s
        join public.invoices i on i.id=s.staff_invoice_id where i.work_order_id=$1) sources,
      (select coalesce(jsonb_agg(to_jsonb(o) order by o.operation_id),'[]') from public.invoice_financial_operations o where o.work_order_id=$1) operations,
      (select coalesce(jsonb_agg(to_jsonb(c) order by c.operation_id),'[]') from public.financial_operation_claims c) operation_claims,
      (select coalesce(jsonb_agg(to_jsonb(g) order by g.id),'[]') from public.invoice_financial_transition_guards g where g.work_order_id=$1) guards`, [workOrderId])).rows[0];
  }
  async function document(invoiceId) {
    return (await db.query(`select to_jsonb(i) header,
      (select coalesce(jsonb_agg(to_jsonb(l) order by l.position,l.id),'[]') from public.invoice_lines l where l.invoice_id=i.id) lines
      from public.invoices i where i.id=$1`, [invoiceId])).rows[0];
  }
  return { db, as, actors: allActors, lifecycle, workOrder, payload, context, query, command,
    staffPayload,staffQuery,staffCommand,snapshot,document };
}
