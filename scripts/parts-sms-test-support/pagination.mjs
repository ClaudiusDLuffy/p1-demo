import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { partsSmsOwnerUpdate } from './candidate-fixtures.mjs';

async function seedQueue(f, count = 103) {
  const target = await f.make('unknown');
  const search = `Synthetic page ${randomUUID()}`;
  await f.db.query('update public.profiles set name=$2 where id=$1', [target.profileId, search]);
  await partsSmsOwnerUpdate(f.db, 'p1_parts_alert_deliveries', `insert into public.p1_parts_alert_deliveries(
    id,recipient_id,local_date,request_signature,status,attempt_count,claimed_at,completed_at,
    provenance,recipient_profile_id,phone_snapshot,timezone,configuration_version,created_at,last_error_code)
    select gen_random_uuid(),recipient_id,local_date-n,request_signature,'unknown',0,clock_timestamp()-interval '3 days',
    clock_timestamp()-interval '2 days','owned_v1',recipient_profile_id,phone_snapshot,timezone,configuration_version,
    clock_timestamp()-interval '1 day','SMS_OUTCOME_UNKNOWN'
    from public.p1_parts_alert_deliveries cross join generate_series(1,$2::integer) n where id=$1`, [target.id, count]);
  // One exact timestamp is required: clock_timestamp() otherwise varies by row.
  await partsSmsOwnerUpdate(f.db, 'p1_parts_alert_deliveries', `update public.p1_parts_alert_deliveries
    set created_at=transaction_timestamp()-interval '1 day' where recipient_id=$1 and id<>$2`, [target.recipient.id, target.id]);
  const rows = (await f.db.query('select id,created_at from public.p1_parts_alert_deliveries where recipient_id=$1 order by created_at desc,id desc', [target.recipient.id])).rows;
  return { ...target, search, rows };
}

