import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createDatabase, applyThrough } from './fixtures.mjs';
import { createFixtures } from '../receiving-dispatch-test-support/fixtures.mjs';
import { initializeLifecycleActors, actorTransactions } from '../lifecycle-test-support/engine-fixtures.mjs';
import { verifyPriorBatchesOnFinalStorageSchema } from '../storage-photo-test-support/combined-regressions.mjs';
import { createStoragePhotoFixtures } from '../storage-photo-test-support/fixtures.mjs';
import { verifyCanonicalObjectCommands } from '../storage-photo-test-support/command-acceptance.mjs';
import { financialNotificationFixtures } from '../financial-notification-test-support/fixtures.mjs';
import { candidateFixtures } from '../financial-notification-test-support/candidate-fixtures.mjs';
import { verifyFinancialNotificationWorkerActions } from '../financial-notification-test-support/worker-actions.mjs';
import { verifyFinancialHoldPolicy } from '../financial-notification-test-support/hold-policy.mjs';
import { partsSmsFixtures } from '../parts-sms-test-support/fixtures.mjs';
import { reproduceLegacyPartsSms } from '../parts-sms-test-support/legacy-reproductions.mjs';
import { verifyLegacyPartsSms } from '../parts-sms-test-support/legacy.mjs';
import { recurrenceFixtures } from '../parts-sms-recurrence-test-support/fixtures.mjs';
import { verifyPartsSmsDelivery } from '../parts-sms-test-support/delivery.mjs';
import { verifyPartsSmsStatusRuns } from '../parts-sms-test-support/status-runs.mjs';
import { verifyPartsSmsSecurityActions } from '../parts-sms-test-support/security-actions.mjs';
import { verifyPartsSmsPagination } from '../parts-sms-test-support/pagination.mjs';
import { verifyPartsSmsBoundsCompatibility } from '../parts-sms-test-support/bounds-compatibility.mjs';
import { verifyPartsRecurrencePolicy } from '../parts-sms-recurrence-test-support/policy.mjs';
import { verifyPartsRecurrenceBoundaries } from '../parts-sms-recurrence-test-support/boundaries.mjs';
import { verifyPartsRecurrenceSecurity } from '../parts-sms-recurrence-test-support/security-atomicity.mjs';
import { verifyPartsRecurrenceActionsHistory } from '../parts-sms-recurrence-test-support/actions-history.mjs';

// Call unchanged prior assertions against the final schema. Never rewrite old
// assertions to make new code pass or modify historical scripts/migrations.
export async function verifyPriorDiagnosticSchema(check, maximum = 142) {
  assert.ok([141, 142].includes(maximum));
  const label = String(maximum).padStart(4, '0');
  await verifyPriorBatchesOnFinalStorageSchema({ createDatabase,
    applyThrough: db => applyThrough(db, maximum),
    repo: fileURLToPath(new URL('../../', import.meta.url)),
    check: (name, run) => check(name.replaceAll('Final 0133', `Final ${label}`).replaceAll('final 0133', `final ${label}`), run),
  });
  const storage = await createDatabase();
  try {
    await applyThrough(storage, maximum);
    const actors = await initializeLifecycleActors(storage);
    const fixture = await createStoragePhotoFixtures({ db: storage, as: actorTransactions(storage), actors });
    await verifyCanonicalObjectCommands(fixture, (name, run) => check(`Final ${label} Storage: ${name}`, run));
  } finally { await storage.close(); }
  const receiving = await createDatabase();
  try {
    await applyThrough(receiving, maximum);
    const f = await createFixtures(receiving);
    await check(`Final ${label} receiving intent, immutable unknown, reasoned resend and manual resolution`, async () => {
      const target = await f.create();
      assert.ok(target.delivery);
      await f.outcome(target, 'unknown');
      const original = await f.row(target.delivery.id);
      assert.equal((await f.current(target)).delivery.state, 'unknown');
      const resend = await f.action('resend', target);
      assert.equal(resend.status, 'queued');
      assert.deepEqual(await f.row(original.id), original);
      const child = { ...target, delivery: await f.row(resend.deliveryId) };
      await f.outcome(child, 'unknown');
      assert.equal((await f.action('manual', child)).status, 'manually_resolved');
      assert.equal((await f.row(original.id)).status, 'unknown');
      assert.equal((await f.row(child.delivery.id)).status, 'unknown');
      assert.equal((await f.current(target)).delivery.state, 'manually_resolved');
    });
  } finally { await receiving.close(); }
  const financial = await createDatabase();
  try {
    await applyThrough(financial, maximum);
    const f = candidateFixtures(await financialNotificationFixtures(financial));
    await verifyFinancialNotificationWorkerActions(f, (name, run) => check(`Final ${label} Financial: ${name}`, run));
    await verifyFinancialHoldPolicy(f, (name, run) => check(`Final ${label} Approved hold policy: ${name}`, run));
  } finally { await financial.close(); }
  const parts = await createDatabase();
  try {
    await applyThrough(parts, 138);
    const base = await partsSmsFixtures(parts);
    const priorCheck = (name, run) => check(`Prior parts reproduction: ${name}`, run);
    await reproduceLegacyPartsSms(base, priorCheck);
    await verifyLegacyPartsSms(base, priorCheck);
    base.legacyBefore = (await parts.query('select * from public.p1_parts_alert_deliveries order by id')).rows;
    await applyThrough(parts, maximum, 139);
    const f = recurrenceFixtures(base);
    const finalCheck = (name, run) => check(`Final ${label} Parts: ${name}`, run);
    await verifyPartsSmsDelivery(f, (name, run) => {
      if (name === 'parts SMS real procurement request A then B then ordering B can recur original exact A signature') {
        console.log('POLICY REPLACEMENT (not a pass): pre0140 blocked-recurrence assertion remains in original 0139 harness; approved recurrence suite runs on final schema.');
        return Promise.resolve();
      }
      return finalCheck(name, run);
    });
    await verifyPartsSmsStatusRuns(f, finalCheck);
    await verifyPartsSmsSecurityActions(f, finalCheck);
    await verifyPartsSmsPagination(f, finalCheck);
    await verifyPartsSmsBoundsCompatibility(f, finalCheck);
    await verifyPartsRecurrencePolicy(f, finalCheck);
    await verifyPartsRecurrenceBoundaries(f, finalCheck);
    await verifyPartsRecurrenceActionsHistory(f, finalCheck);
    await verifyPartsRecurrenceSecurity(f, finalCheck);
  } finally { await parts.close(); }
}
