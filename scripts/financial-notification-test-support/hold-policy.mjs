import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { failWrite, ownerFixtureUpdate } from './candidate-fixtures.mjs';

// Approved latest-effective hold policy only. All provider effects below are
// synthetic SQL completions: no network adapter, email, or external database.
export async function verifyFinancialHoldPolicy(f, check) {
  await f.settle();
  const make = async () => {
    const target = await f.invoice();
    await f.candidateReview(target, { action: 'approve' });
    await f.candidateHold(target);
    return { target, event: (await f.events(target))[0] };
  };
  const change = async (target, action, options = {}) => {
    const source = (await f.status(target)).latestHoldSourceEventId;
    const operation = options.operation || randomUUID();
    await f.candidateHold(target, { action, source, ...options, operation });
    return (await f.events(target)).find(event => event.operation_id === operation);
  };
  const attempts = event => f.db.query(`select a.* from public.financial_notification_attempt_events a
    join public.financial_notification_deliveries d on d.id=a.delivery_id where d.event_id=$1 order by a.id`, [event.id]).then(r => r.rows);
  const supersessions = event => f.db.query('select * from public.financial_notification_hold_supersessions where event_id=$1 order by delivery_id', [event.id]).then(r => r.rows);
  const expire = async rows => {
    await ownerFixtureUpdate(f.db, 'financial_notification_deliveries',
      "update public.financial_notification_deliveries set claim_expires_at=clock_timestamp()-interval '1 second' where id=any($1::uuid[])", [rows.map(row => row.id)]);
  };
  const assertState = async (event, state) => {
    const rows = await f.deliveries(event);
    assert.ok(rows.length > 0);
    assert.ok(rows.every(row => row.state === state), `Every synthetic ${event.family} delivery is ${state}`);
    return rows;
  };
  async function take(event, { start = true, outcome = null, code = null } = {}) {
    const ids = new Set((await f.deliveries(event)).map(row => row.id));
    const owned = [];
    for (let pass = 0; pass < 20 && owned.length < ids.size; pass++) {
      const claim = await f.claim();
      for (const row of claim.rows) {
        if (!ids.has(row.id)) {
          const other = await f.prepare(row.id, claim.token);
          if (other && !other.status) await f.complete(row.id, claim.token, 'sent');
          continue;
        }
        owned.push({ ...row, token: claim.token });
        if (start) {
          const message = await f.prepare(row.id, claim.token);
          assert.equal(message?.eventId, event.id);
        }
        if (outcome) await f.complete(row.id, claim.token, outcome, code,
          outcome === 'sent' ? 202 : code === 'GRAPH_RATE_LIMITED' ? 429 : null);
      }
      if (!claim.rows.length && !claim.summary.superseded && !claim.summary.notDeliverable) break;
    }
    assert.equal(owned.length, ids.size, 'Every current synthetic recipient is claimed once');
    return owned;
  }
  async function deniedSuperseded(event, item, actor = f.actors.handoff) {
    await assert.rejects(() => f.action('resend', event, item, { actor }), error => {
      assert.equal(error.code, 'PT409');
      assert.equal(error.message, 'HOLD_NOTIFICATION_SUPERSEDED');
      return true;
    });
  }
  const note = (event, item, options = {}) => f.rpc('annotate_financial_notification_history_v1',
    [event.id, item.id, options.operation || randomUUID(), options.reason ?? 'Synthetic historical notification review'], options.actor || f.actors.handoff);

  await check('hold policy01 pending hold is superseded atomically by release and never reaches send start', async () => {
    const { target, event } = await make();
    const release = await change(target, 'release');
    await assertState(event, 'superseded'); await assertState(release, 'pending');
    await f.settle(); await assertState(release, 'sent');
    assert.deepEqual(await attempts(event), []);
  });
  await check('hold policy02 retryable known-unsent hold loses automatic retry after release without erasing its attempts', async () => {
    const { target, event } = await make();
    await take(event, { outcome: 'failed', code: 'GRAPH_RATE_LIMITED' });
    const before = await attempts(event);
    const release = await change(target, 'release');
    await assertState(event, 'superseded');
    assert.deepEqual(await attempts(event), before);
    await f.settle(); await assertState(release, 'sent');
    await deniedSuperseded(event, (await f.deliveries(event))[0]);
  });
  await check('hold policy03 provider-confirmed hold remains byte-identical when a later release is delivered', async () => {
    const { target, event } = await make(); await take(event, { outcome: 'sent' });
    const before = await f.deliveries(event); const journal = await attempts(event);
    const release = await change(target, 'release'); await f.settle();
    assert.deepEqual(await f.deliveries(event), before); assert.deepEqual(await attempts(event), journal);
    await assertState(release, 'sent');
  });
  await check('hold policy04 unknown hold stays unknown and cannot resend while its newer release proceeds', async () => {
    const { target, event } = await make(); await take(event, { outcome: 'unknown', code: 'GRAPH_OUTCOME_UNKNOWN' });
    const before = await f.deliveries(event); const journal = await attempts(event);
    const release = await change(target, 'release');
    await deniedSuperseded(event, before[0]); await f.settle();
    assert.deepEqual(await f.deliveries(event), before); assert.deepEqual(await attempts(event), journal);
    await assertState(release, 'sent');
  });
  await check('hold policy05 pending hold release rehold leaves only the latest effective hold sendable', async () => {
    const { target, event } = await make(); const release = await change(target, 'release');
    const rehold = await change(target, 'place');
    await assertState(event, 'superseded'); await assertState(release, 'superseded');
    await take(rehold, { outcome: 'sent' });
    assert.deepEqual(await attempts(event), []); assert.deepEqual(await attempts(release), []);
    assert.equal((await f.status(target)).latestHoldSourceEventId, rehold.source_id);
  });
  await check('hold policy06 a pending release becomes superseded when payment is held again', async () => {
    const { target, event } = await make(); await take(event, { outcome: 'sent' });
    const release = await change(target, 'release'); const rehold = await change(target, 'place');
    await assertState(release, 'superseded'); await take(rehold, { outcome: 'sent' });
    assert.deepEqual(await attempts(release), []);
  });
  await check('hold policy07 sent release is preserved and a later hold remains independently required', async () => {
    const { target } = await make(); const release = await change(target, 'release');
    await take(release, { outcome: 'sent' }); const before = await f.deliveries(release);
    const rehold = await change(target, 'place'); await take(rehold, { outcome: 'sent' });
    assert.deepEqual(await f.deliveries(release), before);
  });
  await check('hold policy08 unknown release is preserved and never resent while rehold sends', async () => {
    const { target } = await make(); const release = await change(target, 'release');
    await take(release, { outcome: 'unknown', code: 'GRAPH_OUTCOME_UNKNOWN' }); const before = await f.deliveries(release);
    const rehold = await change(target, 'place'); await deniedSuperseded(release, before[0]);
    await take(rehold, { outcome: 'sent' }); assert.deepEqual(await f.deliveries(release), before);
  });
  await check('hold policy09 committed opposite event invalidates every pre-send claim before a worker can prepare', async () => {
    const { target, event } = await make(); const claims = await take(event, { start: false });
    const release = await change(target, 'release');
    for (const row of claims) {
      const current = await f.delivery(row.id); assert.equal(current.state, 'superseded'); assert.equal(current.claim_token, null);
      const stale = await f.prepare(row.id, row.token); assert.ok(stale === null || stale.status === 'superseded');
    }
    assert.ok((await attempts(event)).every(row => row.phase !== 'sending'));
    await take(release, { outcome: 'sent' });
  });
  await check('hold policy10 send-start barrier allows financial commit but delays newer notices until lease recovery records unknown', async () => {
    const { target, event } = await make(); const claims = await take(event);
    const release = await change(target, 'release');
    await assertState(event, 'sending'); await assertState(release, 'pending');
    assert.equal((await f.claim()).rows.length, 0, 'No opposite financial notification overlaps durable send start');
    await expire(claims);
    await take(release, { outcome: 'sent' }); await assertState(event, 'unknown');
    const original = await f.deliveries(event);
    await f.settle(); assert.deepEqual(await f.deliveries(event), original);
    assert.ok((await attempts(event)).some(row => row.phase === 'claim_expired' && row.state === 'unknown'));
  });
  await check('hold policy11 stale completion after pre-send supersession cannot mark sent or revive an automatic retry', async () => {
    const { target, event } = await make(); const claims = await take(event, { start: false });
    await change(target, 'release');
    const before = await f.deliveries(event); const journal = await attempts(event);
    for (const row of claims) {
      await f.denied(() => f.complete(row.id, row.token, 'sent'), ['PT409']);
      await f.denied(() => f.complete(row.id, row.token, 'failed', 'GRAPH_RATE_LIMITED', 429), ['PT409']);
    }
    assert.deepEqual(await f.deliveries(event), before); assert.deepEqual(await attempts(event), journal);
    await f.settle();
  });
  await check('hold policy12 superseded pending and known-terminal outcomes have a stable resend denial', async () => {
    const { target, event } = await make();
    await take(event, { outcome: 'failed', code: 'GRAPH_SEND_REJECTED' });
    const before = await attempts(event); await change(target, 'release');
    await assertState(event, 'superseded'); assert.deepEqual(await attempts(event), before);
    await deniedSuperseded(event, (await f.deliveries(event))[0]); await f.settle();
  });
  await check('hold policy13 older unknown projection retains outcome and exposes history rather than ordinary resend', async () => {
    const { target, event } = await make(); await take(event, { outcome: 'unknown', code: 'GRAPH_OUTCOME_UNKNOWN' });
    const item = (await f.deliveries(event))[0]; const release = await change(target, 'release');
    const visible = (await f.status(target)).items.find(row => row.id === item.id);
    assert.equal(visible.state, 'unknown'); assert.equal(visible.current, false); assert.equal(visible.canResend, false);
    assert.equal(visible.canAnnotateHistory, true); assert.equal(visible.supersededBySourceEventId, release.source_id);
    await deniedSuperseded(event, item); await f.settle();
  });
  await check('hold policy14 latest unknown resend requires reason and a stable operation and preserves immutable original', async () => {
    const { target, event } = await make(); await take(event, { outcome: 'unknown', code: 'GRAPH_OUTCOME_UNKNOWN' });
    const item = (await f.deliveries(event))[0]; const before = await f.delivery(item.id); const journal = await attempts(event);
    for (const reason of ['', ' ', 'x'.repeat(501)]) await f.denied(() => f.action('resend', event, item, { reason }), ['PT422']);
    const operation = randomUUID(); const queued = await f.action('resend', event, item, { operation });
    assert.equal(queued.status, 'queued'); assert.notEqual(queued.deliveryId, item.id);
    assert.equal((await f.action('resend', event, item, { operation })).replayed, true);
    await f.denied(() => f.action('resend', event, item, { operation, reason: 'Changed synthetic reason' }), ['PT409']);
    assert.deepEqual(await f.delivery(item.id), before); assert.deepEqual(await attempts(event), journal);
    await f.settle(); assert.equal((await f.delivery(queued.deliveryId)).state, 'sent');
    assert.equal((await f.status(target)).latestHoldSourceEventId, event.source_id);
  });
  await check('hold policy15 manual contact remains separate from Graph sent and historical review notes never relabel unknown', async () => {
    const { target, event } = await make(); await take(event, { outcome: 'unknown', code: 'GRAPH_OUTCOME_UNKNOWN' });
    const item = (await f.deliveries(event))[0]; const before = await f.delivery(item.id);
    const manual = await f.action('manual', event, item); assert.equal(manual.status, 'manually_resolved');
    assert.deepEqual(await f.delivery(item.id), before);
    const release = await change(target, 'release'); await f.settle(); await assertState(release, 'sent');
    assert.deepEqual(await f.delivery(item.id), before);
    const other = await make(); await take(other.event, { outcome: 'unknown', code: 'GRAPH_OUTCOME_UNKNOWN' });
    const old = (await f.deliveries(other.event))[0]; await change(other.target, 'release');
    const result = await note(other.event, old); assert.equal(result.status, 'historical_note_recorded'); assert.equal(result.deliveryCount, 0);
    assert.equal((await f.delivery(old.id)).state, 'unknown');
    assert.ok((await f.history(other.event, null, 50, f.actors.handoff)).items.some(row => row.kind === 'historical_note'));
    await f.settle();
  });
  await check('hold policy16 supersession cannot alter original provider-attempt or explicit-operation evidence', async () => {
    const { target, event } = await make(); await take(event, { outcome: 'unknown', code: 'GRAPH_OUTCOME_UNKNOWN' });
    const item = (await f.deliveries(event))[0]; const result = await f.action('resend', event, item);
    await f.settle(result.deliveryId, 'unknown');
    const journal = await attempts(event);
    const operations = (await f.db.query('select * from public.financial_notification_operations where delivery_id=$1 order by operation_id', [item.id])).rows;
    await change(target, 'release'); await f.settle();
    assert.deepEqual(await attempts(event), journal);
    assert.deepEqual((await f.db.query('select * from public.financial_notification_operations where delivery_id=$1 order by operation_id', [item.id])).rows, operations);
  });
  await check('hold policy17 immutable supersession evidence binds original delivery and authoritative opposite source with staff operation', async () => {
    const { target, event } = await make(); const original = await f.deliveries(event);
    const operation = randomUUID(); const release = await change(target, 'release', { operation });
    const evidence = await supersessions(event); assert.equal(evidence.length, original.length);
    for (const row of evidence) {
      assert.ok(original.some(item => item.id === row.delivery_id)); assert.equal(row.event_id, event.id);
      assert.equal(row.superseding_event_id, release.id); assert.equal(row.superseding_source_event_id, release.source_id);
      assert.equal(row.operation_id, operation); assert.equal(row.actor_id, f.actors.handoff);
      assert.equal(row.original_state, 'pending'); assert.ok(row.created_at);
      assert.ok(['notification_no_longer_required', 'superseded_by_later_hold_state'].includes(row.classification));
    }
    await f.settle();
  });
  await check('hold policy18 browser and raw service cannot forge supersession evidence, historical notes, actor, or provider outcome', async () => {
    const { target, event } = await make(); const item = (await f.deliveries(event))[0]; await change(target, 'release');
    for (const role of ['anon', 'authenticated', 'service_role']) {
      const actor = role === 'authenticated' ? f.actors.mgr : null;
      for (const verb of ['select * from', 'insert into', 'delete from', 'truncate']) {
        const suffix = verb === 'insert into' ? ' default values' : '';
        await f.denied(() => f.as(role, actor, tx => tx.query(`${verb} public.financial_notification_hold_supersessions${suffix}`)), ['42501']);
      }
      await f.denied(() => f.as(role, actor, tx => tx.query("update public.financial_notification_operations set action='history_note',reason='forged'")), ['42501']);
    }
    for (const actorName of ['contractor', 'canonical', 'admin', 'invoice', 'report', 'former', 'outsider', 'inactive', 'noProfile']) {
      await f.denied(() => note(event, item, { actor: f.actors[actorName] }), ['42501']);
    }
    await f.settle();
  });
  await check('hold policy19 authoritative source sequence controls latest state even when notification timestamps are reordered', async () => {
    const { target, event } = await make(); const release = await change(target, 'release'); const rehold = await change(target, 'place');
    await ownerFixtureUpdate(f.db, 'financial_notification_events', "update public.financial_notification_events set created_at=clock_timestamp()+interval '1 day' where id=$1", [event.id]);
    assert.equal((await f.status(target)).latestHoldSourceEventId, rehold.source_id);
    const all = (await f.status(target, null, 50)).items;
    assert.ok(all.filter(item => item.current).every(item => item.eventId === rehold.id));
    assert.ok(all.filter(item => [event.id, release.id].includes(item.eventId)).every(item => !item.current));
    await take(rehold, { outcome: 'sent' });
  });
  await check('hold policy20 transaction-tied immutable source timestamps retain deterministic causal source identity', async () => {
    const target = await f.invoice(); await f.candidateReview(target, { action: 'approve' });
    const sources = await f.as('authenticated', f.actors.handoff, async tx => {
      const result = []; let source = null;
      for (const action of ['place', 'release', 'place']) {
        const next = (await tx.query('select public.set_contractor_invoice_payment_hold_with_notification_v1($1,$2,$3,$4,$5) result',
          [target.id, action, 'Synthetic tied immutable source', randomUUID(), source])).rows[0].result;
        source = next.notifications[0].sourceEventId; result.push(source);
      }
      return result;
    });
    const immutable = await f.holdEvents(target); assert.equal(new Set(immutable.map(row => new Date(row.created_at).toISOString())).size, 1);
    assert.equal(new Set(sources).size, 3); assert.equal((await f.status(target)).latestHoldSourceEventId, sources[2]);
    const events = (await f.events(target)).sort((a, b) => Number(a.event_sequence) - Number(b.event_sequence));
    assert.deepEqual(events.map(row => row.source_id), sources);
    await assertState(events[0], 'superseded'); await assertState(events[1], 'superseded'); await take(events[2], { outcome: 'sent' });
  });
  await check('hold policy21 financial mutation, intent, source head, supersession and operation commit together with replay', async () => {
    const { target, event } = await make(); const operation = randomUUID();
    const release = await change(target, 'release', { operation }); const committed = await f.snapshot(target);
    assert.equal((await f.candidateHold(target, { action: 'release', source: event.source_id, operation })).replayed, true);
    assert.deepEqual(await f.snapshot(target), committed);
    assert.equal((await f.holdEvents(target)).length, 2); assert.equal((await f.events(target)).length, 2);
    assert.equal((await supersessions(event)).length, (await f.deliveries(event)).length);
    await take(release, { outcome: 'sent' });
  });
  for (const table of ['contractor_invoice_payment_holds', 'contractor_invoice_payment_hold_events', 'financial_notification_events',
    'financial_notification_deliveries', 'financial_notification_hold_heads', 'financial_notification_hold_supersessions', 'financial_notification_mutation_operations']) {
    await check(`hold policy22 injected ${table} failure rolls back financial state, new intent and every old-delivery supersession`, async () => {
      const { target, event } = await make(); const before = await f.snapshot(target); const operation = randomUUID();
      await failWrite(f.db, table, async () => {
        await f.denied(() => f.candidateHold(target, { action: 'release', source: event.source_id, operation }), ['P0001']);
      });
      assert.deepEqual(await f.snapshot(target), before);
      await f.candidateHold(target, { action: 'release', source: event.source_id, operation });
      await assertState(event, 'superseded'); await f.settle();
    });
  }
  await check('hold policy23 default unresolved queue includes only the latest actionable hold source and preserves historical unknown privately', async () => {
    const { target, event } = await make(); await take(event, { outcome: 'unknown', code: 'GRAPH_OUTCOME_UNKNOWN' });
    const release = await change(target, 'release'); await take(release, { outcome: 'unknown', code: 'GRAPH_OUTCOME_UNKNOWN' });
    const queue = await f.page({ search: target.workOrderId, actor: f.actors.handoff, limit: 50 });
    assert.ok(queue.items.length > 0); assert.ok(queue.items.every(row => row.eventId === release.id && row.current));
    assert.ok(queue.items.every(row => !Object.hasOwn(row, 'recipientEmail') && !Object.hasOwn(row, 'providerReference')));
    await assertState(event, 'unknown');
  });
  await check('hold policy24 superseded history remains bounded and supports multiple immutable reasoned notes with replay', async () => {
    const { target, event } = await make(); const item = (await f.deliveries(event))[0]; const release = await change(target, 'release');
    const operation = randomUUID(); const first = await note(event, item, { operation });
    assert.equal(first.status, 'historical_note_recorded'); assert.equal((await note(event, item, { operation })).replayed, true);
    await f.denied(() => note(event, item, { operation, reason: 'Changed historical reason' }), ['PT409']);
    for (let index = 0; index < 55; index++) await note(event, item, { reason: `Synthetic bounded historical review ${index}` });
    const firstPage = await f.history(event, null, 10, f.actors.handoff); assert.equal(firstPage.hasMore, true);
    const history = [...firstPage.items]; let cursor = firstPage.nextCursor;
    for (let page = 0; cursor && page < 20; page++) {
      const next = await f.history(event, cursor, 10, f.actors.handoff); assert.ok(next.items.length <= 10);
      history.push(...next.items); cursor = next.nextCursor;
    }
    assert.equal(cursor, null); assert.equal(new Set(history.map(row => row.id)).size, history.length);
    assert.equal(history.filter(row => row.kind === 'historical_note').length, 56);
    assert.ok(history.some(row => row.kind === 'system_no_longer_required'));
    assert.equal((await f.delivery(item.id)).state, 'superseded'); await deniedSuperseded(event, item);
    const visible = (await f.status(target, null, 50)).items.find(row => row.id === item.id);
    assert.equal(visible.supersededBySourceEventId, release.source_id); assert.equal(visible.canResend, false);
    for (const reason of ['', ' ', 'x'.repeat(501)]) await f.denied(() => note(event, item, { reason }), ['PT422']);
    await f.settle();
  });
  await check('hold policy25 rejection and retraction remain source/revision-bound and never acquire hold supersession evidence', async () => {
    const target = await f.invoice(); await f.candidateReview(target);
    const reject = (await f.events(target))[0]; await f.candidateRetract(target);
    const retract = (await f.events(target)).find(row => row.family === 'invoice_rejection_retracted');
    await f.settle(); await assertState(reject, 'superseded'); await assertState(retract, 'sent');
    assert.deepEqual(await supersessions(reject), []); assert.deepEqual(await supersessions(retract), []);
    assert.equal((await f.row(target.id)).state, 'approved');
  });
  await check('hold policy additional invalid-address history retains original not-deliverable outcome but only corrected latest source can resend', async () => {
    const actors = (await f.db.query(`select p.id,p.email from public.profiles p where p.active=true and p.role in ('manager','dispatcher','back_office')
      and exists(select 1 from public.staff_permission_grants s where s.profile_id=p.id and s.permission='quickbooks_handoff')`)).rows;
    assert.ok(actors.length > 0);
    let target; let event;
    try {
      for (const actor of actors) await ownerFixtureUpdate(f.db, 'profiles', 'update public.profiles set email=$2 where id=$1', [actor.id, `invalid-synthetic-${actor.id}`]);
      ({ target, event } = await make()); await assertState(event, 'not_deliverable');
      const original = await f.deliveries(event); const release = await change(target, 'release');
      await assertState(event, 'superseded');
      for (const record of await supersessions(event)) {
        assert.equal(record.original_state, 'not_deliverable');
        assert.equal(record.original_error_code, original.find(row => row.id === record.delivery_id).last_error_code);
      }
      const history = await f.history(event, null, 50, f.actors.handoff);
      assert.ok(history.items.some(row => row.kind === 'system_no_longer_required' && row.state === 'not_deliverable' && row.code === 'RECIPIENT_NOT_DELIVERABLE'));
      for (const actor of actors) await ownerFixtureUpdate(f.db, 'profiles', 'update public.profiles set email=$2 where id=$1', [actor.id, actor.email]);
      await deniedSuperseded(event, original[0]);
      const current = (await f.deliveries(release))[0];
      assert.equal((await f.action('resend', release, current, { actor: f.actors.handoff })).status, 'queued'); await f.settle();
    } finally {
      for (const actor of actors) await ownerFixtureUpdate(f.db, 'profiles', 'update public.profiles set email=$2 where id=$1', [actor.id, actor.email]);
    }
  });
  await check('hold policy additional late known-unsent completion preserves outcome while superseding the obsolete delivery and permitting latest', async () => {
    const { target, event } = await make(); const claims = await take(event); const release = await change(target, 'release');
    for (const row of claims) {
      const completed = await f.complete(row.id, row.token, 'failed', 'GRAPH_RATE_LIMITED', 429);
      assert.equal(completed.state, 'failed'); assert.equal(completed.deliveryState, 'superseded');
      assert.equal((await f.delivery(row.id)).state, 'superseded');
      const replay = await f.complete(row.id, row.token, 'failed', 'GRAPH_RATE_LIMITED', 429); assert.equal(replay.replayed, true); assert.equal(replay.state, 'failed');
    }
    assert.ok((await attempts(event)).some(row => row.phase === 'completed' && row.state === 'failed' && row.code === 'GRAPH_RATE_LIMITED'));
    await take(release, { outcome: 'sent' });
  });
  await check('hold policy release-send barrier spans different recipient identities across the whole invoice', async () => {
    const { target } = await make(); const release = await change(target, 'release');
    const claims = await take(release); assert.ok(claims.length > 1, 'Synthetic fixture has separate handoff recipients');
    for (const row of claims.slice(1)) await f.complete(row.id, row.token, 'sent');
    const before = await f.deliveries(release); const rehold = await change(target, 'place');
    const active = before.find(row => row.id === claims[0].id);
    assert.ok((await f.deliveries(rehold)).some(row => row.recipient_profile_id !== active.recipient_profile_id));
    assert.equal((await f.claim()).rows.length, 0, 'One old recipient send-start blocks every opposite recipient notice, not only that address');
    await f.complete(claims[0].id, claims[0].token, 'unknown', 'GRAPH_OUTCOME_UNKNOWN');
    await take(rehold, { outcome: 'sent' });
    for (const row of before.filter(row => row.state === 'sent')) assert.deepEqual(await f.delivery(row.id), row);
    assert.equal((await f.delivery(claims[0].id)).state, 'unknown');
  });
  await check('hold policy older in-flight send confirms202 after the opposite financial change and then admits the current notice', async () => {
    const { target, event } = await make(); const claims = await take(event); const release = await change(target, 'release');
    assert.equal((await f.claim()).rows.length, 0);
    for (const row of claims) {
      const result = await f.complete(row.id, row.token, 'sent'); assert.equal(result.state, 'sent'); assert.equal(result.deliveryState, 'sent');
    }
    const before = await f.deliveries(event); await take(release, { outcome: 'sent' });
    assert.deepEqual(await f.deliveries(event), before);
    assert.ok((await supersessions(event)).every(row => row.original_state === 'sending'));
  });
  await check('hold policy upgrade recovery classifies several expired pre-start obsolete claims even when the send batch is one', async () => {
    const { target, event } = await make(); const claims = await take(event, { start: false });
    assert.ok(claims.length > 1);
    let release;
    // Owner-only synthetic reproduction of rows created under 0137, before its
    // forward policy trigger existed. No production debug option is introduced.
    await f.db.exec('alter table public.financial_notification_events disable trigger financial_notification_hold_supersession');
    try { release = await change(target, 'release'); }
    finally { await f.db.exec('alter table public.financial_notification_events enable trigger financial_notification_hold_supersession'); }
    await expire(claims);
    const recovered = await f.claim(1); assert.equal(recovered.summary.superseded, claims.length);
    assert.ok(recovered.summary.superseded > recovered.rows.length);
    assert.equal(recovered.rows.length, 1); assert.equal(recovered.rows[0].eventId, release.id);
    await assertState(event, 'superseded');
    await f.prepare(recovered.rows[0].id, recovered.token); await f.complete(recovered.rows[0].id, recovered.token, 'sent');
    await f.settle(); await assertState(release, 'sent');
  });
  await check('hold policy lazy legacy supersession records the first later source and its timestamp rather than a subsequent rehold', async () => {
    const { target, event } = await make(); let release;
    await f.db.exec('alter table public.financial_notification_events disable trigger financial_notification_hold_supersession');
    try { release = await change(target, 'release'); }
    finally { await f.db.exec('alter table public.financial_notification_events enable trigger financial_notification_hold_supersession'); }
    assert.deepEqual(await supersessions(event), []);
    const rehold = await change(target, 'place');
    const evidence = await supersessions(event);
    assert.ok(evidence.length > 0); assert.ok(evidence.every(row => row.superseding_source_event_id === release.source_id));
    const status = await f.status(target, null, 50);
    for (const row of status.items.filter(item => item.eventId === event.id)) {
      assert.equal(row.supersededBySourceEventId, release.source_id);
      assert.equal(new Date(row.supersededAt).getTime(), new Date(release.created_at).getTime());
    }
    await take(rehold, { outcome: 'sent' });
  });
  for (const [outcome, code] of [['failed', 'GRAPH_SEND_REJECTED'], ['not_deliverable', 'RECIPIENT_NOT_DELIVERABLE']]) {
    await check(`hold policy obsolete active send finishing ${outcome} keeps original terminal attempt while latest release proceeds`, async () => {
      const { target, event } = await make(); const claims = await take(event); const release = await change(target, 'release');
      for (const row of claims) {
        const completed = await f.complete(row.id, row.token, outcome, code);
        assert.equal(completed.state, outcome); assert.equal(completed.deliveryState, 'superseded');
        assert.equal((await f.complete(row.id, row.token, outcome, code)).replayed, true);
      }
      await assertState(event, 'superseded');
      const journal = await attempts(event);
      assert.equal(journal.filter(row => row.phase === 'completed' && row.state === outcome && row.code === code).length, claims.length);
      await take(release, { outcome: 'sent' }); assert.deepEqual(await attempts(event), journal);
    });
  }
  await check('hold policy latest source must also agree with authoritative current hold state before any claim', async () => {
    const { target, event } = await make();
    const original = (await f.db.query('select * from public.contractor_invoice_payment_holds where invoice_id=$1', [target.id])).rows[0];
    try {
      await ownerFixtureUpdate(f.db, 'contractor_invoice_payment_holds', 'delete from public.contractor_invoice_payment_holds where invoice_id=$1', [target.id]);
      const status = await f.status(target); assert.equal(status.latestHoldSourceEventId, event.source_id);
      assert.ok(status.items.every(row => !row.current && !row.canResend));
      const claim = await f.claim(); assert.equal(claim.rows.length, 0); assert.ok(claim.summary.superseded > 0);
      await assertState(event, 'superseded'); assert.deepEqual(await attempts(event), []);
    } finally {
      await ownerFixtureUpdate(f.db, 'contractor_invoice_payment_holds',
        'insert into public.contractor_invoice_payment_holds(invoice_id,placed_at,placed_by,reason) values($1,$2,$3,$4)',
        [original.invoice_id, original.placed_at, original.placed_by, original.reason]);
    }
  });
  await check('hold policy legacy source fallback uses timestamp then immutable unique ID when no authoritative source head exists', async () => {
    const target = await f.invoice(); await f.candidateReview(target, { action: 'approve' });
    const ids = [randomUUID(), randomUUID(), randomUUID()].sort();
    const timestamp = '2026-01-01T00:00:00.000Z';
    for (const [index, id] of ids.entries()) {
      await ownerFixtureUpdate(f.db, 'contractor_invoice_payment_hold_events',
        `insert into public.contractor_invoice_payment_hold_events(id,invoice_id,invoice_num,work_order_id,contractor_id,action,reason,actor_id,actor_name,created_at)
        values($1,$2,$3,$4,$5,$6,'Synthetic pre-cutover history',$7,'Synthetic staff',$8)`,
        [id, target.id, target.row.num, target.workOrderId, target.row.contractor_id, index === 1 ? 'released' : 'placed', f.actors.handoff, timestamp]);
    }
    assert.equal((await f.db.query('select count(*)::int n from public.financial_notification_hold_heads where invoice_id=$1', [target.id])).rows[0].n, 0);
    assert.equal((await f.status(target)).latestHoldSourceEventId, ids[2]);
    await ownerFixtureUpdate(f.db, 'contractor_invoice_payment_hold_events', 'update public.contractor_invoice_payment_hold_events set created_at=$2 where id=$1', [ids[0], '2026-01-02T00:00:00.000Z']);
    assert.equal((await f.status(target)).latestHoldSourceEventId, ids[0]);
    assert.equal((await f.events(target)).length, 0, 'Synthetic legacy history is not backfilled or sent by the migration');
  });
  await check('hold policy historical note failure, role denial, changed-target replay and raw-grant bypass preserve original evidence', async () => {
    const { target, event } = await make(); const original = (await f.deliveries(event))[0]; const release = await change(target, 'release');
    const before = await f.snapshot(target); const operation = randomUUID();
    await failWrite(f.db, 'financial_notification_operations', async () => {
      await f.denied(() => note(event, original, { operation }), ['P0001']);
    });
    assert.deepEqual(await f.snapshot(target), before);
    assert.equal((await note(event, original, { operation })).status, 'historical_note_recorded');
    const releaseItem = (await f.deliveries(release))[0];
    await f.denied(() => note(release, releaseItem, { operation }), ['PT409']);
    await f.denied(() => note(event, original, { operation, actor: f.actors.dispatcher }), ['PT409']);
    await f.denied(() => note(release, releaseItem), ['PT409']);
    const secondHold = await change(target, 'place');
    await f.denied(() => note(release, releaseItem, { actor: f.actors.mgr }), ['42501']);
    assert.equal((await note(release, releaseItem, { actor: f.actors.handoff })).status, 'historical_note_recorded');
    await f.db.exec('grant select,update,delete on public.financial_notification_hold_supersessions to service_role');
    try {
      await f.denied(() => f.as('service_role', null, tx => tx.query('update public.financial_notification_hold_supersessions set actor_id=$2 where event_id=$1', [event.id, f.actors.dispatcher])), ['42501']);
      await f.denied(() => f.as('service_role', null, tx => tx.query('delete from public.financial_notification_hold_supersessions where event_id=$1', [event.id])), ['42501']);
    } finally { await f.db.exec('revoke select,update,delete on public.financial_notification_hold_supersessions from service_role'); }
    await take(secondHold, { outcome: 'sent' });
  });
  await check('hold policy read-only latest-state audit executes without mutations or recipient/provider payload', async () => {
    const audit = readFileSync(fileURLToPath(new URL('../../supabase/audits/0138_latest_effective_payment_hold_integrity_verification.sql', import.meta.url)), 'utf8');
    await f.db.transaction(async tx => { await tx.exec('set transaction read only'); await tx.exec(audit); });
  });
}
