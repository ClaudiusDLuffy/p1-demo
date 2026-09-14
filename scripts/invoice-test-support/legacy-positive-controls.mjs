import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

export function saveLegacyStaffInvoice(tx, actor, workOrderId, num, invoiceId = null, lines = null) {
  return tx.query(`select public.save_staff_billing_invoice_v3(
    $1,$2,$3,$4,'99999','Synthetic billing address',null,'2026-09-08','2026-09-07',null,
    'Net 30','draft',0,null,0,'Synthetic territory','7-ELEVEN: Miscellaneous',$5,'{}') id`,
  [actor,invoiceId,num,workOrderId,JSON.stringify(lines || [
    { type: 'Labor', description: 'Synthetic staff work', qty: 1.25, rate: 10.11, is_taxable: false },
    { type: 'Travel', description: '', qty: 1, rate: 5, is_taxable: false },
  ])]);
}

export async function verifyLegacyFinancialPositiveControls({ db, check, as, actors, stage, prefix }) {
  const id = `${prefix}0100`;
  await db.query(`insert into public.work_orders(id,status,functional_status,contractor_id,contractor_assignment_started_at,store_number)
    values ($1,'completed','Completed',$2,now()-interval '1 day','99999')`, [id,actors.contractor]);
  await check(`${stage} legacy staff atomic save/edit preserves source-free draft, exact totals and equipment tag`, async () => {
    const invoiceId = (await as('service_role', null, tx => saveLegacyStaffInvoice(tx,actors.mgr,id,`P1-VALID-${stage}`))).rows[0].id;
    assert.ok(invoiceId);
    assert.deepEqual((await db.query('select state,subtotal::text,total::text,equipment_tag from public.invoices where id=$1', [invoiceId])).rows[0],
      { state: 'draft', subtotal: '17.64', total: '17.64', equipment_tag: '7-ELEVEN: Miscellaneous' });
    await as('service_role', null, tx => saveLegacyStaffInvoice(tx,actors.mgr,id,`P1-VALID-${stage}`,invoiceId,[
      { type: 'Labor', description: 'Synthetic replacement', qty: 2, rate: 20, is_taxable: false },
    ]));
    assert.deepEqual((await db.query('select position,qty::text,rate::text from public.invoice_lines where invoice_id=$1', [invoiceId])).rows,
      [{ position: 1, qty: '2.00', rate: '20.00' }]);
    assert.equal((await db.query('select total::text from public.invoices where id=$1', [invoiceId])).rows[0].total, '40.00');
    assert.equal((await db.query("select count(*)::int n from public.activities where work_order_id=$1 and event_key='staff_billing'", [id])).rows[0].n, 2);
  });
  await check(`${stage} actual legacy controller total correction remains denied while operational staff correction works`, async () => {
    const invoiceId = (await as('authenticated',actors.contractor,tx => tx.query(`select (public.submit_contractor_invoice_once(
      $1,$2,$3,true,null,null,'2026-09-08',null,null,'Net 30',0,55.55,'[]')).id`,
    [randomUUID(),id,`CORRECTION-${stage}`]))).rows[0].id;
    await as('authenticated',actors.mgr,tx => tx.query("select public.review_contractor_invoice($1,'approve',null)",[invoiceId]));
    await assert.rejects(() => as('authenticated',actors.controller,tx => tx.query(
      "select public.correct_contractor_invoice_total($1,75.55,'Synthetic existing policy characterization')",[invoiceId])),
    error => error.code === '42501');
    assert.equal(Number((await db.query('select total from public.invoices where id=$1',[invoiceId])).rows[0].total),55.55);
    await as('authenticated',actors.mgr,tx => tx.query(
      "select public.correct_contractor_invoice_total($1,75.55,'Synthetic supported operational correction')",[invoiceId]));
    assert.equal(Number((await db.query('select total from public.invoices where id=$1',[invoiceId])).rows[0].total),75.55);
  });
}
