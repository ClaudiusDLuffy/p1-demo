import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { failWrite } from './candidate-fixtures.mjs';

export async function verifyFinancialIntentTransactions(f, check) {
  await check('single rejection transaction binds exactly one notification event to authoritative activity and revision', async () => {
    const target = await f.invoice();
    const operation = randomUUID();
    const result = await f.candidateReview(target, { operation });
    assert.equal(result.notificationStatus, 'queued');
    const events = await f.events(target);
    const source = await f.activity(target, 'invoice_rejected');
    assert.equal(events.length, 1);
    assert.equal(events[0].source_id, source[0].id);
    assert.equal(events[0].review_revision, target.row.review_revision);
    assert.equal(events[0].operation_id, operation);
    assert.equal(events[0].family, 'invoice_rejected');
    assert.equal(events[0].actor_id, f.actors.mgr);
    const deliveries = await f.deliveries(events[0]);
    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0].recipient_profile_id, target.row.contractor_id);
    assert.equal(deliveries[0].state, 'pending');
    assert.equal((await f.row(target.id)).state, 'rejected');
    assert.equal((await f.candidateReview(target, { operation })).replayed, true);
    assert.deepEqual(await f.events(target), events);
    for (const changed of [{ reason: 'Different synthetic reason' }, { actor: f.actors.dispatcher }, { revision: 99 }]) {
      await f.denied(() => f.candidateReview(target, { operation, ...changed }), ['PT409']);
    }
  });
  await check('retraction has independent immutable activity and notification identity, approval has no added family', async () => {
    const approved = await f.invoice();
    assert.equal((await f.candidateReview(approved, { action: 'approve' })).notificationStatus, 'not_required');
    assert.equal((await f.events(approved)).length, 0);
    const target = await f.invoice();
    await f.candidateReview(target);
    const rejected = (await f.events(target))[0];
    const operation = randomUUID();
    assert.equal((await f.candidateRetract(target, { operation })).notificationStatus, 'queued');
    const events = await f.events(target);
    assert.equal(events.length, 2);
    const retracted = events.find(event => event.family === 'invoice_rejection_retracted');
    assert.notEqual(retracted.id, rejected.id);
    assert.notEqual(retracted.source_id, rejected.source_id);
    assert.equal(retracted.source_id, (await f.activity(target, 'invoice_rejection_retracted'))[0].id);
    assert.equal((await f.row(target.id)).state, 'approved');
    assert.equal((await f.candidateRetract(target, { operation })).replayed, true);
    assert.equal((await f.events(target)).length, 2);
  });
  await check('batch review records one source-bound event per invoice and operation replay is stable', async () => {
    const targets = [await f.invoice(), await f.invoice(), await f.invoice()];
    const operation = randomUUID();
    const result = await f.batch(targets, { operation });
    assert.equal(result.count, 3);
    for (const target of targets) assert.equal((await f.events(target)).length, 1);
    assert.equal((await f.batch([...targets].reverse(), { operation })).replayed, true);
    await f.denied(() => f.batch(targets, { operation, reason: 'Different synthetic batch reason' }), ['PT409']);
    await f.denied(() => f.batch(targets.slice(1), { operation }), ['PT409']);
  });
  await check('batch stale member rolls back every decision, activity, notification, and operation', async () => {
    const targets = [await f.invoice(), await f.invoice()];
    const before = await f.snapshot(targets[0]);
    await f.denied(() => f.batch(targets, { revisions: { [targets[0].id]: targets[0].row.review_revision, [targets[1].id]: 99 } }), ['PT409']);
    assert.deepEqual(await f.snapshot(targets[0]), before);
    for (const target of targets) {
      assert.equal((await f.row(target.id)).state, 'submitted');
      assert.equal((await f.events(target)).length, 0);
    }
  });
  await check('hold/release/rehold use immutable hold-event UUIDs without review-revision collapse', async () => {
    const target = await f.invoice();
    await f.candidateReview(target, { action: 'approve' });
    const placedOperation = randomUUID();
    const first = await f.candidateHold(target, { operation: placedOperation });
    assert.equal(first.applied, true);
    assert.equal(first.notificationStatus, 'queued');
    let source = (await f.holdEvents(target)).at(-1).id;
    assert.equal((await f.candidateHold(target, { operation: placedOperation })).replayed, true);
    const noChange = await f.candidateHold(target, { source, reason: 'Synthetic changed no-op request' });
    assert.equal(noChange.applied, false);
    assert.equal(noChange.notificationStatus, 'not_required');
    assert.equal((await f.events(target)).length, 1);
    await f.candidateHold(target, { action: 'release', source });
    source = (await f.holdEvents(target)).at(-1).id;
    await f.candidateHold(target, { source, reason: 'Synthetic second hold' });
    const events = await f.events(target);
    assert.deepEqual(events.map(event => event.family), ['payment_hold_placed','payment_hold_released','payment_hold_placed']);
    assert.equal(new Set(events.map(event => event.source_id)).size, 3);
    assert.deepEqual(events.map(event => event.source_id), (await f.holdEvents(target)).map(event => event.id));
    assert.ok(events.every(event => event.review_revision === null));
    assert.equal((await f.row(target.id)).review_revision, target.row.review_revision);
  });
  await check('stale release cannot release a later rehold and an uncertain operation replay has no new source', async () => {
    const target = await f.invoice();
    await f.candidateReview(target, { action: 'approve' });
    await f.candidateHold(target);
    const firstHold = (await f.holdEvents(target)).at(-1).id;
    const operation = randomUUID();
    await f.candidateHold(target, { action: 'release', source: firstHold, operation });
    const release = (await f.holdEvents(target)).at(-1).id;
    await f.candidateHold(target, { source: release });
    const before = await f.snapshot(target);
    assert.equal((await f.candidateHold(target, { action: 'release', source: firstHold, operation })).replayed, true);
    await f.denied(() => f.candidateHold(target, { action: 'release', source: firstHold }), ['PT409']);
    assert.deepEqual(await f.snapshot(target), before);
    assert.equal((await f.holdEvents(target)).length, 3);
  });
  for (const table of ['invoices','activities','financial_notification_events','financial_notification_deliveries','financial_notification_mutation_operations']) {
    await check(`injected ${table} write failure rolls back single review and required notification atomically`, async () => {
      const target = await f.invoice();
      const before = await f.snapshot(target);
      await failWrite(f.db, table, async () => {
        await f.denied(() => f.candidateReview(target), ['P0001']);
      });
      assert.deepEqual(await f.snapshot(target), before);
    });
  }
  for (const table of ['contractor_invoice_payment_holds','contractor_invoice_payment_hold_events','financial_notification_events','financial_notification_deliveries','financial_notification_hold_heads']) {
    await check(`injected ${table} failure rolls back payment hold state, source, and notification`, async () => {
      const target = await f.invoice();
      await f.candidateReview(target, { action: 'approve' });
      const before = await f.snapshot(target);
      await failWrite(f.db, table, async () => {
        await f.denied(() => f.candidateHold(target), ['P0001']);
      });
      assert.deepEqual(await f.snapshot(target), before);
    });
  }
  await check('versioned review validates operation, reasons, revisions, and bounded batch inputs', async () => {
    const target = await f.invoice();
    for (const options of [{ reason: '' }, { reason: ' '.repeat(2) }, { revision: 0 }, { revision: 999 }]) {
      await f.denied(() => f.candidateReview(target, options), ['PT422','PT409']);
    }
    await f.denied(() => f.batch([], {}), ['PT422']);
    await f.denied(() => f.batch([target], { revisions: {} }), ['PT422']);
    await f.denied(() => f.batch([target], { revisions: { [target.id]: 'not-an-integer' } }), ['PT422']);
    await f.denied(() => f.rpc('review_contractor_invoice_with_notification_v1', [target.id, 'reject', 'Synthetic reason', null, 1]), ['PT422']);
    assert.equal((await f.events(target)).length, 0);
    const holdTarget=await f.invoice();await f.candidateReview(holdTarget,{action:'approve'});
    await f.denied(()=>f.candidateHold(holdTarget,{reason:'x'.repeat(501)}),['PT422']);
  });
  await check('maximum100-invoice batch queues one source event per invoice and101-item request is rejected',async()=>{
    const targets=[];
    for(let index=0;index<100;index++)targets.push(await f.invoice());
    const started=performance.now();const result=await f.batch(targets);
    console.log(`MEASURE authoritative financial batch100 ${(performance.now()-started).toFixed(2)}ms; synthetic in-memory PGlite transaction, no provider I/O`);
    assert.equal(result.count,100);
    const rows=(await f.db.query('select invoice_id,count(*)::int n from public.financial_notification_events where invoice_id=any($1::uuid[]) group by invoice_id',[targets.map(target=>target.id)])).rows;
    assert.equal(rows.length,100);assert.ok(rows.every(row=>row.n===1));
    await f.denied(()=>f.batch([...targets,{id:randomUUID(),row:{review_revision:1}}]),['PT422']);
  });
}
