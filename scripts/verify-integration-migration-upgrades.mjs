// Final-chain synthetic clean install and both supported populated histories.
// Run with the syntheticSqlPrivacy preload; never point this at a remote DB.
// @ts-check
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createDatabase, repo } from './receiving-dispatch-test-support/fixtures.mjs';
import { readMigrationInventory } from './migration-inventory.mjs';
import { initializeLifecycleActors, actorTransactions, applyFixtureMigration } from './lifecycle-test-support/engine-fixtures.mjs';
import { migrationStatements } from './invoice-test-support/migration-statements.mjs';

const stabilization = '8300922fbd0c3affbd696bfc7bd511e2c9129ff3';
const upstream = '30abcca11817a95fd60f547f10e7726030e399da';
const names = readMigrationInventory(repo);
/** @param {string} name */
const number = name => Number(name.slice(0, 4));
/** @param {string | Buffer} value */
const hash = value => createHash('sha256').update(value).digest('hex');
/** @param {unknown} value */
const digest = value => hash(JSON.stringify(value));
const reports = [];
const upstreamNames = execFileSync('git', ['ls-tree', '-r', '--name-only', upstream, '--', 'supabase/migrations'],
  { cwd: repo, encoding: 'utf8' }).trim().split('\n');
for (const path of upstreamNames) assert.equal(hash(await readFile(`${repo}/${path}`)),
  hash(execFileSync('git', ['show', `${upstream}:${path}`], { cwd: repo })), `Historical upstream hash changed: ${path}`);
for (const name of names.filter(name => number(name) >= 123 && number(name) <= 147)) {
  const oldName = String(number(name) - 1).padStart(4, '0') + name.slice(4);
  assert.equal(hash(await readFile(`${repo}/supabase/migrations/${name}`)),
    hash(execFileSync('git', ['show', `${stabilization}:supabase/migrations/${oldName}`], { cwd: repo })),
    `Resequencing changed historical stabilization SQL: ${name}`);
}

const tables = ['invoices', 'invoice_lines', 'activities', 'work_orders', 'profiles', 'organizations', 'contractor_technicians'];
/** @typedef {{query(sql: string, parameters?: unknown[]): Promise<{rows: Record<string, unknown>[]}>, exec(sql: string): Promise<unknown>}} DatabasePort */
/** @typedef {Record<string, Record<string, unknown>[]>} DataSnapshot */
/** @param {DatabasePort} db @returns {Promise<DataSnapshot>} */
async function dataSnapshot(db) {
  /** @type {DataSnapshot} */
  const result = {};
  for (const table of tables) result[table] = (await db.query(`select to_jsonb(r) row from public.${table} r order by r.id`)).rows.map(item => {
    assert.ok(item.row && typeof item.row === 'object' && !Array.isArray(item.row));
    return Object.fromEntries(Object.entries(item.row));
  });
  return result;
}
/** @param {DataSnapshot} before @param {DataSnapshot} after */
function compareData(before, after) {
  const evidence = [];
  for (const table of tables) {
    assert.equal(after[table].length, before[table].length, `${table}: upgrade changed the populated row count`);
    const projected = after[table].map((row, index) => Object.fromEntries(Object.keys(before[table][index]).map(key => [key, row[key]])));
    assert.deepEqual(projected, before[table], `${table}: upgrade changed preexisting data`);
    evidence.push({ table, beforeCount: before[table].length, afterCount: after[table].length,
      beforeHash: digest(before[table]), afterOriginalColumnHash: digest(projected) });
  }
  return evidence;
}
/** @param {DatabasePort} db */
async function catalog(db) {
  return {
    functions: (await db.query(`select p.oid::regprocedure::text signature, pg_get_functiondef(p.oid) definition,
      pg_get_userbyid(p.proowner) owner,p.proacl::text acl from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.prokind='f' order by signature`)).rows,
    policies: (await db.query('select schemaname,tablename,policyname,permissive,roles,cmd,qual,with_check from pg_policies order by schemaname,tablename,policyname')).rows,
    indexes: (await db.query("select schemaname,tablename,indexname,indexdef from pg_indexes where schemaname in ('public','storage') order by schemaname,tablename,indexname")).rows,
    grants: (await db.query("select grantee,table_schema,table_name,privilege_type,is_grantable from information_schema.role_table_grants where table_schema in ('public','storage') order by table_schema,table_name,grantee,privilege_type")).rows,
  };
}
/** @param {DatabasePort} db @param {boolean} stabilized */
async function seedPaidInvoice(db, stabilized) {
  const actors = await initializeLifecycleActors(db);
  const as = actorTransactions(db);
  const id = 'WOTINTEGRATION01';
  await db.query('insert into public.work_orders(id) values ($1)', [id]);
  let invoice;
  if (!stabilized) invoice = (await as('service_role', null, /** @param {DatabasePort} tx */ tx => tx.query(`select public.save_staff_billing_invoice_v3(
    $1,null,'P1-INTEGRATION-1',$2,'99999','Synthetic address',null,date '2026-09-14',null,null,
    'Net 60','draft',0,null,null,'Synthetic territory','7-ELEVEN: Miscellaneous',$3,'{}'::uuid[]) id`,
  [actors.mgr, id, JSON.stringify([{ type: 'Labor', description: 'Synthetic paid work', qty: 1, rate: 10, is_taxable: false }])]))).rows[0].id;
  else {
    const payload = { num: 'P1-INTEGRATION-1', userTypedNum: true, storeNumber: '99999', storeAddress: 'Synthetic address', cme: null,
      invoiceDate: '2026-09-14', serviceDate: null, dueDate: null, terms: 'Net 60', state: 'draft', taxMode: 'none', salesTaxOverride: null,
      taxRateOverride: null, taxState: null, territory: 'Synthetic territory', equipmentTag: '7-ELEVEN: Miscellaneous',
      lines: [{ type: 'Labor', description: 'Synthetic paid work', qty: 1, rate: 10, isTaxable: false,
        sourceInvoiceLineId: null, sourceWorkOrderPartId: null, sourceUnitCost: null, markupPercent: null }], sourceInvoiceIds: [] };
    const result = (await as('service_role', null, /** @param {DatabasePort} tx */ tx => tx.query('select public.save_staff_billing_invoice_v4($1,$2,0,0,null,null,$3,$4) result',
      [actors.mgr, id, randomUUID(), JSON.stringify(payload)]))).rows[0].result;
    assert.ok(result && typeof result === 'object' && 'invoiceId' in result);
    invoice = result.invoiceId;
  }
  assert.equal((await db.query('select total from public.invoices where id=$1', [invoice])).rows[0].total, '10.00');
}

