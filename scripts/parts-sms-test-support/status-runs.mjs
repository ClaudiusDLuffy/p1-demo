import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { partsSmsOwnerUpdate, failPartsSmsWrite } from './candidate-fixtures.mjs';

const sid = () => `SM${randomUUID().replaceAll('-', '')}`;
async function claimStatus(f, id) {
  await partsSmsOwnerUpdate(f.db, 'p1_parts_alert_deliveries', "update public.p1_parts_alert_deliveries set next_status_at=clock_timestamp()-interval '1 second' where id=$1", [id]);
  const claimed = await f.statusClaim();
  assert.equal(claimed.claim?.id, id);
  return claimed;
}

export async function verifyPartsSmsStatusRuns(f, check) {
  for (const providerStatus of ['accepted', 'queued', 'sending', 'sent', 'delivered', 'undelivered', 'failed']) {
    await check(`parts SMS status lookup ${providerStatus} uses stored SID and never creates a new send`, async () => {
      const providerMessageId = sid();
      const target = await f.make('accepted', { sid: providerMessageId, providerStatus: 'queued' });
      const sendCount = (await f.attempts(target.id)).filter(row => row.phase === 'send_started').length;
      const claim = await claimStatus(f, target.id);
      assert.equal(claim.claim.providerMessageId, providerMessageId);
      const result = await f.statusComplete(target.id, claim.token, providerStatus, null, providerMessageId);
      const expected = ['failed', 'undelivered'].includes(providerStatus) ? 'failed'
        : ['delivered', 'sent'].includes(providerStatus) ? providerStatus : 'accepted';
      assert.equal(result.state, expected);
      const row = await f.delivery(target.id);
      assert.equal(row.status, expected);
      assert.equal(row.provider_message_id, providerMessageId);
      assert.equal((await f.attempts(target.id)).filter(item => item.phase === 'send_started').length, sendCount);
      if (['failed', 'delivered'].includes(expected)) assert.equal(row.next_status_at, null);
      assert.notEqual((await f.claim()).claim?.id, target.id, 'Provider-status reconciliation never requeues send');
    });
  }
  await check('parts SMS status network ambiguity preserves accepted state and schedules status-only retry', async () => {
    const providerMessageId = sid();
    const target = await f.make('accepted', { sid: providerMessageId, providerStatus: 'queued' });
    const claim = await claimStatus(f, target.id);
    const before = await f.attempts(target.id);
    await f.statusComplete(target.id, claim.token, 'unknown', 'TWILIO_STATUS_UNAVAILABLE', providerMessageId);
    const row = await f.delivery(target.id);
    assert.equal(row.status, 'accepted');
    assert.equal(row.provider_status, 'queued');
    assert.ok(row.next_status_at);
    assert.equal(row.next_attempt_at, null);
    assert.deepEqual((await f.attempts(target.id)).slice(0, before.length), before);
    assert.equal((await f.enqueue()).queued, 0);
    assert.ok((await f.history(target.id)).items.filter(item => item.kind === 'provider_status')
      .every(item => item.providerState === null && item.code === 'TWILIO_STATUS_UNAVAILABLE'));
  });
  await check('parts SMS unknown with trusted stored SID can reconcile without changing original unknown evidence', async () => {
    const providerMessageId = sid();
    const target = await f.make('unknown', { sid: providerMessageId });
    const original = await f.attempts(target.id);
    const claim = await claimStatus(f, target.id);
    assert.equal((await f.statusComplete(target.id, claim.token, 'delivered', null, providerMessageId)).state, 'delivered');
    assert.deepEqual((await f.attempts(target.id)).slice(0, original.length), original);
    assert.ok(original.some(row => row.state === 'unknown' && row.phase === 'completed'));
  });
  await check('parts SMS status transitions are monotonic and terminal delivered stops polling', async () => {
    const providerMessageId = sid();
    const target = await f.make('accepted', { sid: providerMessageId, providerStatus: 'sending' });
    let claim = await claimStatus(f, target.id);
    await f.statusComplete(target.id, claim.token, 'accepted', null, providerMessageId);
    assert.equal((await f.delivery(target.id)).provider_status, 'sending');
    claim = await claimStatus(f, target.id);
    await f.statusComplete(target.id, claim.token, 'sent', null, providerMessageId);
    claim = await claimStatus(f, target.id);
    await f.statusComplete(target.id, claim.token, 'queued', null, providerMessageId);
    assert.equal((await f.delivery(target.id)).status, 'sent');
    assert.equal((await f.delivery(target.id)).provider_status, 'sent');
    claim = await claimStatus(f, target.id);
    await f.statusComplete(target.id, claim.token, 'delivered', null, providerMessageId);
    assert.equal((await f.delivery(target.id)).next_status_at, null);
    assert.notEqual((await f.statusClaim()).claim?.id, target.id);
  });
  await check('parts SMS status claim prevents overlap; token/SID binding and replay reject substitution', async () => {
    const providerMessageId = sid();
    const target = await f.make('accepted', { sid: providerMessageId, providerStatus: 'queued' });
    const claim = await claimStatus(f, target.id);
    assert.notEqual((await f.statusClaim()).claim?.id, target.id);
    await f.denied(() => f.statusComplete(target.id, randomUUID(), 'delivered', null, providerMessageId), ['PT409']);
    await f.denied(() => f.statusComplete(target.id, claim.token, 'delivered', null, sid()), ['PT404']);
    await f.denied(() => f.statusComplete(target.id, claim.token, 'invented', null, providerMessageId), ['PT422']);
    assert.equal((await f.statusComplete(target.id, claim.token, 'sent', null, providerMessageId)).replayed, false);
    const before = await f.attempts(target.id);
    assert.equal((await f.statusComplete(target.id, claim.token, 'sent', null, providerMessageId)).replayed, true);
    await f.denied(() => f.statusComplete(target.id, claim.token, 'delivered', null, providerMessageId), ['PT409']);
    assert.deepEqual(await f.attempts(target.id), before);
  });
  await check('parts SMS status lease expires safely without re-sending and stale checker cannot complete', async () => {
    const providerMessageId = sid();
    const target = await f.make('accepted', { sid: providerMessageId, providerStatus: 'queued' });
    const first = await claimStatus(f, target.id);
    await partsSmsOwnerUpdate(f.db, 'p1_parts_alert_deliveries', "update public.p1_parts_alert_deliveries set status_claim_expires_at=clock_timestamp()-interval '1 second' where id=$1", [target.id]);
    const second = await f.statusClaim();
    assert.equal(second.claim?.id, target.id);
    await f.denied(() => f.statusComplete(target.id, first.token, 'delivered', null, providerMessageId), ['PT409']);
    await f.statusComplete(target.id, second.token, 'delivered', null, providerMessageId);
    assert.equal((await f.delivery(target.id)).attempt_count, 1);
  });
  await check('parts SMS status polling is capped at twenty and then becomes staff-visible stale', async () => {
    const providerMessageId = sid();
    const target = await f.make('accepted', { sid: providerMessageId, providerStatus: 'queued' });
    await partsSmsOwnerUpdate(f.db, 'p1_parts_alert_deliveries', 'update public.p1_parts_alert_deliveries set status_check_count=19 where id=$1', [target.id]);
    const claim = await claimStatus(f, target.id);
    await f.statusComplete(target.id, claim.token, 'queued', null, providerMessageId);
    const row = await f.delivery(target.id);
    assert.equal(row.status_check_count, 20);
    assert.equal(row.status_check_stale, true);
    assert.equal(row.next_status_at, null);
    assert.equal((await f.current(target.id)).statusCheckStale, true);
    assert.ok((await f.page()).items.some(item => item.id === target.id));
  });
  await check('parts SMS status lookup persistence failure retains claim until safe status-only recovery', async () => {
    const providerMessageId = sid();
    const target = await f.make('accepted', { sid: providerMessageId, providerStatus: 'queued' });
    const claim = await claimStatus(f, target.id);
    const before = await f.snapshot();
    await failPartsSmsWrite(f.db, 'p1_parts_sms_attempt_events', 'insert', async () => {
      await assert.rejects(() => f.statusComplete(target.id, claim.token, 'delivered', null, providerMessageId), error => error.code === 'P0001');
    });
    assert.deepEqual(await f.snapshot(), before);
    await f.statusComplete(target.id, claim.token, 'delivered', null, providerMessageId);
    assert.equal((await f.delivery(target.id)).attempt_count, 1);
  });
  await check('parts SMS manual reconciliation races require terminal unknown and respect active provider status claim', async () => {
    const target = await f.make();
    const claim = await f.take(target.id);
    await f.prepare(target.id, claim.token);
    await f.denied(() => f.action('manual', target.id), ['PT409']);
    await f.denied(() => f.action('resend', target.id), ['PT409']);
    await f.complete(target.id, claim.token);
    assert.equal((await f.action('manual', target.id)).status, 'manually_resolved');
    const providerMessageId = sid();
    const accepted = await f.make('accepted', { sid: providerMessageId, providerStatus: 'queued' });
    await partsSmsOwnerUpdate(f.db, 'p1_parts_alert_deliveries', "update public.p1_parts_alert_deliveries set status_check_count=19,next_status_at=clock_timestamp()-interval '1 second' where id=$1", [accepted.id]);
    const statusClaim = await f.statusClaim();
    assert.equal(statusClaim.claim.id, accepted.id);
    await f.denied(() => f.action('manual', accepted.id), ['PT409']);
    await f.statusComplete(accepted.id, statusClaim.token, 'queued', null, providerMessageId);
    assert.equal((await f.current(accepted.id)).statusCheckStale, true);
    assert.equal((await f.action('manual', accepted.id)).status, 'manually_resolved');
    assert.equal((await f.delivery(accepted.id)).status, 'accepted');
    assert.notEqual((await f.statusClaim()).claim?.id, accepted.id);
  });
  await check('parts SMS heartbeat records start/completion/replay and rejects conflicting completion', async () => {
    const run = randomUUID();
    const started = await f.rpc('start_parts_sms_run_v1', [run, 'synthetic-release']);
    assert.equal(started.runId, run);
    const healthStarted = await f.health();
    assert.ok(healthStarted.lastStartedAt);
    assert.equal(healthStarted.currentRunIncomplete, true);
    const summary = { claimed: 1, accepted: 1, unknown: 0 };
    const completed = await f.rpc('finish_parts_sms_run_v1', [run, JSON.stringify(summary), 'RUN_COMPLETE']);
    assert.equal(completed.runId, run);
    assert.equal(completed.replayed, false);
    assert.equal((await f.rpc('finish_parts_sms_run_v1', [run, JSON.stringify(summary), 'RUN_COMPLETE'])).replayed, true);
    await f.denied(() => f.rpc('finish_parts_sms_run_v1', [run, JSON.stringify({ claimed: 2 }), 'RUN_COMPLETE']), ['PT409']);
    const health = await f.health();
    assert.ok(health.lastCompletedAt);
    assert.ok(health.lastSuccessfulAt);
    assert.equal(health.cadenceMinutes, 3);
    assert.equal(health.stale, false);
  });
  await check('parts SMS unfinished worker run and two-interval heartbeat silence remain detectable', async () => {
    const run = randomUUID();
    await f.rpc('start_parts_sms_run_v1', [run, 'synthetic-crash']);
    await partsSmsOwnerUpdate(f.db, 'p1_parts_sms_runs', "update public.p1_parts_sms_runs set started_at=clock_timestamp()-interval '9 minutes',completed_at=case when completed_at is not null then clock_timestamp()-interval '8 minutes' end", []);
    await partsSmsOwnerUpdate(f.db, 'p1_parts_sms_runs', "update public.p1_parts_sms_runs set started_at=clock_timestamp()-interval '7 minutes' where id=$1", [run]);
    const health = await f.health();
    assert.equal(health.stale, true);
    assert.equal(health.currentRunIncomplete, true);
  });
  await check('parts SMS heartbeat rejects sensitive/unbounded summary and failed persistence is atomic', async () => {
    const run = randomUUID();
    await f.rpc('start_parts_sms_run_v1', [run, 'synthetic-bounded']);
    for (const summary of [{ phone: 'synthetic-private-value' }, { claimed: -1 }, { claimed: '1' }, Object.fromEntries(Array.from({ length: 25 }, (_, index) => [`metric${index}`, index]))]) {
      await f.denied(() => f.rpc('finish_parts_sms_run_v1', [run, JSON.stringify(summary), 'OK']), ['PT422']);
    }
    const before = await f.snapshot();
    await failPartsSmsWrite(f.db, 'p1_parts_sms_runs', 'update', async () => {
      await assert.rejects(() => f.rpc('finish_parts_sms_run_v1', [run, JSON.stringify({ claimed: 0 }), 'OK']), error => error.code === 'P0001');
    });
    assert.deepEqual(await f.snapshot(), before);
    assert.equal((await f.db.query('select completed_at from public.p1_parts_sms_runs where id=$1', [run])).rows[0].completed_at, null);
  });
}
