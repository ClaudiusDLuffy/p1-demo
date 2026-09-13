import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createInvoiceCommandFixtures } from '../invoice-test-support/command-fixtures.mjs';

export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

export async function expectSqlDenial(run, codes = ['42501', '22023', '23514', 'P0002']) {
  await assert.rejects(run, error => codes.includes(error.code), `Expected SQL denial: ${codes.join(', ')}`);
}

export async function createStoragePhotoFixtures(options) {
  const financial = await createInvoiceCommandFixtures(options);
  const { db, as, actors } = financial;
  async function object(bucket, path, owner = actors.contractor, metadata = {}) {
    const id = randomUUID();
    await db.query('insert into storage.objects(id,bucket_id,name,owner,metadata) values ($1,$2,$3,$4,$5)',
      [id,bucket,path,owner,JSON.stringify(metadata)]);
    return id;
  }
  async function objectRows(actor, bucket, path) {
    return (await as('authenticated',actor,tx => tx.query(
      'select id,name from storage.objects where bucket_id=$1 and name=$2', [bucket,path]))).rows;
  }
  async function photo(workOrderId, path, actor = actors.contractor) {
    return (await as('authenticated',actor,tx => tx.query(`insert into public.photos
      (work_order_id,storage_path,uploader_id,uploader_name)
      values ($1,$2,$3,'Synthetic uploader') returning id`, [workOrderId,path,actor]))).rows[0].id;
  }
  async function estimate(owner = actors.contractor) {
    const workOrderId = await financial.workOrder({ status:'assigned',functional:'Dispatched',owner });
    const id = randomUUID();
    await db.query(`insert into public.contractor_estimates
      (id,work_order_id,contractor_id,contractor_assignment_version,created_by,updated_by)
      select $1,id,contractor_id,contractor_assignment_version,$3,$3
      from public.work_orders where id=$2`, [id,workOrderId,owner]);
    return { id,workOrderId };
  }
  async function attachEstimate(actor, estimateId, path, size = 128) {
    return (await as('authenticated',actor,tx => tx.query(
      'select public.attach_contractor_estimate_file($1,$2,$3,$4,$5) result',
      [estimateId,path,'Synthetic equipment.xlsx',XLSX_MIME,size]))).rows[0].result;
  }
  async function attachInvoice(actor, invoiceId, path) {
    return as('authenticated',actor,tx => tx.query('select public.attach_contractor_invoice_pdf($1,$2)', [invoiceId,path]));
  }
  return { ...financial,object,objectRows,photo,estimate,attachEstimate,attachInvoice };
}
