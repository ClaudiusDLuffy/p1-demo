// Disposable SQL metadata/RLS characterization only. No Storage gateway or
// document bytes are used, and no remote database or credentials are read.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initializeSupabaseFixtureDatabase, applyFixtureMigration,
  initializeLifecycleActors, actorTransactions } from './lifecycle-test-support/engine-fixtures.mjs';
import { migrationStatements } from './invoice-test-support/migration-statements.mjs';
import { createStoragePhotoFixtures } from './storage-photo-test-support/fixtures.mjs';
import { reproducePhotoBaseline } from './storage-photo-test-support/photo-baseline.mjs';
import { reproduceInvoiceStorageBaseline } from './storage-photo-test-support/invoice-baseline.mjs';
import { reproduceEstimateStorageBaseline } from './storage-photo-test-support/estimate-baseline.mjs';
import { verifyCanonicalObjectCommands } from './storage-photo-test-support/command-acceptance.mjs';
import { verifyPhotoRoleAndPathMatrix } from './storage-photo-test-support/role-acceptance.mjs';
import { verifyCanonicalAttachments } from './storage-photo-test-support/attachment-acceptance.mjs';
import { verifyPhotoAtomicity } from './storage-photo-test-support/atomicity-acceptance.mjs';
import { verifyStorageUpgrade } from './storage-photo-test-support/upgrade-acceptance.mjs';
import { verifyPriorBatchesOnFinalStorageSchema } from './storage-photo-test-support/combined-regressions.mjs';

assert.ok(process.env.P1_SQL_TEST_ENGINE_DIR, 'Use the approved existing isolated SQL engine');
assert.ok(process.argv.slice(2).every(argument => argument === '--baseline-only'));
const requireEngine = createRequire(resolve(process.env.P1_SQL_TEST_ENGINE_DIR, 'package.json'));
const { PGlite } = requireEngine('@electric-sql/pglite');
const { pg_trgm } = requireEngine('@electric-sql/pglite/contrib/pg_trgm');
const { pgcrypto } = requireEngine('@electric-sql/pglite/contrib/pgcrypto');
const repo = fileURLToPath(new URL('../', import.meta.url));
const migrations = readdirSync(`${repo}/supabase/migrations`)
  .filter(name => /^\d+.*\.sql$/.test(name) && Number(name.match(/^\d+/)[0]) <= 130).sort();
