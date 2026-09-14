// Local disposable SQL only. Run with the approved engine and privacy preload:
// P1_SQL_TEST_ENGINE_DIR=... node --import ./scripts/pagination-test-support/syntheticSqlPrivacy.mjs scripts/verify-payment-hold-pagination.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { createDatabase, applyThrough, financialNotificationFixtures } from './financial-notification-test-support/fixtures.mjs';
import { candidateFixtures, ownerFixtureUpdate } from './financial-notification-test-support/candidate-fixtures.mjs';
import { syntheticSqlPrivacyReceipt } from './pagination-test-support/syntheticSqlPrivacy.mjs';

const db = await createDatabase();
const metrics = [];
let checks = 0;
const check = (condition, label) => { assert.ok(condition, label); checks++; };
try {
  await applyThrough(db, 143);
  check(syntheticSqlPrivacyReceipt().substitutedContactIdentities > 0, 'Historical contacts were substituted before fixture migration reads');
  const f = candidateFixtures(await financialNotificationFixtures(db));
  const { actors, as } = f;
  const page = (limit = 25, cursor = null, actor = actors.mgr, role = 'authenticated') => as(role, actor, async tx => {
    await tx.exec('set transaction read only');
    return (await tx.query('select public.list_contractor_invoice_payment_holds_page_v1($1,$2) result', [limit, cursor])).rows[0].result;
  });
  const rejected = async (run, codes = ['PDC01']) => {
    await assert.rejects(run, error => codes.includes(error.code)); checks++;
  };
  const encode = value => db.query('select public.portal_encode_cursor($1::jsonb) value', [JSON.stringify(value)]).then(r => r.rows[0].value);
  const decode = value => db.query('select public.portal_decode_cursor($1) value', [value]).then(r => r.rows[0].value);
  async function seed(size) {
    // Explicit synthetic owner fixture bypass only; no production command or
    // mutation implementation is modified. Real commands are tested below.
    await db.transaction(async tx => {
      await tx.exec('alter table public.invoices disable trigger user; alter table public.contractor_invoice_payment_holds disable trigger user');
      await tx.exec("delete from public.contractor_invoice_payment_holds where invoice_id in (select id from public.invoices where num like 'PH6A-%'); delete from public.invoices where num like 'PH6A-%'");
      await tx.query(`insert into public.invoices(id,num,invoice_date,contractor_id,created_by,invoice_type,state,total)
        select ('60000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'PH6A-'||n,'2026-01-01',$2,$2,'contractor','approved',123.45
        from generate_series(1,$1::integer) n`, [size, actors.contractor]);
      await tx.query(`insert into public.contractor_invoice_payment_holds(invoice_id,placed_at,placed_by,reason)
        select ('60000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
          '2026-01-01T00:00:00.123456Z'::timestamptz+(n/123)*interval '1 second',$2,'Synthetic hold pagination'
        from generate_series(1,$1::integer) n`, [size, actors.mgr]);
      await tx.exec('alter table public.contractor_invoice_payment_holds enable trigger user; alter table public.invoices enable trigger user');
    });
    await db.exec('analyze public.contractor_invoice_payment_holds; analyze public.invoices');
  }
  async function walk(limit = 25, initial = null) {
    let cursor = initial;
    const ids = []; let maximumBytes = 0; let pages = 0;
    do {
      const value = await page(limit, cursor);
      check(value.holds.length <= limit && value.pageSize === limit, 'Every page respects its exact requested bound');
      check(value.hasMore === (value.nextCursor !== null), 'Continuation is not an invented total');
      if (value.hasMore) check(value.holds.length === limit, 'The next-row probe produces complete nonterminal pages');
      ids.push(...value.holds.map(row => row.invoiceId));
      maximumBytes = Math.max(maximumBytes, Buffer.byteLength(JSON.stringify(value)));
      cursor = value.nextCursor;
      pages++;
      check(pages < 1000, 'Traversal terminates');
    } while (cursor);
    check(new Set(ids).size === ids.length, 'No duplicate IDs while data is unchanged');
    return { ids, maximumBytes, pages };
  }
  for (const size of [100, 1000, 10000]) {
    await seed(size);
    const expected = (await db.query('select h.invoice_id from public.contractor_invoice_payment_holds h join public.invoices i on i.id=h.invoice_id where i.invoice_type=\'contractor\' and i.deleted_at is null order by h.placed_at desc,h.invoice_id desc')).rows.map(row => row.invoice_id);
    const started = performance.now(); const result = await walk();
    assert.deepEqual(result.ids, expected); checks++;
    metrics.push({ rows: size, pageSize: 25, pages: result.pages, maximumPageBytes: result.maximumBytes, traversalMs: Math.round(performance.now() - started) });
  }
  // Existing tuple index and an actual late seek plan: no OFFSET or full held
  // table/count RPC result is returned to the browser. Plan metrics are local.
  const pivot = (await db.query('select placed_at::text at,invoice_id id from public.contractor_invoice_payment_holds order by placed_at desc,invoice_id desc offset 9900 limit 1')).rows[0];
  const explain = (await db.query(`explain (analyze, buffers, format json) select h.invoice_id,h.placed_at
    from public.contractor_invoice_payment_holds h join public.invoices i on i.id=h.invoice_id
    where i.invoice_type='contractor' and i.deleted_at is null and (h.placed_at,h.invoice_id)<($1::timestamptz,$2::uuid)
    order by h.placed_at desc,h.invoice_id desc limit 26`, [pivot.at, pivot.id])).rows[0]['QUERY PLAN'][0];
  check(JSON.stringify(explain).includes('contractor_invoice_payment_holds_placed'), 'Late page reuses the existing timestamp/UUID index');
  metrics.push({ lateSeekExecutionMs: explain['Execution Time'], lateSeekRows: explain.Plan['Actual Rows'] });

  await seed(1001);
  const legacyDefault = await as('authenticated', actors.mgr, tx => tx.query('select public.list_contractor_invoice_payment_holds_page_v1() result'));
  check(legacyDefault.rows[0].result.holds.length === 100 && legacyDefault.rows[0].result.pageSize === 100, 'No-parameter browser compatibility default remains 100');
  check((await walk(100)).ids.length === 1001, 'Scalar JSON page crosses a PostgREST 1000-row cap without truncation');
  const first = await page(); const token = first.nextCursor; const cursor = await decode(token);
  check(cursor.placedAt.includes('123456'), 'Cursor retains all PostgreSQL timestamp microseconds');
  for (const limit of [null, 0, -1, 101, 2147483647]) await rejected(() => page(limit), ['22023']);
  for (const invalid of ['', ' ', 'not+base64', 'x'.repeat(4097), 'e30', 'bnVsbA']) await rejected(() => page(25, invalid));
  for (const change of [[], null, { ...cursor, version: 2 }, { ...cursor, version: '1' },
    { ...cursor, actor: actors.mgr }, { ...cursor, scope: 'wrong' }, { ...cursor, placedAt: 'infinity' },
    { ...cursor, placedAt: '2026-13-01T00:00:00Z' }, { ...cursor, invoiceId: null }, { ...cursor, invoiceId: 'not-uuid' }]) {
    const invalid = await encode(change); await rejected(() => page(25, invalid));
  }
  await rejected(() => page(100, token));
  await rejected(() => page(25, token, actors.handoff));
  for (const actor of [actors.contractor, actors.outsider, actors.inactive, actors.noProfile, actors.inactiveManager]) {
    await rejected(() => page(25, token, actor), ['42501']);
  }
  await rejected(() => page(25, null, null, 'anon'), ['42501']);
  await rejected(() => page(25, null, null, 'service_role'), ['42501']);
  for (const actor of [actors.mgr, actors.dispatcher, actors.backOffice, actors.controller, actors.handoffOnly].filter(Boolean)) {
    check((await page(25, null, actor)).holds.length === 25, 'Existing active staff/controller read visibility is preserved');
  }
  await db.query("insert into public.staff_permission_grants(profile_id,permission) values($1,'synthetic_page_scope')", [actors.mgr]);
  await rejected(() => page(25, token));
  await db.query("delete from public.staff_permission_grants where profile_id=$1 and permission='synthetic_page_scope'", [actors.mgr]);
  await ownerFixtureUpdate(db, 'profiles', "update public.profiles set role='back_office' where id=$1", [actors.mgr]);
  await rejected(() => page(25, token));
  await ownerFixtureUpdate(db, 'profiles', "update public.profiles set role='manager' where id=$1", [actors.mgr]);
  await ownerFixtureUpdate(db, 'profiles', 'update public.profiles set active=false where id=$1', [actors.mgr]);
  await rejected(() => page(25, token), ['42501']);
  await ownerFixtureUpdate(db, 'profiles', 'update public.profiles set active=true where id=$1', [actors.mgr]);

  // Filter-before-probe: hidden rows at the head do not make a short first page.
  await ownerFixtureUpdate(db, 'invoices', 'update public.invoices set deleted_at=now() where id=any($1::uuid[])', [first.holds.slice(0, 10).map(row => row.invoiceId)]);
  check((await page()).holds.length === 25 && (await walk()).ids.length === 991, 'Soft-deleted invoice rows are excluded before limit+1');
  const visible = await page();
  check(visible.holds.every(row => row.workOrderId === null && row.externalWorkOrderId === null), 'Unlinked current holds remain visible');
  check(visible.holds[0].total === 123.45 && typeof visible.holds[0].contractorName === 'string', 'Legacy financial/display projection remains intact');
  const originalLabels = (await db.query('select id,name,company from public.profiles where id=any($1::uuid[])', [[actors.mgr, actors.contractor]])).rows;
  await ownerFixtureUpdate(db, 'profiles', "update public.profiles set name=repeat('S',800),company=repeat('C',800) where id=any($1::uuid[])", [[actors.mgr, actors.contractor]]);
  const longDisplay = await page();
  check(longDisplay.holds.length === 25 && longDisplay.holds.every(row => row.contractorName.length === 500
    && row.contractorName.endsWith('…') && row.holdByName.length === 500 && row.holdByName.endsWith('…')),
  'Oversized display-only names remain readable and cannot poison or enlarge the whole page');
  check((await db.query('select bool_and(length(name)=800 and length(company)=800) intact from public.profiles where id=any($1::uuid[])', [[actors.mgr, actors.contractor]])).rows[0].intact,
    'Display ellipsis does not modify full stored identities');
  for (const original of originalLabels) await ownerFixtureUpdate(db, 'profiles', 'update public.profiles set name=$2,company=$3 where id=$1', [original.id, original.name, original.company]);

  // Real financial commands: reads do not mutate ledgers; release/re-hold is
  // still notification-aware, stale-source protected, and naturally live.
  await seed(123);
  const target = await f.invoice();
  await f.candidateReview(target, { action: 'approve' });
  const placed = await f.candidateHold(target);
  const beforeRead = await f.snapshot(target);
  const newest = await page();
  check(newest.holds[0].invoiceId === target.id, 'New hold appears on newest page');
  await page(25, newest.nextCursor);
  assert.deepEqual(await f.snapshot(target), beforeRead); checks++;
  await rejected(() => f.candidateHold(target, { action: 'release', actor: actors.contractor, source: placed.notifications[0].sourceEventId }), ['42501']);
  const released = await f.candidateHold(target, { action: 'release', source: placed.notifications[0].sourceEventId });
  check(released.applied === true && !(await walk()).ids.includes(target.id), 'Authoritative release removes the current hold');
  const reheld = await f.candidateHold(target, { source: released.notifications[0].sourceEventId });
  check(reheld.applied === true && !(await walk(25, newest.nextCursor)).ids.includes(target.id), 'A re-hold above the cursor waits for Refresh newest');
  check((await page()).holds[0].invoiceId === target.id, 'Refresh newest discovers re-hold');
  await rejected(() => f.candidateHold(target, { action: 'release', source: placed.notifications[0].sourceEventId }), ['PT409']);

  const audit = await db.transaction(async tx => {
    await tx.exec('set transaction read only');
    return tx.exec(readFileSync('supabase/audits/0143_bounded_payment_hold_history_verification.sql', 'utf8'));
  });
  check(audit[0].rows[0].all_checks_pass, 'Promotion audit succeeds in a genuine READ ONLY transaction');
  console.log(JSON.stringify({ suite: 'payment-hold-pagination', checks, metrics, privacy: syntheticSqlPrivacyReceipt(), externalCalls: 0 }));
} finally { await db.close(); }
