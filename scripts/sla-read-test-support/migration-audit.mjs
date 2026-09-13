import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { helperSignature } from './fixtures.mjs';

const auditSql = readFileSync(new URL('../../supabase/audits/0141_read_only_sla_policy_compatibility_verification.sql', import.meta.url), 'utf8');
const call = alias => `public.evaluate_work_order_sla_v1(
              ${alias}.priority::text, ${alias}.dispatched_at,
              ${alias}.response_breach_at, ${alias}.resolution_breach_at,
              ${alias}.start_time, now()
            ) effective_sla`;
const dueOld = `coalesce(
        work_order.response_breach_at,
        work_order.resolution_breach_at,`;
const dueNew = `coalesce(
        (select effective_sla.due_at from ${call('work_order')}),`;
const overdueOld = `and coalesce(
            work_order.response_breach_at,
            work_order.resolution_breach_at
          ) < now()`;
const overdueNew = `and (select effective_sla.breached from ${call('work_order')})`;
const navOld = `and (
          (
            annotated.response_breach_at is not null
            and annotated.start_time is null
            and annotated.response_breach_at <= now()
          )
          or (
            annotated.resolution_breach_at is not null
            and annotated.resolution_breach_at <= now()
          )
        )`;
const navNew = `and (select effective_sla.breached from ${call('annotated')})`;

function replaceOnce(value, from, to) {
  assert.equal(value.split(from).length, 2, 'Exactly one reviewed SLA expression is changed');
  return value.replace(from, to);
}
export async function verifySlaMigration(f, before, rowsBefore, check) {
  await check('SLA migration changes exactly four read expressions and preserves all other effective RPC SQL and ACL', async () => {
    const after = await f.definitions();
    assert.equal(after.length, before.length);
    for (const original of before) {
      const candidate = after.find(row => row.proname === original.proname);
      let expected = original.definition;
      if (original.proname === 'get_portal_navigation_summary') expected = replaceOnce(expected, navOld, navNew);
      else {
        expected = replaceOnce(expected, dueOld, dueNew);
        if (original.proname === 'list_work_orders_table_page') expected = replaceOnce(expected, overdueOld, overdueNew);
      }
      assert.equal(candidate.definition, expected);
      assert.deepEqual({ ...candidate, definition: null }, { ...original, definition: null });
    }
    assert.deepEqual(await f.assignment.snapshot(), rowsBefore, 'No source row is changed by read-only migration');
  });
  await check('SLA helper remains pure immutable invoker with only authenticated/service execution', async () => {
    const row = (await f.db.query(`select p.prosecdef,p.provolatile,p.proconfig,p.proparallel,
      has_function_privilege('anon',p.oid,'EXECUTE') anon,
      has_function_privilege('authenticated',p.oid,'EXECUTE') browser,
      has_function_privilege('service_role',p.oid,'EXECUTE') service
      from pg_proc p where oid=$1::regprocedure`, [helperSignature])).rows[0];
    assert.equal(row.prosecdef, false);assert.equal(row.provolatile, 'i');assert.equal(row.proparallel, 's');
    assert.deepEqual(row.proconfig, ['search_path=pg_catalog, public']);
    assert.equal(row.anon, false);assert.equal(row.browser, true);assert.equal(row.service, true);
    await assert.rejects(() => f.as('anon', null,
      tx => tx.query("select * from public.evaluate_work_order_sla_v1('p1',now(),null,null,null,now())")), error => error.code === '42501');
  });
  await check('SLA audit runs in actual READ ONLY transaction and source rows remain byte-identical', async () => {
    const snapshot = await f.assignment.snapshot();
    const results = await f.db.transaction(async tx => {
      await tx.exec('set transaction read only');
      return tx.exec(auditSql);
    });
    assert.equal(results.length, 4);
    assert.equal(results[0].rows.length, 4);
    for (const row of results[0].rows) {
      for (const key of ['invoker_preserved', 'expected_volatility', 'pinned_search_path', 'authenticated_execute', 'service_execute']) assert.equal(row[key], true);
      assert.equal(row.public_execute, false);assert.equal(row.anonymous_execute, false);
    }
    for (const value of Object.values(results[1].rows[0])) assert.equal(value, true);
    for (const row of results[3].rows) for (const [key, value] of Object.entries(row)) if (key !== 'proname') assert.equal(value, true);
    const encoded = JSON.stringify(results);
    assert.equal(encoded.includes('SYNTHETIC-SLA-'), false);
    for (const id of Object.values(f.actors)) assert.equal(encoded.includes(id), false);
    assert.deepEqual(await f.assignment.snapshot(), snapshot);
  });
}