export async function verifyPartsSmsPagination(f, check) {
  await check('parts SMS unresolved keyset reaches every tied-timestamp row in bounded deterministic pages', async () => {
    const target = await seedQueue(f);
    let cursor = null;
    const ids = [];
    let pages = 0;
    do {
      const page = await f.page({ search: target.search, cursor });
      assert.ok(page.items.length <= 25);
      assert.equal(page.hasMore, page.nextCursor !== null);
      ids.push(...page.items.map(row => row.id));
      cursor = page.nextCursor;
      pages++;
      assert.ok(pages <= 5);
    } while (cursor);
    assert.equal(pages, 5);
    assert.deepEqual(ids, target.rows.map(row => row.id));
    assert.equal(new Set(ids).size, 104);
    const capped = await f.page({ search: target.search, limit: 50 });
    assert.equal(capped.items.length, 50);
    assert.equal(capped.hasMore, true);
  });
  await check('parts SMS insertion-safe cursor excludes arrivals and resolution does not skip surviving tied rows', async () => {
    const target = await seedQueue(f, 67);
    const first = await f.page({ search: target.search, limit: 10 });
    const resolvedId = target.rows[35].id;
    await f.action('manual', resolvedId);
    const insertedId = randomUUID();
    await partsSmsOwnerUpdate(f.db, 'p1_parts_alert_deliveries', `insert into public.p1_parts_alert_deliveries(
      id,recipient_id,local_date,request_signature,status,attempt_count,claimed_at,provenance,recipient_profile_id,
      phone_snapshot,timezone,configuration_version,created_at,last_error_code)
      select $2,recipient_id,local_date-200,request_signature,'unknown',0,clock_timestamp(),'owned_v1',recipient_profile_id,
      phone_snapshot,timezone,configuration_version,clock_timestamp(),'SMS_OUTCOME_UNKNOWN'
      from public.p1_parts_alert_deliveries where id=$1`, [target.id, insertedId]);
    const ids = first.items.map(row => row.id);
    let cursor = first.nextCursor;
    for (let pageIndex = 0; cursor && pageIndex < 10; pageIndex++) {
      const page = await f.page({ search: target.search, cursor, limit: 10 });
      ids.push(...page.items.map(row => row.id));
      cursor = page.nextCursor;
    }
    assert.equal(cursor, null);
    assert.deepEqual(ids, target.rows.map(row => row.id).filter(id => id !== resolvedId));
    assert.ok(!ids.includes(insertedId));
    assert.equal(new Set(ids).size, ids.length);
    assert.equal((await f.page({ search: target.search })).items[0].id, insertedId);
  });
  await check('parts SMS cursor binds normalized filters and rejects forged shape, future boundary and invalid limits', async () => {
    const target = await seedQueue(f, 28);
    const first = await f.page({ search: target.search, limit: 5 });
    const cursor = first.nextCursor;
    assert.ok(cursor);
    for (const patch of [{ state: 'failed' }, { search: 'Different search' }]) {
      await f.denied(() => f.page({ search: target.search, cursor, ...patch }), ['PT422']);
    }
    for (const patch of [{ version: 2 }, { id: 'invalid' }, { extra: true }, { snapshotAt: '2099-01-01T00:00:00Z' }, { createdAt: 'infinity' }, { state: 'failed' }]) {
      await f.denied(() => f.page({ search: target.search, cursor: { ...cursor, ...patch } }), ['PT422']);
    }
    for (const value of [[], 'invalid', { ...cursor, snapshotAt: null }]) {
      await f.denied(() => f.page({ search: target.search, cursor: value }), ['PT422']);
    }
    for (const limit of [0, -1, 51, 100000]) await f.denied(() => f.page({ limit }), ['PT422']);
    await f.denied(() => f.page({ state: 'delivered' }), ['PT422']);
    await f.denied(() => f.page({ search: 'x'.repeat(101) }), ['PT422']);
    assert.deepEqual((await f.page({ search: `  ${target.search}  `, cursor })).items,
      (await f.page({ search: target.search, cursor })).items);
  });
  await check('parts SMS aged unknown remains accountable without a stale-source resend action', async () => {
    const target = await seedQueue(f, 2);
    const page = await f.page({ state: 'unknown', search: target.search });
    assert.equal(page.items.length, 3);
    const historical = page.items.filter(row => row.id !== target.id);
    assert.ok(historical.every(row => !row.current && !row.canResend && row.canResolve));
    const selected = historical[0];
    await f.action('manual', selected.id);
    assert.ok(!(await f.page({ search: target.search })).items.some(row => row.id === selected.id));
    assert.equal((await f.page({ state: 'history', search: target.search })).items.find(row => row.id === selected.id).state, 'manually_resolved');
    assert.equal((await f.delivery(selected.id)).status, 'unknown');
  });
  await check('parts SMS history is independently bounded with stable tie-breakers and insertion boundary', async () => {
    const target = await f.make('unknown');
    await partsSmsOwnerUpdate(f.db, 'p1_parts_sms_attempt_events', `insert into public.p1_parts_sms_attempt_events(
      id,delivery_id,sequence,phase,claim_token,state,code,created_at)
      select gen_random_uuid(),$1,n,'expired',gen_random_uuid(),'unknown','SMS_OUTCOME_UNKNOWN',transaction_timestamp()-interval '1 hour'
      from generate_series(1,121) n`, [target.id]);
    const before = await f.attempts(target.id);
    const first = await f.history(target.id, { limit: 20 });
    assert.equal(first.items.length, 20);
    assert.equal(first.hasMore, true);
    const newAttempt = randomUUID();
    await partsSmsOwnerUpdate(f.db, 'p1_parts_sms_attempt_events', `insert into public.p1_parts_sms_attempt_events(
      id,delivery_id,sequence,phase,claim_token,state,code) values($1,$2,122,'expired',$3,'unknown','SMS_OUTCOME_UNKNOWN')`,
    [newAttempt, target.id, randomUUID()]);
    const rows = [...first.items];
    let cursor = first.nextCursor;
    for (let index = 0; cursor && index < 10; index++) {
      const page = await f.history(target.id, { cursor, limit: 20 });
      assert.ok(page.items.length <= 20);
      rows.push(...page.items);
      cursor = page.nextCursor;
    }
    assert.equal(cursor, null);
    assert.equal(rows.length, before.length + 1);
    assert.equal(new Set(rows.map(row => row.id)).size, rows.length);
    assert.ok(!rows.some(row => row.id === `attempt:${newAttempt}`));
    assert.ok((await f.history(target.id)).items.some(row => row.id === `attempt:${newAttempt}`));
    assert.doesNotMatch(JSON.stringify(rows), /phone|providerMessageId|SMS body|\+1202555/i);
    for (const patch of [{ deliveryId: randomUUID() }, { id: 'unsafe:invalid' }, { version: 2 }, { extra: true }]) {
      await f.denied(() => f.history(target.id, { cursor: { ...first.nextCursor, ...patch } }), ['PT422']);
    }
    for (const limit of [0, 51]) await f.denied(() => f.history(target.id, { limit }), ['PT422']);
  });
  await check('parts SMS resend child history preserves original outcome and manual evidence in one bounded family', async () => {
    const target = await f.make('unknown');
    const original = await f.attempts(target.id);
    const resend = await f.action('resend', target.id);
    const claim = await f.take(resend.deliveryId);
    await f.prepare(resend.deliveryId, claim.token);
    await f.complete(resend.deliveryId, claim.token);
    await f.action('manual', resend.deliveryId);
    const history = await f.history(target.id, { limit: 50 });
    assert.ok(history.items.some(row => row.kind === 'resend'));
    assert.ok(history.items.some(row => row.kind === 'manual_resolution'));
    assert.equal(history.items.filter(row => row.kind === 'delivery').length, 2);
    assert.deepEqual(await f.attempts(target.id), original);
    const childHistory = await f.history(resend.deliveryId, { limit: 50 });
    assert.deepEqual(childHistory.items, history.items);
  });
}
