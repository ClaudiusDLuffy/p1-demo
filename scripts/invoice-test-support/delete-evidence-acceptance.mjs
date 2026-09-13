import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { rejectFinancialCall, assertRawFinancialDenied, withFinancialWriteFailure } from './transaction-tools.mjs';

export async function verifyFinancialDeleteAndEvidence(fixture, check) {
  const { db,as,actors,workOrder,context,payload,command,staffPayload,staffCommand,snapshot,document } = fixture;
  async function adminDelete(actor,invoiceId,type,args,operationId = randomUUID()) {
    return (await as('service_role',null,tx => tx.query(
      'select public.delete_invoice_admin_v1($1,$2,$3,$4,$5,$6,$7,$8) result',
      [actor,invoiceId,type,args[4],operationId,args[1],args[2],'Synthetic approved deletion'],
    ))).rows[0].result;
  }
  async function selfDelete(actor,args) {
    return (await as('authenticated',actor,tx => tx.query(
      'select public.delete_own_contractor_invoice_v1($1,$2,$3,$4,$5,$6) result',args,
    ))).rows[0].result;
  }
  async function create(type,id,state = 'draft') {
    return type === 'staff'
      ? staffCommand(actors.mgr,await context(id),staffPayload({ state }))
      : command(state === 'draft' ? 'draft' : 'submit',actors.contractor,await context(id),payload());
  }

  for (const type of ['contractor','staff']) {
    await check(`${type} administrative soft-delete and owned evidence are atomic and idempotent`, async () => {
      const id = await workOrder();
      const saved = await create(type,id);
      const args = await context(id,saved.invoiceId);
      const operationId = randomUUID();
      const deleted = await adminDelete(actors.mgr,saved.invoiceId,type,args,operationId);
      assert.equal(deleted.applied,true);
      const row = await document(saved.invoiceId);
      assert.ok(row.header.deleted_at);
      assert.equal(row.header.deleted_by,actors.mgr);
      assert.ok(row.lines.length > 0, 'Soft deletion must preserve financial lines/history');
      const after = await snapshot(id);
      assert.equal((await adminDelete(actors.mgr,saved.invoiceId,type,args,operationId)).reason,'already_applied');
      assert.deepEqual(await snapshot(id),after);
      assert.equal(after.activities.filter(activity => activity.event_data?.invoiceId === saved.invoiceId
        && (activity.event_key === 'invoice_deleted' || activity.event_data?.action === 'deleted')).length,1);
    });
    for (const table of ['invoices','activities']) {
      await check(`${type} soft-delete rolls back when failure occurs after ${table} write`, async () => {
        const id = await workOrder();
        const saved = await create(type,id);
        const args = await context(id,saved.invoiceId);
        const operationId = randomUUID();
        const before = await snapshot(id);
        await withFinancialWriteFailure(db,{ table,operation: table === 'invoices' ? 'update' : 'insert',condition: table === 'invoices' ? 'new.deleted_at is not null' : 'true' },async () => {
          await rejectFinancialCall(() => adminDelete(actors.mgr,saved.invoiceId,type,args,operationId), ['P0001']);
          assert.deepEqual(await snapshot(id),before);
        });
        assert.equal((await adminDelete(actors.mgr,saved.invoiceId,type,args,operationId)).applied,true);
      });
    }
  }

  await check('contractor self-delete remains draft/rejected-only with current-assignment and version checks', async () => {
    const id = await workOrder();
    const draft = await create('contractor',id);
    const args = await context(id,draft.invoiceId);
    await rejectFinancialCall(() => selfDelete(actors.outsider,args), ['42501','P0002']);
    const deleted = await selfDelete(actors.contractor,args);
    assert.equal(deleted.applied,true);
    assert.equal((await selfDelete(actors.contractor,args)).reason,'already_applied');
    const submitted = await create('contractor',id,'submitted');
    await rejectFinancialCall(async () => selfDelete(actors.contractor,await context(id,submitted.invoiceId)), ['22023','PT409','23514']);
  });

  await check('delete rejects wrong document type, stale edit, inactive/controller and unprivileged actors', async () => {
    const id = await workOrder();
    const draftInput = payload();
    const saved = await command('draft',actors.contractor,await context(id),draftInput);
    const args = await context(id,saved.invoiceId);
    for (const actor of [actors.inactive,actors.controller,actors.contractor,null]) {
      await rejectFinancialCall(() => adminDelete(actor,saved.invoiceId,'contractor',args), ['42501','22023']);
    }
    await rejectFinancialCall(() => adminDelete(actors.mgr,saved.invoiceId,'staff',args), ['22023','P0002','PT409']);
    await command('draft',actors.contractor,args,{ ...draftInput,terms: 'Net 15' });
    await rejectFinancialCall(() => adminDelete(actors.mgr,saved.invoiceId,'contractor',args), ['PT409']);
  });

  await check('active staff source link prevents contractor administrative/self financial deletion', async () => {
    const id = await workOrder();
    const contractor = await create('contractor',id,'submitted');
    await staffCommand(actors.mgr,await context(id),staffPayload({ sourceInvoiceIds: [contractor.invoiceId] }));
    const args = await context(id,contractor.invoiceId);
    const before = await snapshot(id);
    await rejectFinancialCall(() => adminDelete(actors.mgr,contractor.invoiceId,'contractor',args), ['22023','23514','55000','PT409']);
    assert.deepEqual(await snapshot(id),before);
  });

  await check('authoritative financial events cannot be inserted, edited, reclassified or deleted by browser identities', async () => {
    const id = await workOrder();
    const input = payload();
    const draft = await command('draft',actors.contractor,await context(id),input);
    await command('draft',actors.contractor,await context(id,draft.invoiceId),{ ...input,terms: 'Net 15' });
    const submitted = await command('submit',actors.contractor,await context(id,draft.invoiceId),input);
    const staff = await staffCommand(actors.mgr,await context(id),staffPayload());
    await adminDelete(actors.mgr,staff.invoiceId,'staff',await context(id,staff.invoiceId));
    const events = (await snapshot(id)).activities.filter(event => event.event_data?.invoiceId === submitted.invoiceId || event.event_data?.invoiceId === staff.invoiceId);
    assert.ok(events.length >= 5, 'Create/save/submit/staff-create/staff-delete evidence must exist');
    for (const event of events) {
      for (const actor of [actors.contractor,actors.mgr,actors.controller]) {
        for (const [query,values] of [
          ['update public.activities set text=$2 where id=$1 returning id',[event.id,'Forged financial history']],
          ["update public.activities set event_key='note' where id=$1 returning id",[event.id]],
          ['update public.activities set deleted_at=now() where id=$1 returning id',[event.id]],
          ['delete from public.activities where id=$1 returning id',[event.id]],
          ["insert into public.activities(work_order_id,author_id,author_name,text,type,event_key,event_data) values ($1,$2,'Forged actor','Forged financial event','system',$3,$4) returning id",
            [id,actor,event.event_key,JSON.stringify(event.event_data)]],
        ]) await assertRawFinancialDenied({ as,actor,query,values,snapshot: () => snapshot(id) });
      }
    }
  });

  await check('ordinary contractor notes, staff internal notes and staff messages survive financial event protection', async () => {
    const id = await workOrder();
    const contractorNote = (await as('authenticated',actors.contractor,tx => tx.query(`insert into public.activities(work_order_id,author_id,author_name,text,type,event_key,activity_channel)
      values ($1,$2,'Caller name','Synthetic contractor message','note','note','contractor_message') returning id`, [id,actors.contractor]))).rows[0].id;
    const internal = (await as('authenticated',actors.mgr,tx => tx.query(`insert into public.activities(work_order_id,author_id,author_name,text,type,event_key,activity_channel,is_staff_only)
      values ($1,$2,'Caller name','Synthetic private note','note','note','internal_note',true) returning id`, [id,actors.mgr]))).rows[0].id;
    const staffMessage = (await as('authenticated',actors.mgr,tx => tx.query(`insert into public.activities(work_order_id,author_id,author_name,text,type,event_key,activity_channel)
      values ($1,$2,'Caller name','Synthetic staff message','note','note','contractor_message') returning id`, [id,actors.mgr]))).rows[0].id;
    const visible = (await as('authenticated',actors.contractor,tx => tx.query('select id from public.activities where work_order_id=$1',[id]))).rows.map(row => row.id);
    assert.ok(visible.includes(contractorNote));
    assert.ok(visible.includes(staffMessage));
    assert.ok(!visible.includes(internal));
  });
}
