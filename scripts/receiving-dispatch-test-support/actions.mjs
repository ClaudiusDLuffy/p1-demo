import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { deliveryTable, mutateFixture, withWriteFailure } from './fixtures.mjs';

export async function verifyCloseoutActions(f, check) {
  for (const actor of ['mgr', 'dispatcher', 'backOffice']) {
    for (const kind of ['resend', 'manual']) {
      await check(`${actor} ${kind} records immutable evidence, preserves original unknown, and replays one operation`, async () => {
        const target = await f.outcome(await f.create());
        const original = await f.row(target.delivery.id);
        const operation = randomUUID();
        const result = await f.action(kind, target, { actor: f.actors[actor], operation });
        assert.equal(result.status, kind === 'resend' ? 'queued' : 'manually_resolved');
        assert.equal(result.operationId, operation);
        assert.deepEqual(await f.row(target.delivery.id), original);
        const after = await f.snapshot();
        const replay = await f.action(kind, target, { actor: f.actors[actor], operation });
        assert.equal(replay.status, result.status);
        assert.equal(replay.deliveryId, result.deliveryId);
        assert.equal(replay.replayed, true);
        assert.deepEqual(await f.snapshot(), after);
        await f.denied(() => f.action(kind, target, { actor: f.actors[actor], operation, reason: 'Changed synthetic reason' }));
        assert.deepEqual(await f.snapshot(), after);
        const evidence = (await f.db.query('select * from public.receiving_dispatch_operations where operation_id=$1', [operation])).rows[0];
        assert.equal(evidence.actor_id, f.actors[actor]);
        assert.equal(evidence.reason, 'Synthetic reasoned staff contact');
        assert.ok(evidence.created_at);
        const visible = await f.current(target);
        if (kind === 'resend') {
          const child = await f.row(result.deliveryId);
          assert.notEqual(child.id, original.id);
          assert.equal(child.parent_delivery_id, original.id);
          assert.equal(child.event_type, 'explicit_resend');
          assert.equal(child.status, 'pending');
          assert.equal(child.assignment_version, original.assignment_version);
          assert.equal(child.recipient_profile_id, original.recipient_profile_id);
          assert.equal(visible.delivery.id, child.id);
          await f.denied(() => f.action(kind, target), ['PT409', '23505']);
          const pending = await f.claim(25);
          for (const item of pending.rows) { await f.start(item.id, pending.token); await f.complete(item.id, pending.token, 'sent'); }
        } else {
          assert.equal(visible.delivery.state, 'manually_resolved');
          assert.equal(original.sent_at, null);
          await f.denied(() => f.action('resend', target));
        }
        const timeline = await f.history(target.delivery.id);
        assert.ok(timeline.items.length > 0);
        assert.doesNotMatch(JSON.stringify(timeline), /@|recipientEmail|providerReference|claim_token/);
      });
    }
  }
  await check('operation UUID binds delivery, assignment, actor, action, and normalized reason', async () => {
    const target = await f.outcome(await f.create());
    const other = await f.outcome(await f.create());
    const operation = randomUUID();
    await f.action('manual', target, { operation, reason: '  Synthetic normalized reason  ' });
    assert.equal((await f.action('manual', target, { operation, reason: 'Synthetic normalized reason' })).replayed, true);
    for (const options of [{ deliveryId: other.delivery.id }, { version: target.row.contractor_assignment_version + 1 }, { actor: f.actors.dispatcher }]) {
      await f.denied(() => f.action('manual', target, { ...options, operation, reason: 'Synthetic normalized reason' }));
    }
    await f.denied(() => f.action('resend', target, { operation, reason: 'Synthetic normalized reason' }));
  });
  for (const kind of ['resend', 'manual']) {
    await check(`${kind} requires a bounded reason, operation UUID, and current assignment version`, async () => {
      const target = await f.outcome(await f.create());
      const before = await f.snapshot();
      for (const reason of ['', '  ', 'x'.repeat(501)]) await f.denied(() => f.action(kind, target, { reason }));
      await f.denied(() => f.rpc('authenticated', f.actors.mgr,
        kind === 'resend' ? 'request_receiving_dispatch_resend_v1' : 'resolve_receiving_dispatch_out_of_band_v1',
        [target.delivery.id, target.row.contractor_assignment_version, null, 'Synthetic reason']));
      await f.denied(() => f.action(kind, target, { version: target.row.contractor_assignment_version + 1 }));
      await f.denied(() => f.action(kind, target, { deliveryId: randomUUID() }));
      assert.deepEqual(await f.snapshot(), before);
    });
  }
  for (const state of ['pending', 'claimed', 'sending', 'sent', 'superseded', 'cancelled']) {
    await check(`${state} cannot be resent or relabeled as manual contact`, async () => {
      const target = await f.create();
      if (state !== 'pending') await mutateFixture(f.db, deliveryTable,
        `update public.${deliveryTable} set status=$2 where id=$1`, [target.delivery.id, state]);
      const before = await f.snapshot();
      for (const kind of ['resend', 'manual']) await f.denied(() => f.action(kind, target));
      assert.deepEqual(await f.snapshot(), before);
    });
  }
  await check('known-unsent scheduled retry remains worker-owned until the attempt ceiling', async () => {
    const target = await f.create();
    await mutateFixture(f.db, deliveryTable, `update public.${deliveryTable} set status='failed',attempt_count=1,
      last_error_code='GRAPH_RATE_LIMITED',next_attempt_at=clock_timestamp()+interval '5 minutes' where id=$1`, [target.delivery.id]);
    for (const kind of ['resend', 'manual']) await f.denied(() => f.action(kind, target));
    await mutateFixture(f.db, deliveryTable, `update public.${deliveryTable} set attempt_count=3 where id=$1`, [target.delivery.id]);
    assert.equal((await f.action('resend', target)).status, 'queued');
  });
  await check('not-deliverable cannot resend until same recipient has a deliverable address; manual contact is distinct', async () => {
    await f.db.query("update public.profiles set email='' where id=$1", [f.actors.contractor]);
    const target = await f.create();
    assert.equal(target.delivery.status, 'not_deliverable');
    await f.denied(() => f.action('resend', target));
    await f.db.query('update public.profiles set email=$2 where id=$1', [f.actors.contractor, 'restored@closeout.example.invalid']);
    assert.equal((await f.action('resend', target)).status, 'queued');
    await f.db.query("update public.profiles set email='' where id=$1", [f.actors.contractor]);
    const manual = await f.create();
    assert.equal((await f.action('manual', manual)).status, 'manually_resolved');
    assert.equal((await f.row(manual.delivery.id)).status, 'not_deliverable');
    await f.db.query('update public.profiles set email=$2 where id=$1', [f.actors.contractor, 'restored@closeout.example.invalid']);
  });
  for (const condition of ['inactive_recipient', 'missing_email', 'invalid_email', 'deleted_order', 'reassigned', 'unassigned']) {
    await check(`${condition} blocks stale or undeliverable resend`, async () => {
      const target = await f.outcome(await f.create());
      if (condition === 'inactive_recipient') await f.db.query('update public.profiles set active=false where id=$1', [f.actors.contractor]);
      if (condition === 'missing_email' || condition === 'invalid_email') await f.db.query('update public.profiles set email=$2 where id=$1', [f.actors.contractor, condition === 'missing_email' ? '' : 'invalid-address']);
      if (condition === 'deleted_order') await mutateFixture(f.db, 'work_orders', 'update public.work_orders set deleted_at=clock_timestamp() where id=$1', [target.id]);
      if (condition === 'reassigned' || condition === 'unassigned') await f.assignment.command('transition', f.actors.mgr,
        await f.assignment.context(target.id), condition === 'unassigned' ? null : f.actors.outsider);
      await f.denied(() => f.action('resend', target));
      if (['deleted_order', 'reassigned', 'unassigned'].includes(condition)) await f.denied(() => f.action('manual', target));
      await f.db.query('update public.profiles set active=true,email=$2 where id=$1', [f.actors.contractor, 'restored@closeout.example.invalid']);
    });
  }
  await check('manual contact rejects company identity drift even when profile and assignment version remain unchanged', async () => {
    const target = await f.outcome(await f.create());
    await f.db.query("update public.profiles set contractor_organization_id='61000000-0000-4000-8000-000000000001' where id=$1", [f.actors.contractor]);
    const current = await f.current(target);
    assert.equal(current.delivery.canResolve, false, 'Visible action availability must match company identity revalidation');
    assert.equal(current.delivery.canResend, false);
    for (const kind of ['resend', 'manual']) await f.denied(() => f.action(kind, target), ['PT409']);
    await f.db.query('update public.profiles set contractor_organization_id=null where id=$1', [f.actors.contractor]);
  });
  await check('inactive same-identity recipient can be contacted another way without recording email delivery', async () => {
    const target = await f.outcome(await f.create());
    const original = await f.row(target.delivery.id);
    await f.db.query('update public.profiles set active=false where id=$1', [f.actors.contractor]);
    assert.equal((await f.action('manual', target)).status, 'manually_resolved');
    assert.deepEqual(await f.row(target.delivery.id), original);
    await f.db.query('update public.profiles set active=true where id=$1', [f.actors.contractor]);
  });
  for (const [kind, tables] of [['resend', [deliveryTable, 'receiving_dispatch_operations']], ['manual', ['receiving_dispatch_operations']]]) {
    for (const table of tables) {
      await check(`${kind} rolls back all evidence after injected ${table} insertion failure`, async () => {
        const target = await f.outcome(await f.create());
        const before = await f.snapshot();
        const operation = randomUUID();
        await withWriteFailure(f.db, table, 'insert', () => f.denied(() => f.action(kind, target, { operation }), ['P0001']));
        assert.deepEqual(await f.snapshot(), before);
        assert.equal((await f.action(kind, target, { operation })).status, kind === 'resend' ? 'queued' : 'manually_resolved');
      });
    }
  }
}
