import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createDatabase, applyThrough, createFixtures } from '../receiving-dispatch-test-support/fixtures.mjs';

export { createDatabase, applyThrough };

export async function financialNotificationFixtures(db) {
  const base = await createFixtures(db);
  const financial = base.assignment.financial;
  const { actors, as } = base;
  async function invoice(options = {}) {
    const workOrderId = await financial.workOrder({ owner: options.owner || actors.contractor, technician: options.creator || null });
    const result = await financial.command('submit', options.creator || actors.contractor,
      await financial.context(workOrderId), financial.payload());
    return { id: result.invoiceId, workOrderId, row: await row(result.invoiceId) };
  }
  const row = async id => (await db.query('select * from public.invoices where id=$1', [id])).rows[0];
  const review = (target, action = 'reject', actor = actors.mgr, reason = 'Synthetic invoice correction') =>
    as('authenticated', actor, tx => tx.query('select public.review_contractor_invoice($1,$2,$3) result', [target.id, action, action === 'approve' ? null : reason]))
      .then(result => result.rows[0].result);
  const batchReview = (targets, action = 'reject', actor = actors.mgr) =>
    as('authenticated', actor, tx => tx.query('select public.review_contractor_invoices($1,$2,$3) result',
      [targets.map(target => target.id), action, action === 'reject' ? 'Synthetic batch correction' : null])).then(result => result.rows[0].result);
  const retract = (target, actor = actors.mgr) => as('authenticated', actor,
    tx => tx.query('select public.retract_contractor_invoice_rejection($1) result', [target.id])).then(result => result.rows[0].result);
  const hold = (target, action = 'placed', actor = action === 'placed' ? actors.mgr : actors.handoff, reason = `Synthetic ${action}`) => {
    const name = action === 'placed' ? 'place_contractor_invoice_payment_hold' : 'release_contractor_invoice_payment_hold';
    return as('service_role', null, tx => tx.query(`select public.${name}($1,$2,$3) result`, [target.id, actor, reason]))
      .then(result => result.rows[0].result);
  };
  const activity = (target, key) => db.query(`select * from public.activities where work_order_id=$1
    and event_key=$2 and event_data->>'invoiceId'=$3 order by created_at,id`, [target.workOrderId, key, target.id]).then(result => result.rows);
  const holdEvents = target => db.query('select * from public.contractor_invoice_payment_hold_events where invoice_id=$1 order by created_at,id', [target.id]).then(result => result.rows);
  const noDeliveryLedger = async () => {
    const result = (await db.query("select to_regclass('public.financial_notification_events') events,to_regclass('public.financial_notification_deliveries') deliveries")).rows[0];
    assert.deepEqual(result, { events: null, deliveries: null }, 'Baseline schema has authoritative financial events but no financial delivery ledger');
  };
  const denied = (run, codes = ['42501', '40001', 'PT409', '22023', '55000', 'P0002']) => assert.rejects(run, error => codes.includes(error.code));
  return { ...base, financial, invoice, row, review, batchReview, retract, hold, activity, holdEvents, noDeliveryLedger, denied, operation: randomUUID };
}
