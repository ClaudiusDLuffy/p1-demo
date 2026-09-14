import { readMigrationInventory } from "./migration-inventory.mjs";
// Synthetic in-memory PostgreSQL checks only. No dotenv, remote URL, gateway,
// customer fixture, network connection, deployment, or dependency installation.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, readdirSync } from 'node:fs';
import {
  initializeSupabaseFixtureDatabase, applyFixtureMigration,
  initializeLifecycleActors, actorTransactions,
} from './lifecycle-test-support/engine-fixtures.mjs';
import { migrationStatements } from './invoice-test-support/migration-statements.mjs';
import { reproduceLegacyInvoiceFindings } from './invoice-test-support/legacy-reproductions.mjs';
import { verifyLegacyFinancialPositiveControls } from './invoice-test-support/legacy-positive-controls.mjs';
import { createInvoiceCommandFixtures } from './invoice-test-support/command-fixtures.mjs';
import { verifyContractorFinancialCommands } from './invoice-test-support/contractor-acceptance.mjs';
import { verifyStaffFinancialCommands } from './invoice-test-support/staff-acceptance.mjs';
import { verifyFinancialDeleteAndEvidence } from './invoice-test-support/delete-evidence-acceptance.mjs';
import { verifyFinancialExpansionCommands } from './invoice-test-support/expansion-controls.mjs';
import { captureFinancialSchemaBaseline, verifyFinancialSecurityAndCompatibility } from './invoice-test-support/security-compatibility.mjs';
import { verifyLifecycleInterleavings } from './lifecycle-test-support/concurrency-compatibility.mjs';
process.on('uncaughtException', error => {
  console.error(`FATAL ${error.code || ''}: ${error.message}`);
  process.exit(1);
});

