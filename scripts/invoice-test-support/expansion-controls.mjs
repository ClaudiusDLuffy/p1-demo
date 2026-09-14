import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { rejectFinancialCall,withFinancialWriteFailure } from './transaction-tools.mjs';

// Early execution of the backward-compatible expansion while the contraction
// is being reviewed. This deliberately does NOT claim raw-table denials.
export async function verifyFinancialExpansionCommands(fixture,check) {
  const { db,as,actors,workOrder,context,payload,command,staffPayload,staffCommand,document,snapshot,lifecycle } = fixture;
  await check('expansion: empty draft edit advances its version and replays without duplicate evidence', async () => {
    const id = await workOrder();
    const input = payload({ lines: [],salesTax: 0 });
    const draft = await command('draft',actors.contractor,await context(id),input);
    const args = await context(id,draft.invoiceId);
    const edited = await command('draft',actors.contractor,args,input);
    assert.ok(edited.invoiceVersion > draft.invoiceVersion);
    const before = await snapshot(id);
    assert.equal((await command('draft',actors.contractor,args,input)).reason,'already_applied');
    assert.deepEqual(await snapshot(id),before);
  });
  await check('expansion: contractor submit, manual override, PDF association and review/revision remain compatible', async () => {
    const id = await workOrder();
    const input = payload({ mode: 'manual_pdf_total',totalOverride: 55.55,salesTax: 0,lines: [] });
    const saved = await command('submit',actors.contractor,await context(id),input);
    assert.equal(saved.state,'submitted');
    assert.equal(saved.total,55.55);
    assert.equal((await snapshot(id)).parent.status,'completed');
    await as('authenticated',actors.contractor,tx => tx.query('select public.attach_contractor_invoice_pdf($1,$2)',[saved.invoiceId,`${saved.invoiceId}/synthetic.pdf`]));
    await as('authenticated',actors.mgr,tx => tx.query("select public.review_contractor_invoice($1,'reject','Synthetic change')",[saved.invoiceId]));
    assert.equal((await command('revise',actors.contractor,await context(id,saved.invoiceId),input)).state,'revised');
    await as('authenticated',actors.mgr,tx => tx.query("select public.review_contractor_invoice($1,'approve',null)",[saved.invoiceId]));
    assert.equal((await document(saved.invoiceId)).header.state,'approved');
    await as('authenticated',actors.contractor,tx => tx.query('select public.finish_contractor_invoicing($1)',[id]));
  });
  await check('expansion: staff save/edit consumes versions and binds replay', async () => {
    const id = await workOrder();
    const input = staffPayload();
    const saved = await staffCommand(actors.mgr,await context(id),input);
    const args = await context(id,saved.invoiceId);
    const edited = await staffCommand(actors.mgr,args,{ ...input,terms: 'Net 15' });
    assert.ok(edited.invoiceVersion > saved.invoiceVersion);
    assert.equal((await staffCommand(actors.mgr,args,{ ...input,terms: 'Net 15' })).reason,'already_applied');
  });
  await check('expansion: contractor and staff delete retain tombstones for safe replay', async () => {
    for (const type of ['contractor','staff']) {
      const id = await workOrder();
      const saved = type === 'contractor'
        ? await command('draft',actors.contractor,await context(id),payload())
        : await staffCommand(actors.mgr,await context(id),staffPayload());
      const args = await context(id,saved.invoiceId);
      const operationId = randomUUID();
      const call = () => type === 'contractor'
        ? as('authenticated',actors.contractor,tx => tx.query('select public.delete_own_contractor_invoice_v1($1,$2,$3,$4,$5,$6) result',args))
        : as('service_role',null,tx => tx.query('select public.delete_invoice_admin_v1($1,$2,$3,$4,$5,$6,$7,$8) result',
          [actors.mgr,saved.invoiceId,type,args[4],operationId,args[1],args[2],'Synthetic deletion']));
      assert.equal((await call()).rows[0].result.applied,true);
      const before = await snapshot(id);
      assert.equal((await call()).rows[0].result.reason,'already_applied');
      assert.deepEqual(await snapshot(id),before);
    }
  });
  await check('expansion: billing-ready command authorizes active staff and preserves its exact message', async () => {
    const id = await workOrder();
    const args = await lifecycle.context(id);
    const call = actor => as('authenticated',actor,tx => tx.query('select public.mark_work_order_ready_for_billing_v1($1,$2,$3,$4,$5) result',args));
    for (const actor of [actors.contractor,actors.controller,actors.inactive]) await rejectFinancialCall(() => call(actor),['42501']);
    assert.equal((await call(actors.mgr)).rows[0].result.applied,true);
    const before = await snapshot(id);
    assert.equal(before.parent.status,'pending_invoice');
    assert.ok(before.activities.some(row => row.text === '7-Eleven portal updated. Moved to Pending 7-Eleven Submission.'));
    assert.equal((await call(actors.mgr)).rows[0].result.reason,'already_applied');
    assert.deepEqual(await snapshot(id),before);
  });
  await check('expansion: new submit rolls back its header and lines when evidence creation fails', async () => {
    const id = await workOrder();
    const args = await context(id);
    const input = payload();
    const before = await snapshot(id);
    await withFinancialWriteFailure(db,{ table: 'activities',operation: 'insert' },async () => {
      await rejectFinancialCall(() => command('submit',actors.contractor,args,input),['P0001']);
      assert.deepEqual(await snapshot(id),before);
    });
    assert.equal((await command('submit',actors.contractor,args,input)).applied,true);
  });
}