/** @type {Awaited<ReturnType<typeof catalog>> | undefined} */
let expectedCatalog;
for (const mode of ['clean', 'canonical-upstream-populated', 'stabilization-populated']) {
  const db = await createDatabase();
  /** @type {string[]} */
  const applied = [];
  /** @param {string} name */
  const apply = async name => {
    assert.ok(!applied.includes(name), `Migration executed twice: ${name}`);
    await applyFixtureMigration({ db, repo, name, statements: migrationStatements }); applied.push(name);
  };
  try {
    let before;
    if (mode === 'clean') for (const name of names) await apply(name);
    else if (mode === 'canonical-upstream-populated') {
      for (const name of names.filter(name => number(name) <= 122)) await apply(name);
      await seedPaidInvoice(db, false); before = await dataSnapshot(db);
      for (const name of names.filter(name => number(name) > 122)) await apply(name);
    } else {
      // Reproduce the byte-identical stabilization schema without the newer
      // upstream 0122, using the explicit local-only old-to-new filename map.
      for (const name of names.filter(name => number(name) !== 122 && number(name) <= 147)) await apply(name);
      await seedPaidInvoice(db, true); before = await dataSnapshot(db);
      await apply('0122_allow_zero_rate_staff_warranty_lines.sql');
      await apply('0148_bridge_authoritative_staff_warranty_lines.sql');
      await apply('0149_harden_application_table_capabilities.sql');
      await apply('0150_restore_multi_admin_private_object_access.sql');
      await apply('0151_hoist_staff_profile_read_authorization.sql');
    }
    assert.equal(applied.length, 152);
    assert.deepEqual(applied.filter(name => name.startsWith('0029_')), ['0029_add_p5_priority.sql', '0029_invoice_type.sql']);
    const observedCatalog = await catalog(db);
    if (expectedCatalog) assert.deepEqual(observedCatalog, expectedCatalog, `${mode}: final functions/policies/indexes/grants differ`);
    else expectedCatalog = observedCatalog;
    const integrity = before ? compareData(before, await dataSnapshot(db)) : [];
    const report = { mode, applied, migrationCount: applied.length, duplicate0029Executions: [1, 1],
      upstreamHistoricalHashes: upstreamNames.length, stabilizationHistoricalHashes: 25,
      schemaHash: digest(observedCatalog), integrity, passed: true };
    reports.push(report); console.log(JSON.stringify(report));
  } finally { await db.close(); }
}
assert.equal(reports.length, 3);
console.log('PASS final clean install and both populated schema upgrades: identical final catalog, historical data retained, exact 0029 pair once per path');
