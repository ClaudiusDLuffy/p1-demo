// Isolated synthetic SQL only: no environment files, remote URLs or customer data.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initializeSupabaseFixtureDatabase, applyFixtureMigration, initializeLifecycleActors,
  actorTransactions } from './lifecycle-test-support/engine-fixtures.mjs';
import { migrationStatements } from './invoice-test-support/migration-statements.mjs';
import { reproduceAssignmentBaseline } from './assignment-test-support/legacy-reproductions.mjs';
import { createAssignmentFixtures } from './assignment-test-support/command-fixtures.mjs';
import { verifyAssignmentCommands } from './assignment-test-support/command-acceptance.mjs';
import { verifyRejectionAndDuplication } from './assignment-test-support/rejection-duplicate-acceptance.mjs';
import { verifyAssignmentRawAndEvidence } from './assignment-test-support/raw-evidence-acceptance.mjs';
import { verifyAssignmentAtomicity } from './assignment-test-support/atomicity-acceptance.mjs';
import { verifyAssignmentCreationAndDelivery } from './assignment-test-support/creation-delivery-acceptance.mjs';
import { verifyLifecycleCommands } from './lifecycle-test-support/command-acceptance.mjs';
import { verifyLifecycleAtomicity } from './lifecycle-test-support/atomicity-acceptance.mjs';
import { verifyLifecycleInterleavings } from './lifecycle-test-support/concurrency-compatibility.mjs';
import { verifyContractorFinancialCommands } from './invoice-test-support/contractor-acceptance.mjs';
import { verifyStaffFinancialCommands } from './invoice-test-support/staff-acceptance.mjs';
import { verifyFinancialDeleteAndEvidence } from './invoice-test-support/delete-evidence-acceptance.mjs';
import { captureFinancialSchemaBaseline,verifyFinancialSecurityAndCompatibility } from './invoice-test-support/security-compatibility.mjs';
import { verifyAssignmentAudit,verifyHybridAssignmentAudit,verifyAssignmentSecurity,verifyAssignmentReleasePaths } from './assignment-test-support/security-release-acceptance.mjs';
import { verifyAssignmentInterleavings } from './assignment-test-support/interleaving-acceptance.mjs';
import { verifyAdministrativeTransfers } from './assignment-test-support/administrative-transfer-acceptance.mjs';
import { verifyAdministrativeTransferSecurity } from './assignment-test-support/administrative-transfer-security.mjs';
import { verifyAdministrativeTransferAtomicity } from './assignment-test-support/administrative-transfer-atomicity.mjs';
import { verifyAdministrativeContinuation } from './assignment-test-support/administrative-transfer-continuation.mjs';

process.on('uncaughtException',error => {
  console.error(`FATAL ${error.code || ''}: ${error.message}\n${error.where || ''}`);
  process.exit(1);
});

