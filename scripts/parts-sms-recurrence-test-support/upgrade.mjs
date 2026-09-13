import assert from 'node:assert/strict';

export async function reproduceBlockedPartsRecurrence(f, check) {
  let target;
  await check('pre0139 real requested A→A+B→A is blocked with both original deliveries immutable', async () => {
    target = await f.begin();
    const departure = await f.depart(target);
    assert.equal(departure.evaluation.queued, 1);
    assert.equal((await f.delivery(target.id)).status, 'superseded');
    const returned = await f.returnTo(target, departure);
    assert.equal(returned.evaluation.queued, 0);
    assert.equal(returned.evaluation.recurrenceBlocked, 1);
    assert.equal(returned.rows.length, 2);
    assert.ok(returned.rows.every(row => row.status === 'superseded'));
    assert.equal((await f.current(target.id)).code, 'PARTS_SOURCE_RECURRENCE_REVIEW');
    target.original = await f.freeze(target);
    target.departure = departure;
  });
  return target;
}

export async function verifyRecurrenceUpgrade(f, target, check) {
  await check('0139 upgrade preserves all preexisting delivery columns, attempts and operations', async () => {
    await f.unchanged(target, target.original, true);
    assert.equal((await f.delivery(target.departure.opposite.id)).status, 'superseded');
  });
  await check('0139 supported upgrade recovers only a provable prior source cycle, never reopening the superseded original', async () => {
    const evaluation = await f.enqueue();
    const child = await f.newestChild(target);
    assert.equal(evaluation.recurrenceQueued, 1);
    assert.equal(evaluation.recurrenceBlocked, 0);
    assert.ok(child);
    assert.equal(child.status, 'pending');
    assert.equal(child.parent_delivery_id, target.id);
    assert.equal(child.delivery_origin, 'source_recurrence');
    assert.equal(child.request_signature, target.signature);
    await f.unchanged(target, target.original, true);
  });
}
