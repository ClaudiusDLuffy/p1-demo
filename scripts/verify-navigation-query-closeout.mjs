// Synthetic-only 0145 characterization and parity. Uses the existing approved
// engine; no environment credentials, remote databases, or provider calls.
import './pagination-test-support/syntheticSqlPrivacy.mjs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { tsImport } from 'tsx/esm/api';
import { createDatabase, applyThrough, seedPerformanceFixture, seedNotificationPerformanceFixture }
  from './query-performance-test-support/fixtures.mjs';
import { captureIsolatedPlan, classifyHarnessFailure } from './query-performance-test-support/harness-safety.mjs';
import { measureIndexWriteCost } from './query-performance-test-support/index-write-cost.mjs';

const experiment = process.argv.includes('--experiment');
const baselineFile = process.argv.find(argument => argument.startsWith('--baseline-evidence='))?.slice('--baseline-evidence='.length);
const afterOnly = (experiment || Boolean(baselineFile)) && process.argv.includes('--after-only');
const candidateIndex = experiment && process.argv.includes('--candidate-index');
const candidateIndexDdl = "create index work_orders_contractor_created_key_cursor_idx\n  on public.work_orders(contractor_id,coalesce(created_at,'epoch'::timestamptz) desc,id desc)\n  where deleted_at is null;";
const iterations = experiment && !process.argv.includes('--measured-index') ? 5 : 20;
const output = mkdtempSync(join(tmpdir(), 'p1-navigation-closeout-'));
const report = { evidence: 'PGLITE_LOCAL', result: 'INCOMPLETE',
  methodology: { warmups: 2, iterations, percentile: 'nearest-rank', experiment,
    timing: 'local RPC plus role transaction; expanded SQL plans recorded separately' },
  scale: null, measurements: [], plans: [], checks: 0, failures: [],
  unavailable: ['POSTGREST_JWT_DISPOSABLE', 'POSTGRES_DISPOSABLE', 'PREVIEW_HOSTED', 'PRODUCTION_LIKE', 'BROWSER_LOCAL'] };