assert.ok(process.env.P1_SQL_TEST_ENGINE_DIR, 'Use the approved existing isolated SQL engine');
assert.ok(process.argv.slice(2).every(argument => argument === '--baseline-only'));
const requireEngine = createRequire(resolve(process.env.P1_SQL_TEST_ENGINE_DIR, 'package.json'));
const { PGlite } = requireEngine('@electric-sql/pglite');
const { pg_trgm } = requireEngine('@electric-sql/pglite/contrib/pg_trgm');
const { pgcrypto } = requireEngine('@electric-sql/pglite/contrib/pgcrypto');
const repo = fileURLToPath(new URL('../', import.meta.url));
const migrations = readdirSync(`${repo}/supabase/migrations`).filter(name => /^\d+.*\.sql$/.test(name)).sort();
let passed = 0;
let baselineCharacterizations=0;
let reviewGateCharacterizations=0;
async function check(name, run) {
  try {
    await run();passed++;
    if(name.startsWith('BASELINE ')) baselineCharacterizations++;
    else if(name.startsWith('REVIEW GATE')) reviewGateCharacterizations++;
    console.log(`PASS ${name}`);
  }
  catch (error) { console.error(`FAIL ${name}: ${error.code || ''} ${error.message}`); throw error; }
}
const db = new PGlite({ extensions: { pg_trgm, pgcrypto } });
try {
  await initializeSupabaseFixtureDatabase(db);
  let financialBaseline;
  for (const name of migrations.filter(name => Number(name.match(/^\d+/)[0]) <= 125)) {
    await applyFixtureMigration({ db, repo, name, statements: migrationStatements });
    if(name.startsWith('0123_')) financialBaseline=await captureFinancialSchemaBaseline(db);
  }
  const actors = await initializeLifecycleActors(db);
  const as = actorTransactions(db);
  await reproduceAssignmentBaseline({ db, as, actors, check });
  if (!process.argv.includes('--baseline-only')) {
    const assignmentBaseline=await captureFinancialSchemaBaseline(db);
    assert.ok(migrations.some(name => name.startsWith('0126_')), 'Assignment expansion must exist before final acceptance');
    assert.ok(migrations.some(name => name.startsWith('0127_')), 'Assignment contraction must exist before final acceptance');
    assert.ok(migrations.some(name => name.startsWith('0128_')), 'Hybrid administrative transfer migration must exist before final acceptance');
    for (const name of migrations.filter(name=>[126,127,128].includes(Number(name.match(/^\d+/)[0])))) {
      await applyFixtureMigration({ db,repo,name,statements:migrationStatements });
    }
    const fixture=await createAssignmentFixtures({ db,as,actors });
    await verifyAssignmentCommands(fixture,check);
    await verifyRejectionAndDuplication(fixture,check);
    await verifyAssignmentRawAndEvidence(fixture,check);
    await verifyAssignmentAtomicity(fixture,check);
    await verifyAssignmentCreationAndDelivery(fixture,check);
    await verifyAssignmentInterleavings(fixture,check);
    await verifyAdministrativeTransfers(fixture,check);
    await verifyAdministrativeTransferSecurity(fixture,check);
    await verifyAdministrativeTransferAtomicity(fixture,check);
    await verifyAdministrativeContinuation(fixture,check);
    await verifyLifecycleCommands(fixture.lifecycle,check);
    await verifyLifecycleAtomicity(fixture.lifecycle,check);
    await verifyLifecycleInterleavings(fixture.lifecycle,check);
    await verifyContractorFinancialCommands(fixture.financial,check);
    await verifyStaffFinancialCommands(fixture.financial,check);
    await verifyFinancialDeleteAndEvidence(fixture.financial,check);
    const finalSchema=await captureFinancialSchemaBaseline(db);
    // Keep the existing financial grant assertion scoped to routines/tables
    // created by 0124, while evaluating their current final-0128 permissions.
    for(const identity of finalSchema.routines) if(!assignmentBaseline.routines.has(identity)) financialBaseline.routines.add(identity);
    for(const table of finalSchema.tables) if(!assignmentBaseline.tables.has(table)) financialBaseline.tables.add(table);
    await verifyFinancialSecurityAndCompatibility(fixture.financial,check,financialBaseline);
    await verifyAssignmentSecurity(fixture,check,assignmentBaseline);
    await verifyAssignmentAudit(db,repo,check,'Populated final combined schema');
    await verifyHybridAssignmentAudit(db,repo,check,'Populated final combined schema');
    await verifyAssignmentReleasePaths({
      createDatabase:async()=>{ const engine=new PGlite({ extensions:{ pg_trgm,pgcrypto } });await initializeSupabaseFixtureDatabase(engine);return engine; },
      applyNumber:async(engine,number)=>{
        const name=migrations.find(name=>Number(name.match(/^\d+/)[0])===number);assert.ok(name);
        await applyFixtureMigration({ db:engine,repo,name,statements:migrationStatements });
      },
      applyBaseline:async engine=>{
        for(const name of migrations.filter(name=>Number(name.match(/^\d+/)[0])<=121)) {
          await applyFixtureMigration({ db:engine,repo,name,statements:migrationStatements });
        }
      },check,initializeActors:initializeLifecycleActors,asFor:actorTransactions,repo,
    });
  }
  console.log(`PASS ${passed} total SQL checks: ${passed-baselineCharacterizations-reviewGateCharacterizations} acceptance/compatibility checks, `+
    `${baselineCharacterizations} original-schema characterizations, ${reviewGateCharacterizations} explicit review-gate characterizations`);
  if(reviewGateCharacterizations>0) console.log('DEFERRED REVIEW GATE: the existing legacy capital-intake closed-to-capital behavior remains characterized, not approved by this assignment batch.');
  console.log('UNVERIFIED: real PostgREST/JWT and true independent PostgreSQL concurrent sessions; no production promotion is certified.');
} finally { await db.close(); }
