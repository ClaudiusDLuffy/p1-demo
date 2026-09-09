// In-memory synthetic SQL only. No env-file reads, database URLs or deployments.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  initializeWarrantyDatabase, warrantyMigrationSources, applyWarrantyFixtureMigration, asWarrantyActor, migrationStatements,
  assertWarrantyMigrationOrder, WARRANTY_MIGRATION_NAME,
} from './warranty-billing-test-support.mjs';

if (!process.env.P1_SQL_TEST_ENGINE_DIR) throw new Error('Set P1_SQL_TEST_ENGINE_DIR to the approved existing isolated PGlite installation.');
const requireEngine = createRequire(resolve(process.env.P1_SQL_TEST_ENGINE_DIR, 'package.json'));
const { PGlite } = requireEngine('@electric-sql/pglite');
const { pg_trgm } = requireEngine('@electric-sql/pglite/contrib/pg_trgm');
const { pgcrypto } = requireEngine('@electric-sql/pglite/contrib/pgcrypto');
const repo = fileURLToPath(new URL('../', import.meta.url));
const stabilizationRef = process.argv.find(arg => arg.startsWith('--stabilization-ref='))?.split('=')[1];
const baselineOnly = process.argv.includes('--baseline-only');
const migrationPlan = warrantyMigrationSources(repo, stabilizationRef);
const db = new PGlite({ extensions: { pg_trgm, pgcrypto } });
let passed = 0;
const check = async (name, run) => { await run(); passed++; console.log(`PASS ${name}`); };
const manager = '73000000-0000-4000-8000-000000000001';
const workOrder = 'WOT9900100';
const as = asWarrantyActor(db);
let sequence = 0;
let stabilized = false;
const line = (patch = {}) => ({ type: 'Warranty', description: 'Synthetic warranty service', qty: 1, rate: 0, is_taxable: false, ...patch });
async function request(lines, {
  id = null, tax = 0, state = 'draft', role = 'service_role', actor = null,
  operation = randomUUID(), num = `P1-WARRANTY-${++sequence}`, invoiceVersion,
} = {}) {
  if (!stabilized) return () => as(role, actor, tx => tx.query(`select public.save_staff_billing_invoice_v3(
      $1,$2,$3,$4,'99999','Synthetic address',null,date '2026-09-09',null,null,
      'Net 60',$5,$6,null,null,'Synthetic territory','7-ELEVEN: Miscellaneous',$7,'{}'::uuid[]) id`,
  [manager, id, num, workOrder, state, tax, JSON.stringify(lines)]));
  const parent = (await db.query('select contractor_assignment_version,workflow_cycle from public.work_orders where id=$1', [workOrder])).rows[0];
  const version = invoiceVersion ?? (id ? (await db.query('select invoice_version from public.invoices where id=$1', [id])).rows[0].invoice_version : null);
  const payload = {
    num, userTypedNum: true, storeNumber: '99999', storeAddress: 'Synthetic address', cme: null,
    invoiceDate: '2026-09-09', serviceDate: null, dueDate: null, terms: 'Net 60', state,
    taxMode: tax ? 'manual_amount' : 'none', salesTaxOverride: tax || null, taxRateOverride: null,
    taxState: null, territory: 'Synthetic territory', equipmentTag: '7-ELEVEN: Miscellaneous',
    lines: lines.map(item => ({
      type: item.type, description: item.description, qty: item.qty, rate: item.rate, isTaxable: item.is_taxable,
      sourceInvoiceLineId: item.source_invoice_line_id ?? null,
      sourceWorkOrderPartId: item.source_work_order_part_id ?? null,
      sourceUnitCost: item.source_unit_cost ?? null, markupPercent: item.markup_percent ?? null,
    })), sourceInvoiceIds: [],
  };
  return () => as(role, actor, tx => tx.query(`select public.save_staff_billing_invoice_v4($1,$2,$3,$4,$5,$6,$7,$8) result`, [
    manager, workOrder, parent.contractor_assignment_version, parent.workflow_cycle, id, version, operation, JSON.stringify(payload),
  ]));
}
async function save(lines, options) {
  const result = await (await request(lines, options))();
  return result.rows[0].id ?? result.rows[0].result.invoiceId;
}
async function snapshot() {
  const rows = {};
  for (const table of ['invoices', 'invoice_lines', 'staff_invoice_sources', 'activities', 'work_orders', ...(stabilized ? ['invoice_financial_operations'] : [])]) {
    rows[table] = (await db.query(`select to_jsonb(row) data from public.${table} row order by to_jsonb(row)::text`)).rows;
  }
  return rows;
}
const noInvoiceWrites = async (run, codes = ['22023', '22003']) => {
  const before = await snapshot();
  await assert.rejects(run, error => codes.includes(error.code), `Expected one of ${codes.join(', ')}`);
  assert.deepEqual(await snapshot(), before);
};

