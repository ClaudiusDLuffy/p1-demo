import assert from 'node:assert/strict';

const active = new Set(['unassigned', 'assigned', 'wip', 'parts']);
export async function verifySlaReadApis(f, baseline, check) {
  await check('SLA navigation and overdue table now agree for legacy breach and completed response', async () => {
    const summary = await f.summary();
    assert.equal(summary.result.slaBreachedCount, 1);
    const page = await f.page({ overdue: true });
    assert.deepEqual(page.result.items.map(row => row.id), [baseline.legacy.id]);
    assert.equal(page.result.items.some(row => row.id === baseline.responded.id), false);
  });
  await check('SLA both live page APIs place legacy due before completed-response resolution', async () => {
    for (const read of [f.page, f.legacyPage]) {
      const result = await read();
      assert.deepEqual(result.result.items.map(row => row.id), [baseline.legacy.id, baseline.responded.id]);
    }
  });
  const now = await f.clock();
  const at = hours => new Date(now.getTime() + hours * 3_600_000).toISOString();
  for (const row of [
    { response_breach_at: at(-1), resolution_breach_at: at(4) },
    { response_breach_at: at(-1), start_time: at(-2) },
    { resolution_breach_at: at(-2) },
    { response_breach_at: at(1), resolution_breach_at: at(2) },
    { priority: 'p3', dispatched_at: at(-100) },
    { priority: 'p5', dispatched_at: at(-100) },
    { response_breach_at: at(2), resolution_breach_at: at(1) },
    { response_breach_at: at(1), resolution_breach_at: at(1) },
    { response_breach_at: at(-3), resolution_breach_at: at(-1), status: 'closed' },
    { response_breach_at: at(-3), status: 'capital' },
    { response_breach_at: at(-3), status: 'pending_approval' },
    { response_breach_at: at(-3), deleted_at: at(-1) },
    { response_breach_at: at(1), contractor_id: f.actors.outsider },
  ]) await f.workOrder(row);
  await check('SLA navigation keeps exact active-status and deleted-row gates with canonical breach predicate', async () => {
    const result = await f.summary();
    const rows = await f.rows();
    const expected = rows.filter(row => !row.deleted_at && active.has(row.status) && f.model(row, result.evaluated_at).breached).length;
    assert.equal(result.result.slaBreachedCount, expected);
    assert.equal(result.result.openCount, rows.filter(row => !row.deleted_at && active.has(row.status)).length);
    assert.equal(result.result.historyCount, rows.filter(row => !row.deleted_at && row.status === 'closed').length);
  });
  await check('SLA table overdue membership agrees with TS for stored halves, check-in and legacy rows', async () => {
    const result = await f.page({ overdue: true, limit: 100 });
    const expected = (await f.rows()).filter(row => !row.deleted_at && f.model(row, result.evaluated_at).breached).map(row => row.id).sort();
    assert.deepEqual(result.result.items.map(row => row.id).sort(), expected);
    assert.equal(result.result.totalCount, expected.length);
  });
  await check('SLA table due sort, null sentinel and stable ID tiebreaker match both directions', async () => {
    for (const direction of ['asc', 'desc']) {
      const result = await f.page({ direction, limit: 100 });
      const expected = (await f.rows()).filter(row => !row.deleted_at).sort((left, right) => {
        const leftDue = f.model(left, result.evaluated_at).dueTime ?? Date.parse('9999-12-31T23:59:59Z');
        const rightDue = f.model(right, result.evaluated_at).dueTime ?? Date.parse('9999-12-31T23:59:59Z');
        const order = leftDue - rightDue || left.id.localeCompare(right.id);
        return direction === 'asc' ? order : -order;
      });
      assert.deepEqual(result.result.items.map(row => row.id), expected.map(row => row.id));
    }
  });
  await check('SLA table and original cursor continuations preserve bounded pages and no repeated IDs within stable data', async () => {
    for (const read of [f.page, f.legacyPage]) {
      const full = await read({ limit: 100 });
      const seen = [];
      let cursor = null;
      for (let index = 0; index < 20; index++) {
        const page = (await read({ limit: 2, cursor })).result;
        assert.ok(page.items.length <= 2);
        seen.push(...page.items.map(row => row.id));
        if (!page.hasMore) { assert.equal(page.nextCursor, null);break; }
        assert.equal(typeof page.nextCursor, 'string');cursor = page.nextCursor;
      }
      assert.deepEqual(seen, full.result.items.map(row => row.id));
      assert.equal(new Set(seen).size, seen.length);
    }
  });
  await check('SLA existing exact filters, scope, count, invalid-cursor and page caps remain', async () => {
    for (const read of [f.page, f.legacyPage]) {
      const history = (await read({ scope: 'history', limit: 1000 })).result;
      assert.ok(history.items.every(row => row.status === 'closed'));
      assert.equal(history.totalCount, history.items.length);
      const narrowed = (await read({ search: baseline.responded.id })).result;
      assert.deepEqual(narrowed.items.map(row => row.id), [baseline.responded.id]);
      await assert.rejects(() => read({ cursor: 'not_a_valid_cursor' }), error => ['22023', '22021'].includes(error.code));
      assert.ok((await read({ limit: 0 })).result.items.length <= 1);
    }
  });
  await check('SLA invoker reads preserve contractor company isolation and cannot override RLS with another contractor filter', async () => {
    for (const read of [f.page, f.legacyPage]) {
      const own = (await read({ actor: f.actors.contractor, limit: 100 })).result;
      assert.ok(own.items.length > 0);
      assert.ok(own.items.every(row => row.contractor_id === f.actors.contractor));
      const other = (await read({ actor: f.actors.contractor, contractor: f.actors.outsider })).result;
      assert.deepEqual(other.items, []);
      await assert.rejects(() => read({ role: 'anon', actor: null }), error => error.code === '42501');
    }
  });
  await check('SLA read requests cannot alter stored deadlines, anchors, work orders, financial or activity evidence', async () => {
    const before = await f.assignment.snapshot();
    for (const actor of [f.actors.mgr, f.actors.controller, f.actors.dispatcher, f.actors.contractor, f.actors.inactive]) {
      await f.summary(actor);
      await f.page({ actor, overdue: true });
      await f.legacyPage({ actor });
    }
    assert.deepEqual(await f.assignment.snapshot(), before);
  });
}