assert.ok(migrations.some(name => name.startsWith('0130_')));
let passed = 0;
let reviewGates = 0;
async function check(name, run) {
  try { await run(); passed++; console.log(`PASS BASELINE ${name}`); }
  catch (error) {
    console.error(`FAIL BASELINE ${name}: ${error.code || ''} ${error.message}`);
    throw error;
  }
}
let db = new PGlite({ extensions: { pg_trgm, pgcrypto } });
async function initializeStorage(engine) {
  await initializeSupabaseFixtureDatabase(engine);
  await engine.exec(`
    grant select on storage.buckets to anon, authenticated, service_role;
    grant select, insert, update, delete on storage.objects to anon, authenticated, service_role;
    alter table storage.objects add constraint synthetic_storage_object_identity unique(bucket_id, name);
  `);
}
try {
  await initializeStorage(db);
  // The existing fixture has no provider-owned Storage grants or object-name
  // uniqueness. Model only those prerequisites to execute the actual policies.
  // This deliberately does not model MIME inspection, tokens or binary IO.
  for (const name of migrations) {
    await applyFixtureMigration({ db, repo, name, statements: migrationStatements });
  }
  const actors = await initializeLifecycleActors(db);
  const fixture = await createStoragePhotoFixtures({ db, as: actorTransactions(db), actors });
  await reproducePhotoBaseline(fixture, check);
  await reproduceInvoiceStorageBaseline(fixture, check);
  await reproduceEstimateStorageBaseline(fixture, check);
  const baseline = passed;
  if (!process.argv.includes('--baseline-only')) {
    await db.close(); db = new PGlite({ extensions:{ pg_trgm,pgcrypto } });
    await initializeStorage(db);
    for (const name of readdirSync(`${repo}/supabase/migrations`)
      .filter(name => /^\d+.*\.sql$/.test(name) && Number(name.match(/^\d+/)[0]) <= 132).sort()) {
      await applyFixtureMigration({ db,repo,name,statements:migrationStatements });
    }
    const finalActors = await initializeLifecycleActors(db);
    const finalFixture = await createStoragePhotoFixtures({ db,as:actorTransactions(db),actors:finalActors });
    await verifyCanonicalObjectCommands(finalFixture,async (name,run) => {
      await run(); passed++; console.log(`PASS ACCEPTANCE ${name}`);
    });
    await verifyPhotoRoleAndPathMatrix(finalFixture,async (name,run) => {
      await run(); passed++; console.log(`PASS ACCEPTANCE ${name}`);
    });
    await verifyCanonicalAttachments(finalFixture,async (name,run) => {
      await run(); passed++; console.log(`PASS ACCEPTANCE ${name}`);
    });
    await verifyPhotoAtomicity(finalFixture,async (name,run) => {
      await run(); passed++; console.log(`PASS ACCEPTANCE ${name}`);
    });
    await db.transaction(async tx=>{
      await tx.exec('set transaction read only');
      const statements=migrationStatements(readFileSync(`${repo}/supabase/audits/0132_canonical_storage_photo_integrity_verification.sql`,'utf8'));
      assert.ok(statements.length>=5);
      for(const statement of statements) await tx.query(statement);
    });
    passed++;console.log('PASS ACCEPTANCE full consistency/security audit executes in a read-only transaction');
    await db.close(); db = new PGlite({ extensions:{pg_trgm,pgcrypto} });
    await initializeStorage(db);
    for(const name of migrations) await applyFixtureMigration({db,repo,name,statements:migrationStatements});
    const upgradeActors=await initializeLifecycleActors(db);
    const upgradeFixture=await createStoragePhotoFixtures({db,as:actorTransactions(db),actors:upgradeActors});
    await verifyStorageUpgrade({db,fixture:upgradeFixture,
      applyNumber:async number=>{
        const name=readdirSync(`${repo}/supabase/migrations`).find(name=>Number(name.match(/^\d+/)?.[0])===number);
        assert.ok(name);await applyFixtureMigration({db,repo,name,statements:migrationStatements});
      },check:async(name,run)=>{await run();passed++;console.log(`PASS UPGRADE ${name}`);}});
    await verifyPriorBatchesOnFinalStorageSchema({repo,
      createDatabase:async()=>{const engine=new PGlite({extensions:{pg_trgm,pgcrypto}});await initializeStorage(engine);return engine;},
      applyThrough:async(engine,number)=>{
        for(const name of readdirSync(`${repo}/supabase/migrations`)
          .filter(name=>/^\d+.*\.sql$/.test(name)&&Number(name.match(/^\d+/)[0])<=number).sort()) {
          await applyFixtureMigration({db:engine,repo,name,statements:migrationStatements});
        }
      },check:async(name,run)=>{
        await run();passed++;if(name.startsWith('REVIEW GATE')) reviewGates++;
        console.log(`PASS ${name}`);
      },
    });
  }
  console.log(`Storage/photo checks passed: ${passed}; ${baseline} original-schema characterizations; ${passed-baseline-reviewGates} acceptance/compatibility checks; ${reviewGates} explicitly deferred legacy review-gate characterizations.`);
  if (process.argv.includes('--baseline-only')) console.log('Baseline-only: no remediation acceptance was executed.');
  console.log('UNVERIFIED: actual Storage bytes/signatures, signed URLs, PostgREST/JWT gateway, network retries, provider deletion and independent concurrent sessions.');
} catch (error) {
  console.error(`FATAL ${error.code || ''}: ${error.message}\n${error.where || ''}`);
  process.exitCode = 1;
} finally { await db.close(); }