async function assertInvoice(id, { subtotal, tax = 0, state = 'draft', count = 1 }) {
  const header = (await db.query('select subtotal,sales_tax,total,state,invoice_type from public.invoices where id=$1', [id])).rows[0];
  assert.equal(header.invoice_type, 'staff');
  assert.equal(header.state, state);
  assert.equal(Number(header.subtotal), subtotal);
  assert.equal(Number(header.sales_tax), tax);
  assert.equal(Number(header.total), subtotal + tax);
  const lines = (await db.query('select qty,rate,amount,position from public.invoice_lines where invoice_id=$1 order by position', [id])).rows;
  assert.equal(lines.length, count);
  assert.ok(lines.every(item => Number(item.qty) > 0));
  assert.equal(lines.reduce((sum, item) => sum + Number(item.amount), 0), subtotal);
  const evidence = (await db.query("select event_data from public.activities where event_key='staff_billing' and event_data->>'invoiceId'=$1 order by created_at desc,id desc", [id])).rows;
  assert.ok(evidence.some(item => Number(item.event_data.subtotal) === subtotal && Number(item.event_data.total) === subtotal + tax && item.event_data.lineCount === count));
}

async function routineMetadata() {
  return (await db.query(`select oid,proname,proowner,prosecdef,provolatile,proconfig,proacl
    from pg_proc where pronamespace='public'::regnamespace
    and proname in ('save_staff_billing_invoice','save_staff_billing_invoice_v2','save_staff_billing_invoice_v3','save_staff_billing_invoice_v4','normalize_staff_invoice_payload')
    order by oid`)).rows;
}

async function injectFailure(table, operation, run) {
  await db.exec(`create function public.warranty_test_failure() returns trigger language plpgsql as $$
    begin raise exception 'Synthetic Warranty rollback fixture' using errcode='23514'; end $$;
    create trigger zz_warranty_test_failure after ${operation} on public.${table}
    for each row execute function public.warranty_test_failure();`);
  try { await noInvoiceWrites(run, ['23514']); }
  finally { await db.exec(`drop trigger zz_warranty_test_failure on public.${table}; drop function public.warranty_test_failure();`); }
}

