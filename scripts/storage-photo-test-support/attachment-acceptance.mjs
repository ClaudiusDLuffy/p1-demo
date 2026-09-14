import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { expectSqlDenial, XLSX_MIME } from './fixtures.mjs';

export async function verifyCanonicalAttachments(fixture,check) {
  const {db,as,actors,workOrder,payload,context,command,document,attachInvoice,estimate}=fixture;
  async function prepared(parent,purpose,actor=actors.contractor) {
    const isEstimate=purpose==='estimate_attachment';
    const file={name:isEstimate?'Synthetic.xlsx':'Synthetic.pdf',mimeType:isEstimate?XLSX_MIME:'application/pdf',sizeBytes:128,sha256:'c'.repeat(64)};
    const intent=(await as('authenticated',actor,tx=>tx.query('select public.begin_contractor_attachment_upload_v1($1,$2,$3,$4) result',
      [parent,purpose,randomUUID(),JSON.stringify(file)]))).rows[0].result;
    await as('authenticated',actor,tx=>tx.query('insert into storage.objects(bucket_id,name,owner,metadata) values ($1,$2,$3,$4)',
      [intent.bucket,intent.objectPath,actor,JSON.stringify({mimetype:file.mimeType,size:128})]));
    const claim=(await as('authenticated',actor,tx=>tx.query('select public.claim_private_object_upload_v1($1) result',[intent.intentId]))).rows[0].result;
    const inspection={format:isEstimate?'xlsx':'pdf',extension:isEstimate?'xlsx':'pdf',mimeType:file.mimeType,
      sizeBytes:128,sha256:file.sha256,width:null,height:null,frames:null};
    const finished=(await as('service_role',null,tx=>tx.query('select public.finalize_private_object_upload_v1($1,$2,$3) result',
      [claim.intentId,claim.claimId,JSON.stringify(inspection)]))).rows[0].result;
    return finished;
  }
  await check('invoice reservations do not alter financial state and attach marks the binding permanently used',async()=>{
    const own=await workOrder(); const input=payload(); const saved=await command('draft',actors.contractor,await context(own),input);
    const before=await document(saved.invoiceId);const verified=await prepared(saved.invoiceId,'invoice_original');
    assert.deepEqual(await document(saved.invoiceId),before);
    assert.equal((await fixture.objectRows(actors.contractor,verified.bucket,verified.objectPath)).length,0);
    await attachInvoice(actors.contractor,saved.invoiceId,verified.objectPath);
    assert.equal((await fixture.objectRows(actors.contractor,verified.bucket,verified.objectPath)).length,1);
    const binding=(await db.query('select attached_at from public.private_object_bindings where id=$1',[verified.bindingId])).rows[0];
    assert.ok(binding.attached_at);
    const exported=(await as('service_role',null,tx=>tx.query('select public.get_verified_invoice_object_v1($1) result',[saved.invoiceId]))).rows[0].result;
    assert.equal(exported.objectPath,verified.objectPath);
    const cancelled=(await as('authenticated',actors.contractor,tx=>tx.query('select public.cancel_private_object_upload_v1($1) result',[verified.intentId]))).rows[0].result;
    assert.equal(cancelled.status,'finalized');
    await expectSqlDenial(()=>as('service_role',null,tx=>tx.query('select public.claim_private_object_upload_cleanup_v1($1)',[verified.intentId])),['PT409']);
    const other=await command('draft',actors.contractor,await context(await workOrder()),payload());
    await expectSqlDenial(()=>attachInvoice(actors.contractor,other.invoiceId,verified.objectPath),['42501']);
    await expectSqlDenial(()=>attachInvoice(actors.contractor,other.invoiceId,`${other.invoiceId}/missing.pdf`),['42501']);
  });
  await check('rejected invoice revision accepts its own validated replacement and preserves numeric command behavior',async()=>{
    const own=await workOrder();const input=payload();const invoice=await command('submit',actors.contractor,await context(own),input);
    const original=await prepared(invoice.invoiceId,'invoice_original');await attachInvoice(actors.contractor,invoice.invoiceId,original.objectPath);
    await as('authenticated',actors.mgr,tx=>tx.query("select public.review_contractor_invoice($1,'reject','Synthetic revision')",[invoice.invoiceId]));
    const replacement=await prepared(invoice.invoiceId,'invoice_original');
    const revised=await command('revise',actors.contractor,await context(own,invoice.invoiceId),{...input,pdfStoragePath:replacement.objectPath});
    assert.equal(revised.state,'revised');assert.equal((await document(invoice.invoiceId)).header.pdf_storage_path,replacement.objectPath);
    assert.ok((await db.query('select attached_at from public.private_object_bindings where id=$1',[replacement.bindingId])).rows[0].attached_at);
    assert.ok((await db.query('select attached_at from public.private_object_bindings where id=$1',[original.bindingId])).rows[0].attached_at);
  });
  await check('unattached PDF reservation cancellation is recoverable but cannot erase any previously attached PDF',async()=>{
    const own=await workOrder();const invoice=await command('draft',actors.contractor,await context(own),payload());
    const unused=await prepared(invoice.invoiceId,'invoice_generated');
    const cancelled=(await as('authenticated',actors.contractor,tx=>tx.query('select public.cancel_private_object_upload_v1($1) result',[unused.intentId]))).rows[0].result;
    assert.equal(cancelled.status,'cleanup_required');
    await expectSqlDenial(()=>attachInvoice(actors.contractor,invoice.invoiceId,unused.objectPath),['42501']);
    const cleanup=(await as('service_role',null,tx=>tx.query('select public.claim_private_object_upload_cleanup_v1($1) result',[unused.intentId]))).rows[0].result;
    await as('service_role',null,tx=>tx.query('delete from storage.objects where bucket_id=$1 and name=$2',[cleanup.bucket,cleanup.objectPath]));
    await as('service_role',null,tx=>tx.query('select public.complete_private_object_upload_cleanup_v1($1,$2,$3)',[cleanup.intentId,cleanup.claimId,'deleted']));
    assert.equal((await db.query('select state from public.private_object_bindings where id=$1',[unused.bindingId])).rows[0].state,'deleted');
    assert.equal((await document(invoice.invoiceId)).header.pdf_storage_path,null);
  });
  await check('estimate upload works with normal profile names and attaches only through inspected finalization',async()=>{
    const parent=await estimate();const verified=await prepared(parent.id,'estimate_attachment');
    assert.ok(verified.attachmentId);
    assert.equal((await fixture.objectRows(actors.contractor,verified.bucket,verified.objectPath)).length,1);
    await expectSqlDenial(()=>fixture.attachEstimate(actors.contractor,parent.id,verified.objectPath),['42501','23505']);
    await expectSqlDenial(()=>as('service_role',null,tx=>tx.query('update public.contractor_estimate_attachments set storage_path=$2 where id=$1',
      [verified.attachmentId,`${randomUUID()}/${randomUUID()}.xlsx`])),['42501']);
  });
  await check('estimate removal retains metadata until confirmed physical deletion and then commits the tombstone',async()=>{
    const parent=await estimate();const verified=await prepared(parent.id,'estimate_attachment');
    const deletion=(await as('authenticated',actors.contractor,tx=>tx.query('select public.request_private_object_delete_v1($1,$2) result',
      [verified.bindingId,randomUUID()]))).rows[0].result;
    assert.equal((await db.query('select deleted_at from public.contractor_estimate_attachments where id=$1',[verified.attachmentId])).rows[0].deleted_at,null);
    const claimed=(await as('service_role',null,tx=>tx.query('select public.claim_private_object_deletion_v1($1) result',[deletion.deletionId]))).rows[0].result;
    await as('service_role',null,tx=>tx.query('delete from storage.objects where bucket_id=$1 and name=$2',[claimed.bucket,claimed.objectPath]));
    await as('service_role',null,tx=>tx.query('select public.complete_private_object_deletion_v1($1,$2,$3)',[claimed.deletionId,claimed.claimId,'deleted']));
    assert.ok((await db.query('select deleted_at from public.contractor_estimate_attachments where id=$1',[verified.attachmentId])).rows[0].deleted_at);
  });
  await check('expired never-attached PDF is reconciled, while a young reservation and all used PDFs are retained',async()=>{
    const own=await workOrder();const invoice=await command('draft',actors.contractor,await context(own),payload());
    const fresh=await prepared(invoice.invoiceId,'invoice_generated');
    await expectSqlDenial(()=>as('service_role',null,tx=>tx.query('select public.claim_private_object_upload_cleanup_v1($1)',[fresh.intentId])),['PT409']);
    await db.query("update public.private_object_uploads set expires_at=clock_timestamp()-interval '1 minute' where id=$1",[fresh.intentId]);
    const listed=(await as('service_role',null,tx=>tx.query('select public.list_private_object_reconciliation_v1(100,true) result'))).rows[0].result;
    assert.ok(listed.some(item=>item.id===fresh.intentId&&item.kind==='upload'));
    const cleanup=(await as('service_role',null,tx=>tx.query('select public.claim_private_object_upload_cleanup_v1($1) result',[fresh.intentId]))).rows[0].result;
    assert.equal(cleanup.status,'cleanup_required');assert.equal(cleanup.objectPath,fresh.objectPath);
    await expectSqlDenial(()=>attachInvoice(actors.contractor,invoice.invoiceId,fresh.objectPath),['42501']);
    const used=await prepared(invoice.invoiceId,'invoice_original');await attachInvoice(actors.contractor,invoice.invoiceId,used.objectPath);
    await db.query("update public.private_object_uploads set expires_at=clock_timestamp()-interval '1 minute' where id=$1",[used.intentId]);
    await expectSqlDenial(()=>as('service_role',null,tx=>tx.query('select public.claim_private_object_upload_cleanup_v1($1)',[used.intentId])),['PT409']);
  });
  await check('an older validated replacement cannot overwrite a newer invoice version',async()=>{
    const own=await workOrder();const input=payload();const invoice=await command('draft',actors.contractor,await context(own),input);
    const verified=await prepared(invoice.invoiceId,'invoice_original');
    await command('draft',actors.contractor,await context(own,invoice.invoiceId),{...input,terms:'Net 15'});
    await expectSqlDenial(()=>attachInvoice(actors.contractor,invoice.invoiceId,verified.objectPath),['PT409']);
    assert.equal((await document(invoice.invoiceId)).header.pdf_storage_path,null);
  });
}
