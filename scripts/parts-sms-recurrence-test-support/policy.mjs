import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { partsSmsOwnerUpdate } from '../parts-sms-test-support/candidate-fixtures.mjs';

async function cycle(f) {
  const target = await f.begin();
  const departure = await f.depart(target);
  const original = await f.freeze(target);
  const returned = await f.returnTo(target, departure);
  return { target, departure, original, returned, child: await f.newestChild(target) };
}

export async function verifyPartsRecurrencePolicy(f, check) {
  await check('approved never-started A→AB→A creates exactly one immutable worker-owned source recurrence child', async () => {
    const { target, departure, original, returned, child } = await cycle(f);
    assert.equal(returned.evaluation.recurrenceQueued, 1);
    assert.equal(returned.evaluation.recurrenceBlocked, 0);
    assert.ok(child);
    assert.equal(child.status, 'pending');
    assert.equal(child.delivery_origin, 'source_recurrence');
    assert.equal(child.parent_delivery_id, target.id);
    assert.equal(child.root_delivery_id, target.id);
    assert.equal(child.recipient_id, target.recipient.id);
    assert.deepEqual(child.local_date, target.event.local_date);
    assert.equal(child.request_signature, target.signature);
    assert.equal((await f.delivery(departure.opposite.id)).status, 'superseded');
    await f.unchanged(target, original);
    const replay = await f.enqueue();
    assert.equal(replay.recurrenceQueued, 0);
    assert.equal((await f.deliveries(target.recipient.id)).length, 3);
    const created = await f.attempts(child.id);
    assert.equal(created.filter(row => row.phase === 'source_recurrence').length, 1);
    assert.equal((await f.db.query('select count(*)::int count from public.p1_parts_sms_operations where delivery_id=$1', [child.id])).rows[0].count, 0);
    const claim = await f.take(child.id);
    const prepared = await f.prepare(child.id, claim.token);
    assert.equal(prepared.requestSignature, target.signature);
    assert.equal(prepared.parts, 1);
    await f.complete(child.id, claim.token, 'accepted', { sid: `SM${randomUUID().replaceAll('-', '')}`, providerStatus: 'queued' });
    assert.equal((await f.delivery(child.id)).status, 'accepted');
    await f.unchanged(target, original);
  });

  await check('repeated source cycles allocate increasing generations and never rewrite or duplicate an earlier child', async () => {
    const target = await f.begin();
    let previous = target;
    for (let index = 0; index < 4; index++) {
      const departure = await f.depart(target);
      const original = await f.freeze(previous);
      const returned = await f.returnTo(target, departure);
      assert.equal(returned.evaluation.recurrenceQueued, 1);
      const child = await f.newestChild(target);
      assert.ok(child);
      assert.equal(child.parent_delivery_id, previous.id);
      assert.equal(child.delivery_origin, 'source_recurrence');
      await f.unchanged(previous, original);
      previous = { ...target, id: child.id };
      for (let repeat = 0; repeat < 3; repeat++) assert.equal((await f.enqueue()).recurrenceQueued, 0);
    }
    const generations = (await f.generations()).filter(row => row.recipient_id === target.recipient.id);
    assert.equal(generations.length, 9);
    assert.deepEqual(generations.map(row => row.generation).sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
    assert.equal(generations.filter(row => row.request_signature === target.signature).length, 5);
    assert.equal((await f.deliveries(target.recipient.id)).filter(row => row.status === 'pending').length, 1);
  });

  await check('claimed-but-never-started source change invalidates the stale claim and permits narrow recurrence', async () => {
    const target = await f.begin();
    const oldClaim = await f.take(target.id);
    const departure = await f.depart(target);
    assert.equal((await f.delivery(target.id)).status, 'superseded');
    const original = await f.freeze(target);
    assert.equal((await f.returnTo(target, departure)).evaluation.recurrenceQueued, 1);
    const child = await f.newestChild(target);
    assert.ok(child);
    assert.equal(await f.prepare(target.id, oldClaim.token), null);
    await f.denied(() => f.complete(target.id, oldClaim.token), ['PT409']);
    await f.unchanged(target, original);
    const current = await f.take(child.id);
    assert.notEqual(current.token, oldClaim.token);
    await f.denied(() => f.complete(child.id, oldClaim.token), ['PT409']);
  });

  await check('expired pre-start claim does not become historical send-start evidence or prevent eligible recurrence', async () => {
    const target = await f.begin();
    await f.take(target.id);
    await partsSmsOwnerUpdate(f.db, 'p1_parts_alert_deliveries',
      "update public.p1_parts_alert_deliveries set claim_expires_at=now()-interval '1 minute' where id=$1", [target.id]);
    const departure = await f.depart(target);
    const result = await f.returnTo(target, departure);
    assert.equal(result.evaluation.recurrenceQueued, 1);
    assert.ok(await f.newestChild(target));
    assert.ok(!(await f.attempts(target.id)).some(row => row.phase === 'send_started'));
  });

  for (const mode of ['sending', 'unknown', 'retryable', 'terminal', 'accepted', 'sent', 'delivered', 'provider_failed', 'provider_undelivered', 'manual', 'legacy']) {
    await check(`any earlier same-recipient/day ${mode} evidence prevents automatic source recurrence`, async () => {
      const target = await f.begin();
      if (mode === 'legacy') await f.legacyBarrier(target);
      else {
        const claim = await f.take(target.id);
        await f.prepare(target.id, claim.token);
        if (mode === 'unknown' || mode === 'manual') await f.complete(target.id, claim.token);
        else if (mode === 'retryable') await f.complete(target.id, claim.token, 'known_unsent_retryable');
        else if (mode === 'terminal') await f.complete(target.id, claim.token, 'known_unsent_terminal');
        else if (mode !== 'sending') await f.complete(target.id, claim.token, 'accepted', {
          sid: `SM${randomUUID().replaceAll('-', '')}`,
          providerStatus: mode === 'accepted' ? 'queued' : mode === 'provider_failed' ? 'failed'
            : mode === 'provider_undelivered' ? 'undelivered' : mode,
        });
        if (mode === 'manual') await f.action('manual', target.id);
      }
      const departure = await f.depart(target);
      const original = await f.freeze(target);
      const returned = await f.returnTo(target, departure);
      assert.equal(returned.evaluation.recurrenceQueued, 0);
      assert.equal(await f.newestChild(target), undefined);
      await f.unchanged(target, original);
      assert.equal((await f.enqueue()).recurrenceQueued, 0);
      if (mode !== 'legacy') assert.ok((await f.attempts(target.id)).some(row => row.phase === 'send_started'));
    });
  }

  await check('send-start on the intervening AB signature blocks recurrence of unsent A', async () => {
    const target = await f.begin();
    const departure = await f.depart(target);
    const original = await f.freeze(target);
    const claim = await f.take(departure.opposite.id);
    await f.prepare(departure.opposite.id, claim.token);
    await f.complete(departure.opposite.id, claim.token, 'known_unsent_terminal');
    const returned = await f.returnTo(target, departure);
    assert.equal(returned.evaluation.recurrenceQueued, 0);
    assert.equal(await f.newestChild(target), undefined);
    await f.unchanged(target, original);
  });

  await check('source changes after a recurrence child was claimed invalidate its stale worker without touching prior generations', async () => {
    const { target, child, original } = await cycle(f);
    const claim = await f.take(child.id);
    await f.depart(target);
    assert.equal((await f.delivery(child.id)).status, 'superseded');
    assert.equal(await f.prepare(child.id, claim.token), null);
    await f.denied(() => f.complete(child.id, claim.token), ['PT409']);
    await f.unchanged(target, original);
  });

  await check('unknown recurrence child remains quarantined and cannot generate another automatic recurrence', async () => {
    const { target, child } = await cycle(f);
    const claim = await f.take(child.id);
    await f.prepare(child.id, claim.token);
    await f.complete(child.id, claim.token);
    const frozen = await f.freeze({ id: child.id });
    const departure = await f.depart(target);
    const returned = await f.returnTo(target, departure);
    assert.equal(returned.evaluation.recurrenceQueued, 0);
    assert.equal((await f.deliveries(target.recipient.id)).filter(row => row.delivery_origin === 'source_recurrence').length, 1);
    await f.unchanged({ id: child.id }, frozen);
  });

  await check('current recurrence visibility distinguishes recovery from staff resend, retains safe bounded history', async () => {
    const { target, child, departure } = await cycle(f);
    const current = await f.current(child.id);
    assert.equal(current.origin, 'source_recurrence');
    assert.equal(current.current, true);
    assert.equal(current.state, 'pending');
    assert.equal(current.canResend, false);
    assert.equal(current.canResolve, false);
    assert.ok(Number.isInteger(current.recurrenceGeneration));
    const history = await f.history(child.id, { limit: 50 });
    assert.ok(history.items.some(row => row.kind === 'source_recurrence'));
    assert.ok(history.items.some(row => row.id.includes(target.id)));
    assert.ok(history.items.some(row => row.id.includes(departure.opposite.id)));
    assert.ok(history.items.length <= 50);
    assert.doesNotMatch(JSON.stringify({ current, history }), /\+1202555|phone_snapshot|Synthetic parts SMS request|provider_message_id/);
    assert.equal((await f.page({ search: target.recipient.id })).items.some(row => row.id === target.id), false);
    const historical = await f.page({ state: 'history', search: target.recipient.id });
    assert.ok(historical.items.some(row => row.id === child.id));
    assert.equal((await f.current(target.id)).canResend, false);
  });
}
