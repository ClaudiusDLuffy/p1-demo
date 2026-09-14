// Isolated database read policy only. Import the actual TS compatibility model;
// no separate test copy of the business-policy matrix and no source-row repair.
import assert from 'node:assert/strict';
import { createDatabase, applyThrough, slaFixtures, reproduceSlaReadDivergence } from './sla-read-test-support/fixtures.mjs';
import { verifySlaSqlParity } from './sla-read-test-support/parity.mjs';
import { verifySlaReadApis } from './sla-read-test-support/reads.mjs';
import { verifySlaMigration } from './sla-read-test-support/migration-audit.mjs';

assert.ok(process.argv.slice(2).every(value => value === '--baseline-only'));
const db = await createDatabase();
let passed = 0;
const check = async (name, run) => { await run(); passed++; console.log(`PASS ${name}`); };
try {
  await applyThrough(db, 141);
  const f = await slaFixtures(db);
  const baseline = await reproduceSlaReadDivergence(f, check);
  if (!process.argv.includes('--baseline-only')) {
    const before = await f.definitions();
    const snapshot = await f.assignment.snapshot();
    await check('SLA supported0141 to0142 forward upgrade installs explicit read-only definitions', () => applyThrough(db, 142, 142));
    await verifySlaMigration(f, before, snapshot, check);
    await verifySlaSqlParity(f, check);
    await verifySlaReadApis(f, baseline, check);
    const clean = await createDatabase();
    try { await check('SLA clean install succeeds in filename order through0142', () => applyThrough(clean, 142)); }
    finally { await clean.close(); }
  }
  console.log(`SLA read SQL: ${passed} passed; 0 failed.`);
  console.log('UNVERIFIED: hosted PostgREST/JWT and browser behavior. Compatibility values still require owner policy approval; no deadlines changed.');
} catch (error) {
  console.error(`FAIL SLA read SQL: ${error.code || 'ASSERTION'}`);
  if (error.code === 'ERR_ASSERTION') console.error(error.stack?.split('\n').filter(line => line.trim().startsWith('at ')).slice(0, 5).join('\n'));
  process.exitCode = 1;
} finally { await db.close(); }
