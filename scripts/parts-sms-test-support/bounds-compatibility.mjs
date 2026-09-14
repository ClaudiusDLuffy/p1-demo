import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { partsSmsOwnerUpdate } from './candidate-fixtures.mjs';

async function syntheticRecipients(f, count) {
  const recipients = [];
  for (let index = 0; index < count; index++) {
    const profileId = randomUUID();
    await f.db.query('insert into auth.users(id,email) values($1,$2)', [profileId, `${profileId}@parts-bounds.example.invalid`]);
    await f.db.query("update public.profiles set role='back_office',active=true,name='Synthetic bounded recipient' where id=$1", [profileId]);
    recipients.push({ profileId, phoneE164: `+120255501${String(index).padStart(2, '0')}`, active: true });
  }
  return recipients;
}

export async function verifyPartsSmsBoundsCompatibility(f, check) {
  await check('parts SMS maximum twenty-five recipients are independent durable events with bounded one-row claims', async () => {
    const recipients = await syntheticRecipients(f, 25);
    await f.scenario({ recipients });
    const enqueued = await f.enqueue();
    assert.equal(enqueued.queued, 25);
    assert.equal((await f.enqueue()).queued, 0);
    const recipientRows = (await f.db.query('select id from public.p1_parts_alert_recipients where profile_id=any($1::uuid[])', [recipients.map(row => row.profileId)])).rows;
    const ids = new Set(recipientRows.map(row => row.id));
    const events = (await f.deliveries()).filter(row => ids.has(row.recipient_id));
    assert.equal(events.length, 25);
    let completed = 0;
    for (const event of events) {
      const claim = await f.take(event.id);
      assert.equal(Object.keys(claim.claim).join(','), 'id');
      await f.prepare(event.id, claim.token);
      await f.complete(event.id, claim.token);
      completed++;
    }
    assert.equal(completed, 25);
    assert.ok((await f.deliveries()).filter(row => ids.has(row.recipient_id)).every(row => row.status === 'unknown'));
  });
  await check('parts SMS provider outcomes remain isolated across recipients and active profile loss becomes visible', async () => {
    const recipients = await syntheticRecipients(f, 5);
    await f.scenario({ recipients });
    await f.enqueue();
    const recipientRows = (await f.db.query('select id,profile_id from public.p1_parts_alert_recipients where profile_id=any($1::uuid[])', [recipients.map(row => row.profileId)])).rows;
    const profileFor = new Map(recipientRows.map(row => [row.id, row.profile_id]));
    const events = (await f.deliveries()).filter(row => profileFor.has(row.recipient_id));
    const outcomes = ['accepted', 'known_unsent_terminal', 'unknown', 'inactive', 'known_unsent_retryable'];
    for (let index = 0; index < events.length; index++) {
      const event = events[index];
      const claim = await f.take(event.id);
      const outcome = outcomes[index];
      if (outcome === 'inactive') {
        await partsSmsOwnerUpdate(f.db, 'profiles', 'update public.profiles set active=false where id=$1', [profileFor.get(event.recipient_id)]);
        assert.equal((await f.prepare(event.id, claim.token)).status, 'not_deliverable');
      } else if (outcome === 'known_unsent_retryable') {
        await f.complete(event.id, claim.token, outcome);
      } else {
        await f.prepare(event.id, claim.token);
        await f.complete(event.id, claim.token, outcome, outcome === 'accepted'
          ? { sid: `SM${randomUUID().replaceAll('-', '')}`, providerStatus: 'queued' }
          : outcome === 'known_unsent_terminal' ? { code: 'PARTS_SMS_MESSAGE_INVALID' } : {});
      }
    }
    const states = await Promise.all(events.map(event => f.delivery(event.id).then(row => row.status)));
    assert.deepEqual(states, ['accepted', 'failed', 'unknown', 'not_deliverable', 'failed']);
    assert.ok((await f.delivery(events.at(-1).id)).next_attempt_at);
    assert.equal((await f.delivery(events[1].id)).next_attempt_at, null);
  });
  await check('parts SMS unavailable recipient/configuration can be corrected only through reasoned new attempt', async () => {
    const target = await f.make('known_unsent_terminal');
    assert.equal((await f.delivery(target.id)).status, 'not_deliverable');
    const original = await f.attempts(target.id);
    const resend = await f.action('resend', target.id);
    assert.equal(resend.status, 'queued');
    assert.deepEqual(await f.attempts(target.id), original);
    const claim = await f.take(resend.deliveryId);
    await f.prepare(resend.deliveryId, claim.token);
    await f.complete(resend.deliveryId, claim.token);
  });
  await check('parts SMS accepted undelivered/failed may be explicitly resent but current SID unknown cannot', async () => {
    for (const providerStatus of ['undelivered', 'failed']) {
      const target = await f.make('accepted', { sid: `SM${randomUUID().replaceAll('-', '')}`, providerStatus });
      const resend = await f.action('resend', target.id);
      assert.equal(resend.status, 'queued');
      const claim = await f.take(resend.deliveryId);
      await f.prepare(resend.deliveryId, claim.token);
      await f.complete(resend.deliveryId, claim.token);
    }
    const target = await f.make('unknown', { sid: `MM${randomUUID().replaceAll('-', '')}` });
    assert.equal((await f.current(target.id)).canResend, false);
    await f.denied(() => f.action('resend', target.id), ['PT409']);
  });
  await check('parts SMS overdue pending and expired claim surface accurate non-actionable heartbeat queue states', async () => {
    const target = await f.make();
    await partsSmsOwnerUpdate(f.db, 'p1_parts_alert_deliveries', "update public.p1_parts_alert_deliveries set created_at=clock_timestamp()-interval '7 minutes' where id=$1", [target.id]);
    let view = (await f.page({ search: target.recipient.id })).items.find(row => row.id === target.id);
    assert.equal(view.state, 'pending');
    assert.equal(view.code, 'PENDING_WORKER_DELAY');
    assert.equal(view.canResend, false);
    assert.equal(view.canResolve, false);
    const claim = await f.take(target.id);
    await f.prepare(target.id, claim.token);
    await partsSmsOwnerUpdate(f.db, 'p1_parts_alert_deliveries', "update public.p1_parts_alert_deliveries set claim_expires_at=clock_timestamp()-interval '1 second' where id=$1", [target.id]);
    view = (await f.page({ search: target.recipient.id })).items.find(row => row.id === target.id);
    assert.equal(view.state, 'sending');
    assert.equal(view.code, 'CLAIM_EXPIRED_REVIEW');
    assert.equal(view.canResend, false);
    assert.equal(view.canResolve, false);
    await f.claim();
    assert.equal((await f.current(target.id)).state, 'unknown');
  });
  await check('parts SMS twentieth provider status lease is bounded and not reset during active final poll', async () => {
    const providerMessageId = `SM${randomUUID().replaceAll('-', '')}`;
    const target = await f.make('accepted', { sid: providerMessageId, providerStatus: 'queued' });
    await partsSmsOwnerUpdate(f.db, 'p1_parts_alert_deliveries', "update public.p1_parts_alert_deliveries set status_check_count=19,next_status_at=clock_timestamp()-interval '1 second' where id=$1", [target.id]);
    const first = await f.statusClaim();
    assert.equal(first.claim.id, target.id);
    assert.notEqual((await f.statusClaim()).claim?.id, target.id);
    assert.equal((await f.delivery(target.id)).status_check_stale, false, 'Live twentieth status claim may complete');
    await f.statusComplete(target.id, first.token, 'delivered', null, providerMessageId);
    assert.equal((await f.delivery(target.id)).status, 'delivered');
    await f.denied(() => f.statusComplete(target.id, null, 'delivered', null, providerMessageId), ['PT422']);
  });
  await check('parts SMS recipient cap and source overflow are visible bounds, not partial undocumented selection', async () => {
    const target = await f.scenario();
    await partsSmsOwnerUpdate(f.db, 'wo_parts', `insert into public.wo_parts(id,work_order_id,description,qty,created_by,ordering_responsibility,p1_order_status,p1_requested_at,p1_requested_by)
      select gen_random_uuid(),$1,'Synthetic capacity-only part',1,$2,'p1','requested',clock_timestamp(),$2 from generate_series(1,10000)`, [target.part.workOrderId, f.actors.mgr]);
    const before = await f.deliveries(target.recipient.id);
    assert.equal((await f.enqueue()).status, 'capacity_exceeded');
    assert.deepEqual(await f.deliveries(target.recipient.id), before);
    await partsSmsOwnerUpdate(f.db, 'wo_parts', "update public.wo_parts set p1_order_status='cancelled' where description='Synthetic capacity-only part'");
  });
}
