import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { rejectFinancialCall, assertRawFinancialDenied, withFinancialWriteFailure } from './transaction-tools.mjs';

export async function verifyContractorFinancialCommands(fixture, check) {
  const { db, as, actors, workOrder, payload, context, command, snapshot, document } = fixture;
  await check('contractor draft creation, complete replacement, stale-save denial and submission are versioned', async () => {
    const id = await workOrder();
    const original = payload();
    const first = await command('draft',actors.contractor,await context(id),original);
    assert.equal(first.applied,true);
    assert.equal(first.state,'draft');
    assert.equal(first.invoiceVersion,Number((await document(first.invoiceId)).header.invoice_version));
    const args = await context(id,first.invoiceId);
    const edited = { ...original, terms: 'Net 15', lines: [{ type: 'Labor', description: 'Synthetic replacement', qty: 2, rate: 20 }] };
    const second = await command('draft',actors.contractor,args,edited);
    assert.ok(second.invoiceVersion > first.invoiceVersion);
    const afterSave = await snapshot(id);
    await rejectFinancialCall(() => command('draft',actors.contractor,[...args.slice(0,5),randomUUID()],original), ['PT409']);
    assert.deepEqual(await snapshot(id),afterSave);
    const saved = await document(first.invoiceId);
    assert.equal(second.invoiceVersion,Number(saved.header.invoice_version));
    assert.equal(saved.lines.length,1);
    assert.equal(Number(saved.header.total),41.25);
    assert.equal(saved.header.terms,'Net 15');
    const submitted = await command('submit',actors.contractor,await context(id,first.invoiceId),edited);
    assert.equal(submitted.state,'submitted');
    assert.equal((await document(first.invoiceId)).lines.length,1);
    assert.equal((await snapshot(id)).parent.status,'completed', 'Separate invoicing confirmation remains authoritative');
    assert.equal((await snapshot(id)).activities.filter(row => row.event_key === 'invoice_submitted').length,1);
  });

  await check('empty incomplete drafts remain supported but line-mode submission requires complete lines', async () => {
    const id = await workOrder();
    const input = payload({ lines: [], salesTax: 0 });
    const draft = await command('draft',actors.contractor,await context(id),input);
    assert.equal(draft.state,'draft');
    const unchanged = await command('draft',actors.contractor,await context(id,draft.invoiceId),input);
    assert.ok(unchanged.invoiceVersion > draft.invoiceVersion,
      'An accepted empty-draft save must advance the monotonic revision even with identical content');
    const before = await snapshot(id);
    await rejectFinancialCall(async () => command('submit',actors.contractor,await context(id,draft.invoiceId),input), ['22023','23514']);
    assert.deepEqual(await snapshot(id),before);
  });

  await check('manual/PDF total override explicitly permits zero lines and is operation/audit bound', async () => {
    const id = await workOrder();
    const input = payload({ mode: 'manual_pdf_total', totalOverride: 55.55, salesTax: 0, lines: [] });
    const args = await context(id);
    const saved = await command('submit',actors.contractor,args,input);
    const row = await document(saved.invoiceId);
    assert.equal(Number(row.header.total),55.55);
    assert.equal(row.lines.length,0);
    const activities = (await snapshot(id)).activities;
    assert.equal(activities.filter(activity => activity.event_key === 'invoice_submitted').length,1);
    const audit = activities.find(activity => activity.event_key === 'invoice_submitted');
    assert.ok(JSON.stringify(audit.event_data).includes('manual_pdf_total'), 'Override provenance must be explicit in authoritative evidence');
    assert.equal((await command('submit',actors.contractor,args,input)).reason,'already_applied');
    await rejectFinancialCall(() => command('submit',actors.contractor,args,{ ...input,totalOverride: 999.99 }), ['PT409']);
  });

  await check('existing draft financial save/submission preserves its supported original PDF reference', async () => {
    const id = await workOrder();
    const input = payload({ mode: 'manual_pdf_total',totalOverride: 55.55,salesTax: 0,lines: [] });
    const draft = await command('draft',actors.contractor,await context(id),input);
    const path = `${draft.invoiceId}/synthetic-original.pdf`;
    await as('authenticated',actors.contractor,tx => tx.query('select public.attach_contractor_invoice_pdf($1,$2)',[draft.invoiceId,path]));
    await command('draft',actors.contractor,await context(id,draft.invoiceId),{ ...input,terms: 'Net 15' });
    assert.equal((await document(draft.invoiceId)).header.pdf_storage_path,path);
    await command('submit',actors.contractor,await context(id,draft.invoiceId),{ ...input,terms: 'Net 15' });
    assert.equal((await document(draft.invoiceId)).header.pdf_storage_path,path);
  });

  await check('line-mode totals retain PostgreSQL aggregate-product rounding and existing tax amount rule', async () => {
    const id = await workOrder();
    const input = payload({ salesTax: 0, lines: Array.from({ length: 3 }, () => ({ type: 'Other', description: 'Synthetic fractional cent', qty: 1.01, rate: 0.5 })) });
    const saved = await command('submit',actors.contractor,await context(id),input);
    const row = await document(saved.invoiceId);
    assert.equal(Number(row.header.subtotal),1.52);
    assert.equal(Number(row.header.total),1.52);
    assert.equal(row.lines.reduce((sum,line) => sum + Number(line.amount),0),1.53);
  });

  await check('contractor numeric precision is normalized without rejecting supported fractional inputs or multiline descriptions', async () => {
    const id = await workOrder();
    const input = payload({ salesTax: 0, lines: [
      { type: 'Other',description: 'Synthetic first line\nSynthetic second line',qty: 1.001,rate: 4.286 },
    ] });
    const saved = await command('submit',actors.contractor,await context(id),input);
    const row = await document(saved.invoiceId);
    assert.equal(Number(row.lines[0].qty),1);
    assert.equal(Number(row.lines[0].rate),4.29);
    assert.equal(Number(row.header.total),4.29);
    assert.equal(row.lines[0].description,input.lines[0].description);
  });

  await check('invoice submission does not finish an active field visit or bypass separate invoicing confirmation', async () => {
    const id = await workOrder({ status: 'wip',functional: 'Work in Progress',visit: true });
    await command('submit',actors.contractor,await context(id),payload());
    const parent = (await snapshot(id)).parent;
    assert.equal(parent.status,'wip');
    assert.equal(parent.functional_status,'Work in Progress');
    assert.equal((await db.query('select count(*)::int n from public.work_order_visits where work_order_id=$1 and check_out_at is null',[id])).rows[0].n,1);
  });

  await check('same operation replay is stable and changed target/family/lines/override/state is rejected', async () => {
    const id = await workOrder();
    const input = payload();
    const args = await context(id);
    const saved = await command('draft',actors.contractor,args,input);
    const before = await snapshot(id);
    const replay = await command('draft',actors.contractor,args,input);
    assert.equal(replay.reason,'already_applied');
    assert.equal(replay.invoiceId,saved.invoiceId);
    assert.deepEqual(await snapshot(id),before);
    for (const changed of [
      { ...input,terms: 'Net 90' },
      { ...input,lines: [{ ...input.lines[0],rate: 99 }] },
      { ...input,mode: 'manual_pdf_total',totalOverride: 50 },
    ]) await rejectFinancialCall(() => command('draft',actors.contractor,args,changed), ['PT409']);
    await rejectFinancialCall(() => command('submit',actors.contractor,args,input), ['PT409']);
    const otherId = await workOrder();
    const otherArgs = await context(otherId,null,args[5]);
    await rejectFinancialCall(() => command('draft',actors.contractor,otherArgs,input), ['PT409']);
    assert.deepEqual(await snapshot(id),before);
  });

  await check('stale assignment and workflow cycle reject without header/line/audit writes', async () => {
    const id = await workOrder();
    const args = await context(id);
    const before = await snapshot(id);
    for (const index of [1,2]) {
      const changed = [...args]; changed[index]++;
      await rejectFinancialCall(() => command('submit',actors.contractor,changed,payload()), ['PT409']);
      assert.deepEqual(await snapshot(id),before);
    }
  });

  await check('successful financial operation cannot be replayed after actor deactivation or technician reassignment', async () => {
    const id = await workOrder({ owner: actors.canonical,technician: actors.invoice });
    const input = payload();
    const args = await context(id);
    await command('submit',actors.invoice,args,input);
    await db.query('update public.profiles set active=false where id=$1',[actors.invoice]);
    try { await rejectFinancialCall(() => command('submit',actors.invoice,args,input), ['42501']); }
    finally { await db.query('update public.profiles set active=true where id=$1',[actors.invoice]); }
    await db.query('update public.work_orders set assigned_technician_profile_id=$2 where id=$1',[id,actors.former]);
    await rejectFinancialCall(() => command('submit',actors.invoice,args,input), ['42501','PT409']);
  });

  await check('all malformed contractor line/decimal/override commands fail atomically', async () => {
    const id = await workOrder();
    const good = payload();
    const missing = key => Object.fromEntries(Object.entries(good).filter(([name]) => name !== key));
    for (const invalid of [
      null, [], missing('mode'), missing('userTypedNum'), missing('salesTax'), missing('lines'),
      { ...good,num: 123 }, { ...good,cme: { hidden: 'Unexpected object' } },
      { ...good,storeAddress: 123 }, { ...good,terms: false }, { ...good,pdfStoragePath: [] },
      { ...good,lines: [good.lines[0],null] },
      { ...good,lines: [good.lines[0],{ ...good.lines[1],qty: '2' }] },
      { ...good,lines: [{ ...good.lines[0],qty: 0 }] },
      { ...good,lines: [{ ...good.lines[0],rate: -1 }] },
      { ...good,lines: [{ ...good.lines[0],qty: 100000000000 }] },
      { ...good,lines: [{ ...good.lines[0],rate: 'Infinity' }] },
      { ...good,salesTax: '0' },
      { ...good,invoiceDate: '2026-02-30' },
      { ...good,userTypedNum: 'false' },
      { ...good,totalOverride: 9999 },
      { ...good,mode: 'unknown' },
      { ...good,contractorId: actors.outsider },
    ]) {
      const before = await snapshot(id);
      await rejectFinancialCall(async () => command('submit',actors.contractor,await context(id),invalid), ['22023','22003','22007','22008','23514']);
      assert.deepEqual(await snapshot(id),before);
    }
  });

  const authorized = [
    ['standalone',actors.contractor,actors.contractor,null],
    ['company administrator',actors.admin,actors.canonical,actors.invoice],
    ['current invoice-capable member',actors.invoice,actors.canonical,actors.invoice],
  ];
  for (const [label,actor,owner,technician] of authorized) {
    await check(`${label} can submit only in its current authorized company/assignment`, async () => {
      const id = await workOrder({ owner,technician });
      assert.equal((await command('submit',actor,await context(id),payload())).applied,true);
      const other = await workOrder({ owner: actors.outsider });
      await rejectFinancialCall(async () => command('submit',actor,await context(other),payload()), ['42501']);
    });
  }
  for (const [label,actor,role] of [
    ['anonymous',null,'anon'],['inactive contractor',actors.inactiveContractor,'authenticated'],
    ['inactive staff',actors.inactive,'authenticated'],['operational staff',actors.mgr,'authenticated'],
    ['invoice controller',actors.controller,'authenticated'],['handoff grantee',actors.handoff,'authenticated'],
    ['report-only technician',actors.report,'authenticated'],['unassigned member',actors.unassigned,'authenticated'],
    ['former member',actors.former,'authenticated'],['other company',actors.outsider,'authenticated'],
  ]) {
    await check(`${label} cannot invoke contractor financial command on another assignment`, async () => {
      const id = await workOrder({ owner: actors.canonical,technician: actors.report });
      if (actor === actors.former) {
        await db.query('update public.work_orders set assigned_technician_profile_id=$2 where id=$1',[id,actors.former]);
        await db.query('update public.work_orders set assigned_technician_profile_id=$2 where id=$1',[id,actors.report]);
      }
      const before = await snapshot(id);
      await rejectFinancialCall(async () => command('submit',actor,await context(id),payload(),role), ['42501']);
      assert.deepEqual(await snapshot(id),before);
    });
  }

  await check('raw financial header and line mutations deny every browser role while authorized read remains', async () => {
    const id = await workOrder({ owner: actors.canonical,technician: actors.invoice });
    const saved = await command('draft',actors.invoice,await context(id),payload());
    const line = (await document(saved.invoiceId)).lines[0];
    const otherId = await workOrder({ owner: actors.canonical,technician: actors.invoice });
    await rejectFinancialCall(async () => command('draft',actors.invoice,await context(otherId,saved.invoiceId),payload()), ['42501','22023','PT409']);
    for (const [role,actor] of [
      ['anon',null], ...Object.values(actors).map(actor => ['authenticated',actor]),
    ]) {
      for (const [query,values] of [
        ["update public.invoices set subtotal=9999,total=9999,state='submitted' where id=$1 returning id",[saved.invoiceId]],
        ["update public.invoices set state='approved' where id=$1 returning id",[saved.invoiceId]],
        ["update public.invoices set contractor_id=$2,work_order_id=$3 where id=$1 returning id",[saved.invoiceId,actors.outsider,id]],
        ['update public.invoices set work_order_id=$2 where id=$1 returning id',[saved.invoiceId,otherId]],
        ["update public.invoices set submission_key=$2 where id=$1 returning id",[saved.invoiceId,randomUUID()]],
        ["update public.invoices set deleted_at=now(),deleted_by=$2 where id=$1 returning id",[saved.invoiceId,actors.mgr]],
        ['update public.invoice_lines set rate=999 where id=$1 returning id',[line.id]],
        ['delete from public.invoice_lines where id=$1 returning id',[line.id]],
      ]) await assertRawFinancialDenied({ as,actor,role,query,values,snapshot: () => snapshot(id) });
    }
    assert.equal((await as('authenticated',actors.invoice,tx => tx.query('select id from public.invoices where id=$1',[saved.invoiceId]))).rows.length,1);
  });

  await check('raw contractor invoice insert and protected line insert are denied', async () => {
    const id = await workOrder();
    const saved = await command('draft',actors.contractor,await context(id),payload());
    await assertRawFinancialDenied({ as,actor: actors.contractor,
      query: "insert into public.invoices(num,work_order_id,contractor_id,invoice_type,invoice_date,state,total) values ('RAW-FINAL',$1,$2,'contractor',current_date,'draft',9999) returning id",
      values: [id,actors.contractor],snapshot: () => snapshot(id) });
    await assertRawFinancialDenied({ as,actor: actors.contractor,
      query: "insert into public.invoice_lines(invoice_id,position,type,description,qty,rate) values ($1,99,'Other','Forged line',1,9999) returning id",
      values: [saved.invoiceId],snapshot: () => snapshot(id) });
  });

  for (const [table,operation,condition] of [
    ['invoices','update','true'],['invoice_lines','delete','true'],
    ['invoice_lines','insert','new.position = 1'],['invoice_lines','insert','new.position = 2'],
    ['activities','insert','true'],
  ]) {
    await check(`draft replacement rollback after ${table} ${operation} ${condition}`, async () => {
      const id = await workOrder();
      const input = payload();
      const saved = await command('draft',actors.contractor,await context(id),input);
      const args = await context(id,saved.invoiceId);
      const before = await snapshot(id);
      const replacement = { ...input,terms: 'Net 15',lines: input.lines.map(line => ({ ...line,rate: line.rate + 1 })) };
      await withFinancialWriteFailure(db,{ table,operation,condition },async () => {
        await rejectFinancialCall(() => command('draft',actors.contractor,args,replacement), ['P0001']);
        assert.deepEqual(await snapshot(id),before);
      });
      assert.equal((await command('draft',actors.contractor,args,replacement)).applied,true);
    });
  }

  for (const [table,operation] of [
    ['invoice_financial_operations','insert'],['invoices','insert'],
    ['invoice_lines','insert'],['work_orders','update'],
    ['activities','insert'],['invoice_financial_operations','update'],
  ]) {
    await check(`new contractor submit rollback after ${table} ${operation} preserves all state and replay identity`, async () => {
      const id = await workOrder();
      const input = payload();
      const args = await context(id);
      const before = await snapshot(id);
      await withFinancialWriteFailure(db,{ table,operation },async () => {
        await rejectFinancialCall(() => command('submit',actors.contractor,args,input), ['P0001']);
        assert.deepEqual(await snapshot(id),before);
      });
      assert.equal((await command('submit',actors.contractor,args,input)).applied,true);
      assert.equal((await snapshot(id)).guards.length,0, 'No usable transaction capability may survive success');
    });
  }
}
