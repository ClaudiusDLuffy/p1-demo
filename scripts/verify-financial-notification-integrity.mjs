// Execute authoritative historical financial commands in an isolated engine.
// Only synthetic fixtures are used; no Graph, gateways, secrets, or remote DB.
import assert from 'node:assert/strict';
import { createDatabase, applyThrough, financialNotificationFixtures } from './financial-notification-test-support/fixtures.mjs';
import { reproduceFinancialNotificationLoss } from './financial-notification-test-support/legacy-reproductions.mjs';
import { candidateFixtures } from './financial-notification-test-support/candidate-fixtures.mjs';
import { verifyFinancialIntentTransactions } from './financial-notification-test-support/transactions.mjs';
import { verifyFinancialNotificationAuthorization } from './financial-notification-test-support/authorization.mjs';
import { verifyFinancialNotificationRecipients } from './financial-notification-test-support/recipients.mjs';
import { verifyFinancialNotificationWorkerActions } from './financial-notification-test-support/worker-actions.mjs';
import { verifyFinancialNotificationPagination } from './financial-notification-test-support/pagination.mjs';
import { verifyFinancialExpansionCompatibility, verifyFinancialContractionCompatibility } from './financial-notification-test-support/migration-compatibility.mjs';
import { verifyPriorFinancialNotificationSchema } from './financial-notification-test-support/prior-regressions.mjs';
import { verifyFinancialHoldPolicy } from './financial-notification-test-support/hold-policy.mjs';

assert.ok(process.argv.slice(2).every(argument => argument === '--baseline-only'));
const db = await createDatabase();
let passed = 0;
try {
  await applyThrough(db, 135);
  const fixture = await financialNotificationFixtures(db);
  const check = async (name, run) => { await run(); passed++; console.log(`PASS ${name}`); };
  await reproduceFinancialNotificationLoss(fixture, check);
  console.log(`Financial notification baseline SQL: ${passed} passed; 0 failed. This reproduces pre-fix gaps, not remediation acceptance.`);
  if (!process.argv.includes('--baseline-only')) {
    await applyThrough(db, 136, 136);
    const candidate = candidateFixtures(fixture);
    await verifyFinancialExpansionCompatibility(candidate, check);
    await verifyFinancialIntentTransactions(candidate, check);
    await applyThrough(db, 137, 137);
    await applyThrough(db, 138, 138);
    await verifyFinancialNotificationAuthorization(candidate, check);
    await verifyFinancialNotificationRecipients(candidate, check);
    await verifyFinancialNotificationWorkerActions(candidate, check);
    await verifyFinancialHoldPolicy(candidate, check);
    await verifyFinancialNotificationPagination(candidate, check);
    await verifyFinancialContractionCompatibility(candidate, check);
    await verifyPriorFinancialNotificationSchema(candidate, check);
    for(const name of ['claim_financial_notification_deliveries_v1','prepare_financial_notification_send_v1','complete_financial_notification_delivery_v1','get_financial_notification_status_v1','get_financial_notification_history_v1','list_financial_notification_unresolved_v1']) {
      const values=[...(candidate.measurements.get(name)||[])].sort((a,b)=>a-b);
      if(values.length)console.log(`MEASURE ${name}: ${values.length} synthetic transactions; median ${values[Math.floor(values.length/2)].toFixed(2)}ms, maximum ${values.at(-1).toFixed(2)}ms; includes local transaction overhead`);
    }
    console.log(`Financial notification SQL: ${passed} passed; 0 failed, including historical reproduction and forward migration installation.`);
  }
  console.log('UNVERIFIED: real Graph, PostgREST/JWT gateway, independent PostgreSQL sessions, hosted browser and scheduler behavior. No email sent.');
} catch (error) {
  console.error(`FAIL financial notification baseline SQL: ${error.code || 'ASSERTION'} ${error.message}`);
  process.exitCode = 1;
} finally { await db.close(); }
