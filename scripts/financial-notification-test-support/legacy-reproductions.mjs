import assert from 'node:assert/strict';

export async function reproduceFinancialNotificationLoss(f, check) {
  await check('BASELINE rejection commits authoritative activity when the browser never requests its notification', async () => {
    const target = await f.invoice();
    await f.review(target);
    assert.equal((await f.row(target.id)).state, 'rejected');
    const events = await f.activity(target, 'invoice_rejected');
    assert.equal(events.length, 1);
    assert.equal(events[0].event_data.revision, (await f.row(target.id)).review_revision);
    assert.ok(events[0].id);
    await f.noDeliveryLedger();
  });
  await check('BASELINE retraction commits approval and distinct activity without a durable correction-email intent', async () => {
    const target = await f.invoice();
    await f.review(target);
    const rejected = (await f.activity(target, 'invoice_rejected'))[0];
    await f.retract(target);
    assert.equal((await f.row(target.id)).state, 'approved');
    const retracted = await f.activity(target, 'invoice_rejection_retracted');
    assert.equal(retracted.length, 1);
    assert.notEqual(retracted[0].id, rejected.id);
    assert.equal(retracted[0].event_data.revision, rejected.event_data.revision);
    await f.noDeliveryLedger();
  });
  await check('BASELINE batch rejection commits all invoice decisions while no worker-owned financial delivery exists', async () => {
    const targets = [await f.invoice(), await f.invoice(), await f.invoice()];
    await f.batchReview(targets);
    for (const target of targets) {
      assert.equal((await f.row(target.id)).state, 'rejected');
      assert.equal((await f.activity(target, 'invoice_rejected')).length, 1);
    }
    await f.noDeliveryLedger();
  });
  await check('BASELINE ordinary approval is a financial event without an existing contractor notification family', async () => {
    const target = await f.invoice();
    await f.review(target, 'approve');
    assert.equal((await f.row(target.id)).state, 'approved');
    assert.equal((await f.activity(target, 'invoice_approved')).length, 1);
    assert.equal((await f.activity(target, 'invoice_rejected')).length, 0);
    await f.noDeliveryLedger();
  });
  await check('BASELINE hold, release, and rehold have distinct source UUIDs despite unchanged review revision', async () => {
    const target = await f.invoice();
    await f.review(target, 'approve');
    const revision = (await f.row(target.id)).review_revision;
    assert.equal((await f.hold(target)).applied, true);
    assert.equal((await f.hold(target, 'released')).applied, true);
    assert.equal((await f.hold(target, 'placed', f.actors.dispatcher, 'Synthetic second hold')).applied, true);
    const events = await f.holdEvents(target);
    assert.equal(events.length, 3);
    assert.deepEqual(events.map(event => event.action), ['placed', 'released', 'placed']);
    assert.equal(new Set(events.map(event => event.id)).size, 3);
    assert.equal((await f.row(target.id)).review_revision, revision);
    assert.equal((await f.row(target.id)).state, 'approved');
    await f.noDeliveryLedger();
  });
  await check('BASELINE repeated hold and already-released commands produce no new authoritative transition event', async () => {
    const target = await f.invoice();
    await f.review(target, 'approve');
    await f.hold(target, 'placed', f.actors.mgr, 'Synthetic original hold reason');
    const held = await f.holdEvents(target);
    const repeatedHold = await f.hold(target, 'placed', f.actors.mgr, 'Synthetic changed request reason');
    assert.equal(repeatedHold.applied, false);
    assert.equal(repeatedHold.reason, 'already_held');
    assert.equal(repeatedHold.holdReason, 'Synthetic original hold reason');
    assert.deepEqual(await f.holdEvents(target), held);
    await f.hold(target, 'released');
    const released = await f.holdEvents(target);
    const repeatedRelease = await f.hold(target, 'released');
    assert.equal(repeatedRelease.applied, false);
    assert.equal(repeatedRelease.reason, 'not_held');
    assert.deepEqual(await f.holdEvents(target), released);
  });
  await check('BASELINE old release request lacks an expected hold identity and can release a later rehold', async () => {
    const target = await f.invoice();
    await f.review(target, 'approve');
    await f.hold(target);
    await f.hold(target, 'released', f.actors.handoff, 'Synthetic release request A');
    await f.hold(target, 'placed', f.actors.mgr, 'Synthetic later hold B');
    const repeatedOldRelease = await f.hold(target, 'released', f.actors.handoff, 'Synthetic release request A');
    assert.equal(repeatedOldRelease.applied, true);
    assert.equal((await f.holdEvents(target)).length, 4);
    assert.equal((await f.db.query('select count(*)::int n from public.contractor_invoice_payment_holds where invoice_id=$1', [target.id])).rows[0].n, 0);
  });
  await check('BASELINE review excludes controller while hold placement allows all active staff and release requires handoff', async () => {
    const target = await f.invoice();
    for (const actor of [f.actors.controller, f.actors.contractor, f.actors.admin, f.actors.report, f.actors.inactive]) {
      await f.denied(() => f.review(target, 'reject', actor));
    }
    await f.review(target, 'approve');
    assert.equal((await f.hold(target, 'placed', f.actors.controller)).applied, true);
    for (const actor of [f.actors.mgr, f.actors.dispatcher, f.actors.controller, f.actors.contractor, f.actors.inactive]) {
      await f.denied(() => f.hold(target, 'released', actor));
    }
    assert.equal((await f.hold(target, 'released', f.actors.handoff)).applied, true);
  });
}
