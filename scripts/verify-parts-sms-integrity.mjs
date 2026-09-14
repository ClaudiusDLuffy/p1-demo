// Isolated, synthetic SQL verification only. No Twilio, credentials or remote DB.
import assert from 'node:assert/strict';
import { createDatabase, applyThrough, partsSmsFixtures } from './parts-sms-test-support/fixtures.mjs';
import { reproduceLegacyPartsSms } from './parts-sms-test-support/legacy-reproductions.mjs';
import { verifyLegacyPartsSms } from './parts-sms-test-support/legacy.mjs';
import { partsSmsCandidateFixtures } from './parts-sms-test-support/candidate-fixtures.mjs';
import { verifyPartsSmsDelivery } from './parts-sms-test-support/delivery.mjs';
import { verifyPartsSmsStatusRuns } from './parts-sms-test-support/status-runs.mjs';
import { verifyPartsSmsSecurityActions } from './parts-sms-test-support/security-actions.mjs';
import { verifyPriorPartsSmsSchema } from './parts-sms-test-support/prior-regressions.mjs';
import { verifyPartsSmsPagination } from './parts-sms-test-support/pagination.mjs';
import { verifyPartsSmsAudit } from './parts-sms-test-support/audit.mjs';
import { verifyPartsSmsBoundsCompatibility } from './parts-sms-test-support/bounds-compatibility.mjs';
import { verifyPartsSmsSourceRecurrence, verifyPartsSmsOriginalChecksOnFinalSchema } from './parts-sms-recurrence-test-support/final-schema.mjs';

assert.ok(process.argv.slice(2).every(argument => ['--baseline-only', '--skip-prior'].includes(argument)));
const db = await createDatabase();
let passed = 0;
try {
  await applyThrough(db, 138);
  const fixture = await partsSmsFixtures(db);
  const check = async (name, run) => { await run(); passed++; console.log(`PASS ${name}`); };
  await reproduceLegacyPartsSms(fixture, check);
  await verifyLegacyPartsSms(fixture, check);
  console.log(`Parts SMS legacy SQL: ${passed} passed; 0 failed. Reproduces historical gaps, not remediation acceptance.`);
  if (!process.argv.includes('--baseline-only')) {
    fixture.legacyBefore = (await db.query('select * from public.p1_parts_alert_deliveries order by id')).rows;
    await applyThrough(db, 139, 139);
    const candidate = partsSmsCandidateFixtures(fixture);
    await verifyPartsSmsDelivery(candidate, check);
    await verifyPartsSmsStatusRuns(candidate, check);
    await verifyPartsSmsSecurityActions(candidate, check);
    await verifyPartsSmsPagination(candidate, check);
    await verifyPartsSmsBoundsCompatibility(candidate, check);
    await verifyPartsSmsAudit(check);
    if (!process.argv.includes('--skip-prior')) await verifyPriorPartsSmsSchema(check);
    console.log(`Preserved through-0139 parts SMS SQL: ${passed} passed; 0 failed.`);
    await verifyPartsSmsSourceRecurrence(check);
    await verifyPartsSmsOriginalChecksOnFinalSchema(check);
    if (!process.argv.includes('--skip-prior')) await verifyPriorPartsSmsSchema(check, 140);
    for (const [name, timings] of candidate.measurements) {
      if (!name.includes('parts_sms')) continue;
      const sorted = [...timings].sort((a, b) => a - b);
      console.log(`MEASURE ${name}: ${sorted.length} local synthetic transactions; median ${sorted[Math.floor(sorted.length / 2)].toFixed(2)}ms, max ${sorted.at(-1).toFixed(2)}ms`);
    }
    console.log(`Parts SMS SQL: ${passed} passed; 0 failed, including historical reproductions and forward installation.`);
  }
  console.log('UNVERIFIED: real Twilio, PostgREST/JWT, independent PostgreSQL sessions, hosted browser and cron. No SMS sent.');
} catch (error) {
  console.error(`FAIL parts SMS SQL: ${error.code || 'ASSERTION'} ${error.message}`);
  if (error.code === 'ERR_ASSERTION') console.error(error.stack?.split('\n').filter(line => line.trim().startsWith('at ')).slice(0, 5).join('\n'));
  process.exitCode = 1;
} finally { await db.close(); }
