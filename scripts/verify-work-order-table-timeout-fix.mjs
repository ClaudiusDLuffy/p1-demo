// Synthetic-only verification for migration 0151. Uses the approved disposable
// SQL engine and never reads environment credentials or a hosted database.
import './pagination-test-support/syntheticSqlPrivacy.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { createDatabase, applyThrough, seedPerformanceFixture }
  from './query-performance-test-support/fixtures.mjs';

const samples = 7;
const db = await createDatabase();
let checks = 0;
const check = value => { assert.ok(value); checks++; };

try {
  await applyThrough(db, 150);
  const fixture = await seedPerformanceFixture(db);
  const run = (actor, sql, params = [], role = 'authenticated') =>
    fixture.as(role, actor, tx => tx.query(sql, params)).then(result => result.rows[0]?.result);

  const policySql = `select polcmd,polpermissive,polroles,pg_get_expr(polqual,polrelid) expression
    from pg_policy where polrelid='public.profiles'::regclass and polname='profiles_read'`;
  assert.deepEqual((await db.query(policySql)).rows, [{
    polcmd: 'r', polpermissive: true, polroles: [0], expression: 'can_read_contractor_profile(id)',
  }]);
  checks++;

  const helperSql = `select p.oid::regprocedure::text identity,pg_get_functiondef(p.oid) definition,p.proacl::text acl
    from pg_proc p where p.oid in ('public.is_staff()'::regprocedure,
      'public.can_read_contractor_profile(uuid)'::regprocedure) order by 1`;
  const helpersBefore = (await db.query(helperSql)).rows;
  const dataBefore = (await db.query(`select
    (select count(*) from public.profiles)::integer profiles,
    (select count(*) from public.work_orders)::integer work_orders,
    (select count(*) from public.activities)::integer activities`)).rows[0];

  const actors = [...Object.keys(fixture.actors), 'missingProfile', 'anonymous'];
  const actorId = name => name === 'missingProfile'
    ? '89999999-0000-4000-8000-000000000999'
    : name === 'anonymous' ? null : fixture.actors[name];
  const visibleProfiles = async name => {
    try {
      const rows = await fixture.as(name === 'anonymous' ? 'anon' : 'authenticated', actorId(name),
        tx => tx.query('select id from public.profiles order by id'));
      return { outcome: 'rows', ids: rows.rows.map(row => row.id) };
    } catch (error) {
      return { outcome: 'error', code: error.code };
    }
  };
  const visibilityBefore = new Map();
  for (const actor of actors) visibilityBefore.set(actor, await visibleProfiles(actor));

  const cases = [
    ['staff_contractor_sort', 'manager',
      "select public.list_work_orders_table_rows_v2(p_scope=>'all',p_sort_column=>'contractor',p_limit=>25) result"],
    ['staff_contractor_filter', 'manager',
      "select public.list_work_orders_table_rows_v2(p_scope=>'all',p_sort_column=>'contractor',p_contractor_filter=>'Synthetic',p_limit=>25) result"],
    ['staff_contractor_count', 'manager',
      "select public.count_work_orders_table_v2(p_scope=>'all',p_contractor_filter=>'Synthetic') result"],
    ['company_admin_contractor_sort', 'companyAdmin',
      "select public.list_work_orders_table_rows_v2(p_scope=>'all',p_sort_column=>'contractor',p_limit=>25) result"],
    ['technician_contractor_filter', 'reportTechnician',
      "select public.list_work_orders_table_rows_v2(p_scope=>'all',p_sort_column=>'contractor',p_contractor_filter=>'Synthetic',p_limit=>25) result"],
  ];
  const resultsBefore = new Map();
  for (const [name, actor, sql] of cases) resultsBefore.set(name, await run(fixture.actors[actor], sql));

  const timed = async (phase, name, actor, sql) => {
    const elapsed = [];
    await run(fixture.actors[actor], sql);
    for (let index = 0; index < samples; index++) {
      const started = performance.now();
      await run(fixture.actors[actor], sql);
      elapsed.push(performance.now() - started);
    }
    elapsed.sort((a, b) => a - b);
    return { phase, name, p50Ms: elapsed[Math.floor(samples / 2)], p95Ms: elapsed.at(-1), samples };
  };
  const measuredCases = cases.filter(([name]) => name.startsWith('staff_'));
  const beforeMetrics = [];
  for (const [name, actor, sql] of measuredCases) beforeMetrics.push(await timed('before', name, actor, sql));

  await applyThrough(db, 151, 151);

  assert.deepEqual((await db.query(helperSql)).rows, helpersBefore,
    '0151 must not replace either canonical authorization helper');
  checks++;
  assert.deepEqual((await db.query(`select
    (select count(*) from public.profiles)::integer profiles,
    (select count(*) from public.work_orders)::integer work_orders,
    (select count(*) from public.activities)::integer activities`)).rows[0], dataBefore,
  '0151 must not rewrite application rows');
  checks++;

  for (const actor of actors) {
    assert.deepEqual(await visibleProfiles(actor), visibilityBefore.get(actor), `${actor} profile visibility changed`);
    checks++;
  }
  for (const [name, actor, sql] of cases) {
    assert.deepEqual(await run(fixture.actors[actor], sql), resultsBefore.get(name), `${name} result changed`);
    checks++;
  }

  const audit = (await db.query(readFileSync(
    new URL('../supabase/audits/0151_hoist_staff_profile_read_authorization_verification.sql', import.meta.url),
    'utf8',
  ))).rows;
  check(audit.length === 1 && audit[0].all_checks_pass === true);

  const afterMetrics = [];
  for (const [name, actor, sql] of measuredCases) afterMetrics.push(await timed('after', name, actor, sql));
  for (const metric of afterMetrics) check(metric.p95Ms <= 500);

  console.log(JSON.stringify({
    result: 'PASS', checks, scale: fixture.scale, beforeMetrics, afterMetrics,
    authorizationParityActors: actors.length, resultParityCases: cases.length,
  }));
} finally {
  await db.close();
}
