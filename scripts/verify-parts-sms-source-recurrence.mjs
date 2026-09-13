// Synthetic isolated SQL only. No provider, credentials, remote database or SMS.
import assert from 'node:assert/strict';
import { createDatabase, applyThrough, partsSmsFixtures } from './parts-sms-test-support/fixtures.mjs';
import { recurrenceFixtures } from './parts-sms-recurrence-test-support/fixtures.mjs';
import { reproduceBlockedPartsRecurrence, verifyRecurrenceUpgrade } from './parts-sms-recurrence-test-support/upgrade.mjs';
import { verifyPartsRecurrencePolicy } from './parts-sms-recurrence-test-support/policy.mjs';
import { verifyPartsRecurrenceBoundaries } from './parts-sms-recurrence-test-support/boundaries.mjs';
import { verifyPartsRecurrenceSecurity } from './parts-sms-recurrence-test-support/security-atomicity.mjs';
import { applyPartsRecurrenceMigration } from './parts-sms-recurrence-test-support/migration.mjs';
import { verifyPartsRecurrenceActionsHistory } from './parts-sms-recurrence-test-support/actions-history.mjs';
import { verifyPartsRecurrenceAudit } from './parts-sms-recurrence-test-support/audit.mjs';
import { verifyPartsRecurrenceUpgradeBoundaries } from './parts-sms-recurrence-test-support/upgrade-boundaries.mjs';

assert.ok(process.argv.slice(2).every(argument => argument === '--baseline-only'));
const db = await createDatabase();
let passed = 0;
const check = async (name, run) => { await run(); passed++; console.log(`PASS ${name}`); };
try {
  await applyThrough(db, 138);
  const f = recurrenceFixtures(await partsSmsFixtures(db));
  const target = await reproduceBlockedPartsRecurrence(f, check);
  if (!process.argv.includes('--baseline-only')) {
    await applyPartsRecurrenceMigration(db);
    await verifyRecurrenceUpgrade(f, target, check);
    await verifyPartsRecurrencePolicy(f, check);
    await verifyPartsRecurrenceBoundaries(f, check);
    await verifyPartsRecurrenceActionsHistory(f, check);
    await verifyPartsRecurrenceSecurity(f, check);
    await verifyPartsRecurrenceAudit(check);
    await verifyPartsRecurrenceUpgradeBoundaries(check);
    for (const [name, values] of f.measurements) {
      if (!name.includes('parts_sms')) continue;
      const sorted = [...values].sort((a, b) => a - b);
      console.log(`MEASURE ${name}: ${values.length} isolated local transactions; median ${sorted[Math.floor(sorted.length / 2)].toFixed(2)}ms, max ${sorted.at(-1).toFixed(2)}ms`);
    }
  }
  console.log(`Parts SMS recurrence SQL: ${passed} passed; 0 failed.`);
  console.log('UNVERIFIED: real Twilio, PostgREST/JWT, independent PostgreSQL sessions, browser, hosted cron and schedule ownership. No SMS sent.');
} catch (error) {
  console.error(`FAIL parts SMS recurrence SQL: ${error.code || 'ASSERTION'} ${error.message}`);
  if (error.code === 'ERR_ASSERTION') console.error(error.stack?.split('\n').filter(line => line.trim().startsWith('at ')).slice(0, 5).join('\n'));
  process.exitCode = 1;
} finally { await db.close(); }
