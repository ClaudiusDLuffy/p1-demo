// Disposable PostgreSQL execution with synthetic actors only. No Graph, remote
// database, environment files, secrets, or customer messages are accessed.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { migrationStatements } from './invoice-test-support/migration-statements.mjs';
import { createDatabase, applyThrough, createFixtures, repo } from './receiving-dispatch-test-support/fixtures.mjs';
import { verifyCloseoutAuthorization } from './receiving-dispatch-test-support/authorization.mjs';
import { verifyCloseoutActions } from './receiving-dispatch-test-support/actions.mjs';
import { verifyCloseoutPagination } from './receiving-dispatch-test-support/pagination.mjs';
import { verifyCloseoutWorker } from './receiving-dispatch-test-support/worker.mjs';
import { verifyCloseoutAssignment } from './receiving-dispatch-test-support/assignment.mjs';

assert.equal(process.argv.length, 2, 'This harness does not accept production connection arguments');
let passed = 0;
const check = async (name, run) => {
  await run(); passed++;
  console.log(`PASS ${name}`);
};
let db;
try {
  db = await createDatabase();
  await applyThrough(db, 132);
  const fixture = await createFixtures(db);
  const legacy = await fixture.create();
  await applyThrough(db, 133, 133);
  const legacyUnknown = await fixture.outcome(await fixture.create());
  const unknownBefore = await fixture.row(legacyUnknown.delivery.id);
  const upgrade = await fixture.create();
  const before = await fixture.row(upgrade.delivery.id);
  await applyThrough(db, 134, 134);
  await check('supported 0133 upgrade preserves its event bytes and classifies earlier assignments separately', async () => {
    const after = await fixture.row(before.id);
    for (const [key, value] of Object.entries(before)) assert.deepEqual(after[key], value, key);
    assert.equal((await fixture.current(legacy)).kind, 'legacy_untracked');
    assert.equal((await fixture.current(upgrade)).kind, 'current');
  });
  await check('0133 unknown outcome survives upgrade without automatic retry or invented earlier attempts', async () => {
    const after = await fixture.row(unknownBefore.id);
    for (const [key, value] of Object.entries(unknownBefore)) assert.deepEqual(after[key], value, key);
    const history = await fixture.history(after.id);
    assert.equal(history.items.filter(item => item.kind === 'attempt').length, 0);
    assert.equal(history.items[0].state, 'unknown');
    const current = await fixture.current(legacyUnknown);
    assert.ok(current.delivery.lastAttemptAt, 'Legacy recorded send-start remains visible without inventing an attempt');
    assert.equal((await fixture.claim()).rows.some(item => item.id === after.id), false);
  });
  await verifyCloseoutAuthorization(fixture, check);
  await verifyCloseoutAssignment(fixture, check);
  await verifyCloseoutActions(fixture, check);
  await verifyCloseoutWorker(fixture, check);
  await verifyCloseoutPagination(fixture, check);
  const audit = readdirSync(`${repo}/supabase/audits`).find(name => /^0134_.*\.sql$/.test(name));
  assert.ok(audit, 'Closeout must provide a separate read-only audit');
  await check('closeout integrity and grants audit executes with transaction READ ONLY', async () => {
    const source = readFileSync(`${repo}/supabase/audits/${audit}`, 'utf8');
    await db.transaction(async tx => {
      await tx.exec('set transaction read only');
      for (const statement of migrationStatements(source)) await tx.query(statement);
    });
  });
  await db.close();
  db = await createDatabase();
  await applyThrough(db, 134);
  await check('clean combined installation executes every migration through 0134 in filename order', async () => {
    assert.equal((await db.query("select to_regclass('public.receiving_dispatch_operations') is not null present")).rows[0].present, true);
  });
  console.log(`Receiving-dispatch closeout SQL: ${passed} passed; 0 failed. All assertions executed in disposable PGlite.`);
  console.log('UNVERIFIED: actual PostgREST/JWT gateway, independent PostgreSQL sessions, hosted cron/browser behavior, and real Graph. No email sent.');
} catch (error) {
  console.error(`FAIL receiving-dispatch closeout SQL: ${error.code || 'ASSERTION'} ${error.message}`);
  process.exitCode = 1;
} finally { if (db) await db.close(); }
