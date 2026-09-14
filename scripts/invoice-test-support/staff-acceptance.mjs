import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { rejectFinancialCall, assertRawFinancialDenied, withFinancialWriteFailure } from './transaction-tools.mjs';

export async function verifyStaffFinancialCommands(fixture, check) {
  const { db,as,actors,workOrder,context,payload,command,staffPayload,staffCommand,snapshot,document } = fixture;
  await check('staff create/edit/state promotion is atomic, calculated, versioned and replay-safe', async () => {
    const id = await workOrder();
    const input = staffPayload();
    const saved = await staffCommand(actors.mgr,await context(id),input);
    assert.equal(saved.applied,true);
    assert.equal(saved.state,'draft');
    const row = await document(saved.invoiceId);
    assert.equal(saved.invoiceVersion,Number(row.header.invoice_version));
    assert.equal(Number(row.header.subtotal),17.64);
    assert.equal(Number(row.header.total),17.64);
    assert.equal(row.header.equipment_tag,'7-ELEVEN: Miscellaneous');
    const args = await context(id,saved.invoiceId);
    const updated = { ...input,state: 'submitted',lines: [{ ...input.lines[0],qty: 2,rate: 20 }] };
    const applied = await staffCommand(actors.mgr,args,updated);
    assert.equal(applied.state,'submitted');
    assert.ok(applied.invoiceVersion > saved.invoiceVersion);
    assert.equal(Number((await document(saved.invoiceId)).header.total),40);
    const beforeReplay = await snapshot(id);
    assert.equal((await staffCommand(actors.mgr,args,updated)).reason,'already_applied');
    assert.deepEqual(await snapshot(id),beforeReplay);
    await rejectFinancialCall(() => staffCommand(actors.mgr,args,{ ...updated,terms: 'Net 90' }), ['PT409']);
    await rejectFinancialCall(() => staffCommand(actors.mgr,[...args.slice(0,5),randomUUID()],updated), ['PT409']);
  });

  await check('staff number reservation rolls back with failed save and is reused safely after recovery', async () => {
    await db.query("insert into public.staff_invoice_number_series(user_id,prefix,next_number) values ($1,'P1-SQL-',100)",[actors.mgr]);
    const id = await workOrder();
    const input = staffPayload({ num: '',userTypedNum: false });
    const args = await context(id);
    const before = await snapshot(id);
    const series = (await db.query('select to_jsonb(s) value from public.staff_invoice_number_series s where user_id=$1',[actors.mgr])).rows[0].value;
    await withFinancialWriteFailure(db,{ table: 'staff_invoice_number_series',operation: 'update' },async () => {
      await rejectFinancialCall(() => staffCommand(actors.mgr,args,input), ['P0001']);
      assert.deepEqual(await snapshot(id),before);
      assert.deepEqual((await db.query('select to_jsonb(s) value from public.staff_invoice_number_series s where user_id=$1',[actors.mgr])).rows[0].value,series);
    });
    const saved = await staffCommand(actors.mgr,args,input);
    assert.equal(saved.invoiceNum,'P1-SQL-100');
    assert.equal(Number((await db.query('select next_number from public.staff_invoice_number_series where user_id=$1',[actors.mgr])).rows[0].next_number),101);
  });

  await check('staff manual tax amount/rate/none preserve existing financial semantics', async () => {
    for (const [mode,amount,rate,expected] of [
      ['none',null,null,0],['manual_amount',1.25,null,1.25],['manual_rate',null,7,1.23],
    ]) {
      const id = await workOrder();
      const input = staffPayload({ taxMode: mode,salesTaxOverride: amount,taxRateOverride: rate });
      input.lines = input.lines.map(line => ({ ...line,isTaxable: true }));
      const saved = await staffCommand(actors.mgr,await context(id),input);
      assert.equal(Number((await document(saved.invoiceId)).header.sales_tax),expected);
    }
  });

  await check('staff active database tax rate is resolved from effective stored settings, not caller totals', async () => {
    // Historical migrations already seed FL. Set the isolated fixture's
    // effective row rather than inserting a forbidden overlapping interval.
    const seeded = await db.query("update public.state_sales_tax_rates set rate=0.07 where state_code='FL' and effective_from <= '2026-09-08'::date and (effective_to is null or effective_to >= '2026-09-08'::date) returning id");
    assert.equal(seeded.rows.length,1, 'Synthetic current tax-rate fixture must be unambiguous');
    const id = await workOrder();
    const input = staffPayload({ taxMode: 'active_db_rate',taxState: 'FL' });
    input.lines = input.lines.map(line => ({ ...line,isTaxable: true }));
    const saved = await staffCommand(actors.mgr,await context(id),input);
    const row = await document(saved.invoiceId);
    assert.equal(Number(row.header.sales_tax),1.23);
    assert.equal(Number(row.header.tax_rate),0.07);
  });

  await check('staff non-taxable automatic mode needs neither a tax state nor a configured rate', async () => {
    const id = await workOrder();
    await db.query('update public.work_orders set store_state=null where id=$1',[id]);
    const saved = await staffCommand(actors.mgr,await context(id),staffPayload({ taxMode: 'active_db_rate',taxState: null }));
    const row = await document(saved.invoiceId);
    assert.equal(Number(row.header.sales_tax),0);
    assert.equal(row.header.tax_rate,null);
  });

  await check('staff tax rounds the exact taxable products only at the final tax amount', async () => {
    const id = await workOrder();
    const input = staffPayload({ taxMode: 'manual_rate',taxRateOverride: 10 });
    input.lines = [{ ...input.lines[0],qty: 0.03,rate: 1.5,isTaxable: true }];
    const saved = await staffCommand(actors.mgr,await context(id),input);
    const row = await document(saved.invoiceId);
    assert.equal(Number(row.header.subtotal),0.05);
    assert.equal(Number(row.header.sales_tax),0, 'Exact 0.045 taxable products × 10% rounds to 0.00, not 0.01');
  });

  await check('staff manual percentage precision is retained during calculation before legacy rate-column storage', async () => {
    const id = await workOrder();
    const input = staffPayload({ taxMode: 'manual_rate',taxRateOverride: 7.123456 });
    input.lines = [{ ...input.lines[0],qty: 1,rate: 1000000,isTaxable: true }];
    const saved = await staffCommand(actors.mgr,await context(id),input);
    assert.equal(Number((await document(saved.invoiceId)).header.sales_tax),71234.56);
  });

  await check('staff automatic tax preserves the existing state-rate fallback even when a different location rate exists', async () => {
    const id = await workOrder();
    await db.query("update public.work_orders set address='123 Synthetic Tax Lane',city=null,store_county=null,store_postal_code=null,store_state='FL' where id=$1",[id]);
    const batch = (await db.query(`insert into public.tax_rate_import_batches(
      state_code,source_name,source_url,source_version,effective_from)
      values ('FL','Synthetic invoice parity','https://tax-fixture.example.invalid','batch1c','2026-01-01') returning id`)).rows[0].id;
    await db.query(`insert into public.sales_tax_location_rates(import_batch_id,address,state_code,combined_rate,effective_from)
      values ($1,'123 Synthetic Tax Lane','FL',0.09,'2026-01-01')`,[batch]);
    const input = staffPayload({ taxMode: 'active_db_rate',taxState: 'TX' });
    input.lines = [{ ...input.lines[0],qty: 1,rate: 100,isTaxable: true }];
    const saved = await staffCommand(actors.mgr,await context(id),input);
    const row = await document(saved.invoiceId);
    assert.equal(Number(row.header.sales_tax),7, 'Linked WO state and existing state fallback remain authoritative; no new location-rate selection');
    assert.equal(row.header.tax_state,'FL');
  });

  await check('staff save auto-includes omitted billable P1 parts with canonical cost, quantity and 25 percent markup', async () => {
    const id = await workOrder();
    const part = (await db.query(`insert into public.wo_parts(work_order_id,description,qty)
      values ($1,'Synthetic purchased motor',2) returning id`,[id])).rows[0].id;
    await as('authenticated',actors.mgr,tx => tx.query('select public.request_p1_part_order($1)',[part]));
    await as('authenticated',actors.mgr,tx => tx.query("select public.set_p1_part_order_status_with_cost($1,'ordered',10)",[part]));
    const input = staffPayload();
    const saved = await staffCommand(actors.mgr,await context(id),input);
    const row = await document(saved.invoiceId);
    const canonical = row.lines.find(line => line.source_work_order_part_id === part);
    assert.ok(canonical, 'Billable P1 part must not disappear when browser omits the preview line');
    assert.equal(Number(canonical.qty),2);
    assert.equal(Number(canonical.rate),12.5);
    assert.equal(Number(canonical.source_unit_cost),10);
    assert.equal(Number(canonical.markup_percent),25);
    assert.equal(Number(row.header.subtotal),42.64);
    const changed = { ...input,lines: [{ ...input.lines[0],sourceWorkOrderPartId: part,sourceUnitCost: 1,markupPercent: 0 }] };
    await rejectFinancialCall(async () => staffCommand(actors.mgr,await context(id),changed), ['22023','23514','55000','PT409']);
  });

  await check('staff strict database boundary rejects malformed boolean/state/line/source/date/number as whole commands', async () => {
    const id = await workOrder();
    const good = staffPayload();
    const invalids = [
      ...['false','true',0,1,'0','1'].map(value => ({ ...good,lines: [{ ...good.lines[0],isTaxable: value }] })),
      { ...good,state: 'something_else' },{ ...good,lines: [good.lines[0],null] },
      { ...good,lines: [good.lines[0],{ ...good.lines[1],qty: '2' }] },
      { ...good,lines: [] },{ ...good,sourceInvoiceIds: [123] },
      { ...good,sourceInvoiceIds: ['not-a-uuid'] },{ ...good,invoiceDate: '2026-02-30' },
      { ...good,lines: [{ ...good.lines[0],qty: 1.001 }] },
      { ...good,lines: [{ ...good.lines[0],rate: 100000000000 }] },
      { ...good,lines: [{ ...good.lines[0],rate: 'NaN' }] },
      { ...good,taxMode: 'manual_rate',taxRateOverride: 101 },
      { ...good,unexpectedAction: 'approve' },
    ];
    for (const invalid of invalids) {
      const before = await snapshot(id);
      await rejectFinancialCall(async () => staffCommand(actors.mgr,await context(id),invalid), ['22023','22003','22007','22008','23514']);
      assert.deepEqual(await snapshot(id),before);
    }
  });

  await check('staff-only service command independently rejects inactive/controller/contractor supplied actor', async () => {
    const id = await workOrder();
    for (const actor of [actors.inactive,actors.controller,actors.contractor,actors.report,actors.outsider,null]) {
      const before = await snapshot(id);
      await rejectFinancialCall(async () => staffCommand(actor,await context(id),staffPayload()), ['42501','22023']);
      assert.deepEqual(await snapshot(id),before);
    }
    for (const role of ['anon','authenticated']) {
      await rejectFinancialCall(async () => staffCommand(actors.mgr,await context(id),staffPayload(),role,actors.mgr), ['42501']);
    }
    assert.equal((await staffCommand(actors.handoff,await context(id),staffPayload())).applied,true,
      'Additive QuickBooks permission must not remove otherwise allowed staff billing access');
  });

  await check('service financial replay rechecks active staff and controller permissions', async () => {
    const id = await workOrder();
    const input = staffPayload();
    const args = await context(id);
    await staffCommand(actors.mgr,args,input);
    await db.query('update public.profiles set active=false where id=$1',[actors.mgr]);
    try { await rejectFinancialCall(() => staffCommand(actors.mgr,args,input), ['42501']); }
    finally { await db.query('update public.profiles set active=true where id=$1',[actors.mgr]); }
    await db.query("insert into public.staff_permission_grants(profile_id,permission) values ($1,'invoice_controller')",[actors.mgr]);
    try { await rejectFinancialCall(() => staffCommand(actors.mgr,args,input), ['42501']); }
    finally { await db.query("delete from public.staff_permission_grants where profile_id=$1 and permission='invoice_controller'",[actors.mgr]); }
  });

  await check('raw staff financial header, source and line paths are denied without breaking accounting read access', async () => {
    const id = await workOrder();
    const input = staffPayload();
    const saved = await staffCommand(actors.mgr,await context(id),input);
    const line = (await document(saved.invoiceId)).lines[0];
    for (const actor of [actors.mgr,actors.controller,actors.handoff]) {
      for (const [query,values] of [
        ["update public.invoices set subtotal=8888,total=8888,state='submitted' where id=$1 returning id",[saved.invoiceId]],
        ["update public.invoices set state='approved' where id=$1 returning id",[saved.invoiceId]],
        ["update public.invoices set deleted_at=now(),deleted_by=$2 where id=$1 returning id",[saved.invoiceId,actor]],
        ['update public.invoice_lines set rate=999 where id=$1 returning id',[line.id]],
        ['delete from public.invoice_lines where id=$1 returning id',[line.id]],
        ["insert into public.invoices(num,invoice_type,work_order_id,invoice_date,state,total) values ($1,'staff',$2,current_date,'submitted',8888) returning id",[`RAW-STAFF-${actor}`,id]],
      ]) await assertRawFinancialDenied({ as,actor,query,values,snapshot: () => snapshot(id) });
      assert.equal((await as('authenticated',actor,tx => tx.query('select id from public.invoices where id=$1',[saved.invoiceId]))).rows.length,1);
    }
  });

  await check('staff source linking is current-WO scoped, unique and replay does not duplicate links', async () => {
    const id = await workOrder();
    const contractor = await command('submit',actors.contractor,await context(id),payload());
    const secondContractor = await command('submit',actors.contractor,await context(id),payload());
    const sourceLine = (await document(contractor.invoiceId)).lines[0];
    const input = staffPayload({ sourceInvoiceIds: [contractor.invoiceId,secondContractor.invoiceId] });
    input.lines[0].sourceInvoiceLineId = sourceLine.id;
    const args = await context(id);
    const staff = await staffCommand(actors.mgr,args,input);
    assert.equal((await snapshot(id)).sources.length,2);
    assert.equal((await staffCommand(actors.mgr,args,{ ...input,sourceInvoiceIds: [...input.sourceInvoiceIds].reverse() })).invoiceId,staff.invoiceId);
    assert.equal((await snapshot(id)).sources.length,2);
    await rejectFinancialCall(async () => staffCommand(actors.mgr,await context(id),staffPayload({ sourceInvoiceIds: [contractor.invoiceId] })), ['55000','PT409','23514']);
    const other = await workOrder();
    await rejectFinancialCall(async () => staffCommand(actors.mgr,await context(other),staffPayload({ sourceInvoiceIds: [contractor.invoiceId] })), ['22023','23514']);
    await assertRawFinancialDenied({ as,actor: actors.mgr,
      query: 'delete from public.staff_invoice_sources where staff_invoice_id=$1 returning staff_invoice_id',
      values: [staff.invoiceId],snapshot: () => snapshot(id) });
  });

  await check('supported staff edit can relink work order atomically without retaining stale source ownership', async () => {
    const from = await workOrder();
    const to = await workOrder();
    const sourceFrom = await command('submit',actors.contractor,await context(from),payload());
    const sourceTo = await command('submit',actors.contractor,await context(to),payload());
    const initial = staffPayload({ sourceInvoiceIds: [sourceFrom.invoiceId] });
    const saved = await staffCommand(actors.mgr,await context(from),initial);
    const targetLine = (await document(sourceTo.invoiceId)).lines[0];
    const replacement = { ...initial,sourceInvoiceIds: [sourceTo.invoiceId],
      lines: [{ ...initial.lines[0],sourceInvoiceLineId: targetLine.id }] };
    const args = await context(to,saved.invoiceId);
    const edited = await staffCommand(actors.mgr,args,replacement);
    assert.equal(edited.invoiceId,saved.invoiceId);
    assert.equal((await document(saved.invoiceId)).header.work_order_id,to);
    assert.deepEqual((await db.query('select contractor_invoice_id from public.staff_invoice_sources where staff_invoice_id=$1',[saved.invoiceId])).rows,
      [{ contractor_invoice_id: sourceTo.invoiceId }]);
    assert.equal((await staffCommand(actors.mgr,await context(from),staffPayload({ sourceInvoiceIds: [sourceFrom.invoiceId] }))).applied,true);
    const otherLine = (await document(sourceFrom.invoiceId)).lines[0];
    await rejectFinancialCall(async () => staffCommand(actors.mgr,await context(to,saved.invoiceId),{
      ...replacement,lines: [{ ...replacement.lines[0],sourceInvoiceLineId: otherLine.id }],
    }), ['22023','23503','23514']);
  });

  for (const [table,operation,condition] of [
    ['invoices','insert','true'],['invoice_lines','insert','new.position = 1'],
    ['invoice_lines','insert','new.position = 2'],['staff_invoice_sources','insert','true'],
    ['activities','insert','true'],
  ]) {
    await check(`staff create rolls back after ${table} ${operation} ${condition}`, async () => {
      const id = await workOrder();
      const source = await command('submit',actors.contractor,await context(id),payload());
      const input = staffPayload({ sourceInvoiceIds: [source.invoiceId] });
      const args = await context(id);
      const before = await snapshot(id);
      await withFinancialWriteFailure(db,{ table,operation,condition },async () => {
        await rejectFinancialCall(() => staffCommand(actors.mgr,args,input), ['P0001']);
        assert.deepEqual(await snapshot(id),before);
      });
      assert.equal((await staffCommand(actors.mgr,args,input)).applied,true);
    });
  }

  for (const [table,operation] of [
    ['invoices','update'],['invoice_lines','delete'],['staff_invoice_sources','delete'],['activities','insert'],
  ]) {
    await check(`staff edit rollback after ${table} ${operation} preserves the previous complete invoice`, async () => {
      const id = await workOrder();
      const source = await command('submit',actors.contractor,await context(id),payload());
      const input = staffPayload({ sourceInvoiceIds: [source.invoiceId] });
      const saved = await staffCommand(actors.mgr,await context(id),input);
      const args = await context(id,saved.invoiceId);
      const replacement = { ...input,terms: 'Net 15',sourceInvoiceIds: [],state: 'submitted' };
      const before = await snapshot(id);
      await withFinancialWriteFailure(db,{ table,operation },async () => {
        await rejectFinancialCall(() => staffCommand(actors.mgr,args,replacement), ['P0001']);
        assert.deepEqual(await snapshot(id),before);
      });
      assert.equal((await staffCommand(actors.mgr,args,replacement)).applied,true);
    });
  }
}
