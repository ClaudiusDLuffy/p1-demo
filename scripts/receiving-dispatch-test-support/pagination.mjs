import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { deliveryTable, mutateFixture } from './fixtures.mjs';

export async function verifyCloseoutPagination(f, check) {
  const targets = [];
  const tiedAt = new Date(Date.now() - 60_000).toISOString();
  for (let index = 0; index < 123; index++) {
    const target = await f.create({ id: `WOT98${String(index).padStart(5, '0')}` });
    await mutateFixture(f.db, deliveryTable, `update public.${deliveryTable} set status='unknown',
      last_error_code='GRAPH_OUTCOME_UNKNOWN',created_at=$2,completed_at=$2 where id=$1`, [target.delivery.id, tiedAt]);
    targets.push(target);
  }
  await check('123 tied-time unresolved rows are all reachable once with a bounded deterministic cursor', async () => {
    let cursor = null;
    const ids = [];
    do {
      const page = await f.page('unknown', 'WOT98', cursor, 17);
      assert.ok(page.items.length <= 17);
      assert.equal(page.hasMore, page.nextCursor !== null);
      for (const item of page.items) {
        assert.equal(item.state, 'unknown');
        assert.ok(item.workOrderId.startsWith('WOT98'));
        assert.doesNotMatch(JSON.stringify(item), /@|recipient|provider|claim_token|description/i);
        ids.push(item.id);
      }
      cursor = page.nextCursor;
    } while (cursor);
    assert.equal(ids.length, 123);
    assert.equal(new Set(ids).size, 123);
    const expected = targets.map(target => target.delivery.id).sort().reverse();
    assert.deepEqual(ids, expected);
  });
  await check('new arrival and resolution between pages preserve the remaining snapshot order', async () => {
    const first = await f.page('unknown', 'WOT98', null, 13);
    const seen = first.items.map(item => item.id);
    const remaining = targets.filter(target => !seen.includes(target.delivery.id));
    const resolved = remaining[0];
    await f.action('manual', resolved);
    const inserted = await f.create({ id: 'WOT9899999' });
    await mutateFixture(f.db, deliveryTable, `update public.${deliveryTable} set status='unknown',last_error_code='GRAPH_OUTCOME_UNKNOWN' where id=$1`, [inserted.delivery.id]);
    let cursor = first.nextCursor;
    while (cursor) {
      const page = await f.page('unknown', 'WOT98', cursor, 13);
      seen.push(...page.items.map(item => item.id));
      cursor = page.nextCursor;
    }
    assert.equal(new Set(seen).size, seen.length);
    assert.equal(seen.includes(inserted.delivery.id), false, 'Arrival after snapshot is available on refresh');
    assert.equal(seen.includes(resolved.delivery.id), false, 'Resolved unseen rows leave the live queue');
    assert.deepEqual(new Set(seen), new Set(targets.filter(target => target.delivery.id !== resolved.delivery.id).map(target => target.delivery.id)));
    assert.equal((await f.page('unknown', 'WOT98', null, 13)).items[0].id, inserted.delivery.id);
  });
  await check('cursor is filter-bound and rejects malformed timestamps, IDs, shape, and future snapshot', async () => {
    const page = await f.page('unknown', 'WOT98', null, 7);
    assert.ok(page.nextCursor);
    for (const cursor of [null, {}, [], 'bad', { ...page.nextCursor, extra: true },
      { ...page.nextCursor, version: 2 }, { ...page.nextCursor, id: 'bad-id' },
      { ...page.nextCursor, createdAt: 'invalid-date' }, { ...page.nextCursor, createdAt: 'infinity' },
      { ...page.nextCursor, snapshotAt: '2099-01-01T00:00:00Z' }]) {
      if (cursor === null) continue;
      await f.denied(() => f.page('unknown', 'WOT98', cursor, 7), ['PT422']);
    }
    await f.denied(() => f.page('failed', 'WOT98', page.nextCursor, 7), ['PT422']);
    await f.denied(() => f.page('unknown', 'another-search', page.nextCursor, 7), ['PT422']);
    assert.equal((await f.page('unknown', 'not-present', null, 7)).items.length, 0);
  });
  await check('page limits, state filter, search bound, and explicit empty/end contracts are enforced', async () => {
    for (const limit of [0, -1, 51, 100000, null]) await f.denied(() => f.page(null, '', null, limit), ['PT422']);
    for (const state of ['sent', 'pending', 'superseded', 'unknown OR true']) await f.denied(() => f.page(state), ['PT422']);
    await f.denied(() => f.page(null, 'x'.repeat(101)), ['PT422']);
    assert.deepEqual(await f.page(null, 'NO-SYNTHETIC-MATCH'), { items: [], hasMore: false, nextCursor: null });
    assert.ok((await f.page(null, '', null, 50)).items.length <= 50);
  });
  await check('queue excludes automatic retries, sent, superseded, manual resolutions, and prior receiving identities', async () => {
    const target = await f.create({ id: 'WOT9898888' });
    for (const [status, count, code] of [['pending', 0, null], ['sent', 1, null], ['superseded', 0, 'ASSIGNMENT_SUPERSEDED'],
      ['failed', 1, 'GRAPH_RATE_LIMITED']]) {
      await mutateFixture(f.db, deliveryTable, `update public.${deliveryTable} set status=$2,attempt_count=$3,last_error_code=$4 where id=$1`, [target.delivery.id, status, count, code]);
      assert.equal((await f.page(null, target.id)).items.length, 0);
    }
    await mutateFixture(f.db, deliveryTable, `update public.${deliveryTable} set status='unknown' where id=$1`, [target.delivery.id]);
    await f.assignment.command('transition', f.actors.mgr, await f.assignment.context(target.id), f.actors.outsider);
    assert.equal((await f.page(null, target.id)).items.length, 0);
    await f.denied(() => f.current(target), ['PT409']);
    const updated = { ...target, row: await f.parent(target.id) };
    assert.notEqual((await f.current(updated)).delivery.id, target.delivery.id);
  });
  await check('single-event history has continuation, immutable reason evidence, and rejects a different event cursor', async () => {
    const target = await f.create({ id: 'WOT9897777' });
    await mutateFixture(f.db, deliveryTable, `update public.${deliveryTable} set status='unknown' where id=$1`, [target.delivery.id]);
    let active = target;
    for (let index = 0; index < 9; index++) {
      const result = await f.action('resend', active, { reason: `Synthetic deliberate resend ${index}` });
      const child = await f.row(result.deliveryId);
      await mutateFixture(f.db, deliveryTable, `update public.${deliveryTable} set status='unknown' where id=$1`, [child.id]);
      active = { ...target, delivery: child };
    }
    await f.action('manual', active, { reason: 'Synthetic contacted by telephone' });
    const first = await f.history(target.delivery.id, null, 4);
    assert.equal(first.hasMore, true);
    const ids = [];
    let current = first;
    do {
      ids.push(...current.items.map(item => item.id));
      assert.ok(current.items.length <= 4);
      if (!current.nextCursor) break;
      current = await f.history(target.delivery.id, current.nextCursor, 4);
    } while (current);
    assert.equal(ids.length, 20);
    assert.equal(new Set(ids).size, ids.length);
    await f.denied(() => f.history(active.delivery.id, first.nextCursor, 4), ['PT422']);
    await f.denied(() => f.history(target.delivery.id, { ...first.nextCursor, id: 'x'.repeat(101) }, 4), ['PT422']);
    for (const id of ['', 'bogus', `unknown:${randomUUID()}`, 'delivery:not-a-uuid']) {
      await f.denied(() => f.history(target.delivery.id, { ...first.nextCursor, id }, 4), ['PT422']);
    }
    await f.denied(() => f.history(randomUUID()), ['PT404']);
  });
  await check('missing post-cutover intent is distinct from legacy and cannot trigger browser-created recovery', async () => {
    const id = 'WOT9896666';
    await f.db.transaction(async tx => {
      await tx.exec('alter table public.work_orders disable trigger queue_receiving_contractor_dispatch_trigger');
      await tx.query("insert into public.work_orders(id,contractor_id,status,contractor_assignment_started_at) values($1,$2,'assigned',clock_timestamp())", [id, f.actors.contractor]);
      await tx.exec('alter table public.work_orders enable trigger queue_receiving_contractor_dispatch_trigger');
    });
    const result = await f.current({ id, row: await f.parent(id) });
    assert.equal(result.kind, 'missing_intent');
    assert.equal(result.delivery, null);
  });
  await check('local current, empty, maximum-page, and continuation queries remain bounded with synthetic data', async () => {
    const samples = {};
    const measure = async (label, operation) => {
      const started = performance.now();
      const result = await operation();
      samples[label] = Math.round((performance.now() - started) * 100) / 100;
      return result;
    };
    await measure('currentStatusMs', () => f.current(targets[1]));
    assert.equal((await measure('emptyQueueMs', () => f.page(null, 'NO-SYNTHETIC-MATCH'))).items.length, 0);
    const page = await measure('maximumPageMs', () => f.page('unknown', 'WOT98', null, 50));
    assert.equal(page.items.length, 50);
    assert.ok((await measure('continuationPageMs', () => f.page('unknown', 'WOT98', page.nextCursor, 50))).items.length <= 50);
    console.log(`LOCAL synthetic query samples ${JSON.stringify(samples)}; local PGlite timings, not hosted throughput or independent sessions.`);
  });
}
