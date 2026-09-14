import { readMigrationInventory } from "./migration-inventory.mjs";
// Isolated synthetic PostgreSQL execution only. Never reads environment files,
// provider credentials, customer email, or a remote database connection string.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initializeSupabaseFixtureDatabase, applyFixtureMigration,
  initializeLifecycleActors, actorTransactions } from './lifecycle-test-support/engine-fixtures.mjs';
import { migrationStatements } from './invoice-test-support/migration-statements.mjs';
import { createEmailSecurityFixtures } from './email-intake-test-support/fixtures.mjs';
import { reproduceEmailSecurityBaseline } from './email-intake-test-support/legacy-reproductions.mjs';
import { verifyEmailReceipts,verifyEmailReceiptValidation } from './email-intake-test-support/receipt-acceptance.mjs';
import { verifyActiveEmailAuthorization,verifyEmailRawAndGrants } from './email-intake-test-support/authorization-acceptance.mjs';
import { verifyEmailReceiptAtomicity,verifyEmailExpansion,verifyEmailAudit,verifyEmailAuditAnomalies,verifyEmailReleasePaths } from './email-intake-test-support/atomicity-and-release.mjs';
import { verifyPriorBatchesOnFinalEmailSchema } from './email-intake-test-support/combined-regressions.mjs';

assert.ok(process.env.P1_SQL_TEST_ENGINE_DIR, 'Use the approved existing isolated SQL engine');
assert.ok(process.argv.slice(2).every(argument => argument === '--baseline-only'));
const requireEngine = createRequire(resolve(process.env.P1_SQL_TEST_ENGINE_DIR, 'package.json'));
const { PGlite } = requireEngine('@electric-sql/pglite');
const { pg_trgm } = requireEngine('@electric-sql/pglite/contrib/pg_trgm');
const { pgcrypto } = requireEngine('@electric-sql/pglite/contrib/pgcrypto');
const repo = fileURLToPath(new URL('../', import.meta.url));
const migrations = readMigrationInventory(repo).filter(name => /^\d+.*\.sql$/.test(name)).sort();
let passed = 0;
let baseline = 0;
let reviewGates = 0;
async function check(name, run) {
  try {
    await run(); passed++;
    if (name.startsWith('BASELINE ')) baseline++;
    else if (name.startsWith('REVIEW GATE')) reviewGates++;
    console.log(`PASS ${name}`);
  }
  catch (error) { console.error(`FAIL ${name}: ${error.code || ''} ${error.message}`); throw error; }
}
const db = new PGlite({ extensions: { pg_trgm, pgcrypto } });
try {
  await initializeSupabaseFixtureDatabase(db);
  for (const name of migrations.filter(name => Number(name.match(/^\d+/)[0]) <= 129)) {
    await applyFixtureMigration({ db, repo, name, statements: migrationStatements });
  }
  const actors = await initializeLifecycleActors(db);
  const fixture = await createEmailSecurityFixtures({ db, as: actorTransactions(db), actors });
  await reproduceEmailSecurityBaseline(fixture, check);
  if (!process.argv.includes('--baseline-only')) {
    for (const number of [130,131]) {
      const name=migrations.find(name=>Number(name.match(/^\d+/)[0])===number);
      assert.ok(name,`Required migration ${number} must exist`);
      await applyFixtureMigration({ db,repo,name,statements:migrationStatements });
      if(number===130) await verifyEmailExpansion(fixture,check);
    }
    await verifyActiveEmailAuthorization(fixture,check);
    await verifyEmailReceipts(fixture,check);
    await verifyEmailReceiptValidation(fixture,check);
    await verifyEmailRawAndGrants(fixture,check);
    await verifyEmailReceiptAtomicity(fixture,check);
    await verifyEmailAudit(db,repo,check,'Populated final schema');
    await verifyEmailAuditAnomalies(fixture,repo,check);
    const releaseTools={
      createDatabase:async()=>{const engine=new PGlite({extensions:{pg_trgm,pgcrypto}});await initializeSupabaseFixtureDatabase(engine);return engine;},
      applyThrough:async(engine,number)=>{
        for(const name of migrations.filter(name=>Number(name.match(/^\d+/)[0])<=number)) {
          await applyFixtureMigration({db:engine,repo,name,statements:migrationStatements});
        }
      },
      applyNumber:async(engine,number)=>{
        const name=migrations.find(name=>Number(name.match(/^\d+/)[0])===number);assert.ok(name);
        await applyFixtureMigration({db:engine,repo,name,statements:migrationStatements});
      },repo,check,
    };
    await verifyEmailReleasePaths(releaseTools);
    await verifyPriorBatchesOnFinalEmailSchema(releaseTools);
  }
  console.log(`Email-intake SQL checks passed: ${passed}; ${baseline} original-schema characterizations; ${passed-baseline-reviewGates} acceptance/compatibility checks; ${reviewGates} explicitly deferred legacy review-gate characterizations.`);
  console.log('UNVERIFIED: real JWT/PostgREST gateway, provider delivery and independent PostgreSQL concurrent sessions.');
} catch (error) {
  console.error(`FATAL ${error.code || ''}: ${error.message}\n${error.where || ''}`);
  process.exitCode = 1;
} finally { await db.close(); }
