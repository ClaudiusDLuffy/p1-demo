import assert from 'node:assert/strict';
import { createDatabase, applyThrough, partsSmsFixtures } from '../parts-sms-test-support/fixtures.mjs';
import { partsSmsOwnerUpdate } from '../parts-sms-test-support/candidate-fixtures.mjs';
import { recurrenceFixtures } from './fixtures.mjs';
import { applyPartsRecurrenceMigration } from './migration.mjs';

export async function verifyPartsRecurrenceUpgradeBoundaries(check) {
  const db = await createDatabase();
  try {
    await applyThrough(db, 139);
    const f = recurrenceFixtures(await partsSmsFixtures(db));
    const target = await f.begin();
    const away = await f.depart(target);
    await f.returnTo(target, away);
    await partsSmsOwnerUpdate(db, 'p1_parts_alert_deliveries', `update public.p1_parts_alert_deliveries
      set created_at=transaction_timestamp()-interval '1 hour' where recipient_id=$1`, [target.recipient.id]);
    const original = await f.freeze(target);
    await applyPartsRecurrenceMigration(db);
    await check('tied pre0140 source timestamps do not invent historical chronology or automatically reopen an ambiguous original', async () => {
      const result = await f.enqueue();
      assert.equal(result.recurrenceQueued, 0);
      assert.equal(result.recurrenceBlocked, 1);
      assert.equal(await f.newestChild(target), undefined);
      assert.equal((await f.current(target.id)).recurrenceBlockCategory, 'proof_incomplete');
      const observations = (await f.generations()).filter(row => row.recipient_id === target.recipient.id);
      assert.equal(observations.length, 1);
      assert.equal(observations[0].source_kind, 'snapshot');
      await f.unchanged(target, original, true);
    });
    await check('new genuine post-upgrade observations can prove a later recurrence without rewriting ambiguous historical ordering', async () => {
      const next = await f.depart(target);
      assert.equal((await f.returnTo(target, next)).evaluation.recurrenceQueued, 1);
      const child = await f.newestChild(target);
      assert.ok(child);
      assert.equal(child.delivery_origin, 'source_recurrence');
      assert.equal((await f.current(child.id)).recurrenceGeneration, 3);
      await f.unchanged(target, original, true);
      assert.ok((await f.generations()).filter(row => row.recipient_id === target.recipient.id).every(row => row.source_kind === 'snapshot'));
    });
  } finally { await db.close(); }
}
