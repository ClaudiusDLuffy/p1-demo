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

export async function verifyPriorPartsSmsSchema(check, maximum = 140) {
  assert.ok([139, 140].includes(maximum));
  const label = String(maximum).padStart(4, '0');
  // Existing checks execute unchanged against the final migration target. The
  // original source files and their assertions remain untouched.
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
    await check(`final${label} receiving intent, unknown quarantine, bounded status, reasoned resend and manual resolution remain`, async () => {
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
}
