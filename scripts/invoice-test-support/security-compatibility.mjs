import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { rejectFinancialCall } from './transaction-tools.mjs';

export async function captureFinancialSchemaBaseline(db) {
  return {
    routines: new Set((await db.query(`select p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' identity
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'`)).rows.map(row => row.identity)),
    tables: new Set((await db.query("select tablename from pg_tables where schemaname='public'")).rows.map(row => row.tablename)),
  };
}

export async function verifyFinancialSecurityAndCompatibility(fixture,check,baseline,{ guardFixtureOnly = false } = {}) {
  const { db,as,actors,workOrder,context,payload,command,snapshot,document,lifecycle } = fixture;
  const browserCommands = ['save_contractor_invoice_draft_v1','submit_contractor_invoice_v1','revise_contractor_invoice_v1','delete_own_contractor_invoice_v1','mark_work_order_ready_for_billing_v1'];
  const serviceCommands = ['save_staff_billing_invoice_v4','delete_invoice_admin_v1'];
  // The invoker-only page adapter must call its old read implementation with
  // unchanged RLS. This is an intentional read surface, never a private writer.
  const readCompatibilityCommands = ['list_contractor_invoices_page_pre_financial_version'];
  await check('invoice cursor pages retain RLS and expose current invoice/assignment versions for editing', async () => {
    const id = await workOrder();
    const args = await context(id);
    const invoice = await command('draft',actors.contractor,args,payload());
    const page = (await as('authenticated',actors.contractor,tx => tx.query(
      "select public.list_contractor_invoices_page(p_work_order_id=>$1,p_limit=>1) page",[id]))).rows[0].page;
    assert.equal(page.items.length,1);
    assert.equal(page.items[0].id,invoice.invoiceId);
    assert.equal(Number(page.items[0].invoice_version),invoice.invoiceVersion);
    assert.equal(page.items[0].contractor_assignment_version,args[1]);
    assert.equal(page.items[0].workflow_cycle,args[2]);
    assert.equal(page.hasMore,false);
    const outsider = (await as('authenticated',actors.outsider,tx => tx.query(
      "select public.list_contractor_invoices_page(p_work_order_id=>$1,p_limit=>1) page",[id]))).rows[0].page;
    assert.deepEqual(outsider.items,[]);
  });
  await check('new financial routines pin search paths and expose only deliberately granted public commands', async () => {
    const routines = (await db.query(`select p.oid,p.proname,p.prosecdef,p.proconfig,
      p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' identity,
      has_function_privilege('anon',p.oid,'EXECUTE') anon,
      has_function_privilege('authenticated',p.oid,'EXECUTE') authenticated,
      has_function_privilege('service_role',p.oid,'EXECUTE') service
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'`)).rows;
    const added = routines.filter(row => !baseline.routines.has(row.identity));
    assert.ok(added.length >= 6);
    for (const row of added) {
      assert.equal(row.anon,false, `${row.proname} must not expose anonymous execution`);
      if (row.prosecdef) assert.ok(row.proconfig?.some(value => value === 'search_path=public, pg_temp'), `${row.proname} must pin public,pg_temp`);
      const compatibleRead = readCompatibilityCommands.includes(row.proname);
      if (compatibleRead) assert.equal(row.prosecdef,false, 'Read compatibility must preserve caller RLS');
      assert.equal(row.authenticated,browserCommands.includes(row.proname) || compatibleRead, `${row.proname} browser grant must be deliberate`);
      assert.equal(row.service,serviceCommands.includes(row.proname) || compatibleRead, `${row.proname} service grant must be deliberate`);
    }
  });

  await check('private financial ledger/capability/control tables are inaccessible and RLS enabled', async () => {
    const tables = (await db.query(`select c.relname,c.relrowsecurity,
      has_table_privilege('anon',c.oid,'SELECT,INSERT,UPDATE,DELETE') anon,
      has_table_privilege('authenticated',c.oid,'SELECT,INSERT,UPDATE,DELETE') authenticated,
      has_table_privilege('service_role',c.oid,'SELECT,INSERT,UPDATE,DELETE') service
      from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where n.nspname='public' and c.relkind='r'`)).rows.filter(row => !baseline.tables.has(row.relname));
    assert.ok(tables.length >= 3, 'Expected private operation, capability and staged-control relations');
    for (const row of tables) {
      assert.equal(row.relrowsecurity,true, `${row.relname} RLS must be enabled`);
      assert.equal(row.anon,false); assert.equal(row.authenticated,false); assert.equal(row.service,false);
      for (const role of ['anon','authenticated','service_role']) {
        await rejectFinancialCall(() => as(role,role === 'authenticated' ? actors.mgr : null,
          tx => tx.query(`select * from public.${row.relname}`)), ['42501']);
      }
    }
  });

  if (guardFixtureOnly) {
    console.log('UNVERIFIED synthetic guard mode: actual contraction execution-grant changes are not installed');
  } else await check('obsolete unversioned financial mutation entry points are unavailable after contraction', async () => {
    for (const signature of [
      'public.submit_contractor_invoice_once(uuid,text,text,boolean,text,text,date,date,date,text,numeric,numeric,jsonb)',
      'public.resubmit_rejected_contractor_invoice(uuid,text,text,date,date,text,numeric,numeric,jsonb,text)',
      'public.delete_own_contractor_invoice(uuid)',
      'public.save_staff_billing_invoice(uuid,uuid,text,text,text,text,text,date,date,date,text,text,numeric,text,numeric,text,jsonb,uuid[])',
      'public.save_staff_billing_invoice_v2(uuid,uuid,text,text,text,text,text,date,date,date,text,text,numeric,text,numeric,text,jsonb,uuid[])',
      'public.save_staff_billing_invoice_v3(uuid,uuid,text,text,text,text,text,date,date,date,text,text,numeric,text,numeric,text,text,jsonb,uuid[])',
    ]) {
      const row = (await db.query(`select has_function_privilege('authenticated',$1,'EXECUTE') browser,
        has_function_privilege('service_role',$1,'EXECUTE') service`,[signature])).rows[0];
      assert.deepEqual(row,{ browser: false,service: false },`${signature} must not remain an alternate bypass`);
    }
  });

  await check('caller-set legacy/new session flags cannot authorize raw protected financial writes', async () => {
    const id = await workOrder();
    const invoice = await command('draft',actors.contractor,await context(id),payload());
    const before = await snapshot(id);
    await rejectFinancialCall(() => as('authenticated',actors.contractor,async tx => {
      await tx.exec(`select set_config('app.contractor_invoice_transition','resubmit',true),
        set_config('app.contractor_invoice_delete_transition','delete_own',true),
        set_config('app.invoice_financial_transition','submit',true),
        set_config('app.invoice_financial_capability','true',true),
        set_config('app.work_order_lifecycle_transition','complete',true)`);
      await tx.query("update public.invoices set state='submitted',total=9999 where id=$1", [invoice.invoiceId]);
    }), ['42501']);
    assert.deepEqual(await snapshot(id),before);
  });

  await check('raw parent financial total and queue promotion cannot bypass the owning invoice command', async () => {
    const id = await workOrder();
    await command('submit',actors.contractor,await context(id),payload());
    await as('authenticated',actors.contractor,tx => tx.query('select public.finish_contractor_invoicing($1)',[id]));
    assert.equal((await snapshot(id)).parent.status,'pending_approval');
    const before = await snapshot(id);
    for (const actor of [actors.contractor,actors.mgr,actors.controller]) {
      for (const sql of [
        'update public.work_orders set invoice_total=9999 where id=$1',
        "update public.work_orders set status='pending_invoice' where id=$1",
        "update public.work_orders set status='pending_payment' where id=$1",
      ]) {
        await rejectFinancialCall(() => as('authenticated',actor,tx => tx.query(sql,[id])), ['42501']);
        assert.deepEqual(await snapshot(id),before);
      }
    }
  });

  await check('staff billing-ready parent command preserves current labels while enforcing versions, replay and role', async () => {
    const id = await workOrder();
    const args = await lifecycle.context(id);
    const call = (actor,values = args,role = 'authenticated') => as(role,actor,
      tx => tx.query('select public.mark_work_order_ready_for_billing_v1($1,$2,$3,$4,$5) result',values));
    for (const actor of [actors.contractor,actors.controller,actors.inactive,actors.report,actors.outsider]) {
      await rejectFinancialCall(() => call(actor), ['42501']);
    }
    await rejectFinancialCall(() => call(null,args,'anon'), ['42501']);
    const ready = (await call(actors.mgr)).rows[0].result;
    assert.equal(ready.applied,true);
    assert.equal((await snapshot(id)).parent.status,'pending_invoice');
    const before = await snapshot(id);
    assert.equal((await call(actors.mgr)).rows[0].result.reason,'already_applied');
    assert.deepEqual(await snapshot(id),before);
    assert.ok(before.activities.some(activity => activity.event_key === 'staff_billing'
      && activity.text === '7-Eleven portal updated. Moved to Pending 7-Eleven Submission.'));
    await rejectFinancialCall(() => call(actors.mgr,[...args.slice(0,4),randomUUID()]), ['PT409']);
    const other = await workOrder();
    await rejectFinancialCall(async () => call(actors.mgr,await lifecycle.context(other,args[4])), ['PT409']);
    const open = await lifecycle.workOrder();
    await rejectFinancialCall(async () => call(actors.mgr,await lifecycle.context(open)), ['PT409','23514']);
    await rejectFinancialCall(async () => fixture.staffCommand(actors.mgr,await context(id,null,args[4]),fixture.staffPayload()), ['PT409']);
  });

  await check('review/rejection, versioned resubmission and operational correction retain controller restrictions', async () => {
    const id = await workOrder();
    const input = payload();
    const submitted = await command('submit',actors.contractor,await context(id),input);
    await as('authenticated',actors.mgr,tx => tx.query("select public.review_contractor_invoice($1,'reject','Synthetic correction request')", [submitted.invoiceId]));
    const rejected = await document(submitted.invoiceId);
    assert.equal(rejected.header.state,'rejected');
    const beforeRenumber = await snapshot(id);
    await rejectFinancialCall(async () => command('revise',actors.contractor,
      await context(id,submitted.invoiceId),{ ...input,num: 'FORBIDDEN-RENUMBER' }), ['22023','PT409','42501']);
    assert.deepEqual(await snapshot(id),beforeRenumber, 'Rejected correction must retain its invoice number and identity');
    const revised = await command('revise',actors.contractor,await context(id,submitted.invoiceId),input);
    assert.equal(revised.invoiceId,submitted.invoiceId);
    assert.equal(revised.state,'revised');
    assert.equal(Number((await document(submitted.invoiceId)).header.review_revision),Number(rejected.header.review_revision)+1);
    await as('authenticated',actors.mgr,tx => tx.query("select public.review_contractor_invoice($1,'approve',null)", [submitted.invoiceId]));
    assert.equal((await document(submitted.invoiceId)).header.state,'approved');
    await rejectFinancialCall(() => as('authenticated',actors.controller,tx => tx.query(
      "select public.correct_contractor_invoice_total($1,75.55,'Synthetic existing controller restriction')", [submitted.invoiceId])), ['42501']);
    await as('authenticated',actors.mgr,tx => tx.query("select public.correct_contractor_invoice_total($1,75.55,'Synthetic supported correction')", [submitted.invoiceId]));
    assert.equal(Number((await document(submitted.invoiceId)).header.total),75.55);
    const afterCorrection = await snapshot(id);
    for (const amount of ['NaN','Infinity','-Infinity']) {
      await rejectFinancialCall(() => as('authenticated',actors.controller,
        tx => tx.query("select public.correct_contractor_invoice_total($1,$2::numeric,'Synthetic invalid value')",[submitted.invoiceId,amount])), ['22023']);
      assert.deepEqual(await snapshot(id),afterCorrection);
    }
    assert.ok((await snapshot(id)).activities.some(activity => activity.event_key === 'contractor_invoice_total_corrected'));
  });

  await check('payment hold/release and PDF association retain their existing command boundaries', async () => {
    const id = await workOrder();
    const invoice = await command('submit',actors.contractor,await context(id),payload());
    await as('authenticated',actors.contractor,tx => tx.query('select public.attach_contractor_invoice_pdf($1,$2)',
      [invoice.invoiceId,`${invoice.invoiceId}/synthetic.pdf`]));
    assert.ok((await document(invoice.invoiceId)).header.pdf_storage_path.endsWith('/synthetic.pdf'));
    await as('authenticated',actors.mgr,tx => tx.query("select public.review_contractor_invoice($1,'approve',null)",[invoice.invoiceId]));
    await as('service_role',null,tx => tx.query("select public.place_contractor_invoice_payment_hold($1,$2,'Synthetic payment hold')", [invoice.invoiceId,actors.mgr]));
    assert.equal((await db.query('select count(*)::int n from public.contractor_invoice_payment_holds where invoice_id=$1',[invoice.invoiceId])).rows[0].n,1);
    await as('service_role',null,tx => tx.query("select public.release_contractor_invoice_payment_hold($1,$2,'Synthetic release')", [invoice.invoiceId,actors.handoff]));
    assert.equal((await db.query('select count(*)::int n from public.contractor_invoice_payment_holds where invoice_id=$1',[invoice.invoiceId])).rows[0].n,0);
  });

  await check('staff rejection retraction preserves its approved-invoice audit and parent behavior', async () => {
    const id = await workOrder();
    const invoice = await command('submit',actors.contractor,await context(id),payload());
    await as('authenticated',actors.mgr,tx => tx.query(
      "select public.review_contractor_invoice($1,'reject','Synthetic retractable correction')",[invoice.invoiceId]));
    const rejected = await document(invoice.invoiceId);
    await as('authenticated',actors.mgr,tx => tx.query(
      'select public.retract_contractor_invoice_rejection($1)',[invoice.invoiceId]));
    const approved = await document(invoice.invoiceId);
    assert.equal(approved.header.state,'approved');
    assert.ok(Number(approved.header.invoice_version) > Number(rejected.header.invoice_version));
    assert.ok((await snapshot(id)).activities.some(activity => activity.event_key === 'invoice_rejection_retracted'));
  });

  await check('manual contractor-bill handoff remains immutable and confirmation preserves parent lifecycle', async () => {
    const id = await workOrder();
    const invoice = await command('submit',actors.contractor,await context(id),payload());
    await as('authenticated',actors.mgr,tx => tx.query("select public.review_contractor_invoice($1,'approve',null)",[invoice.invoiceId]));
    const updatedAt = (await db.query('select updated_at::text from public.invoices where id=$1',[invoice.invoiceId])).rows[0].updated_at;
    const batch = randomUUID();
    const archiveHash = 'a'.repeat(64);
    await as('service_role',null,tx => tx.query('select public.stage_contractor_bill_handoff($1,$2,$3,$4,$5,$6,$7)',
      [batch,actors.handoff,`synthetic/${batch}.zip`,JSON.stringify([{ invoiceId: invoice.invoiceId,updatedAt }]),archiveHash,100,'reference_manifest_v2']));
    await rejectFinancialCall(() => as('authenticated',actors.mgr,tx => tx.query(
      "select public.correct_contractor_invoice_total($1,99,'Synthetic prohibited pending-handoff edit')",[invoice.invoiceId])), ['55000','23514','PT409']);
    const beforeParent = (await snapshot(id)).parent.status;
    await as('service_role',null,tx => tx.query('select public.confirm_controller_invoice_export($1,$2)',[batch,actors.handoff]));
    const current = await document(invoice.invoiceId);
    assert.equal(current.header.state,'paid');
    assert.ok(current.header.qbo_synced_at);
    assert.equal((await snapshot(id)).parent.status,beforeParent, 'QuickBooks entry must not close or restart field work');
    const item = (await db.query('select total::text from public.controller_invoice_export_items where batch_id=$1',[batch])).rows[0];
    assert.equal(item.total,'18.89');
    assert.equal((await as('service_role',null,tx => tx.query('select public.confirm_controller_invoice_export($1,$2) result',[batch,actors.handoff]))).rows[0].result.reason,'already_confirmed');
  });

  await check('final financial schema preserves lifecycle command authority and advanced invoice status on completion', async () => {
    const id = await lifecycle.workOrder();
    await lifecycle.command('eta',actors.contractor,await lifecycle.context(id));
    await lifecycle.command('start',actors.contractor,await lifecycle.context(id));
    await lifecycle.command('pause',actors.contractor,await lifecycle.context(id));
    await lifecycle.command('resume',actors.contractor,await lifecycle.context(id));
    // Owner-seeded advanced queue is a synthetic legacy positive control, not
    // an application write path granted by the financial capability.
    await db.query("update public.work_orders set status='pending_approval' where id=$1",[id]);
    await lifecycle.command('complete',actors.contractor,await lifecycle.context(id));
    const parent = (await snapshot(id)).parent;
    assert.equal(parent.status,'pending_approval');
    assert.equal(parent.functional_status,'Completed');
    await rejectFinancialCall(() => as('authenticated',actors.contractor,tx => tx.query("update public.work_orders set status='wip',functional_status='Work in Progress' where id=$1",[id])), ['42501']);
  });

  await check('later invoice changes cannot turn an old operation replay into false success', async () => {
    const id = await workOrder();
    const input = payload();
    const args = await context(id);
    const invoice = await command('draft',actors.contractor,args,input);
    await command('draft',actors.contractor,await context(id,invoice.invoiceId),{ ...input,terms: 'Net 15' });
    const before = await snapshot(id);
    await rejectFinancialCall(() => command('draft',actors.contractor,args,input), ['PT409']);
    assert.deepEqual(await snapshot(id),before);
    await rejectFinancialCall(() => command('draft',actors.contractor,[...args.slice(0,5),randomUUID()],{ ...input,num: (before.invoices[0].num) }), ['23505','PT409']);
  });

  await check('financial parent guards preserve a legitimate parts pause from an advanced invoice queue', async () => {
    const id = await lifecycle.workOrder();
    await lifecycle.command('eta',actors.contractor,await lifecycle.context(id));
    await lifecycle.command('start',actors.contractor,await lifecycle.context(id));
    await db.query("update public.work_orders set status='pending_approval' where id=$1",[id]);
    await lifecycle.command('pause',actors.contractor,await lifecycle.context(id));
    const parent = (await snapshot(id)).parent;
    assert.equal(parent.status,'parts');
    assert.equal(parent.functional_status,'Awaiting Parts');
  });
}