const save = () => writeFileSync(join(output, 'evidence.json'), JSON.stringify(report, null, 2));
const count = () => { report.checks++; };
let db;
let phase = 'engine';
try {
  if (baselineFile) {
    const payload = readFileSync(baselineFile, 'utf8');
    const baseline = JSON.parse(payload);
    assert.ok(baseline.measurements?.length >= 13 && baseline.scale.workOrders === 50000);
    report.preexistingBaseline = { file: baselineFile, sha256: createHash('sha256').update(payload).digest('hex'),
      methodology: baseline.methodology, scale: baseline.scale, measurements: baseline.measurements };
  }
  db = await createDatabase(); phase = 'schema';
  console.log(JSON.stringify({ phase, output }));
  await applyThrough(db, 144);
  const protectedFunctions = (await db.query(`select n.nspname||'.'||p.proname||'('||pg_get_function_identity_arguments(p.oid)||')' identity,
    md5(pg_get_functiondef(p.oid)) hash from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname in ('public','p1_read_contracts') order by 1`)).rows;
  const policiesSql = "select polrelid::regclass::text relation,polname,polcmd,polroles,polpermissive,polqual::text,polwithcheck::text from pg_policy order by 1,2";
  const protectedPolicies = (await db.query(policiesSql)).rows;
  const indexesSql = "select indexrelid::regclass::text identity,pg_get_indexdef(indexrelid) definition from pg_index where indrelid in (select oid from pg_class where relnamespace='public'::regnamespace) order by 1";
  const protectedIndexes = (await db.query(indexesSql)).rows;
  phase = 'fixture';
  const fixture = await seedPerformanceFixture(db);
  report.scale = { ...fixture.scale, ...await seedNotificationPerformanceFixture(db, fixture.actors) };
  save();
  const run = (actorClass, sql, params = []) => fixture.as('authenticated', fixture.actors[actorClass], tx => tx.query(sql, params))
    .then(result => result.rows[0]?.result);
  const metric = async (name, actorClass, sql, params = []) => {
    const samples = []; const serializationSamples = []; let result; let serialized;
    for (let index = 0; index < iterations + 2; index++) {
      const started = performance.now(); result = await run(actorClass, sql, params);
      if (index >= 2) samples.push(performance.now() - started);
      const serializationStarted = performance.now(); serialized = JSON.stringify(result);
      if (index >= 2) serializationSamples.push(performance.now() - serializationStarted);
    }
    samples.sort((a, b) => a - b); serializationSamples.sort((a, b) => a - b);
    const mean = samples.reduce((sum, value) => sum + value, 0) / samples.length;
    const deviation = Math.sqrt(samples.reduce((sum, value) => sum + (value - mean) ** 2, 0) / samples.length);
    const measured = { name, actorClass, p50Ms: samples[Math.ceil(samples.length * .5) - 1],
      p95Ms: samples[Math.ceil(samples.length * .95) - 1], maxMs: samples.at(-1), minMs: samples[0],
      coefficientOfVariation: deviation / mean, samples, rows: result?.items?.length ?? null,
      payloadBytes: Buffer.byteLength(serialized), targetP95Ms: 500,
      serializationP50Ms: serializationSamples[Math.ceil(iterations * .5) - 1],
      serializationP95Ms: serializationSamples[Math.ceil(iterations * .95) - 1],
      serializationMaxMs: serializationSamples.at(-1) };
    measured.withinLocalBudget = measured.p95Ms <= 500;
    assert.ok(measured.payloadBytes <= 204800); count();
    if (result?.items) { assert.ok(result.items.length <= 25); assert.ok(!Object.hasOwn(result, 'totalCount')); count(); }
    report.measurements.push(measured); save();
    console.log(JSON.stringify({ ...measured, samples: undefined }));
    return result;
  };
  const actors = experiment ? ['manager', 'contractor', 'companyAdmin', 'reportTechnician']
    : ['manager', 'dispatcher', 'backOffice', 'controller', 'quickbooksOnly', 'handoffOnly',
      'contractor', 'companyAdmin', 'secondAdmin', 'invoiceMember', 'technician', 'reportTechnician', 'formerTechnician', 'otherCompany'];
  phase = 'baseline';
  for (const actor of afterOnly ? [] : actors) await metric('navigation_before', actor, 'select public.get_portal_navigation_summary_v1() result');
  for (const actor of afterOnly ? [] : ['contractor', 'companyAdmin', 'reportTechnician']) {
    const account = fixture.actors[actor === 'contractor' ? 'contractor' : 'companyAdmin'];
    await metric('my_jobs_before', actor, "select public.list_work_orders_table_rows_v1(p_scope=>'active',p_contractor_id=>$1,p_sort_column=>'created') result", [account]);
  }
  phase = 'migration';
  if (candidateIndex) {
    // Test-only index deferral preserves reproducible before/after evidence
    // without dropping any index or modifying a repository migration file.
    const migration = readFileSync(new URL('../supabase/migrations/0145_measured_navigation_and_work_order_reads.sql', import.meta.url), 'utf8');
    assert.equal(migration.split(candidateIndexDdl).length, 2);
    await db.exec(migration.replace(candidateIndexDdl, '-- Measured candidate index is deferred until after baseline.'));
    report.candidateDeferralSourceSha256 = createHash('sha256').update(migration).digest('hex');
  } else await applyThrough(db, 145, 145);
  const afterFunctions = (await db.query(`select n.nspname||'.'||p.proname||'('||pg_get_function_identity_arguments(p.oid)||')' identity,
    md5(pg_get_functiondef(p.oid)) hash from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname in ('public','p1_read_contracts') order by 1`)).rows;
  for (const original of protectedFunctions) {
    assert.deepEqual(afterFunctions.find(candidate => candidate.identity === original.identity), original); count();
  }
  assert.deepEqual((await db.query(policiesSql)).rows, protectedPolicies); count();
  const afterIndexes = (await db.query(indexesSql)).rows;
  for (const original of protectedIndexes) {
    assert.deepEqual(afterIndexes.find(candidate => candidate.identity === original.identity), original); count();
  }
  if (candidateIndex) {
    phase = 'candidate_index';
    for (const actor of ['contractor', 'companyAdmin', 'reportTechnician']) {
      const account = fixture.actors[actor === 'contractor' ? 'contractor' : 'companyAdmin'];
      const sql = "select public.list_work_orders_table_rows_v2(p_scope=>'active',p_contractor_id=>$1,p_sort_column=>'created',p_cursor=>$2) result";
      const first = await metric('candidate_without_index_first', actor, sql, [account, null]);
      await metric('candidate_without_index_continuation', actor, sql, [account, first.nextCursor]);
    }
    await db.exec(candidateIndexDdl);
    report.candidateIndex = (await db.query("select pg_get_indexdef(indexrelid) definition,pg_relation_size(indexrelid) bytes from pg_index where indexrelid='public.work_orders_contractor_created_key_cursor_idx'::regclass")).rows[0];
  }
  phase = 'after';
  for (const actor of actors) {
    await fixture.as('authenticated', fixture.actors[actor], async tx => {
      const old = (await tx.query('select public.get_portal_navigation_summary_v1() result')).rows[0].result;
      const current = (await tx.query('select public.get_portal_navigation_summary_v2() result')).rows[0].result;
      for (const [key, value] of Object.entries(current.metrics)) { assert.equal(value, old[key], `${actor}/${key}`); count(); }
    });
    await metric('navigation_after', actor, 'select public.get_portal_navigation_summary_v2() result');
  }
  for (const actor of ['contractor', 'companyAdmin', 'reportTechnician']) {
    const account = fixture.actors[actor === 'contractor' ? 'contractor' : 'companyAdmin'];
    const sql = version => `select public.list_work_orders_table_rows_${version}(p_scope=>'active',p_contractor_id=>$1,p_sort_column=>'created',p_cursor=>$2) result`;
    let cursor = null;
    for (let page = 0; page < 3; page++) {
      await fixture.as('authenticated', fixture.actors[actor], async tx => {
        const old = (await tx.query(sql('v1'), [account, cursor])).rows[0].result;
        const current = (await tx.query(sql('v2'), [account, cursor])).rows[0].result;
        assert.deepEqual(current, old); count(); cursor = current.nextCursor;
      });
    }
    const first = await metric('my_jobs_after', actor, sql('v2'), [account, null]);
    await metric('my_jobs_continuation_after', actor, sql('v2'), [account, first.nextCursor]);
    await metric('my_jobs_count_after', actor, "select public.count_work_orders_table_v2(p_scope=>'active',p_contractor_id=>$1) result", [account]);
  }
  phase = 'plans';
  for (const name of ['work_orders_table_v1', 'work_orders_table_v2']) {
    const routine = (await db.query("select prosrc,pg_get_function_arguments(oid) arguments from pg_proc where pronamespace=case when $1 like '%v2' then 'p1_portal_reads'::regnamespace else 'p1_read_contracts'::regnamespace end and proname=$1", [name])).rows[0];
    for (const actor of ['contractor', 'companyAdmin', 'reportTechnician']) {
      const account = fixture.actors[actor === 'contractor' ? 'contractor' : 'companyAdmin'];
      let body = routine.prosrc;
      const overrides = { p_read_mode: "'rows'::text", p_scope: "'active'::text", p_contractor_id: `'${account}'::uuid` };
      const args = routine.arguments.split(', ').map(argument => [argument.split(' ')[0], overrides[argument.split(' ')[0]] ?? argument.split(' DEFAULT ')[1]]);
      for (const [argument, value] of args.sort((a, b) => b[0].length - a[0].length)) body = body.replace(new RegExp(`\\b${argument}\\b`, 'g'), `(${value})`);
      const plan = await fixture.as('authenticated', fixture.actors[actor], tx => captureIsolatedPlan((sql, params) => tx.query(sql, params), body));
      report.plans.push({ name, actor, input: 'current MyJobs active/canonical contractor/created/25',
        sourceSha256: createHash('sha256').update(routine.prosrc).digest('hex'), plan }); save(); count();
    }
  }
  for (const name of ['get_portal_navigation_summary_v1', 'navigation_staff_v2', 'navigation_contractor_v2']) {
    const routine = (await db.query('select prosrc from pg_proc where proname=$1', [name])).rows[0];
    for (const actor of name === 'navigation_staff_v2' ? ['manager'] : name === 'navigation_contractor_v2' ? ['contractor', 'companyAdmin', 'reportTechnician'] : ['manager']) {
      const plan = await fixture.as('authenticated', fixture.actors[actor], tx => captureIsolatedPlan((sql, params) => tx.query(sql, params), routine.prosrc));
      report.plans.push({ name, actor, sourceSha256: createHash('sha256').update(routine.prosrc).digest('hex'), plan }); save(); count();
    }
  }
  const scopeSource = (await db.query("select prosrc from pg_proc where pronamespace='p1_portal_reads'::regnamespace and proname='authorized_contractor_work_order_scope_v1'")).rows[0].prosrc;
  const scopeBody = scopeSource.slice(scopeSource.indexOf('return query\n') + 'return query\n'.length, scopeSource.lastIndexOf(';\nend'));
  for (const actor of ['contractor', 'companyAdmin', 'reportTechnician']) {
    const plan = await db.transaction(async tx => {
      await tx.query("select set_config('request.jwt.claim.role','authenticated',true),set_config('request.jwt.claim.sub',$1,true)", [fixture.actors[actor]]);
      return captureIsolatedPlan((sql, params) => tx.query(sql, params), scopeBody);
    });
    report.plans.push({ name: 'canonical_scope_set_body', actor,
      executionContext: 'OWNER_EQUIVALENT_DEFINER_BODY_WITH_AUTHENTICATED_CALLER_CLAIMS', plan }); count(); save();
  }
  console.log(JSON.stringify({ phase: 'timing_and_plan_capture_complete', output }));
  phase = 'denial';
  for (const [role, actor] of [['anon', null], ['authenticated', null], ['authenticated', fixture.actors.inactive], ['service_role', null]]) {
    await assert.rejects(fixture.as(role, actor, tx => tx.query('select public.get_portal_navigation_summary_v2()')), error => error.code === '42501'); count();
  }
  if (!experiment) {
    phase = 'canonical_contractor_scope_parity';
    const compareScope = async actor => fixture.as('authenticated', fixture.actors[actor], async tx => {
      const comparison = (await tx.query(`with actual as materialized (
        select id,status from p1_portal_reads.authorized_contractor_work_order_scope_v1()
      ), expected as materialized (
        select id,status from public.work_orders where deleted_at is null
      ) select (select count(*) from actual) actual_count,(select count(*) from expected) expected_count,
        (select count(*) from ((select * from actual except select * from expected)
          union all (select * from expected except select * from actual)) differences) differences`)).rows[0];
      assert.equal(comparison.actual_count, comparison.expected_count); assert.equal(comparison.differences, 0); count();
    });
    const contractors = ['contractor', 'companyAdmin', 'secondAdmin', 'invoiceMember', 'technician', 'reportTechnician', 'formerTechnician', 'otherCompany'];
    for (const actor of contractors) await compareScope(actor);
    for (const actor of ['manager','dispatcher','backOffice','controller','quickbooksOnly','handoffOnly','inactive']) {
      await assert.rejects(run(actor, 'select p1_portal_reads.authorized_contractor_work_order_scope_v1() result'), error => error.code === '42501'); count();
    }
    for (const role of ['anon','authenticated','service_role']) {
      await assert.rejects(fixture.as(role, null, tx => tx.query('select p1_portal_reads.authorized_contractor_work_order_scope_v1()')), error => error.code === '42501'); count();
    }
    await assert.rejects(fixture.as('authenticated', '89999999-0000-4000-8000-000000000999',
      tx => tx.query('select p1_portal_reads.authorized_contractor_work_order_scope_v1()')), error => error.code === '42501'); count();
    const scenarios = [
      { name: 'inactive_organization', table: 'organizations', filter: 'canonical_contractor_id', id: fixture.actors.companyAdmin },
      { name: 'inactive_canonical_profile', table: 'profiles', filter: 'id', id: fixture.actors.companyAdmin },
    ];
    for (const scenario of scenarios) {
      await db.query(`update public.${scenario.table} set active=false where ${scenario.filter}=$1`, [scenario.id]);
      try {
        for (const actor of ['secondAdmin', 'invoiceMember', 'technician', 'reportTechnician', 'formerTechnician']) await compareScope(actor);
      } finally { await db.query(`update public.${scenario.table} set active=true where ${scenario.filter}=$1`, [scenario.id]); }
    }
    await db.query('update public.contractor_technicians set is_active=false where profile_id=$1', [fixture.actors.reportTechnician]);
    try { await compareScope('reportTechnician'); await compareScope('technician'); }
    finally { await db.query('update public.contractor_technicians set is_active=true where profile_id=$1', [fixture.actors.reportTechnician]); }
    await assert.rejects(db.query(`insert into public.contractor_technicians(id,contractor_id,profile_id,name,is_active)
      values(gen_random_uuid(),$1,$2,'Synthetic duplicate-link integrity fixture',true)`,
    [fixture.actors.companyAdmin, fixture.actors.reportTechnician]), error => error.code === '23505'); count();
    await compareScope('reportTechnician');
    const reassignment = (await db.query('select id,assigned_technician_profile_id from public.work_orders where assigned_technician_profile_id=$1 order by id limit 1', [fixture.actors.reportTechnician])).rows[0];
    const setSyntheticAssignment = async assignedTo => db.transaction(async tx => {
      // Same owner-only fixture seeding technique as the existing50k fixture;
      // restore all trigger settings before any authorized read is exercised.
      await tx.exec('alter table public.work_orders disable trigger user');
      await tx.query('update public.work_orders set assigned_technician_profile_id=$2 where id=$1', [reassignment.id, assignedTo]);
      await tx.exec('alter table public.work_orders enable trigger user');
    });
    await setSyntheticAssignment(fixture.actors.technician);
    try { await compareScope('reportTechnician'); await compareScope('technician'); }
    finally { await setSyntheticAssignment(reassignment.assigned_technician_profile_id); }
    report.canonicalScopeParity = 'PASS_ALL_CONTRACTOR_SETS_STAFF_SERVICE_DENIAL_AND_REVOCATION';
    phase = 'table_role_filter_parity';
    const contractCases = [
      { p_scope: 'all', p_limit: 7 },
      { p_scope: 'active', p_sort_column: 'created', p_sort_direction: 'asc', p_limit: 7 },
      { p_scope: 'history', p_sort_column: 'closed', p_limit: 7 },
      { p_scope: 'operations', p_priority: 'p1', p_limit: 7 },
      { p_scope: 'capital', p_sort_column: 'priority', p_limit: 7 },
      { p_scope: 'all', p_search: 'Synthetic companyAdmin', p_sort_column: 'contractor', p_limit: 7 },
      { p_scope: 'all', p_contractor_filter: 'Synthetic', p_sort_column: 'contractor', p_limit: 7 },
      { p_scope: 'all', p_work_order_filter: '0001', p_sort_column: 'work_order', p_limit: 7 },
      { p_scope: 'all', p_sla_filter: 'overdue', p_sort_column: 'sla', p_limit: 7 },
      { p_scope: 'staff_work', p_needs_action: true, p_pending_first: true, p_limit: 7 },
      { p_scope: 'dashboard_seven_eleven_updates', p_pending_first: true, p_limit: 7 },
      { p_scope: 'all', p_status: 'assigned', p_sort_column: 'updated', p_limit: 7 },
    ];
    const tableActors = [...actors, 'inactive'];
    let cases = 0;
    for (const actor of tableActors) {
      // Unrestricted authorization parity is exercised once per actor; filter
      // combinations use deterministic bounded fixture IDs, not easier timing.
      const selections = actor === 'manager' || actor === 'companyAdmin' || actor === 'reportTechnician'
        ? contractCases : contractCases.slice(0, 3);
      for (const selection of selections) {
        const keys = Object.keys(selection);
        const params = Object.values(selection);
        const call = version => `select public.list_work_orders_table_rows_${version}(${keys.map((key, i) => `${key}=>$${i + 1}`).join(',')}) result`;
        await fixture.as('authenticated', fixture.actors[actor], async tx => {
          const before = (await tx.query(call('v1'), params)).rows[0].result;
          const after = (await tx.query(call('v2'), params)).rows[0].result;
          assert.deepEqual(after, before, `${actor}/${JSON.stringify(selection)}`); count(); cases++;
          if (after.nextCursor) {
            const continuation = version => call(version).replace(') result', `,p_cursor=>$${params.length + 1}) result`);
            assert.deepEqual((await tx.query(continuation('v2'), [...params, after.nextCursor])).rows,
              (await tx.query(continuation('v1'), [...params, after.nextCursor])).rows); count();
          }
        });
      }
      await fixture.as('authenticated', fixture.actors[actor], async tx => {
        assert.deepEqual((await tx.query("select public.count_work_orders_table_v2(p_scope=>'all') result")).rows,
          (await tx.query("select public.count_work_orders_table_v1(p_scope=>'all') result")).rows); count();
      });
    }
    for (const role of ['anon', 'authenticated']) {
      for (const version of ['v1', 'v2']) {
        if (role === 'anon') {
          await assert.rejects(fixture.as(role, null, tx => tx.query(`select public.list_work_orders_table_rows_${version}()`)), error => error.code === '42501'); count();
        } else {
          const empty = await fixture.as(role, null, tx => tx.query(`select public.list_work_orders_table_rows_${version}() result`));
          assert.deepEqual(empty.rows[0].result.items, []); count();
        }
      }
    }
    await fixture.as('service_role', null, async tx => {
      assert.deepEqual((await tx.query('select public.list_work_orders_table_rows_v2(p_limit=>3) result')).rows,
        (await tx.query('select public.list_work_orders_table_rows_v1(p_limit=>3) result')).rows); count();
    });
    for (const argumentsSql of ["p_scope=>'invalid'", 'p_limit=>0', 'p_limit=>101', "p_sort_column=>'unsafe'", "p_cursor=>'not-a-valid-cursor'"]) {
      for (const version of ['v1', 'v2']) {
        await assert.rejects(run('manager', `select public.list_work_orders_table_rows_${version}(${argumentsSql}) result`), error => typeof error.code === 'string'); count();
      }
    }
    report.tableRoleFilterParityCases = cases;
    phase = 'generated_sla_parity';
    const { verifySlaSqlParity } = await tsImport('./sla-read-test-support/parity.mjs', import.meta.url);
    const source = (await db.query("select prosrc from pg_proc where pronamespace='p1_portal_reads'::regnamespace and proname='navigation_staff_v2'")).rows[0].prosrc;
    const start = source.indexOf('lateral (');
    const end = source.indexOf(') effective_sla(due_at,breached)', start);
    assert.ok(start > 0 && end > start); count();
    let expression = source.slice(start + 'lateral ('.length, end);
    for (const [from, to] of Object.entries({ 'annotated.priority::text': '$1::text',
      'annotated.dispatched_at': '$2::timestamptz', 'annotated.response_breach_at': '$3::timestamptz',
      'annotated.resolution_breach_at': '$4::timestamptz', 'annotated.start_time': '$5::timestamptz', 'now()': '$6::timestamptz' })) {
      expression = expression.replaceAll(from, to);
    }
    let comparisons = 0;
    const adapter = { db: { query: async (sql, params) => {
      assert.equal(sql, 'select * from public.evaluate_work_order_sla_v1($1,$2,$3,$4,$5,$6)');
      const actual = await db.query(`select * from (${expression}) evaluated(due_at,breached)`, params);
      const canonical = await db.query(sql, params);
      assert.deepEqual(actual.rows, canonical.rows); comparisons++; count();
      return actual;
    } }, assignment: { snapshot: async () => (await db.query("select count(*) count,md5(string_agg(row_to_json(w)::text,',' order by id)) digest from public.work_orders w")).rows } };
    await verifySlaSqlParity(adapter, async (_name, verify) => { await verify(); count(); });
    report.canonicalSlaParityCases = comparisons;
    phase = 'count_branch_failure_injection';
    const definition = (await db.query("select pg_get_functiondef(oid) definition from pg_proc where pronamespace='p1_portal_reads'::regnamespace and proname='work_orders_table_v2'")).rows[0].definition;
    const fault = "'totalCount', (select p1_portal_reads.synthetic_count_failure())";
    const injected = definition.replace("'totalCount', (select count(*) from filtered)", fault);
    assert.notEqual(injected, definition); count();
    await db.exec("create function p1_portal_reads.synthetic_count_failure() returns bigint language plpgsql as $$ begin raise exception 'SYNTHETIC_COUNT_BRANCH'; end $$; grant execute on function p1_portal_reads.synthetic_count_failure() to authenticated");
    try {
      await db.exec(injected);
      const first = await run('manager', "select public.list_work_orders_table_rows_v2(p_scope=>'all') result");
      const second = await run('manager', "select public.list_work_orders_table_rows_v2(p_scope=>'all',p_cursor=>$1) result", [first.nextCursor]);
      assert.equal(first.items.length, 25); assert.equal(second.items.length, 25); count();
      await assert.rejects(run('manager', 'select public.count_work_orders_table_v2() result'), error => error.code === 'P0001'); count();
    } finally {
      await db.exec(definition); await db.exec('drop function p1_portal_reads.synthetic_count_failure()');
    }
  }
  phase = 'audit';
  const previousAudit = (await db.query(readFileSync(new URL('../supabase/audits/0144_count_independent_page_reads_verification.sql', import.meta.url), 'utf8'))).rows;
  assert.ok(previousAudit.every(row => row.all_checks_pass)); count();
  const currentAudit = (await db.query(readFileSync(new URL('../supabase/audits/0145_measured_navigation_and_work_order_reads_verification.sql', import.meta.url), 'utf8'))).rows;
  report.audit = currentAudit;
  assert.ok(currentAudit.every(row => row.all_checks_pass)); count();
  report.contracts = (await db.query(`select p.oid::regprocedure::text signature,p.prosecdef security_definer,
    p.provolatile volatility,p.proconfig configuration,has_function_privilege('anon',p.oid,'EXECUTE') anon_execute,
    has_function_privilege('authenticated',p.oid,'EXECUTE') authenticated_execute,
    has_function_privilege('service_role',p.oid,'EXECUTE') service_execute
    from pg_proc p where p.pronamespace='p1_portal_reads'::regnamespace or
      (p.pronamespace='public'::regnamespace and p.proname in
      ('get_portal_navigation_summary_v2','list_work_orders_table_rows_v2','count_work_orders_table_v2')) order by 1`)).rows;
  report.priorRoutineHashesPreserved = protectedFunctions.length;
  report.priorPoliciesPreserved = protectedPolicies.length;
  report.priorIndexDefinitionsPreserved = protectedIndexes.length;
  if (candidateIndex || !experiment) {
    phase = 'synthetic_index_write_cost';
    report.indexWriteCost = await measureIndexWriteCost(db, fixture.actors.contractor); count();
  }
  if (!experiment) {
    phase = 'clean_install';
    const clean = await createDatabase();
    try {
      await applyThrough(clean, 145);
      const cleanAudit = (await clean.query(readFileSync(new URL('../supabase/audits/0145_measured_navigation_and_work_order_reads_verification.sql', import.meta.url), 'utf8'))).rows;
      assert.deepEqual(cleanAudit, currentAudit); count();
      report.cleanInstall = 'PASS_THROUGH_0145'; report.upgrade = 'PASS_0144_TO_0145';
    } finally { await clean.close(); }
  }
  report.result = experiment ? 'EXPERIMENT_ONLY_NOT_CERTIFICATION'
    : report.measurements.filter(item => item.name.includes('_after')).every(item => item.withinLocalBudget)
      ? 'LOCAL_NAVIGATION_AND_MY_JOBS_BUDGETS_PASS' : 'LOCAL_BUDGET_GATE_REMAINS';
} catch (error) {
  report.failures.push(classifyHarnessFailure(phase, error));
  console.error(JSON.stringify({ phase, code: error.code ?? 'LOCAL_FAILURE', message: error.message?.slice(0, 600) }));
  process.exitCode = 1;
} finally {
  if (db) await db.close(); save();
  console.log(JSON.stringify({ output, checks: report.checks, result: report.result, failures: report.failures }));
}
