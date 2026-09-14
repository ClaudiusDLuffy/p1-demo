import assert from 'node:assert/strict';
import { partsSmsOwnerUpdate } from '../parts-sms-test-support/candidate-fixtures.mjs';

export async function verifyPartsRecurrenceBoundaries(f, check) {
  for (const setting of ['disabled', 'before_cutoff']) {
    await check(`source recurrence respects ${setting} and proceeds only after the approved current window returns`, async () => {
      const target = await f.begin();
      const departure = await f.depart(target);
      await f.order(departure.partB);
      const recipient = [{ profileId: target.profileId, phoneE164: '+12025550123', active: true }];
      if (setting === 'disabled') await f.configure({ enabled: false, recipients: recipient });
      else {
        const time = (await f.db.query("select to_char(clock_timestamp() at time zone 'UTC','HH24:MI') time")).rows[0].time;
        assert.notEqual(time, '23:59', 'Run before-cutoff fixture away from the final local minute');
        await f.configure({ cutoff: '23:59', recipients: recipient });
      }
      const blocked = await f.enqueue();
      assert.equal(blocked.status, setting);
      assert.equal(blocked.recurrenceQueued, 0);
      assert.equal(await f.newestChild(target), undefined);
      await f.configure({ recipients: recipient });
      assert.equal((await f.enqueue()).recurrenceQueued, 1);
      const child = await f.newestChild(target);
      assert.equal(child.status, 'pending');
    });
  }

  for (const invalidation of ['profile_inactive', 'recipient_inactive']) {
    await check(`never-started ${invalidation} source recurrence is withheld and corrected safely without rewriting its parent`, async () => {
      const target = await f.begin();
      const departure = await f.depart(target);
      await f.order(departure.partB);
      const original = await f.freeze(target);
      if (invalidation === 'profile_inactive') await partsSmsOwnerUpdate(f.db, 'profiles', 'update public.profiles set active=false where id=$1', [target.profileId]);
      else await f.configure({ recipients: [{ profileId: target.profileId, phoneE164: '+12025550123', active: false }] });
      const result = await f.enqueue();
      assert.equal(result.recurrenceQueued, 0);
      assert.equal(await f.newestChild(target), undefined);
      await f.unchanged(target, original);
      if (invalidation === 'profile_inactive') await partsSmsOwnerUpdate(f.db, 'profiles', 'update public.profiles set active=true where id=$1', [target.profileId]);
      await f.configure({ recipients: [{ profileId: target.profileId, phoneE164: '+12025550123', active: true }] });
      assert.equal((await f.enqueue()).recurrenceQueued, 1);
      const child = await f.newestChild(target);
      assert.equal(child.phone_snapshot, target.event.phone_snapshot);
      await f.unchanged(target, original);
    });
  }

  await check('approved never-started recurrence snapshots corrected current recipient phone without rewriting historical contact identity', async () => {
    const target = await f.begin();
    const departure = await f.depart(target);
    const original = await f.freeze(target);
    await f.configure({ recipients: [{ profileId: target.profileId, phoneE164: '+12025550129', active: true }] });
    assert.equal((await f.returnTo(target, departure)).evaluation.recurrenceQueued, 1);
    const child = await f.newestChild(target);
    assert.equal(child.phone_snapshot, '+12025550129');
    assert.equal(child.recipient_profile_id, target.profileId);
    await f.unchanged(target, original);
    const claimed = await f.take(child.id);
    await f.configure({ recipients: [{ profileId: target.profileId, phoneE164: '+12025550128', active: true }] });
    assert.equal((await f.prepare(child.id, claimed.token)).status, 'not_deliverable');
    assert.ok(!(await f.attempts(child.id)).some(row => row.phase === 'send_started'));
  });

  await check('proven pre-network recipient failure without any durable send-start may recover after config correction and real recurrence', async () => {
    const target = await f.begin();
    const claim = await f.take(target.id);
    await f.configure({ recipients: [{ profileId: target.profileId, phoneE164: '+12025550129', active: true }] });
    assert.equal((await f.prepare(target.id, claim.token)).status, 'not_deliverable');
    assert.ok(!(await f.attempts(target.id)).some(row => row.phase === 'send_started'));
    await f.configure({ recipients: [{ profileId: target.profileId, phoneE164: '+12025550123', active: true }] });
    const departure = await f.depart(target);
    const original = await f.freeze(target);
    const unavailableBefore = (await f.health()).notDeliverableCount;
    assert.equal((await f.returnTo(target, departure)).evaluation.recurrenceQueued, 1);
    const child = await f.newestChild(target);
    assert.ok(child);
    const historical = await f.current(target.id);
    assert.equal(historical.current, false, 'Immutable unavailable parent is historical once a recovery child exists');
    assert.equal(historical.canResend, false);
    await assert.rejects(f.action('resend', target.id), error => error.code === 'PT409' && error.message === 'STALE_DIGEST');
    const current = await f.current(child.id);
    assert.equal(current.current, true);
    assert.equal(current.state, 'pending');
    assert.equal((await f.health()).notDeliverableCount, unavailableBefore - 1, 'Historical parent must not inflate global actionable health');
    assert.equal((await f.db.query(`select count(*)::int count from public.p1_parts_alert_deliveries d
      where d.recipient_id=$1 and d.status='not_deliverable'
      and not exists(select 1 from public.p1_parts_alert_deliveries child where child.parent_delivery_id=d.id)`, [target.recipient.id])).rows[0].count, 0);
    await f.unchanged(target, original);
  });

  await check('per-recipient daily barrier isolates started recipient from an independent never-started recipient', async () => {
    const target = await f.begin();
    const originalClaim = await f.take(target.id);
    await f.prepare(target.id, originalClaim.token);
    await f.complete(target.id, originalClaim.token);
    await f.configure({ recipients: [
      { profileId: target.profileId, phoneE164: '+12025550123', active: true },
      { profileId: f.actors.mgr, phoneE164: '+12025550124', active: true },
    ] });
    await f.enqueue();
    const otherRecipient = (await f.db.query('select * from public.p1_parts_alert_recipients where profile_id=$1', [f.actors.mgr])).rows[0];
    const otherEvent = (await f.deliveries(otherRecipient.id)).find(row => Number(row.local_date) === Number(target.event.local_date) && row.request_signature === target.signature);
    assert.ok(otherEvent);
    const other = { ...target, id: otherEvent.id, event: otherEvent, recipient: otherRecipient };
    const departure = await f.depart(target);
    const returned = await f.returnTo(target, departure);
    assert.equal(returned.evaluation.recurrenceQueued, 1);
    assert.equal(await f.newestChild(target), undefined);
    assert.ok(await f.newestChild(other));
    assert.equal((await f.delivery(target.id)).status, 'unknown');
  });

  await check('different authoritative local date is independent from earlier-day accepted or unknown evidence', async () => {
    const target = await f.scenario();
    const recipient = [{ profileId: target.profileId, phoneE164: '+12025550123', active: true }];
    await f.configure({ timezone: 'Etc/GMT+12', recipients: recipient });
    await f.enqueue();
    const original = (await f.deliveries(target.recipient.id)).at(-1);
    const claim = await f.take(original.id);
    await f.prepare(original.id, claim.token);
    await f.complete(original.id, claim.token);
    await f.configure({ timezone: 'Etc/GMT-14', recipients: recipient });
    const evaluation = await f.enqueue();
    assert.equal(evaluation.queued, 1);
    assert.equal(evaluation.recurrenceQueued, 0);
    const current = (await f.deliveries(target.recipient.id)).find(row => row.id !== original.id);
    assert.ok(current);
    assert.ok(current.local_date > original.local_date);
    assert.equal(current.parent_delivery_id, null);
    assert.equal(current.delivery_origin, 'initial');
    assert.equal((await f.delivery(original.id)).status, 'unknown');
  });

  await check('equal source observation timestamps remain deterministic through immutable sequence and identity', async () => {
    const target = await f.begin();
    const departure = await f.depart(target);
    await f.returnTo(target, departure);
    await f.db.transaction(async tx => {
      await tx.exec('alter table public.p1_parts_sms_source_generations disable trigger user');
      await tx.query(`update public.p1_parts_sms_source_generations set observed_at=transaction_timestamp()-interval '1 hour'
        where recipient_id=$1`, [target.recipient.id]);
      await tx.exec('alter table public.p1_parts_sms_source_generations enable trigger user');
    });
    const next = await f.depart(target);
    assert.equal((await f.returnTo(target, next)).evaluation.recurrenceQueued, 1);
    const generations = (await f.generations()).filter(row => row.recipient_id === target.recipient.id);
    assert.deepEqual(generations.map(row => row.generation).sort((a, b) => a - b), [1, 2, 3, 4, 5]);
    const child = await f.newestChild(target);
    assert.equal((await f.current(child.id)).recurrenceGeneration, 5);
  });

  await check('genuinely empty requested-parts observation is a distinct generation without historical catch-up or duplicate observations', async () => {
    const target = await f.begin();
    await f.order(target.part);
    assert.equal((await f.enqueue()).status, 'nothing_to_send');
    const afterEmpty = (await f.generations()).filter(row => row.recipient_id === target.recipient.id);
    assert.equal(afterEmpty.length, 2);
    assert.notEqual(afterEmpty[0].request_signature, afterEmpty[1].request_signature);
    assert.equal((await f.enqueue()).status, 'nothing_to_send');
    assert.equal((await f.generations()).filter(row => row.recipient_id === target.recipient.id).length, 2);
    await f.source();
    const newRequest = await f.enqueue();
    assert.equal(newRequest.queued, 1);
    assert.equal(newRequest.recurrenceQueued, 0);
    assert.equal((await f.generations()).filter(row => row.recipient_id === target.recipient.id).length, 3);
  });
}
