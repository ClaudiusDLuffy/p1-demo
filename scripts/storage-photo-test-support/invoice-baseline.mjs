import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { expectSqlDenial } from './fixtures.mjs';

export async function reproduceInvoiceStorageBaseline(fixture, check) {
  const { db,as,actors,workOrder,object,objectRows,payload,context,command,document,attachInvoice } = fixture;
  async function foreignInvoice() {
    const workOrderId = await workOrder({ owner:actors.outsider });
    const input = payload();
    const invoice = await command('draft',actors.outsider,await context(workOrderId),input);
    const path = `${invoice.invoiceId}/${randomUUID()}.pdf`;
    await object('invoice-pdfs',path,actors.outsider,{ mimetype:'application/pdf',size:128 });
    await attachInvoice(actors.outsider,invoice.invoiceId,path);
    return { ...invoice,path };
  }
  await check('guarded invoice attachment accepts another invoice object and grants its read', async () => {
    const victim = await foreignInvoice(); const own = await workOrder();
    const invoice = await command('draft',actors.contractor,await context(own),payload());
    assert.equal((await objectRows(actors.contractor,'invoice-pdfs',victim.path)).length,0);
    await attachInvoice(actors.contractor,invoice.invoiceId,victim.path);
    assert.equal((await document(invoice.invoiceId)).header.pdf_storage_path,victim.path);
    assert.equal((await objectRows(actors.contractor,'invoice-pdfs',victim.path)).length,1);
    assert.equal((await db.query('select id from public.invoices where pdf_storage_path=$1',[victim.path])).rows.length,2);
  });
  await check('guarded invoice attachment accepts a nonexistent object reference', async () => {
    const own = await workOrder(); const invoice = await command('draft',actors.contractor,await context(own),payload());
    const missing = `${randomUUID()}/missing.pdf`;
    await attachInvoice(actors.contractor,invoice.invoiceId,missing);
    assert.equal((await document(invoice.invoiceId)).header.pdf_storage_path,missing);
  });
  await check('operational staff invoice upload accepts a nonexistent invoice prefix', async () => {
    const path = `${randomUUID()}/synthetic.pdf`;
    await as('authenticated',actors.mgr,tx => tx.query(
      "insert into storage.objects(bucket_id,name,owner) values ('invoice-pdfs',$1,$2)",[path,actors.mgr]));
    assert.equal((await objectRows(actors.mgr,'invoice-pdfs',path)).length,1);
  });
  await check('contractor raw foreign-prefix invoice upload and raw header rebinding are already denied', async () => {
    const victim = await foreignInvoice(); const own = await workOrder();
    const invoice = await command('draft',actors.contractor,await context(own),payload());
    await expectSqlDenial(() => as('authenticated',actors.contractor,tx => tx.query(
      "insert into storage.objects(bucket_id,name,owner) values ('invoice-pdfs',$1,$2)",
      [`${victim.invoiceId}/${randomUUID()}.pdf`,actors.contractor])),['42501']);
    await expectSqlDenial(() => as('authenticated',actors.contractor,tx => tx.query(
      'update public.invoices set pdf_storage_path=$2 where id=$1',[invoice.invoiceId,victim.path])),['42501']);
    assert.equal((await document(invoice.invoiceId)).header.pdf_storage_path,null);
  });
  await check('atomic draft save preserves an unchanged foreign PDF binding introduced by attach', async () => {
    const victim = await foreignInvoice(); const own = await workOrder(); const input = payload();
    const invoice = await command('draft',actors.contractor,await context(own),input);
    await attachInvoice(actors.contractor,invoice.invoiceId,victim.path);
    const saved = await command('draft',actors.contractor,await context(own,invoice.invoiceId),
      { ...input,pdfStoragePath:victim.path });
    assert.equal(saved.invoiceId,invoice.invoiceId);
    assert.equal((await document(invoice.invoiceId)).header.pdf_storage_path,victim.path);
  });
  await check('valid rejection/revision preserves the same foreign PDF reference', async () => {
    const victim = await foreignInvoice(); const own = await workOrder(); const input = payload();
    const invoice = await command('submit',actors.contractor,await context(own),input);
    await attachInvoice(actors.contractor,invoice.invoiceId,victim.path);
    await as('authenticated',actors.mgr,tx => tx.query(
      "select public.review_contractor_invoice($1,'reject','Synthetic revision request')",[invoice.invoiceId]));
    const revised = await command('revise',actors.contractor,await context(own,invoice.invoiceId),
      { ...input,pdfStoragePath:victim.path });
    assert.equal(revised.state,'revised');
    assert.equal((await document(invoice.invoiceId)).header.pdf_storage_path,victim.path);
  });
  await check('changed foreign PDF binding through the financial save command is already rejected', async () => {
    const victim = await foreignInvoice(); const own = await workOrder(); const input = payload();
    const invoice = await command('draft',actors.contractor,await context(own),input);
    await expectSqlDenial(async () => command('draft',actors.contractor,await context(own,invoice.invoiceId),
      { ...input,pdfStoragePath:victim.path }),['22023']);
    assert.equal((await document(invoice.invoiceId)).header.pdf_storage_path,null);
  });
}