if (!process.env.P1_SQL_TEST_ENGINE_DIR) {
  throw new Error('Set P1_SQL_TEST_ENGINE_DIR to the approved isolated existing @electric-sql/pglite installation.');
}
const requireEngine = createRequire(resolve(process.env.P1_SQL_TEST_ENGINE_DIR, 'package.json'));
const { PGlite } = requireEngine('@electric-sql/pglite');
const { pg_trgm } = requireEngine('@electric-sql/pglite/contrib/pg_trgm');
const { pgcrypto } = requireEngine('@electric-sql/pglite/contrib/pgcrypto');
const repo = fileURLToPath(new URL('../', import.meta.url));
const migrationFiles = readMigrationInventory(repo).filter(name => /^\d+.*\.sql$/.test(name)).sort();
const migrationNumber = name => Number(name.match(/^\d+/)[0]);
const baselineOnly = process.argv.includes('--baseline-only');
const expansionOnly = process.argv.includes('--expansion-only');
const guardFixtureOnly = process.argv.includes('--guard-fixture-only');
assert.ok(process.argv.slice(2).every(argument => ['--baseline-only','--expansion-only','--guard-fixture-only'].includes(argument)), 'Only explicit baseline, expansion or synthetic-guard stages are supported');
assert.ok([baselineOnly,expansionOnly,guardFixtureOnly].filter(Boolean).length <= 1, 'Choose only one early verification stage');
let passed = 0;
async function check(name, run) {
  try { await run(); passed++; console.log(`PASS ${name}`); }
  catch (error) { console.error(`FAIL ${name}: ${error.code || ''} ${error.message}`); throw error; }
}
async function createDatabase() {
  const db = new PGlite({ extensions: { pg_trgm, pgcrypto } });
  await initializeSupabaseFixtureDatabase(db);
  return db;
}
async function apply(db, name) {
  await applyFixtureMigration({ db, repo, name, statements: migrationStatements });
}
async function applyNumber(db, number) {
  const name = migrationFiles.find(name => migrationNumber(name) === number);
  assert.ok(name, `Expected forward migration ${number} must exist`);
  await apply(db,name);
}
async function verifyReadOnlyFinancialAudit(db,label) {
  await check(`${label}: financial consistency audit executes read-only`, async () => {
    const name = readdirSync(`${repo}/supabase/audits`).find(name => /^0126_.*invoice.*\.sql$/.test(name));
    assert.ok(name, 'Forward financial audit SQL must exist');
    const results = await db.transaction(async tx => {
      await tx.exec('set transaction read only');
      return tx.exec(readFileSync(`${repo}/supabase/audits/${name}`,'utf8'));
    });
    assert.ok(results.some(result => result.rows.length > 0));
    for (const result of results) {
      for (const row of result.rows) {
        if (Object.hasOwn(row,'all_checks_pass')) assert.equal(row.all_checks_pass,true,
          'Installed schema/guard audit must pass; legacy anomaly counts remain separately visible');
      }
    }
  });
}
async function verifyCombinedMigrationPaths() {
  for (const staged of [false,true]) {
    const isolated = await createDatabase();
    try {
      for (const name of migrationFiles.filter(name => migrationNumber(name) <= 122)) await apply(isolated,name);
      const actors = await initializeLifecycleActors(isolated);
      const as = actorTransactions(isolated);
      if (staged) {
        // The release uses normal numeric history, not out-of-order migration
        // records. After 0123 deploy the final web candidate: lifecycle RPCs
        // work; financial writes fail safely with 503 until 0125 is present.
        await applyNumber(isolated,123);
        await check('combined expansion-only lifecycle callers retain old raw ETA compatibility before cutover', async () => {
          await isolated.query("insert into public.work_orders(id,status,functional_status,contractor_id) values ('WOT9330101','assigned','Dispatched',$1)",[actors.contractor]);
          await as('authenticated',actors.contractor,tx => tx.exec("update public.work_orders set eta=now()+interval '1 hour' where id='WOT9330101'"));
        });
        await applyNumber(isolated,124);
        await check('pre-financial-expansion schema intentionally has no versioned financial RPC', async () => {
          assert.equal((await isolated.query("select to_regprocedure('public.save_staff_billing_invoice_v4(uuid,text,integer,integer,uuid,bigint,uuid,jsonb)') is null absent")).rows[0].absent,true);
        });
        await applyNumber(isolated,125);
        await verifyLegacyFinancialPositiveControls({ db: isolated,check,actors,as,stage: 'financial expansion-only',prefix: 'WOT933' });
        await applyNumber(isolated,126);
      } else {
        for (const number of [123,124,125,126]) await applyNumber(isolated,number);
      }
      const fixture = await createInvoiceCommandFixtures({ db: isolated,as,actors });
      await check(`${staged ? 'staged upgrade' : 'clean numerical install'} final command and raw denial compatibility`, async () => {
        const id = await fixture.workOrder();
        const result = await fixture.command('submit',actors.contractor,await fixture.context(id),fixture.payload());
        assert.equal(result.applied,true);
        await assert.rejects(() => as('authenticated',actors.contractor,tx => tx.query('update public.invoices set total=9999 where id=$1',[result.invoiceId])), error => error.code === '42501');
        await assert.rejects(() => as('authenticated',actors.contractor,tx => tx.query("update public.work_orders set status='wip',functional_status='Work in Progress' where id=$1",[id])), error => error.code === '42501');
      });
      await verifyReadOnlyFinancialAudit(isolated,staged ? 'Controlled combined upgrade' : 'Clean combined numerical install');
    } finally { await isolated.close(); }
  }
}
const db = await createDatabase();
try {
  for (const name of migrationFiles.filter(name => migrationNumber(name) <= 122)) await apply(db, name);
  const actors = await initializeLifecycleActors(db);
  const as = actorTransactions(db);
  await reproduceLegacyInvoiceFindings({ db, check, actors, as, stage: '0121', prefix: 'WOT930' });
  await verifyLegacyFinancialPositiveControls({ db, check, actors, as, stage: '0121', prefix: 'WOT930' });
  for (const name of migrationFiles.filter(name => [123, 124].includes(migrationNumber(name)))) await apply(db, name);
  await reproduceLegacyInvoiceFindings({ db, check, actors, as, stage: '0124', prefix: 'WOT931' });
  await verifyLegacyFinancialPositiveControls({ db, check, actors, as, stage: '0124', prefix: 'WOT931' });
  assert.equal((await db.query('select contracted from public.work_order_lifecycle_control')).rows[0].contracted, true);
  if (baselineOnly) {
    console.log(`PASS ${passed} baseline characterization checks only; final financial acceptance was explicitly not requested`);
  } else {
    const baseline = await captureFinancialSchemaBaseline(db);
    await applyNumber(db,125);
    await reproduceLegacyInvoiceFindings({ db,check,actors,as,stage: '0125 expansion',prefix: 'WOT932' });
    await verifyLegacyFinancialPositiveControls({ db,check,actors,as,stage: '0125 expansion',prefix: 'WOT932' });
    if (expansionOnly) {
      const fixture = await createInvoiceCommandFixtures({ db,as,actors });
      await verifyFinancialExpansionCommands(fixture,check);
      console.log(`PASS ${passed} baseline/expansion checks only; contraction denials and final audit remain unverified`);
    } else {
    if (guardFixtureOnly) {
      // Explicit disposable-fixture activation, not a migration deployment or
      // proof of the still-unreviewed contraction/grants/upgrade sequence.
      await db.exec('update public.invoice_financial_control set contracted=true where singleton');
    } else await applyNumber(db,126);
    const fixture = await createInvoiceCommandFixtures({ db,as,actors });
    await verifyContractorFinancialCommands(fixture,check);
    await verifyStaffFinancialCommands(fixture,check);
    await verifyFinancialDeleteAndEvidence(fixture,check);
    await verifyFinancialSecurityAndCompatibility(fixture,check,baseline,{ guardFixtureOnly });
    await verifyLifecycleInterleavings(fixture.lifecycle,check);
    if (guardFixtureOnly) {
      console.log(`PASS ${passed} synthetic activated-guard checks; actual0126, contraction grants, combined release paths and final audit remain unverified`);
    } else {
    await verifyReadOnlyFinancialAudit(db,'Populated supported upgrade');
    await verifyCombinedMigrationPaths();
    console.log(`PASS ${passed} invoice runtime checks; gateway and genuine parallel-session lock behavior remain unverified`);
    }
    }
  }
} finally { await db.close(); }
