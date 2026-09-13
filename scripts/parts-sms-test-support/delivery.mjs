import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { failPartsSmsWrite, partsSmsOwnerUpdate } from './candidate-fixtures.mjs';

const syntheticSid = () => `SM${randomUUID().replaceAll('-', '')}`;
const expire = (f, id) => partsSmsOwnerUpdate(f.db, 'p1_parts_alert_deliveries',
  "update public.p1_parts_alert_deliveries set claim_expires_at=clock_timestamp()-interval '1 second' where id=$1", [id]);

export async function verifyPartsSmsDelivery(f, check) {
  await check('parts SMS expansion preserves legacy bytes and quarantines historical uncertain rows', async () => {
    for (const before of f.legacyBefore) {
      const after = await f.delivery(before.id);
      for (const [key, value] of Object.entries(before)) assert.deepEqual(after[key], value);
      assert.equal(after.provenance, 'legacy');
      const view = await f.current(after.id);
      assert.equal(view.legacy, true);
      assert.equal(view.canResend, false);
      if (before.status !== 'sent') assert.equal(view.state, 'unknown');
    }
    const rows = await f.page();
    assert.ok(rows.items.some(row => row.legacy && row.state === 'unknown'));
  });
  await check('parts SMS eligible request atomically creates one immutable original per recipient/date/signature', async () => {
    const target = await f.make();
    assert.equal(target.event.status, 'pending');
    assert.equal(target.event.attempt_count, 0);
    assert.equal(target.event.recipient_profile_id, target.profileId);
    assert.match(target.event.request_signature, /^[0-9a-f]{64}$/);
    assert.equal(new Date(target.event.local_date).toISOString().slice(0, 10), (await f.enqueue()).localDate);
    assert.equal((await f.enqueue()).queued, 0);
    assert.equal((await f.deliveries(target.recipient.id)).length, 1);
    assert.deepEqual(await f.attempts(target.id), []);
  });
  await check('parts SMS database signature reproduces sorted UTC serialized id/timestamp digest', async () => {
    const target = await f.make();
    const parts = (await f.db.query(`select p.id,to_char(p.updated_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US') stamp
      from public.wo_parts p join public.work_orders w on w.id=p.work_order_id
      where p.ordering_responsibility='p1' and p.p1_order_status='requested' and w.deleted_at is null
      and w.status not in('closed','capital','pending_capital_completion') order by p.id`)).rows;
    const canonical = parts.map(part => `${part.id}:${part.stamp.replace(/0+$/, '').replace(/\.$/, '')}+00:00`).sort().join('|');
    assert.equal(target.event.request_signature, createHash('sha256').update(canonical).digest('hex'));
    await partsSmsOwnerUpdate(f.db, 'wo_parts', 'update public.wo_parts set description=$2 where id=$1', [target.part.id, 'Synthetic description only']);
    assert.equal((await f.enqueue()).queued, 0, 'No volatile field is independently added to existing timestamp signature');
  });
  await check('parts SMS eligible snapshot excludes closed/deleted/capital/procurement-completed parts', async () => {
    await f.scenario();
    for (const status of ['closed', 'capital', 'pending_capital_completion']) {
      const source = await f.source();
      await partsSmsOwnerUpdate(f.db, 'work_orders', 'update public.work_orders set status=$2 where id=$1', [source.workOrderId, status]);
    }
    const deleted = await f.source();
    await partsSmsOwnerUpdate(f.db, 'work_orders', 'update public.work_orders set deleted_at=clock_timestamp() where id=$1', [deleted.workOrderId]);
    const ordered = await f.source();
    await f.as('authenticated', f.actors.mgr, tx => tx.query("select public.set_p1_part_order_status($1,'ordered')", [ordered.id]));
    const result = await f.enqueue();
    assert.equal(result.parts, 1);
    assert.equal(result.workOrders, 1);
  });
  await check('parts SMS disabled/before-cutoff/no-request evaluations never create intent or send', async () => {
    const target = await f.scenario({ noParts: true });
    assert.equal((await f.enqueue()).status, 'nothing_to_send');
    await f.source();
    const recipients = [{ profileId: target.profileId, phoneE164: '+12025550123', active: true }];
    await f.configure({ recipients, enabled: false });
    assert.equal((await f.enqueue()).status, 'disabled');
    await f.configure({ recipients, cutoff: '23:59' });
    const clock = (await f.db.query("select to_char(clock_timestamp() at time zone 'UTC','HH24:MI') local_minute")).rows[0].local_minute;
    if (clock < '23:59') assert.equal((await f.enqueue()).status, 'before_cutoff');
    assert.equal((await f.enqueue(true)).status, 'queued', 'Existing service force is explicit and service-only');
  });
  await check('parts SMS changed unstarted signature creates distinct event and supersedes stale claim safely', async () => {
    const target = await f.make();
    const claim = await f.take(target.id);
    const attempts = await f.attempts(target.id);
    await partsSmsOwnerUpdate(f.db, 'wo_parts', "update public.wo_parts set qty=qty+1,updated_at=clock_timestamp()+interval '1 second' where id=$1", [target.part.id]);
    const result = await f.enqueue();
    assert.equal(result.queued, 1);
    assert.equal(result.superseded, 1);
    assert.equal((await f.delivery(target.id)).status, 'superseded');
    assert.equal((await f.delivery(target.id)).claim_token, null);
    assert.equal(await f.prepare(target.id, claim.token), null);
    await f.denied(() => f.complete(target.id, claim.token), ['PT409']);
    const rows = await f.deliveries(target.recipient.id);
    assert.equal(rows.length, 2);
    assert.notEqual(rows[0].request_signature, rows[1].request_signature);
    assert.deepEqual((await f.attempts(target.id)).slice(0, attempts.length), attempts);
  });
  await check('parts SMS unknown blocks original and changed-signature automatic resend for the whole local day', async () => {
    const target = await f.make('unknown');
    const original = await f.delivery(target.id);
    await partsSmsOwnerUpdate(f.db, 'wo_parts', "update public.wo_parts set updated_at=clock_timestamp()+interval '2 seconds' where id=$1", [target.part.id]);
    assert.equal((await f.enqueue()).queued, 0);
    assert.equal((await f.deliveries(target.recipient.id)).length, 1);
    assert.deepEqual(await f.delivery(target.id), original);
    assert.equal((await f.current(target.id)).canResend, false, 'Explicit resend requires current source signature');
  });
  await check('parts SMS accepted queued SID is not handset delivery and prevents automatic new-signature sending', async () => {
    const sid = syntheticSid();
    const target = await f.make('accepted', { sid, providerStatus: 'queued' });
    const row = await f.delivery(target.id);
    assert.equal(row.status, 'accepted');
    assert.equal(row.provider_status, 'queued');
    assert.equal(row.provider_message_id, sid);
    assert.ok(row.next_status_at);
    assert.equal((await f.current(target.id)).state, 'accepted');
    await partsSmsOwnerUpdate(f.db, 'wo_parts', "update public.wo_parts set updated_at=clock_timestamp()+interval '3 seconds' where id=$1", [target.part.id]);
    assert.equal((await f.enqueue()).queued, 0);
    assert.equal((await f.current(target.id)).canResend, false);
  });
  await check('parts SMS two claims cannot own same event; wrong token and repeated send-start are denied', async () => {
    const target = await f.make();
    const first = await f.take(target.id);
    const second = await f.claim();
    assert.notEqual(second.claim?.id, target.id);
    assert.equal(await f.prepare(target.id, randomUUID()), null);
    assert.equal((await f.prepare(target.id, first.token)).id, target.id);
    assert.equal(await f.prepare(target.id, first.token), null);
    await f.denied(() => f.complete(target.id, randomUUID()), ['PT409']);
    assert.equal((await f.delivery(target.id)).status, 'sending');
    await f.complete(target.id, first.token);
  });
  await check('parts SMS pre-send lease expiry is reclaimable but old token cannot start or complete', async () => {
    const target = await f.make();
    const first = await f.take(target.id);
    await expire(f, target.id);
    const second = await f.take(target.id);
    assert.notEqual(second.token, first.token);
    assert.equal(second.recoveredBeforeSend, 1);
    assert.equal((await f.delivery(target.id)).attempt_count, 2);
    assert.equal(await f.prepare(target.id, first.token), null);
    await f.denied(() => f.complete(target.id, first.token), ['PT409']);
    await f.prepare(target.id, second.token);
    await f.complete(target.id, second.token);
  });
  await check('parts SMS durable send-start expiry becomes unknown and cannot be automatically reclaimed', async () => {
    const target = await f.make();
    const claim = await f.take(target.id);
    await f.prepare(target.id, claim.token);
    await expire(f, target.id);
    const recovery = await f.claim();
    assert.equal(recovery.recoveredUnknown, 1);
    assert.notEqual(recovery.claim?.id, target.id);
    assert.equal((await f.delivery(target.id)).status, 'unknown');
    await f.denied(() => f.complete(target.id, claim.token, 'accepted', { sid: syntheticSid(), providerStatus: 'queued' }), ['PT409']);
    assert.equal((await f.enqueue()).queued, 0);
  });
  await check('parts SMS send completion is replay-safe and conflicting outcome replay cannot rewrite unknown', async () => {
    const target = await f.make();
    const claim = await f.take(target.id);
    await f.prepare(target.id, claim.token);
    assert.equal((await f.complete(target.id, claim.token)).replayed, false);
    const before = await f.attempts(target.id);
    assert.equal((await f.complete(target.id, claim.token)).replayed, true);
    await f.denied(() => f.complete(target.id, claim.token, 'known_unsent_terminal', { code: 'TWILIO_NOT_CONFIGURED' }), ['PT409']);
    assert.deepEqual(await f.attempts(target.id), before);
  });
  await check('parts SMS confirmed acceptance followed by completion transaction failure remains sending then unknown', async () => {
    const target = await f.make();
    const claim = await f.take(target.id);
    await f.prepare(target.id, claim.token);
    const before = await f.snapshot();
    await failPartsSmsWrite(f.db, 'p1_parts_sms_attempt_events', 'insert', async () => {
      await assert.rejects(() => f.complete(target.id, claim.token, 'accepted', { sid: syntheticSid(), providerStatus: 'queued' }), error => error.code === 'P0001');
    });
    assert.deepEqual(await f.snapshot(), before);
    await expire(f, target.id);
    await f.claim();
    assert.equal((await f.delivery(target.id)).status, 'unknown');
    assert.equal((await f.delivery(target.id)).provider_message_id, null, 'An uncommitted SID must not be invented');
  });
  await check('parts SMS intent insertion and supersession failures rollback every event/claim change', async () => {
    const target = await f.make();
    await partsSmsOwnerUpdate(f.db, 'wo_parts', "update public.wo_parts set updated_at=clock_timestamp()+interval '4 seconds' where id=$1", [target.part.id]);
    const before = await f.snapshot();
    await failPartsSmsWrite(f.db, 'p1_parts_alert_deliveries', 'insert', async () => {
      await assert.rejects(() => f.enqueue(), error => error.code === 'P0001');
    });
    assert.deepEqual(await f.snapshot(), before);
    await failPartsSmsWrite(f.db, 'p1_parts_sms_attempt_events', 'insert', async () => {
      await assert.rejects(() => f.enqueue(), error => error.code === 'P0001');
    });
    assert.deepEqual(await f.snapshot(), before);
  });
  await check('parts SMS known-unsent retry uses minimum backoff, respects cap and never retries ambiguity', async () => {
    const target = await f.make();
    for (let attempt = 1; attempt <= 3; attempt++) {
      const claim = await f.take(target.id);
      assert.equal((await f.complete(target.id, claim.token, 'known_unsent_retryable', { retryAfter: 10 })).state, 'failed');
      const row = await f.delivery(target.id);
      assert.equal(row.attempt_count, attempt);
      if (attempt < 3) {
        assert.ok(new Date(row.next_attempt_at).valueOf() - Date.now() > (attempt === 1 ? 290_000 : 590_000));
        assert.notEqual((await f.claim()).claim?.id, target.id);
        await partsSmsOwnerUpdate(f.db, 'p1_parts_alert_deliveries', "update public.p1_parts_alert_deliveries set next_attempt_at=clock_timestamp()-interval '1 second' where id=$1", [target.id]);
      } else assert.equal(row.next_attempt_at, null);
    }
    assert.notEqual((await f.claim()).claim?.id, target.id);
  });
  await check('parts SMS outcome validation requires SID/send-start proof and rejects malformed/provider-ambiguous retry', async () => {
    const target = await f.make();
    const claim = await f.take(target.id);
    await f.denied(() => f.complete(target.id, claim.token, 'accepted', { sid: syntheticSid(), providerStatus: 'queued' }), ['PT409']);
    await f.prepare(target.id, claim.token);
    for (const options of [{ sid: 'not-a-sid', providerStatus: 'queued' }, { providerStatus: 'queued' }, { sid: syntheticSid(), providerStatus: 'unrecognized' }]) {
      await f.denied(() => f.complete(target.id, claim.token, 'accepted', options), ['PT422']);
    }
    await f.denied(() => f.complete(target.id, claim.token, 'known_unsent_retryable', { code: 'TWILIO_UNKNOWN' }), ['PT422']);
    await f.denied(() => f.complete(target.id, claim.token, 'unknown', { code: 'unsafe detail value' }), ['PT422']);
    await f.denied(() => f.complete(target.id, claim.token, 'unknown', { retryAfter: 300 }), ['PT422']);
    await f.denied(() => f.complete(target.id, claim.token, 'known_unsent_retryable', { retryAfter: 3601 }), ['PT422']);
    await f.complete(target.id, claim.token);
  });
  await check('parts SMS provider SID cannot be rebound to a second delivery and failed binding is atomic', async () => {
    const sid = syntheticSid();
    const accepted = await f.make('accepted', { sid, providerStatus: 'queued' });
    const next = await f.make();
    const claim = await f.take(next.id);
    await f.prepare(next.id, claim.token);
    const before = await f.snapshot();
    await assert.rejects(() => f.complete(next.id, claim.token, 'accepted', { sid, providerStatus: 'queued' }), error => error.code === '23505');
    assert.deepEqual(await f.snapshot(), before);
    assert.equal((await f.delivery(accepted.id)).provider_message_id, sid);
    await expire(f, next.id);
    await f.claim();
    assert.equal((await f.delivery(next.id)).status, 'unknown');
    assert.equal((await f.delivery(next.id)).provider_message_id, null);
  });
  await check('parts SMS current recipient deactivation/phone change is revalidated before send-start', async () => {
    for (const change of ['profile_inactive', 'recipient_inactive', 'phone_changed']) {
      const target = await f.make();
      const claim = await f.take(target.id);
      if (change === 'profile_inactive') await partsSmsOwnerUpdate(f.db, 'profiles', 'update public.profiles set active=false where id=$1', [target.profileId]);
      if (change === 'recipient_inactive') await partsSmsOwnerUpdate(f.db, 'p1_parts_alert_recipients', 'update public.p1_parts_alert_recipients set active=false where id=$1', [target.recipient.id]);
      if (change === 'phone_changed') await partsSmsOwnerUpdate(f.db, 'p1_parts_alert_recipients', "update public.p1_parts_alert_recipients set phone_e164='+12025550129' where id=$1", [target.recipient.id]);
      assert.equal((await f.prepare(target.id, claim.token)).status, 'not_deliverable');
      assert.equal((await f.delivery(target.id)).send_started_at, null);
      assert.equal((await f.delivery(target.id)).last_error_code, 'RECIPIENT_NOT_DELIVERABLE');
    }
  });
  await check('parts SMS source resolution supersedes while disabled settings park before provider start', async () => {
    for (const change of ['source', 'disabled']) {
      const target = await f.make();
      const claim = await f.take(target.id);
      if (change === 'source') await f.as('authenticated', f.actors.mgr, tx => tx.query("select public.set_p1_part_order_status($1,'ordered')", [target.part.id]));
      else await f.configure({ enabled: false, recipients: [{ profileId: target.profileId, phoneE164: '+12025550123', active: true }] });
      const prepared = await f.prepare(target.id, claim.token);
      if (change === 'source') assert.equal(prepared.status, 'superseded');
      else {
        assert.equal(prepared, null);
        assert.equal((await f.delivery(target.id)).status, 'claimed');
        await f.configure({ recipients: [{ profileId: target.profileId, phoneE164: '+12025550123', active: true }] });
        assert.equal((await f.prepare(target.id, claim.token)).id, target.id);
        await f.complete(target.id, claim.token, 'known_unsent_terminal');
      }
      assert.equal((await f.delivery(target.id)).send_started_at, null);
    }
  });
  await check('parts SMS real procurement request A then B then ordering B can recur original exact A signature', async () => {
    const target = await f.make();
    const firstSignature = target.event.request_signature;
    const secondPart = await f.source();
    const changed = await f.enqueue();
    assert.equal(changed.queued, 1);
    assert.equal((await f.delivery(target.id)).status, 'superseded');
    await f.as('authenticated', f.actors.mgr, tx => tx.query("select public.set_p1_part_order_status($1,'ordered')", [secondPart.id]));
    const recurrence = await f.enqueue();
    const rows = await f.deliveries(target.recipient.id);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].request_signature, firstSignature);
    assert.equal(recurrence.queued, 0);
    assert.ok(rows.every(row => row.status === 'superseded'));
    assert.equal(recurrence.recurrenceBlocked, 1);
    const view = (await f.page({ search: target.recipient.id })).items.find(row => row.id === target.id);
    assert.ok(view, 'Current exact-source recurrence must not be hidden from operational staff');
    assert.equal(view.state, 'superseded');
    assert.equal(view.code, 'PARTS_SOURCE_RECURRENCE_REVIEW');
    assert.equal(view.canResend, false);
    assert.equal(view.canResolve, false);
    assert.equal((await f.health()).sourceRecurrenceCount, 1);
    await f.denied(() => f.action('resend', target.id), ['PT409']);
    await f.denied(() => f.action('manual', target.id), ['PT409']);
    // This is a deliberate fail-closed policy characterization. Recurrence
    // needs explicit visibility/accountability or an owner-approved rule;
    // never silently reset or automatically resend a superseded event.
  });
}
