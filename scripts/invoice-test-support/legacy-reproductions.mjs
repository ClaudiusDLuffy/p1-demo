import assert from 'node:assert/strict';

// Deliberately demonstrate the original policies on synthetic records. All rows
// are in an in-memory disposable database. Each failed INSERT is a separate
// transaction after the preceding successful mutation has actually committed.
export async function reproduceLegacyInvoiceFindings({ db, check, actors, as, stage, prefix }) {
  const { contractor, mgr } = actors;
  const operationPrefix = `${prefix.slice(3)}00000`;
  const workOrder = async suffix => {
    const id = `${prefix}${suffix}`;
    await db.query(`insert into public.work_orders(id,status,functional_status,contractor_id,
      contractor_assignment_started_at,store_number,address)
      values ($1,'completed','Completed',$2,now()-interval '1 day','99999','Synthetic address')`, [id, contractor]);
    return id;
  };
  const rawDraft = async (id, num, type = 'contractor') => (await as('authenticated', type === 'staff' ? mgr : contractor,
    tx => tx.query(`insert into public.invoices(num,work_order_id,contractor_id,invoice_type,
      invoice_date,state,subtotal,sales_tax,total,created_by)
      values ($1,$2,$3,$4,current_date,'draft',10,0,10,$5) returning id`,
    [num,id,type === 'staff' ? null : contractor,type,type === 'staff' ? mgr : contractor]))).rows[0].id;

  await check(`BASELINE ${stage} raw contractor draft becomes submitted with arbitrary total and zero lines/evidence`, async () => {
    const id = await workOrder('0001');
    const invoiceId = await rawDraft(id, `RAW-${stage}`);
    await as('authenticated', contractor, tx => tx.query(`update public.invoices
      set state='submitted',subtotal=9999,total=9999,submission_key=null where id=$1`, [invoiceId]));
    const invoice = (await db.query(`select state,subtotal::text,total::text,submission_key,
      (select count(*)::int from public.invoice_lines where invoice_id=i.id) lines,
      (select count(*)::int from public.activities where work_order_id=i.work_order_id and event_key='invoice_submitted') events
      from public.invoices i where id=$1`, [invoiceId])).rows[0];
    assert.deepEqual(invoice, { state: 'submitted', subtotal: '9999.00', total: '9999.00', submission_key: null, lines: 0, events: 0 });
    assert.equal((await db.query('select status from public.work_orders where id=$1', [id])).rows[0].status, 'completed');
  });

  await check(`BASELINE ${stage} separate draft replacement loses old lines on replacement failure`, async () => {
    const id = await workOrder('0002');
    const invoiceId = await rawDraft(id, `PARTIAL-${stage}`);
    await as('authenticated', contractor, tx => tx.query(`insert into public.invoice_lines(invoice_id,position,type,description,qty,rate)
      values ($1,1,'Labor','Synthetic original line',1,10)`, [invoiceId]));
    await as('authenticated', contractor, tx => tx.query(`update public.invoices set subtotal=20,total=20,terms='Changed header' where id=$1`, [invoiceId]));
    await as('authenticated', contractor, tx => tx.query('delete from public.invoice_lines where invoice_id=$1', [invoiceId]));
    await assert.rejects(() => as('authenticated', contractor, tx => tx.query(`insert into public.invoice_lines(invoice_id,position,type,description,qty,rate)
      values ($1,1,'Labor','Synthetic failed replacement','not-a-number',20)`, [invoiceId])), error => error.code === '22P02');
    const after = (await db.query(`select subtotal::text,total::text,terms,
      (select count(*)::int from public.invoice_lines where invoice_id=i.id) lines
      from public.invoices i where id=$1`, [invoiceId])).rows[0];
    assert.deepEqual(after, { subtotal: '20.00', total: '20.00', terms: 'Changed header', lines: 0 });
  });

  await check(`BASELINE ${stage} operational staff raw financial insert/update bypasses save calculation and audit`, async () => {
    const id = await workOrder('0003');
    const invoiceId = await rawDraft(id, `P1-RAW-${stage}`, 'staff');
    await as('authenticated', mgr, tx => tx.query("update public.invoices set state='submitted',subtotal=8888,total=8888 where id=$1", [invoiceId]));
    const after = (await db.query(`select state,total::text,
      (select count(*)::int from public.invoice_lines where invoice_id=i.id) lines,
      (select count(*)::int from public.activities where work_order_id=i.work_order_id and event_key='staff_billing') events
      from public.invoices i where id=$1`, [invoiceId])).rows[0];
    assert.deepEqual(after, { state: 'submitted', total: '8888.00', lines: 0, events: 0 });
  });

  for (const [index, type] of ['contractor', 'staff'].entries()) {
    await check(`BASELINE ${stage} ${type} administrative soft-delete survives later authoritative audit failure`, async () => {
      const id = await workOrder(`000${4 + index}`);
      const invoiceId = await rawDraft(id, `DELETE-${type}-${stage}`, type);
      // Exact separate-commit shape used by both DELETE routes. The synthetic
      // database-only CHECK injects a failure without production debug hooks.
      await db.exec("alter table public.activities add constraint invoice_harness_audit_failure check (text <> 'Synthetic deletion evidence')");
      await as('service_role', null, tx => tx.query('update public.invoices set deleted_at=now(),deleted_by=$2 where id=$1', [invoiceId,mgr]));
      await assert.rejects(() => as('service_role', null, tx => tx.query(`insert into public.activities(work_order_id,author_id,author_name,text,type,event_key,event_data)
        values ($1,$2,'Synthetic staff','Synthetic deletion evidence','system',$3,jsonb_build_object('invoiceId',$4::text,'action','deleted'))`,
      [id,mgr,type === 'staff' ? 'staff_billing' : 'invoice_deleted',invoiceId])), error => error.code === '23514');
      await db.exec('alter table public.activities drop constraint invoice_harness_audit_failure');
      assert.equal((await db.query('select deleted_at is not null as deleted from public.invoices where id=$1', [invoiceId])).rows[0].deleted, true);
      assert.equal((await db.query('select count(*)::int n from public.activities where event_data->>\'invoiceId\'=$1', [invoiceId])).rows[0].n, 0);
    });
  }

  await check(`BASELINE ${stage} atomic new contractor submission preserves totals, order and same-key replay`, async () => {
    const id = await workOrder('0006');
    const operationId = `${operationPrefix}-0000-4000-8000-000000000001`;
    const call = () => as('authenticated', contractor, tx => tx.query(`select (public.submit_contractor_invoice_once(
      $1,$2,$3,true,null,null,'2026-09-08','2026-09-07',null,'Net 30',1.25,null,$4)).id`,
    [operationId,id,`ATOMIC-${stage}`,JSON.stringify([
      { type: 'Labor', description: 'Synthetic line A', qty: 1.25, rate: 10.11 },
      { type: 'Travel', description: '', qty: 1, rate: 5 },
    ])]));
    const invoiceId = (await call()).rows[0].id;
    assert.equal((await call()).rows[0].id, invoiceId);
    const row = (await db.query('select state,subtotal::text,sales_tax::text,total::text from public.invoices where id=$1', [invoiceId])).rows[0];
    assert.deepEqual(row, { state: 'submitted', subtotal: '17.64', sales_tax: '1.25', total: '18.89' });
    assert.deepEqual((await db.query('select position,type from public.invoice_lines where invoice_id=$1 order by position', [invoiceId])).rows,
      [{ position: 1, type: 'Labor' }, { position: 2, type: 'Travel' }]);
    // Migration 0085 deliberately retains the field-completed queue until the
    // separate contractor-invoicing confirmation. Submission must not bypass it.
    assert.equal((await db.query('select status from public.work_orders where id=$1', [id])).rows[0].status, 'completed');
    assert.equal((await db.query("select count(*)::int n from public.activities where work_order_id=$1 and event_key='invoice_submitted'", [id])).rows[0].n, 1);
  });

  await check(`BASELINE ${stage} explicit manual/PDF total override supports zero-line submitted document`, async () => {
    const id = await workOrder('0007');
    const operationId = `${operationPrefix}-0000-4000-8000-000000000002`;
    const invoiceId = (await as('authenticated', contractor, tx => tx.query(`select (public.submit_contractor_invoice_once(
      $1,$2,$3,true,null,null,'2026-09-08',null,null,'Net 30',0,55.55,'[]')).id`,
    [operationId,id,`MANUAL-${stage}`]))).rows[0].id;
    assert.deepEqual((await db.query('select state,total::text from public.invoices where id=$1', [invoiceId])).rows[0], { state: 'submitted', total: '55.55' });
    assert.equal((await db.query('select count(*)::int n from public.invoice_lines where invoice_id=$1', [invoiceId])).rows[0].n, 0);
  });

  await check(`BASELINE ${stage} aggregate exact-product rounding differs from sum of displayed line amounts`, async () => {
    const id = await workOrder('0008');
    const operationId = `${operationPrefix}-0000-4000-8000-000000000003`;
    const lines = Array.from({ length: 3 }, () => ({ type: 'Other', description: 'Synthetic rounding case', qty: 1.01, rate: 0.5 }));
    const invoiceId = (await as('authenticated', contractor, tx => tx.query(`select (public.submit_contractor_invoice_once(
      $1,$2,$3,true,null,null,'2026-09-08',null,null,'Net 30',0,null,$4)).id`,
    [operationId,id,`ROUND-${stage}`,JSON.stringify(lines)]))).rows[0].id;
    assert.equal((await db.query('select subtotal::text from public.invoices where id=$1', [invoiceId])).rows[0].subtotal, '1.52');
    assert.equal((await db.query('select sum(amount)::text total from public.invoice_lines where invoice_id=$1', [invoiceId])).rows[0].total, '1.53');
  });

  await check(`BASELINE ${stage} existing same-key replay does not bind changed financial payload`, async () => {
    const id = await workOrder('0009');
    const operationId = `${operationPrefix}-0000-4000-8000-000000000004`;
    const call = total => as('authenticated', contractor, tx => tx.query(`select (public.submit_contractor_invoice_once(
      $1,$2,$3,true,null,null,'2026-09-08',null,null,'Net 30',0,$4,'[]')).id`,
    [operationId,id,`REPLAY-${stage}`,total]));
    const invoiceId = (await call(55.55)).rows[0].id;
    assert.equal((await call(999.99)).rows[0].id, invoiceId, 'Legacy command returns an earlier invoice instead of rejecting conflicting payload');
    assert.equal((await db.query('select total::text from public.invoices where id=$1', [invoiceId])).rows[0].total, '55.55');
  });
}