try {
  const localNames = [...migrationPlan.base.map(([name]) => name), migrationPlan.warranty[0]];
  await check('dev adds only sequential Warranty 0122; the exact pre-existing historical 0029 pair is preserved', () => {
    assertWarrantyMigrationOrder(localNames);
    assert.equal(migrationPlan.warranty[0], WARRANTY_MIGRATION_NAME);
    assert.equal(migrationPlan.base.some(([name]) => Number.parseInt(name, 10) > 121), false);
  });
  await check('migration ordering rejects a new duplicate 0122 or a newly introduced sequence gap', () => {
    assert.throws(() => assertWarrantyMigrationOrder([...localNames, '0122_expand_authoritative_work_order_lifecycle.sql']), /duplicate migration version 122/);
    assert.throws(() => assertWarrantyMigrationOrder(localNames.filter(name => !name.startsWith('0121_'))), /sequential 0122/);
    assert.throws(() => assertWarrantyMigrationOrder([...localNames, '0029_unrelated_change.sql']), /duplicate migration version 29/);
  });
  if (migrationPlan.stabilization.length) {
    await check('preserved stabilization definitions are isolated from the dev release sequence, not sorted into a duplicate-0122 installation', () => {
      assert.equal(migrationPlan.stabilization.some(([name]) => name === WARRANTY_MIGRATION_NAME), false);
      assert.equal(migrationPlan.stabilization[0][0].startsWith('0122_'), true);
      assert.throws(() => assertWarrantyMigrationOrder([
        ...localNames, ...migrationPlan.stabilization.map(([name]) => name),
      ]), /duplicate migration version 122/);
    });
    console.log('DEFINITION-COMPATIBILITY FIXTURE ONLY: dev base <=0121 + unchanged preserved stabilization 0122–0132, then Warranty SQL. This is NOT a merged filename-order or Supabase-ledger installation. Future resequencing and a post-financial-expansion bridge are required.');
  }
  console.log('Historical note: committed dev already has two 0029 files; this harness preserves them and does not certify a clean Supabase migration ledger.');
  await initializeWarrantyDatabase(db);
  for (const [name, source] of [...migrationPlan.base, ...migrationPlan.stabilization]) {
    await applyWarrantyFixtureMigration(db, name, source);
  }
  stabilized = (await db.query("select to_regprocedure('public.normalize_staff_invoice_payload(jsonb)') is not null present")).rows[0].present;
  await db.query('insert into auth.users(id,email) values ($1,$2)', [manager, 'warranty-manager@example.invalid']);
  await db.query("update public.profiles set role='manager',active=true,name='Synthetic manager' where id=$1", [manager]);
  await db.query('insert into public.work_orders(id) values ($1)', [workOrder]);
  await check('baseline rejects a zero-rate Warranty line before any invoice/audit write', () => noInvoiceWrites(() => save([line()])));
  await check('baseline rejects mixed paid and zero Warranty lines atomically', () => noInvoiceWrites(() => save([
    line({ type: 'Labor', rate: 100 }), line(),
  ])));
  if (!baselineOnly) {
    const migration = migrationPlan.warranty;
    assert.ok(migration, 'Reviewed forward Warranty migration is required');
    const before = await routineMetadata();
    const originalDefinitions = (await db.query(`select proname,pg_get_functiondef(oid) definition from pg_proc
      where pronamespace='public'::regnamespace and proname in ('save_staff_billing_invoice','normalize_staff_invoice_payload')`)).rows;
    await check(`${migrationPlan.stabilization.length ? 'Warranty definition patch' : 'sequential 0122 forward migration'} applies and preserves function identity, grants, owner, search paths and security mode`, async () => {
      await applyWarrantyFixtureMigration(db, ...migration);
      assert.deepEqual(await routineMetadata(), before);
    });
    await check('reapplying the exact forward migration is idempotent without widening legacy execution', async () => {
      await applyWarrantyFixtureMigration(db, ...migration);
      assert.deepEqual(await routineMetadata(), before);
    });
    await check('an unknown routine shape aborts and rolls back the whole migration block', async () => {
      const definitionsBefore = (await db.query(`select oid,pg_get_functiondef(oid) definition from pg_proc
        where pronamespace='public'::regnamespace and proname in ('save_staff_billing_invoice','normalize_staff_invoice_payload') order by oid`)).rows;
      await assert.rejects(db.transaction(async tx => {
        for (const row of originalDefinitions) {
          const unknownShape = stabilized ? row.proname === 'normalize_staff_invoice_payload' : row.proname === 'save_staff_billing_invoice';
          const modified = unknownShape ? row.definition.replace(
            stabilized ? "or (line ->> 'rate')::numeric <= 0" : 'or coalesce(line.rate, 0) <= 0',
            stabilized ? "or (line ->> 'rate')::numeric < 0.01" : 'or coalesce(line.rate, 0) < 0.01',
          ) : row.definition;
          await tx.exec(modified);
        }
        const patchBlock = migrationStatements(migration[1]).find(statement => /do \$warranty_lines\$/.test(statement));
        assert.ok(patchBlock);
        await tx.exec(patchBlock);
      }), error => error.code === 'P0001' && /Unexpected staff billing function shape/.test(error.message));
      const definitionsAfter = (await db.query(`select oid,pg_get_functiondef(oid) definition from pg_proc
        where pronamespace='public'::regnamespace and proname in ('save_staff_billing_invoice','normalize_staff_invoice_payload') order by oid`)).rows;
      assert.deepEqual(definitionsAfter, definitionsBefore);
      assert.deepEqual(await routineMetadata(), before);
    });
    for (const state of ['draft', 'submitted']) await check(`zero-rate Warranty ${state} persists a complete zero-total invoice and matching audit`, async () => {
      await assertInvoice(await save([line()], { state }), { subtotal: 0, state, count: 1 });
    });
    await check('positive-rate Warranty retains existing arithmetic', async () => {
      await assertInvoice(await save([line({ qty: 2, rate: 12.25 })]), { subtotal: 24.5 });
    });
    await check('case/space normalized exact Warranty type permits zero without substring matching', async () => {
      await assertInvoice(await save([line({ type: ' warranty ' })]), { subtotal: 0 });
    });
    await check('mixed paid and zero Warranty lines preserve source order, subtotal, tax and final total', async () => {
      const id = await save([line({ type: 'Labor', rate: 100, qty: 1.25 }), line()], { tax: 10 });
      await assertInvoice(id, { subtotal: 125, tax: 10, count: 2 });
      const actual = (await db.query('select type,position from public.invoice_lines where invoice_id=$1 order by position', [id])).rows;
      assert.deepEqual(actual.map(item => item.type), ['Labor', 'Warranty']);
    });
    await check('editing an existing paid-rate draft to Warranty zero replaces complete header/lines and audit atomically', async () => {
      const id = await save([line({ type: 'Labor', rate: 75 })]);
      assert.equal(await save([line()], { id }), id);
      await assertInvoice(id, { subtotal: 0 });
    });
    for (const type of ['Labor', 'Parts', 'Travel', 'Truck Charge', 'Other', 'Warranty repair', 'Not Warranty']) {
      await check(`${type} zero rate is denied even with a Warranty description`, () => noInvoiceWrites(() => save([line({ type })])));
    }
    for (const [name, patch] of [
      ['negative rate', { rate: -1 }], ['negative sub-cent rate', { rate: -0.001 }],
      ['null rate', { rate: null }], ['NaN rate', { rate: 'NaN' }],
      ['positive infinite rate', { rate: 'Infinity' }], ['negative infinite rate', { rate: '-Infinity' }],
      ['zero quantity', { qty: 0 }], ['negative quantity', { qty: -1 }],
      ['null quantity', { qty: null }], ['NaN quantity', { qty: 'NaN' }],
      ['infinite quantity', { qty: 'Infinity' }], ['sub-cent zero-persisting quantity', { qty: 0.001 }],
      ['non-Warranty sub-cent zero-persisting rate', { type: 'Labor', rate: 0.001 }],
      ['null description', { description: null }], ['empty description', { description: '' }],
      ['space-only description', { description: '   ' }], ['whitespace-only description', { description: ' \t\n ' }],
    ]) await check(`Warranty exception rejects ${name} without any writes`, () => noInvoiceWrites(() => save([line(patch)])));
    await check('valid Travel blank-description behavior is preserved', async () => {
      await assertInvoice(await save([line({ type: 'Travel', description: '', rate: 10 })]), { subtotal: 10 });
    });
    await check('valid fractional quantity money rounding is unchanged', async () => {
      await assertInvoice(await save([line({ type: 'Labor', qty: 1.25, rate: 10.2 }), line()]), { subtotal: 12.75, count: 2 });
    });
    await check('Warranty cannot bypass selected-source invoice-line validation', () => noInvoiceWrites(() => save([line({ source_invoice_line_id: randomUUID() })]), ['23503']));
    await check('Warranty cannot reclassify a nonexistent P1 canonical part as a zero-price line', () => noInvoiceWrites(() => save([line({ source_work_order_part_id: randomUUID() })]), ['23514']));
    await check('recorded P1 part pricing remains canonical and cannot become zero through a Warranty label', async () => {
      const part = randomUUID();
      await db.query(`insert into public.wo_parts(id,work_order_id,description,qty)
        values ($1,$2,'Synthetic purchased part',1)`, [part, workOrder]);
      await as('authenticated', manager, tx => tx.query('select public.request_p1_part_order($1)', [part]));
      await as('authenticated', manager, tx => tx.query("select public.set_p1_part_order_status_with_cost($1,'ordered',100)", [part]));
      const sourced = { source_work_order_part_id: part, source_unit_cost: 100, markup_percent: 25 };
      await noInvoiceWrites(() => save([line(sourced)]), ['23514']);
      const id = await save([line({ ...sourced, type: 'Parts', rate: 125 }), line()]);
      await assertInvoice(id, { subtotal: 125, count: 2 });
      assert.equal((await db.query('select source_work_order_part_id from public.invoice_lines where invoice_id=$1 and type=\'Parts\'', [id])).rows[0].source_work_order_part_id, part);
    });
    await check('one invalid later line leaves a previously complete draft unchanged', async () => {
      const id = await save([line({ type: 'Labor', rate: 75 })]);
      await noInvoiceWrites(() => save([line(), line({ type: 'Labor', rate: 0 })], { id }));
    });
    for (const [table, operation] of [['invoices', 'insert'], ['invoice_lines', 'insert'], ['activities', 'insert']]) {
      await check(`failure after ${table} write rolls back Warranty creation and all audit/state`, () => injectFailure(table, operation, () => save([line()])));
    }
    await check('failure during replacement line insertion restores the previous header, lines and evidence', async () => {
      const id = await save([line({ type: 'Labor', rate: 55 })]);
      await injectFailure('invoice_lines', 'insert', () => save([line()], { id }));
    });
    await check('failure immediately after old-line deletion restores the complete draft', async () => {
      const id = await save([line({ type: 'Labor', rate: 55 })]);
      await injectFailure('invoice_lines', 'delete', () => save([line()], { id }));
    });
    for (const role of ['anon', 'authenticated']) {
      await check(`${role} cannot directly invoke the trusted staff billing RPC`, () => noInvoiceWrites(() => save([line()], { role, actor: manager }), ['42501']));
    }
    if (stabilized) {
      await check('Phase 3 operation replay returns the same Warranty invoice without duplicate financial evidence', async () => {
        const invoke = await request([line()], { state: 'submitted' });
        const first = (await invoke()).rows[0].result;
        const beforeReplay = await snapshot();
        const second = (await invoke()).rows[0].result;
        assert.equal(first.invoiceId, second.invoiceId);
        assert.equal(first.applied, true);
        assert.equal(second.applied, false);
        assert.equal(second.reason, 'already_applied');
        assert.deepEqual(await snapshot(), beforeReplay);
      });
      await check('Phase 3 changed Warranty payload cannot reuse an accepted operation identity', async () => {
        const operation = randomUUID(), num = `P1-WARRANTY-${++sequence}`;
        await save([line()], { operation, num });
        await noInvoiceWrites(() => save([line({ rate: 1 })], { operation, num }), ['PT409']);
      });
      await check('Phase 3 stale revision cannot overwrite a newer Warranty draft', async () => {
        const id = await save([line()]);
        const stale = await request([line({ rate: 1 })], { id });
        await save([line({ rate: 2 })], { id });
        await noInvoiceWrites(stale, ['PT409']);
      });
      await check('Phase 3 financial operation persistence failure rolls back Warranty state and audit', () => injectFailure('invoice_financial_operations', 'insert', () => save([line()])));
      await check('Phase 3 contraction still denies the service role old unguarded persistence entry points', async () => {
        const routines = (await db.query(`select oid,proname,has_function_privilege('service_role',oid,'EXECUTE') allowed
          from pg_proc where pronamespace='public'::regnamespace and proname in
          ('save_staff_billing_invoice','save_staff_billing_invoice_v2','save_staff_billing_invoice_v3')`)).rows;
        assert.equal(routines.length, 3);
        assert.ok(routines.every(item => item.allowed === false));
        await noInvoiceWrites(() => as('service_role', null, tx => tx.query(`select public.save_staff_billing_invoice_v3(
          $1,null,'P1-WARRANTY-RAW',$2,'99999','Synthetic address',null,date '2026-09-09',null,null,
          'Net 60','draft',0,null,null,'Synthetic territory','7-ELEVEN: Miscellaneous',$3,'{}'::uuid[])`,
        [manager, workOrder, JSON.stringify([line()])])), ['42501']);
      });
    }
  }
  console.log(`Warranty SQL ${baselineOnly ? 'baseline' : 'verification'} (${stabilized ? 'definition compatibility against preserved 0122–0132; NOT a deployable merged migration sequence' : 'dev 0121 → sequential Warranty 0122'}): ${passed} passed. SQL-only synthetic execution; no gateway or parallel-session claim.`);
} finally { await db.close(); }
