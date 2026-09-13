import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { partsSmsOwnerUpdate } from '../parts-sms-test-support/candidate-fixtures.mjs';

async function recover(f) {
  const target = await f.begin();
  const away = await f.depart(target);
  assert.equal((await f.returnTo(target, away)).evaluation.recurrenceQueued, 1);
  return { target, child: await f.newestChild(target) };
}

export async function verifyPartsRecurrenceActionsHistory(f, check) {
  await check('current unknown recurrence retains reasoned immutable explicit resend and operation replay without automatic resend', async () => {
    const { child } = await recover(f);
    const claim = await f.take(child.id);
    await f.prepare(child.id, claim.token);
    await f.complete(child.id, claim.token);
    const original = await f.freeze({ id: child.id });
    const view = await f.current(child.id);
    assert.equal(view.current, true);
    assert.equal(view.canResend, true);
    assert.equal((await f.enqueue()).recurrenceQueued, 0);
    for (const reason of ['', 'x'.repeat(501)]) await f.denied(() => f.action('resend', child.id, { reason }), ['PT422']);
    const operation = randomUUID();
    const result = await f.action('resend', child.id, { operation, reason: 'Synthetic explicitly confirmed duplicate-risk review' });
    assert.equal(result.status, 'queued');
    assert.equal((await f.delivery(result.deliveryId)).delivery_origin, 'explicit_resend');
    const repeated = await f.action('resend', child.id, { operation, reason: 'Synthetic explicitly confirmed duplicate-risk review' });
    assert.equal(repeated.deliveryId, result.deliveryId);
    assert.equal(repeated.replayed, true);
    await f.denied(() => f.action('resend', child.id, { operation, reason: 'Changed operation reason' }), ['PT409']);
    // Staff operation is appended to the parent, but provider rows/journal never change.
    assert.deepEqual(await f.delivery(child.id), original.delivery);
    assert.deepEqual(await f.attempts(child.id), original.attempts);
  });

  await check('unknown child from an earlier observed generation cannot be resent on source return but can be reviewed out of band', async () => {
    const { target, child } = await recover(f);
    const claim = await f.take(child.id);
    await f.prepare(child.id, claim.token);
    await f.complete(child.id, claim.token);
    const original = await f.freeze({ id: child.id });
    const away = await f.depart(target);
    const returned = await f.returnTo(target, away);
    assert.equal(returned.evaluation.recurrenceQueued, 0);
    const view = await f.current(child.id);
    assert.equal(view.current, false);
    assert.equal(view.canResend, false);
    assert.equal(view.canResolve, true);
    await f.denied(() => f.action('resend', child.id), ['PT409']);
    const operation = randomUUID();
    assert.equal((await f.action('manual', child.id, { operation })).status, 'manually_resolved');
    assert.equal((await f.action('manual', child.id, { operation })).replayed, true);
    assert.deepEqual(await f.delivery(child.id), original.delivery);
    assert.deepEqual(await f.attempts(child.id), original.attempts);
    assert.equal((await f.current(child.id)).state, 'manually_resolved');
  });

  await check('manual resolution without any provider send-start independently bars automatic source recurrence', async () => {
    const target = await f.begin();
    const claim = await f.take(target.id);
    await f.configure({ recipients: [{ profileId: target.profileId, phoneE164: '+12025550129', active: true }] });
    assert.equal((await f.prepare(target.id, claim.token)).status, 'not_deliverable');
    assert.ok(!(await f.attempts(target.id)).some(row => row.phase === 'send_started'));
    await f.action('manual', target.id);
    await f.configure({ recipients: [{ profileId: target.profileId, phoneE164: '+12025550123', active: true }] });
    const away = await f.depart(target);
    const original = await f.freeze(target);
    assert.equal((await f.returnTo(target, away)).evaluation.recurrenceQueued, 0);
    assert.equal(await f.newestChild(target), undefined);
    await f.unchanged(target, original);
    assert.equal((await f.current(target.id)).state, 'manually_resolved');
  });

  await check('returned failed or unavailable original cannot bypass blocked recurrence with direct staff resend/manual RPC', async () => {
    for (const mode of ['failed', 'not_deliverable']) {
      const target = await f.begin();
      const claim = await f.take(target.id);
      await f.prepare(target.id, claim.token);
      await f.complete(target.id, claim.token, 'known_unsent_terminal', { code: mode === 'failed' ? 'PARTS_SMS_MESSAGE_INVALID' : 'TWILIO_NOT_CONFIGURED' });
      const away = await f.depart(target);
      await f.returnTo(target, away);
      const original = await f.freeze(target);
      const view = await f.current(target.id);
      assert.equal(view.current, false);
      assert.equal(view.canResend, false);
      await f.denied(() => f.action('resend', target.id), ['PT409']);
      await f.denied(() => f.action('manual', target.id), ['PT409']);
      await f.unchanged(target, original);
    }
  });

  await check('cached cleared fields never erase historical send-start barrier', async () => {
    const target = await f.begin();
    const claim = await f.take(target.id);
    await f.prepare(target.id, claim.token);
    await f.complete(target.id, claim.token, 'known_unsent_terminal');
    assert.equal((await f.delivery(target.id)).send_started_at, null);
    assert.ok((await f.attempts(target.id)).some(row => row.phase === 'send_started'));
    const away = await f.depart(target);
    const returned = await f.returnTo(target, away);
    assert.equal(returned.evaluation.recurrenceQueued, 0);
    assert.equal(await f.newestChild(target), undefined);
  });

  await check('incomplete claimed/failed history cannot be interpreted as proven never-started', async () => {
    const target = await f.begin();
    const away = await f.depart(target);
    await partsSmsOwnerUpdate(f.db, 'p1_parts_sms_attempt_events',
      "delete from public.p1_parts_sms_attempt_events where delivery_id=$1 and phase='cancelled'", [target.id]);
    const before = await f.freeze(target);
    const result = await f.returnTo(target, away);
    assert.equal(result.evaluation.recurrenceQueued, 0);
    assert.equal(result.evaluation.recurrenceBlocked, 1);
    assert.equal((await f.current(target.id)).recurrenceBlockCategory, 'proof_incomplete');
    await f.unchanged(target, before);
  });

  await check('same-generation child unavailable before start cannot silently create another automatic child after correction', async () => {
    const { target, child } = await recover(f);
    const claim = await f.take(child.id);
    await f.configure({ recipients: [{ profileId: target.profileId, phoneE164: '+12025550129', active: true }] });
    assert.equal((await f.prepare(child.id, claim.token)).status, 'not_deliverable');
    const original = await f.freeze({ id: child.id });
    await f.configure({ recipients: [{ profileId: target.profileId, phoneE164: '+12025550123', active: true }] });
    assert.equal((await f.enqueue()).recurrenceQueued, 0);
    assert.equal((await f.deliveries(target.recipient.id)).filter(row => row.delivery_origin === 'source_recurrence').length, 1);
    await f.unchanged({ id: child.id }, original);
  });

  await check('bounded same-day recurrence history traverses tied evidence once and excludes new arrivals past first-page boundary', async () => {
    const { target, child } = await recover(f);
    await partsSmsOwnerUpdate(f.db, 'p1_parts_sms_attempt_events', `insert into public.p1_parts_sms_attempt_events
      (id,delivery_id,sequence,phase,claim_token,state,code,created_at)
      select gen_random_uuid(),$1,n,'expired',gen_random_uuid(),'pending','CLAIM_EXPIRED_BEFORE_SEND',transaction_timestamp()-interval '1 hour'
      from generate_series(1,75)n`, [target.id]);
    const first = await f.history(child.id, { limit: 10 });
    assert.equal(first.items.length, 10);
    const added = randomUUID();
    await partsSmsOwnerUpdate(f.db, 'p1_parts_sms_attempt_events', `insert into public.p1_parts_sms_attempt_events
      (id,delivery_id,sequence,phase,claim_token,state,code) values($1,$2,80,'expired',$3,'pending','CLAIM_EXPIRED_BEFORE_SEND')`, [added, target.id, randomUUID()]);
    const ids = first.items.map(row => row.id);
    let cursor = first.nextCursor;
    for (let page = 0; cursor && page < 20; page++) {
      const next = await f.history(child.id, { limit: 10, cursor });
      ids.push(...next.items.map(row => row.id));
      cursor = next.nextCursor;
    }
    assert.equal(cursor, null);
    assert.equal(ids.length, new Set(ids).size);
    assert.ok(!ids.includes(`attempt:${added}`));
    assert.ok(ids.includes(`delivery:${target.id}`));
    assert.ok(ids.includes(`delivery:${child.id}`));
    await f.denied(() => f.history(target.id, { cursor: first.nextCursor }), ['PT422']);
  });

  await check('known-unsent retry completed before durable send-start is cancelled atomically by safe source recurrence', async () => {
    const target = await f.begin();
    const claim = await f.take(target.id);
    await f.complete(target.id, claim.token, 'known_unsent_retryable');
    assert.ok(!(await f.attempts(target.id)).some(row => row.phase === 'send_started'));
    assert.ok((await f.delivery(target.id)).next_attempt_at);
    const departure = await f.depart(target);
    assert.equal((await f.delivery(target.id)).status, 'superseded');
    assert.equal((await f.delivery(target.id)).next_attempt_at, null);
    const original = await f.freeze(target);
    assert.equal((await f.returnTo(target, departure)).evaluation.recurrenceQueued, 1);
    assert.ok(await f.newestChild(target));
    await f.unchanged(target, original);
  });

  await check('claimed intervening source is cancelled before recurrence child admission and cannot later send or complete', async () => {
    const target = await f.begin();
    const departure = await f.depart(target);
    const claim = await f.take(departure.opposite.id);
    const result = await f.returnTo(target, departure);
    assert.equal(result.evaluation.recurrenceQueued, 1);
    const stale = await f.delivery(departure.opposite.id);
    assert.equal(stale.status, 'superseded');
    assert.equal(stale.claim_token, null);
    assert.equal(stale.claim_expires_at, null);
    assert.equal(await f.prepare(stale.id, claim.token), null);
    await f.denied(() => f.complete(stale.id, claim.token), ['PT409']);
  });

  for (const evidence of ['missing_claimed_journal', 'cached_sid']) {
    await check(`independent ${evidence} evidence prevents recurrence even when no send-start appears in cached state`, async () => {
      const target = await f.begin();
      const departure = await f.depart(target);
      if (evidence === 'missing_claimed_journal') await partsSmsOwnerUpdate(f.db, 'p1_parts_alert_deliveries',
        'update public.p1_parts_alert_deliveries set attempt_count=1 where id=$1', [target.id]);
      else await partsSmsOwnerUpdate(f.db, 'p1_parts_alert_deliveries',
        'update public.p1_parts_alert_deliveries set provider_message_id=$2 where id=$1', [target.id, `SM${randomUUID().replaceAll('-', '')}`]);
      const original = await f.freeze(target);
      assert.equal((await f.returnTo(target, departure)).evaluation.recurrenceQueued, 0);
      assert.equal(await f.newestChild(target), undefined);
      assert.equal((await f.current(target.id)).recurrenceBlockCategory, evidence === 'missing_claimed_journal' ? 'proof_incomplete' : 'daily_outcome');
      await f.unchanged(target, original);
    });
  }

  await check('later other same-day manual or provider evidence blocks current unknown-child resend without hiding manual review', async () => {
    for (const outcome of ['manual', 'unknown', 'provider_sid']) {
      const { target, child } = await recover(f);
      const claim = await f.take(child.id);
      await f.prepare(child.id, claim.token);
      await f.complete(child.id, claim.token);
      assert.equal((await f.current(child.id)).canResend, true);
      const other = (await f.deliveries(target.recipient.id)).find(row => row.request_signature !== target.signature);
      assert.ok(other);
      // Isolated owner fixtures model later durable evidence which cannot be
      // manufactured by browser or ordinary service callers (tested separately).
      if (outcome === 'manual') await partsSmsOwnerUpdate(f.db, 'p1_parts_sms_operations', `insert into public.p1_parts_sms_operations
        (operation_id,delivery_id,action,actor_id,reason) values($1,$2,'manual_resolution',$3,'Synthetic later historical review')`,
      [randomUUID(), other.id, f.actors.mgr]);
      else await partsSmsOwnerUpdate(f.db, 'p1_parts_sms_attempt_events', `insert into public.p1_parts_sms_attempt_events
        (delivery_id,sequence,phase,claim_token,state,outcome,provider_message_id)
        values($1,1,'completed',$2,$3,$3,$4)`, [other.id, randomUUID(), outcome === 'unknown' ? 'unknown' : 'accepted',
        outcome === 'provider_sid' ? `SM${randomUUID().replaceAll('-', '')}` : null]);
      const original = await f.freeze({ id: child.id });
      const view = await f.current(child.id);
      assert.equal(view.canResend, false);
      assert.equal(view.canResolve, true);
      await f.denied(() => f.action('resend', child.id), ['PT409']);
      assert.equal((await f.action('manual', child.id)).status, 'manually_resolved');
      assert.deepEqual(await f.delivery(child.id), original.delivery);
      assert.deepEqual(await f.attempts(child.id), original.attempts);
      assert.equal((await f.delivery(child.id)).status, 'unknown');
    }
  });
}
