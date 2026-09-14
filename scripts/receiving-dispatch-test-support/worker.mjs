import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { deliveryTable, mutateFixture, withWriteFailure } from './fixtures.mjs';

export async function verifyCloseoutWorker(f, check) {
  async function claimedTarget() {
    const target = await f.create();
    for (let page = 0; page < 100; page++) {
      const claim = await f.claim(25);
      for (const item of claim.rows) {
        if (item.id === target.delivery.id) continue;
        if (await f.start(item.id, claim.token)) await f.complete(item.id, claim.token, 'sent');
      }
      if (claim.rows.some(item => item.id === target.delivery.id)) return { target, token: claim.token };
    }
    assert.fail('Synthetic pending target must be reached in bounded drains');
  }
  await check('claim input bounds, exclusive tokens, completion replay, and sent terminal ownership execute', async () => {
    for (const limit of [0, -1, 26, 100, null]) await f.denied(() => f.claim(limit), ['PT422']);
    await f.denied(() => f.claim(1, null), ['PT422']);
    const { target, token } = await claimedTarget();
    assert.equal((await f.claim(25)).rows.some(item => item.id === target.delivery.id), false);
    assert.equal(await f.start(target.delivery.id, randomUUID()), false);
    await f.denied(() => f.complete(target.delivery.id, token, 'sent'), ['PT409']);
    assert.equal(await f.start(target.delivery.id, token), true);
    assert.equal(await f.start(target.delivery.id, token), false);
    await f.complete(target.delivery.id, token, 'sent');
    const before = await f.snapshot();
    assert.equal((await f.complete(target.delivery.id, token, 'sent')).status, 'sent');
    await f.denied(() => f.complete(target.delivery.id, token, 'unknown', 'GRAPH_OUTCOME_UNKNOWN'), ['PT409']);
    assert.deepEqual(await f.snapshot(), before);
    assert.equal((await f.claim(25)).rows.some(item => item.id === target.delivery.id), false);
  });
  await check('crash after claim before durable send-start reclaims safely with immutable expiry evidence', async () => {
    const { target, token } = await claimedTarget();
    await mutateFixture(f.db, deliveryTable, `update public.${deliveryTable} set claim_expires_at=clock_timestamp()-interval '1 second' where id=$1`, [target.delivery.id]);
    const reclaimed = await f.claim(25);
    assert.ok(reclaimed.rows.some(item => item.id === target.delivery.id));
    assert.notEqual(reclaimed.token, token);
    assert.equal((await f.row(target.delivery.id)).attempt_count, 2);
    await f.denied(() => f.complete(target.delivery.id, token, 'unknown', 'GRAPH_OUTCOME_UNKNOWN'), ['PT409']);
    const events = (await f.db.query("select state from public.receiving_dispatch_attempt_events where delivery_id=$1 and phase='claim_expired'", [target.delivery.id])).rows;
    assert.deepEqual(events, [{ state: 'pending' }]);
    await f.start(target.delivery.id, reclaimed.token);
    await f.complete(target.delivery.id, reclaimed.token, 'sent');
  });
  for (const description of ['crash after durable start before provider', 'provider timeout after possible acceptance', 'provider confirms but completion is lost']) {
    await check(`${description} becomes unknown on expiry and is never automatically claimed`, async () => {
      const { target, token } = await claimedTarget();
      await f.start(target.delivery.id, token);
      await mutateFixture(f.db, deliveryTable, `update public.${deliveryTable} set claim_expires_at=clock_timestamp()-interval '1 second' where id=$1`, [target.delivery.id]);
      assert.equal((await f.claim(25)).rows.some(item => item.id === target.delivery.id), false);
      assert.equal((await f.row(target.delivery.id)).status, 'unknown');
      assert.equal((await f.claim(25)).rows.some(item => item.id === target.delivery.id), false);
      await f.denied(() => f.complete(target.delivery.id, token, 'sent'), ['PT409']);
      assert.equal((await f.current(target)).delivery.canResend, true);
    });
  }
  for (const change of ['reassignment', 'deactivation', 'email_removed', 'company_changed']) {
    await check(`${change} between claim and provider preparation prevents the stale send`, async () => {
      const { target, token } = await claimedTarget();
      if (change === 'reassignment') await f.assignment.command('transition', f.actors.mgr, await f.assignment.context(target.id), f.actors.outsider);
      if (change === 'deactivation') await f.db.query('update public.profiles set active=false where id=$1', [f.actors.contractor]);
      if (change === 'email_removed') await f.db.query("update public.profiles set email='' where id=$1", [f.actors.contractor]);
      if (change === 'company_changed') await f.db.query("update public.profiles set contractor_organization_id='61000000-0000-4000-8000-000000000001' where id=$1", [f.actors.contractor]);
      assert.equal(await f.rpc('service_role', null, 'prepare_receiving_dispatch_send_v1', [target.delivery.id, token]), null);
      assert.equal((await f.row(target.delivery.id)).status, change === 'reassignment' ? 'superseded' : 'not_deliverable');
      await f.db.query('update public.profiles set active=true,email=$2,contractor_organization_id=null where id=$1', [f.actors.contractor, 'restored@closeout.example.invalid']);
    });
  }
  await check('same recipient email changes use current address and message projection excludes outgoing history', async () => {
    const { target, token } = await claimedTarget();
    await f.db.query('update public.profiles set email=$2 where id=$1', [f.actors.contractor, 'changed@closeout.example.invalid']);
    const message = await f.rpc('service_role', null, 'prepare_receiving_dispatch_send_v1', [target.delivery.id, token]);
    assert.equal(message.contractorEmail, 'changed@closeout.example.invalid');
    assert.doesNotMatch(JSON.stringify(message), /outgoing|previous|removal|transition|private|claim_token/i);
    await f.complete(target.delivery.id, token, 'sent');
  });
  await check('known-unsent rate-limit retry is delayed, capped at three, and distinct from terminal failure', async () => {
    const { target, token } = await claimedTarget();
    await f.start(target.delivery.id, token);
    await f.complete(target.delivery.id, token, 'failed', 'GRAPH_RATE_LIMITED');
    assert.equal((await f.row(target.delivery.id)).send_started_at, null, 'Failed shape remains valid for retry');
    assert.equal((await f.claim(25)).rows.some(item => item.id === target.delivery.id), false);
    assert.equal((await f.current(target)).delivery.canResend, false);
    for (let attempt = 2; attempt <= 3; attempt++) {
      await mutateFixture(f.db, deliveryTable, `update public.${deliveryTable} set next_attempt_at=clock_timestamp()-interval '1 second' where id=$1`, [target.delivery.id]);
      const next = await f.claim(25);
      assert.ok(next.rows.some(item => item.id === target.delivery.id));
      await f.start(target.delivery.id, next.token);
      await f.complete(target.delivery.id, next.token, 'failed', 'GRAPH_RATE_LIMITED');
    }
    assert.equal((await f.row(target.delivery.id)).attempt_count, 3);
    await mutateFixture(f.db, deliveryTable, `update public.${deliveryTable} set next_attempt_at=clock_timestamp()-interval '1 second' where id=$1`, [target.delivery.id]);
    assert.equal((await f.claim(25)).rows.some(item => item.id === target.delivery.id), false);
    assert.equal((await f.current(target)).delivery.canResend, true);
  });
  await check('completion evidence insertion failure rolls back result and stale sending later quarantines', async () => {
    const { target, token } = await claimedTarget();
    await f.start(target.delivery.id, token);
    const before = await f.snapshot();
    await withWriteFailure(f.db, 'receiving_dispatch_attempt_events', 'insert', () =>
      f.denied(() => f.complete(target.delivery.id, token, 'sent'), ['P0001']));
    assert.deepEqual(await f.snapshot(), before);
    await mutateFixture(f.db, deliveryTable, `update public.${deliveryTable} set claim_expires_at=clock_timestamp()-interval '1 second' where id=$1`, [target.delivery.id]);
    await f.claim(25);
    assert.equal((await f.row(target.delivery.id)).status, 'unknown');
  });
}
