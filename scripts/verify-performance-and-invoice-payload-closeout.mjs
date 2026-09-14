// Synthetic/disposable only. No environment files, remote databases, provider
// calls, customer rows, or raw plan expressions are read/written by this tool.
import './pagination-test-support/syntheticSqlPrivacy.mjs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { tsImport } from 'tsx/esm/api';
import { createDatabase, applyThrough, seedPerformanceFixture, workOrderId, syntheticId } from './query-performance-test-support/fixtures.mjs';
import { captureIsolatedPlan, classifyHarnessFailure } from './query-performance-test-support/harness-safety.mjs';

const contractsOnly = process.argv.includes('--contracts-only');
assert.ok(process.argv.slice(2).every(arg => arg === '--contracts-only'), 'Only an explicit contracts-only mode is supported');
const warmups = 3, iterations = 20;
const report = {
  version: 1, evidence: 'PGLITE_LOCAL', generatedAt: new Date().toISOString(),
  mode: contractsOnly ? 'CONTRACTS_ONLY_NOT_PERFORMANCE_CERTIFICATION' : 'SAME_50K_CLOSEOUT_FIXTURE',
  methodology: { seed: 20260910, warmups, iterations, percentile: 'nearest-rank',
    databaseTimer: 'RPC plus local SET ROLE/JWT-GUC transaction; expanded EXPLAIN planning/execution recorded separately',
    application: 'canonical JSON clone/serialization measured separately; actual TypeScript mapper and Response bytes covered by client/API tests',
    rls: 'actual installed policies under authenticated role and synthetic JWT GUCs, no PostgREST gateway' },
  measurements: [], plans: [], roles: [], payloads: [], failures: [],
  unavailable: ['POSTGRES_DISPOSABLE', 'POSTGREST_JWT_DISPOSABLE', 'BROWSER_LOCAL', 'PREVIEW_HOSTED', 'PRODUCTION_LIKE', 'Independent sessions', 'Hosted p50/p95'],
};
const output = mkdtempSync(join(tmpdir(), 'p1-invoice-closeout-'));
const evidencePath = join(output, 'evidence.json');
const save = () => writeFileSync(evidencePath, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
let db, phase = 'engine', checks = 0;
const check = (value, label) => { assert.ok(value, label); checks++; };
const same = (actual, expected, label) => { assert.deepEqual(actual, expected, label); checks++; };
const bytes = value => Buffer.byteLength(JSON.stringify(value), 'utf8');
const migrationPath = new URL('../supabase/migrations/0147_compact_invoice_reads_and_line_pages.sql', import.meta.url);
const migrationHash = () => createHash('sha256').update(readFileSync(migrationPath)).digest('hex');
const distribution = values => {
  const sorted = [...values].sort((a, b) => a - b);
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  return { p50Ms: sorted[Math.ceil(sorted.length * .5) - 1], p95Ms: sorted[Math.ceil(sorted.length * .95) - 1],
    minMs: sorted[0], maxMs: sorted.at(-1), meanMs: mean, variance, coefficientOfVariation: Math.sqrt(variance) / mean };
};
const planSummary = value => {
  const nodes = [];
  const visit = (node, depth = 0) => {
    const entry = { depth };
    for (const key of ['Node Type', 'Relation Name', 'Index Name', 'Subplan Name', 'Plan Rows', 'Actual Rows',
      'Actual Loops', 'Actual Total Time', 'Rows Removed by Filter', 'Sort Method', 'Sort Space Used',
      'Sort Space Type', 'Shared Hit Blocks', 'Shared Read Blocks']) if (key in node) entry[key] = node[key];
    nodes.push(entry); for (const child of node.Plans ?? []) visit(child, depth + 1);
  };
  visit(value.Plan);
  return { planningMs: value['Planning Time'], executionMs: value['Execution Time'], nodes };
};

try {
  const { summarizeInvoiceLineTypes } = await tsImport('../src/lib/invoiceLineSubtotals.ts', import.meta.url);
  const { normalizeUnknownError } = await tsImport('../src/lib/errors/normalizeUnknown.ts', import.meta.url);
  same(normalizeUnknownError({ code: 'PT413', message: 'PAYLOAD_TOO_LARGE' }).code, 'PAYLOAD_TOO_LARGE',
    'Oversized legacy item maps to the existing safe non-retryable public error');
  db = await createDatabase(); phase = 'schema'; await applyThrough(db, 145);
  phase = 'fixture';
  const f = await seedPerformanceFixture(db, { workOrders: contractsOnly ? 100 : 50000, largeDirectories: !contractsOnly });
  report.scale = f.scale;
  const run = async (actor, sql, params = [], role = 'authenticated') =>
    (await f.read(actor, sql, params, role)).rows[0]?.result;
  const rpc = (name, args = [], actor = f.actors.manager, role = 'authenticated') => {
    assert.ok(/^(list_(contractor|staff)_invoices_(rows_v[12]|page)|get_invoice_summary_v1|list_invoice_lines_page_v1|get_work_order_invoice_part_hints_v1|get_invoice_source_summaries_v1)$/.test(name));
    return run(actor, `select public.${name}(${args.map((_, index) => `$${index + 1}`).join(',')}) result`, args, role);
  };
  const measure = async (name, version, actorName, sql, params = [], options = {}) => {
    if (contractsOnly) return run(f.actors[actorName], sql, params, options.role);
    const timings = [], serialize = [], mapping = []; let value;
    for (let n = 0; n < warmups + iterations; n++) {
      let started = performance.now(); value = await run(f.actors[actorName], sql, params, options.role);
      const elapsed = performance.now() - started;
      started = performance.now(); const text = JSON.stringify(value); const serialization = performance.now() - started;
      started = performance.now(); JSON.parse(text); const mapped = performance.now() - started;
      if (n >= warmups) { timings.push(elapsed); serialize.push(serialization); mapping.push(mapped); }
    }
    const metric = { name, version, actorName, databaseRpc: distribution(timings), serialization: distribution(serialize),
      simulatedClientJsonParsing: distribution(mapping), payloadBytes: bytes(value), rows: value?.items?.length ?? value?.invoices?.length ?? null,
      targetP95Ms: options.target ?? 500, budget: distribution(timings).p95Ms <= (options.target ?? 500) ? 'PASS' : 'FAIL',
      evidence: 'PGLITE_LOCAL' };
    report.measurements.push(metric); save();
    console.log(JSON.stringify({ measurement: name, version, actorName, p95Ms: metric.databaseRpc.p95Ms, bytes: metric.payloadBytes, budget: metric.budget }));
    return value;
  };
  const captureBodyPlan = async (schema, name, actorName, stage) => {
    const routine = (await db.query(`select prosrc,pg_get_function_arguments(oid) args from pg_proc
      where pronamespace=$1::regnamespace and proname=$2`, [schema, name])).rows[0];
    let sql = routine.prosrc;
    const parameters = routine.args.split(', ').map(arg => [arg.split(' ')[0],
      arg.includes(' DEFAULT ') ? arg.split(' DEFAULT ')[1] : arg.startsWith('p_read_mode ') ? "'rows'::text" : 'null']);
    for (const [parameter, value] of parameters.sort((a, b) => b[0].length - a[0].length))
      sql = sql.replace(new RegExp(`\\b${parameter}\\b`, 'g'), `(${value})`);
    const plan = await f.as('authenticated', f.actors[actorName], tx => captureIsolatedPlan((query, params) => tx.query(query, params), sql));
    report.plans.push({ name, stage, actorName, evidence: 'PGLITE_LOCAL',
      visibility: 'expanded production SQL body under actual RLS; constants can plan differently from nested RPC',
      bodySha256: createHash('sha256').update(routine.prosrc).digest('hex'), ...planSummary(plan) });
    save(); checks++;
  };
  phase = 'measurement';
  for (const actor of ['manager', 'contractor', 'controller', 'companyAdmin', 'invoiceMember', 'technician']) {
    const first = await measure('contractor_invoice_first', '0145', actor, 'select public.list_contractor_invoices_rows_v1() result');
    if (first.hasMore) await measure('contractor_invoice_continuation', '0145', actor,
      'select public.list_contractor_invoices_rows_v1(p_cursor=>$1) result', [first.nextCursor]);
  }
  await measure('staff_invoice_first', '0145', 'manager', 'select public.list_staff_invoices_rows_v1() result', [], { role: 'service_role' });
  if (!contractsOnly) for (const actor of ['manager', 'contractor', 'companyAdmin'])
    await captureBodyPlan('p1_read_contracts', 'contractor_invoices_v1', actor, 'BEFORE');

  // Additional deterministic cardinality fixtures supplement, never replace,
  // the original 50k/101k/10k performance distribution.
  phase = 'fixture';
  const high = syntheticId('92', 1), staff = syntheticId('92', 2), empty = syntheticId('92', 3), maximumText = syntheticId('92', 4);
  await db.transaction(async tx => {
    for (const table of ['invoices', 'invoice_lines', 'staff_invoice_sources']) await tx.exec(`alter table public.${table} disable trigger user`);
    await tx.query(`insert into public.invoice_lines(id,invoice_id,position,type,description,qty,rate)
      select ('b1000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,$1,1+n/3,
      (array['Labor','OT Labor','Travel','Parts/Hardware','Shipping','Other'])[1+n%6],
      'Synthetic high-line invoice item '||n,1,0.01 from generate_series(1,999)n`, [high]);
    await tx.query(`insert into public.invoice_lines(id,invoice_id,position,type,description,qty,rate)
      select ('b2000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,$1,n+1,'Labor',
      repeat(chr(1),4000),1,0.01 from generate_series(1,100)n`, [maximumText]);
    await tx.query('delete from public.invoice_lines where invoice_id=$1', [empty]);
    await tx.query(`update public.invoice_lines set description='SYNTHETIC PART component'
      where id='b1000000-0000-4000-8000-000000000500'`);
    await tx.query(`update public.invoices set subtotal=case id when $1 then 109.99 when $2 then 101 else 500 end,
      total=case id when $1 then 109.99 when $2 then 101 else 500 end,invoice_version=7
      where id in ($1,$2,$3)`, [high, maximumText, empty]);
    await tx.query(`insert into public.staff_invoice_sources(id,staff_invoice_id,contractor_invoice_id,work_order_id)
      values('b3000000-0000-4000-8000-000000000001',$1,$2,$3)`, [staff, high, workOrderId(1)]);
    // Nonempty current company/admin/invoice-member/technician read cases.
    // The original Phase 6B invoice seed used the standalone contractor for
    // every contractor invoice, leaving company invoice reads empty.
    for (const [index, parent, owner, lineCount] of [[1, 2, f.actors.companyAdmin, 1],
      [2, 3, f.actors.companyAdmin, 50], [3, 4, f.actors.otherCompany, 51], [4, 7, f.actors.companyAdmin, 1]]) {
      const id = syntheticId('b4', index);
      await tx.query(`insert into public.invoices(id,num,work_order_id,contractor_id,invoice_type,invoice_date,state,
        subtotal,sales_tax,total,created_at,updated_at,invoice_version) values($1,$2,$3,$4,'contractor','2026-09-01',
        'submitted',$5,0,$5,'2026-09-01','2026-09-01',1)`, [id, `SYNTHETIC-COMPANY-${index}`, workOrderId(parent), owner, lineCount]);
      await tx.query(`insert into public.invoice_lines(id,invoice_id,position,type,description,qty,rate)
        select ('b5000000-0000-4000-8000-'||lpad(($2::integer*1000+n)::text,12,'0'))::uuid,$1,n,'Labor','Synthetic company line',1,1
        from generate_series(1,$3::integer)n`, [id, index, lineCount]);
    }
    await tx.query(`insert into public.invoices(id,num,work_order_id,contractor_id,invoice_type,invoice_date,state,
      subtotal,sales_tax,total,created_at,updated_at,invoice_version) values
      ('b8000000-0000-4000-8000-000000000001','SYNTHETIC-FRACTIONAL',$1,$2,'contractor','2026-09-01','submitted',0.03,0,0.03,'2026-09-01','2026-09-01',0),
      ('b8000000-0000-4000-8000-000000000002','SYNTHETIC-LEGACY-NULL',$1,$2,'contractor','2026-09-01','submitted',null,null,null,'2026-09-01','2026-09-01',0),
      ('b8000000-0000-4000-8000-000000000003','SYNTHETIC-DISPLAY-PARITY',$1,$2,'contractor','2026-09-01','submitted',37.91,0,37.91,'2026-09-01','2026-09-01',0)`,
    [workOrderId(1), f.actors.contractor]);
    await tx.query(`insert into public.invoice_lines(id,invoice_id,position,type,description,qty,rate) values
      ('b9000000-0000-4000-8000-000000000001','b8000000-0000-4000-8000-000000000001',1,'Labor','Synthetic fractional',0.3,0.05),
      ('b9000000-0000-4000-8000-000000000002','b8000000-0000-4000-8000-000000000001',2,'Labor','Synthetic fractional',0.3,0.05),
      ('b9000000-0000-4000-8000-000000000003','b8000000-0000-4000-8000-000000000002',-1,'Other',null,1,0),
      ('b9000000-0000-4000-8000-000000000004','b8000000-0000-4000-8000-000000000002',0,'Other',repeat('x',190000),1,0)`);
    for (const [index, type, qty, rate] of [
      [5, 'Labor', 1, 1.005], [6, 'Labor', 1, 1.015], [7, 'Labor', -1, 1.005],
      [8, 'Other', 1, -0.005], [9, 'Parts/Hardware', 0.3, 0.05], [10, '\tLabor\t', 1, 1.005],
      [11, 'OT\u00a0Labor', 1, 1.005],
    ]) await tx.query(`insert into public.invoice_lines(id,invoice_id,position,type,description,qty,rate)
      values($1,'b8000000-0000-4000-8000-000000000003',$2,$3,'Synthetic display rounding',$4,$5)`,
    [syntheticId('b9', index), index, type, qty, rate]);
    await tx.query("update public.invoices set rejection_reason='Synthetic visible rejection explanation' where id=$1", [high]);
    for (const table of ['invoices', 'invoice_lines', 'staff_invoice_sources']) await tx.exec(`alter table public.${table} enable trigger user`);
  });
  await db.exec('analyze public.invoices; analyze public.invoice_lines; analyze public.staff_invoice_sources');
  report.invoiceLines = { typical: 1, high: 1000, maximumTextLineCount: 101, maximumTextCharacters: 4000,
    tiedPositions: true, emptyManualTotalHeader: true, baselineInvoices: f.scale.invoices };
  report.scaleAfterSupplement = (await db.query(`select (select count(*) from public.invoices)::integer invoices,
    (select count(*) from public.invoice_lines)::integer invoice_lines`)).rows[0];
  const oldHigh = await rpc('list_contractor_invoices_rows_v1', ['all', null, 'recent', 'desc', 25, null, workOrderId(1)]);
  report.payloads.push({ name: 'legacy_high_line_invoice', bytes: bytes(oldHigh), lines: oldHigh.items[0].lines.length });
  const financialFingerprint = async () => (await db.query(`select
    (select md5(string_agg(to_jsonb(invoice)::text,'' order by invoice.id)) from public.invoices invoice) headers,
    (select md5(string_agg(to_jsonb(line)::text,'' order by line.id)) from public.invoice_lines line) lines,
    (select md5(string_agg(to_jsonb(source)::text,'' order by source.id)) from public.staff_invoice_sources source) sources`)).rows[0];
  const beforeFinancial = await financialFingerprint();
  const hasNavigationMigration = readdirSync(new URL('../supabase/migrations/', import.meta.url)).some(name => /^0146_.*\.sql$/.test(name));
  if (hasNavigationMigration) await applyThrough(db, 146, 146);
  const oldDefinitions = (await db.query(`select oid::regprocedure::text signature,pg_get_functiondef(oid) definition
    from pg_proc where pronamespace='public'::regnamespace order by oid`)).rows;
  const policySnapshot = async () => (await db.query(`select polrelid::regclass::text relation,polname,polcmd,polpermissive,polroles,
    pg_get_expr(polqual,polrelid) using_expression,pg_get_expr(polwithcheck,polrelid) check_expression
    from pg_policy order by polrelid,polname`)).rows;
  const policies = await policySnapshot();
  const indexes = (await db.query("select indexname,indexdef from pg_indexes where schemaname='public' order by indexname")).rows;
  phase = 'schema'; report.migrationSha256AtApply = migrationHash(); await applyThrough(db, 147, 147);
  same(await financialFingerprint(), beforeFinancial, '0147 changes no financial header, line, or source');
  same(await policySnapshot(), policies, '0147 changes no RLS policy');
  same((await db.query("select indexname,indexdef from pg_indexes where schemaname='public' order by indexname")).rows, indexes, 'No speculative invoice index');
  for (const previous of oldDefinitions) same((await db.query('select pg_get_functiondef(to_regprocedure($1)) definition', [previous.signature])).rows[0].definition,
    previous.definition, 'Every previous public function remains byte-identical');
  report.oldFunctionsPreserved = oldDefinitions.length;

  phase = 'contracts';
  for (const [actorName, actor] of Object.entries(f.actors)) for (const family of ['contractor', 'staff']) {
    const before = await rpc(`list_${family}_invoices_rows_v1`, [], actor);
    const after = await rpc(`list_${family}_invoices_rows_v2`, [], actor);
    same(after.items.map(item => item.id), before.items.map(item => item.id), `${actorName} ${family}: authorized IDs and order`);
    same([after.hasMore, after.nextCursor], [before.hasMore, before.nextCursor], 'Compatible first-page cursor');
    check(!Object.hasOwn(after, 'totalCount'), 'Compact page is count-independent');
    check(bytes(after) <= 204800, 'Compact list uncompressed bytes');
    for (const item of after.items) {
      const prior = before.items.find(row => row.id === item.id);
      for (const key of ['num', 'state', 'subtotal', 'sales_tax', 'total', 'invoice_version', 'work_order_id'])
        same(item[key], prior[key], `Unchanged financial summary ${key}`);
      same(item.rejection_reason, prior.rejection_reason, 'Current work-order invoice rejection explanation remains visible');
      check(item.projection === 'summary' && !Object.hasOwn(item, 'lines') && !Object.hasOwn(item, 'source_invoices'), 'List never contains line/source arrays');
      if (family === 'contractor') same(item.line_count, prior.lines.length, 'Exact per-header line count');
    }
    report.roles.push({ actorName, family, rows: after.items.length, status: 'IDENTICAL_AUTHORIZED_IDS' });
  }
  for (const family of ['contractor', 'staff']) for (const sort of family === 'contractor'
    ? ['recent', 'invoice', 'lines', 'total', 'work_order', 'contractor', 'status', 'store', 'date']
    : ['recent', 'invoice', 'total', 'work_order', 'status', 'store', 'date', 'territory']) for (const direction of ['asc', 'desc']) {
    const args = [family === 'contractor' ? 'all' : 'work_order', null, sort, direction, 7, null, null];
    const previous = await rpc(`list_${family}_invoices_rows_v1`, args);
    const next = await rpc(`list_${family}_invoices_rows_v2`, args);
    same(next.items.map(item => item.id), previous.items.map(item => item.id), `${family}/${sort}/${direction} ordering`);
    same(next.nextCursor, previous.nextCursor, 'Legacy cursor identity parity');
    if (next.hasMore) {
      args[5] = next.nextCursor;
      const continuation = await rpc(`list_${family}_invoices_rows_v2`, args);
      check(!continuation.items.some(item => next.items.some(first => first.id === item.id)), 'Continuation never repeats a loaded row');
      check(!Object.hasOwn(continuation, 'totalCount'), 'Continuation never requests global count');
    }
  }
  const deny = async (operation, codes) => { await assert.rejects(operation, error => codes.includes(error.code)); checks++; };
  for (const actor of [null, syntheticId('af', 1), f.actors.inactive, f.actors.otherCompany, f.actors.formerTechnician, f.actors.reportTechnician]) {
    for (const name of ['get_invoice_summary_v1', 'list_invoice_lines_page_v1'])
      await deny(() => rpc(name, [high], actor, actor === null ? 'anon' : 'authenticated'), ['42501', 'P0002']);
  }
  const highSummary = await rpc('get_invoice_summary_v1', [high]);
  same(highSummary.total, 109.99, 'Stored full-document total unchanged');
  same(highSummary.line_count, 1000, 'Exact all-line summary count');
  same(highSummary.line_type_summary.categories.reduce((total, category) => total + category.lineCount, 0), 1000, 'Category counts include every line');
  check(!Object.hasOwn(highSummary, 'lines') && !Object.hasOwn(highSummary, 'tax_jurisdiction_snapshot'), 'Exact summary excludes unbounded children');
  const emptySummary = await rpc('get_invoice_summary_v1', [empty]);
  same([emptySummary.line_count, emptySummary.total], [0, 500], 'Manual-total header is not recomputed from empty lines');
  const staffSummary = await rpc('get_invoice_summary_v1', [staff]);
  same(staffSummary.source_invoice_ids, [high], 'Source IDs are preserved without source lines');
  same(staffSummary.contractor_cost, 109.99, 'Source cost uses authoritative subtotal');
  const fractional = await rpc('get_invoice_summary_v1', [syntheticId('b8', 1)]);
  same([fractional.subtotal, fractional.total, fractional.line_type_summary.subtotal], [0.03, 0.03, 0.04],
    'Per-line display rounding never overwrites aggregate-rounded authoritative header totals');
  const displayLines = (await f.read(f.actors.manager, 'select type,qty,rate from public.invoice_lines where invoice_id=$1 order by position,id', [syntheticId('b8', 3)])).rows;
  const displaySummary = await rpc('get_invoice_summary_v1', [syntheticId('b8', 3)]);
  same(displaySummary.line_type_summary, summarizeInvoiceLineTypes(displayLines, displaySummary.sales_tax),
    'Full category display matches production JavaScript for 1.005, fractional quantity, negative legacy, and Unicode whitespace');
  same([displaySummary.subtotal, displaySummary.total], [37.91, 37.91], 'Display parity never changes the manual authoritative header');
  const legacyNull = await rpc('get_invoice_summary_v1', [syntheticId('b8', 2)]);
  same([legacyNull.invoice_version, legacyNull.subtotal, legacyNull.sales_tax, legacyNull.total], [0, null, null, null],
    'Legacy version zero and nullable monetary header values survive raw contract unchanged');
  const legacyLines = await rpc('list_invoice_lines_page_v1', [syntheticId('b8', 2)]);
  same([legacyLines.items[0].position, legacyLines.items[0].description], [-1, null], 'Legacy null description and signed integer position retained');
  same(legacyLines.items[1].description.length, 190000, 'Under-budget large legacy line is fully reachable, not rejected by an arbitrary reserve');
  check(bytes(legacyLines) <= 204800, 'Exact envelope budget includes a large legacy line');
  const sourceBatch = await rpc('get_invoice_source_summaries_v1', [[syntheticId('b4', 1), high, syntheticId('af', 1)]]);
  same(sourceBatch.invoices.map(item => item.id), [syntheticId('b4', 1), high], 'Source batch preserves requested order, filters nonexistent IDs');
  same(sourceBatch.invoices.map(item => item.line_count), [1, 1000], 'Source batch line counts are exact without line payloads');
  check(sourceBatch.invoices.every(item => Object.keys(item).length === 10 && !Object.hasOwn(item, 'lines')), 'Source batch has exactly ten compact header fields');
  same(await rpc('get_invoice_source_summaries_v1', [[high, syntheticId('b4', 1)]], f.actors.otherCompany), { invoices: [] }, 'Source batch does not leak another company existence');
  same(await rpc('get_invoice_source_summaries_v1', [[]]), { invoices: [] }, 'Empty explicit source set is bounded');
  await deny(() => rpc('get_invoice_source_summaries_v1', [[high, high]]), ['22023']);
  await deny(() => rpc('get_invoice_source_summaries_v1', [Array.from({ length: 101 }, (_, index) => syntheticId('ae', index))]), ['22023']);
  await deny(() => rpc('get_invoice_source_summaries_v1', [[high]], null, 'anon'), ['42501']);
  const mixedSourceIds = [high, staff, syntheticId('b4', 1), syntheticId('b4', 2), syntheticId('b4', 3), syntheticId('af', 1)];
  for (const actor of [...Object.values(f.actors), syntheticId('af', 1)]) {
    const expected = (await f.read(actor, `select invoice.id,
      (select count(*)::integer from public.invoice_lines line where line.invoice_id=invoice.id) line_count
      from public.invoices invoice where invoice.id=any($1::uuid[]) and invoice.invoice_type='contractor'
        and invoice.deleted_at is null order by array_position($1::uuid[],invoice.id)`, [mixedSourceIds])).rows;
    const actual = await rpc('get_invoice_source_summaries_v1', [mixedSourceIds], actor);
    same(actual.invoices.map(item => ({ id: item.id, line_count: item.line_count })), expected,
      'Every role source batch has identical authorized IDs and exact non-leaking line counts');
  }
  for (const [actor, expected] of [
    ['companyAdmin', [1, 2, 4]], ['secondAdmin', [1, 2, 4]], ['technician', [1]],
    ['invoiceMember', [2]], ['otherCompany', [3]], ['reportTechnician', []], ['formerTechnician', []],
  ]) {
    const page = await rpc('list_contractor_invoices_rows_v2', ['all', 'SYNTHETIC-COMPANY', 'invoice', 'asc', 25], f.actors[actor]);
    same(page.items.map(item => item.id), expected.map(index => syntheticId('b4', index)), 'Company scope is nonempty and exact for each current assignment');
    for (const id of expected) {
      const item = await rpc('get_invoice_summary_v1', [syntheticId('b4', id)], f.actors[actor]);
      check(item.line_count > 0, 'Authorized company exact summary is nonempty');
      const lines = await rpc('list_invoice_lines_page_v1', [item.id], f.actors[actor]);
      check(lines.items.length > 0, 'Authorized company line page is nonempty');
    }
  }
  const hints = await rpc('get_work_order_invoice_part_hints_v1', [workOrderId(1), [syntheticId('94', 1), syntheticId('94', 2)]]);
  same(hints, { billedPartIds: [syntheticId('94', 1)] }, 'Part hints preserve case-insensitive matching without leaking another parent part');
  for (const [partText, lineText, expected] of [[' valve ', 'valve', true], ['valve', ' valve ', true],
    [' ', 'abc', false], [' ', 'a b', true], ['', 'valve', false], ['valve', null, false]]) {
    await db.transaction(async tx => {
      await tx.exec('alter table public.wo_parts disable trigger user; alter table public.invoice_lines disable trigger user');
      await tx.query('update public.wo_parts set description=$2 where id=$1', [syntheticId('94', 2), partText]);
      await tx.query('update public.invoice_lines set description=$2 where id=$1', [syntheticId('b5', 1001), lineText]);
      await tx.exec('alter table public.wo_parts enable trigger user; alter table public.invoice_lines enable trigger user');
    });
    same(await rpc('get_work_order_invoice_part_hints_v1', [workOrderId(2), [syntheticId('94', 2)]]),
      { billedPartIds: expected ? [syntheticId('94', 2)] : [] }, 'Part hints retain exact legacy whitespace/substring semantics');
  }
  await db.transaction(async tx => {
    await tx.exec('alter table public.wo_parts disable trigger user; alter table public.invoice_lines disable trigger user');
    await tx.query("update public.wo_parts set description='Synthetic part' where id=$1", [syntheticId('94', 2)]);
    await tx.query("update public.invoice_lines set description='Synthetic company line' where id=$1", [syntheticId('b5', 1001)]);
    await tx.exec('alter table public.wo_parts enable trigger user; alter table public.invoice_lines enable trigger user');
  });
  const traverse = async (id, limit) => {
    const summary = await rpc('get_invoice_summary_v1', [id]);
    const expected = (await f.read(f.actors.manager, 'select id,position from public.invoice_lines where invoice_id=$1 order by position,id', [id])).rows;
    const ids = [], cursors = new Set(); let cursor = null, pages = 0, maximumBytes = 0;
    do {
      const page = await rpc('list_invoice_lines_page_v1', [id, limit, cursor, summary.invoice_version]);
      check(page.items.length <= limit && bytes(page) <= 204800, 'Line page obeys row and wire-byte ceilings');
      check(!Object.hasOwn(page, 'totalCount') && !Object.hasOwn(page, 'line_count'), 'Continuation returns no all-line count');
      same(page.invoiceVersion, summary.invoice_version, 'Every page belongs to one financial version');
      ids.push(...page.items.map(line => line.id)); maximumBytes = Math.max(maximumBytes, bytes(page)); pages++;
      cursor = page.hasMore ? page.nextCursor : null;
      if (cursor) { check(!cursors.has(cursor), 'Cursor advances even when byte ceiling shortens page'); cursors.add(cursor); }
      check(pages <= 1001, 'Traversal is finitely bounded by the synthetic document');
    } while (cursor);
    same(ids, expected.map(line => line.id), 'Every line is reachable exactly once in original position/ID order');
    report.payloads.push({ name: 'line_traversal', invoiceFixture: id === high ? '1000_LINES' : id === maximumText ? 'MAXIMUM_VALID_TEXT' : `BOUNDARY_${ids.length}_LINES`,
      lines: ids.length, pages, maximumBytes, pageSize: limit });
  };
  await traverse(high, 50); await traverse(maximumText, 100);
  await traverse(empty, 50); await traverse(syntheticId('b4', 1), 50);
  await traverse(syntheticId('b4', 2), 50); await traverse(syntheticId('b4', 3), 50);
  const first = await rpc('list_invoice_lines_page_v1', [high, 50, null, 7]);
  same(await rpc('list_invoice_lines_page_v1', [high, 50, first.nextCursor, 7]),
    await rpc('list_invoice_lines_page_v1', [high, 50, first.nextCursor, 7]), 'Same cursor replay has stable line identity');
  for (const args of [[high, 0], [high, 101], [high, 50, 'invalid', 7], [staff, 50, first.nextCursor, 0],
    [high, 50, first.nextCursor, null], [high, 50, null, 8]])
    await deny(() => rpc('list_invoice_lines_page_v1', args), ['22023', 'PT409']);
  const goodCursor = { v: 1, invoice_id: high, invoice_version: 7, position: 1, id: syntheticId('93', 1) };
  for (const invalid of [{ ...goodCursor, invoice_version: null }, { ...goodCursor, invoice_version: '7' },
    { ...goodCursor, position: null }, { ...goodCursor, position: 2147483648 }, { ...goodCursor, id: 'invalid' },
    { ...goodCursor, extra: true }, { ...goodCursor, invoice_id: staff }, { ...goodCursor, v: 2 }, { ...goodCursor, v: '1' },
    { ...goodCursor, invoice_version: -1 }, { ...goodCursor, position: 1.5 }]) {
    const cursor = (await db.query('select public.portal_encode_cursor($1::jsonb) result', [JSON.stringify(invalid)])).rows[0].result;
    await deny(() => rpc('list_invoice_lines_page_v1', [high, 50, cursor, 7]), ['22023', 'PT409']);
  }
  // Simulate an independently committed draft/revision version change. The
  // owner-only fixture operation is not an application mutation capability.
  await db.transaction(async tx => {
    await tx.exec('alter table public.invoices disable trigger user');
    await tx.query('update public.invoices set invoice_version=8 where id=$1', [high]);
    await tx.exec('alter table public.invoices enable trigger user');
  });
  await deny(() => rpc('list_invoice_lines_page_v1', [high, 50, first.nextCursor, 7]), ['PT409']);
  const refreshed = await rpc('list_invoice_lines_page_v1', [high, 50, null, 8]);
  same(refreshed.items.map(line => line.id), first.items.map(line => line.id), 'Version change requires first-page refresh, never old/new merge');
  const oversizedId = (await db.query('select id from public.invoice_lines where invoice_id=$1 order by position,id limit 1', [maximumText])).rows[0].id;
  await db.transaction(async tx => {
    await tx.exec('alter table public.invoice_lines disable trigger user');
    await tx.query("update public.invoice_lines set description=repeat('x',205000) where id=$1", [oversizedId]);
    await tx.exec('alter table public.invoice_lines enable trigger user');
  });
  await deny(() => rpc('list_invoice_lines_page_v1', [maximumText]), ['PT413']);
  await db.transaction(async tx => {
    await tx.exec('alter table public.invoice_lines disable trigger user');
    await tx.query("update public.invoice_lines set description='Synthetic line' where id=$1", [oversizedId]);
    await tx.exec('alter table public.invoice_lines enable trigger user');
  });
  report.payloads.push({ name: 'compact_high_line_header', bytes: bytes(highSummary), total: highSummary.total, lineCount: highSummary.line_count });
  const highList = await rpc('list_contractor_invoices_rows_v2', ['all', null, 'recent', 'desc', 25, null, workOrderId(1)]);
  report.payloads.push({ name: 'compact_high_line_list', bytes: bytes(highList), lineCount: highList.items[0].line_count });
  // A currently visible scalar can itself be large: escaped 4,000-character
  // rejection reasons must shorten a page, never disappear or hide invoices.
  const rejectionRows = (await f.read(f.actors.manager, `select id,num,rejection_reason from public.invoices
    where invoice_type='contractor' and deleted_at is null and id>$1 and id<$2 order by id limit 25`,
  [syntheticId('92', 4), syntheticId('93', 0)])).rows;
  same(rejectionRows.length, 25, 'Payload fixture contains 25 real authorized invoice rows');
  await db.transaction(async tx => {
    await tx.exec('alter table public.invoices disable trigger user');
    for (const [index, invoice] of rejectionRows.entries()) await tx.query(`update public.invoices
      set num=$2,rejection_reason=repeat(chr(1),4000) where id=$1`, [invoice.id, `SYNTHETIC-BUDGET-${index}`]);
    await tx.exec('alter table public.invoices enable trigger user');
  });
  const rejectionIds = []; let rejectionCursor = null, rejectionPages = 0, rejectionMaximumBytes = 0;
  do {
    const page = await rpc('list_contractor_invoices_rows_v2', ['all', 'SYNTHETIC-BUDGET-', 'recent', 'desc', 25, rejectionCursor]);
    check(bytes(page) <= 204800 && page.items.length > 0, 'Visible large rejection text uses a bounded nonempty page');
    check(page.items.every(item => item.rejection_reason === '\u0001'.repeat(4000)), 'Visible rejection reasons are not truncated');
    rejectionIds.push(...page.items.map(item => item.id)); rejectionPages++;
    rejectionMaximumBytes = Math.max(rejectionMaximumBytes, bytes(page));
    rejectionCursor = page.hasMore ? page.nextCursor : null;
    check(rejectionPages <= 25, 'Byte-bound compact invoice cursor advances');
  } while (rejectionCursor);
  same([...rejectionIds].sort(), rejectionRows.map(item => item.id).sort(), 'Every byte-bound invoice remains reachable exactly once');
  check(rejectionPages > 1, 'Valid escaped scalar fields exercise byte-prefix continuation');
  report.payloads.push({ name: 'large_visible_rejection_page_traversal', rows: rejectionIds.length,
    pages: rejectionPages, maximumBytes: rejectionMaximumBytes, fieldCharacters: 4000 });
  await db.transaction(async tx => {
    await tx.exec('alter table public.invoices disable trigger user');
    for (const invoice of rejectionRows) await tx.query('update public.invoices set num=$2,rejection_reason=$3 where id=$1',
      [invoice.id, invoice.num, invoice.rejection_reason]);
    await tx.exec('alter table public.invoices enable trigger user');
  });
  // Exercise the validated <=100-source header boundary, not only the
  // separate 100-ID source-selection batch. These temporary synthetic rows
  // are removed before distributions so the documented scale stays exact.
  const maximumHeader = syntheticId('bc', 1);
  const maximumSources = Array.from({ length: 101 }, (_, index) => syntheticId('bd', index + 1));
  await db.transaction(async tx => {
    for (const table of ['invoices', 'invoice_lines', 'staff_invoice_sources']) await tx.exec(`alter table public.${table} disable trigger user`);
    await tx.query(`insert into public.invoices(id,num,work_order_id,invoice_type,invoice_date,state,subtotal,sales_tax,total,
      store_number,store_address,cme,terms,territory,pdf_storage_path,rejection_reason,invoice_version)
      values($1,'SYNTHETIC-MAXIMUM-HEADER',$2,'staff','2026-09-01','draft',1,0,1,repeat('S',80),
        repeat(chr(1),1000),repeat(chr(1),200),repeat(chr(1),200),repeat(chr(1),200),repeat('p',1000),repeat(chr(1),2000),0)`,
    [maximumHeader, workOrderId(1)]);
    await tx.query(`insert into public.invoice_lines(id,invoice_id,position,type,description,qty,rate)
      values($1,$2,1,'Labor','Synthetic maximum-header item',1,1)`, [syntheticId('be', 1), maximumHeader]);
    for (const [index, id] of maximumSources.entries()) {
      await tx.query(`insert into public.invoices(id,num,work_order_id,contractor_id,invoice_type,invoice_date,state,subtotal,sales_tax,total,invoice_version)
        values($1,repeat(chr(128161),76)||lpad($4::text,4,'0'),$2,$3,'contractor','2026-09-01','approved',1,0,1,0)`,
      [id, workOrderId(1), f.actors.contractor, index + 1]);
      if (index < 100) await tx.query(`insert into public.staff_invoice_sources(id,staff_invoice_id,contractor_invoice_id,work_order_id)
        values($1,$2,$3,$4)`, [syntheticId('bf', index + 1), maximumHeader, id, workOrderId(1)]);
    }
    for (const table of ['invoices', 'invoice_lines', 'staff_invoice_sources']) await tx.exec(`alter table public.${table} enable trigger user`);
  });
  const maximumSummary = await rpc('get_invoice_summary_v1', [maximumHeader]);
  same([maximumSummary.source_count, maximumSummary.source_invoice_ids.length, maximumSummary.source_invoices.length],
    [100, 100, 100], 'Exact header preserves all 100 maximum-length source summaries');
  check(bytes(maximumSummary) <= 204800, 'Maximum-field header with 100 sources respects uncompressed JSON budget');
  const maximumSourceBatch = await rpc('get_invoice_source_summaries_v1', [maximumSources.slice(0, 100)]);
  same(maximumSourceBatch.invoices.length, 100, 'Maximum-number source batch retains every authorized source');
  check(bytes(maximumSourceBatch) <= 204800, 'Maximum-number source batch respects uncompressed JSON budget');
  report.payloads.push({ name: 'maximum_field_header_100_sources', bytes: bytes(maximumSummary), sources: 100,
    sourceNumberCharacters: 80, sourceNumberUtf8Bytes: 308, storedTotal: maximumSummary.total });
  report.payloads.push({ name: 'maximum_number_source_batch_100', bytes: bytes(maximumSourceBatch), sources: 100 });
  await db.transaction(async tx => {
    await tx.exec('alter table public.staff_invoice_sources disable trigger user');
    await tx.query(`insert into public.staff_invoice_sources(id,staff_invoice_id,contractor_invoice_id,work_order_id)
      values($1,$2,$3,$4)`, [syntheticId('bf', 101), maximumHeader, maximumSources[100], workOrderId(1)]);
    await tx.exec('alter table public.staff_invoice_sources enable trigger user');
  });
  await deny(() => rpc('get_invoice_summary_v1', [maximumHeader]), ['PT413']);
  await db.transaction(async tx => {
    for (const table of ['invoices', 'invoice_lines', 'staff_invoice_sources']) await tx.exec(`alter table public.${table} disable trigger user`);
    await tx.query('delete from public.staff_invoice_sources where staff_invoice_id=$1', [maximumHeader]);
    await tx.query('delete from public.invoice_lines where invoice_id=$1', [maximumHeader]);
    await tx.query('delete from public.invoices where id=any($1::uuid[])', [[maximumHeader, ...maximumSources]]);
    for (const table of ['invoices', 'invoice_lines', 'staff_invoice_sources']) await tx.exec(`alter table public.${table} enable trigger user`);
  });

  phase = 'measurement';
  for (const actor of ['manager', 'contractor', 'controller', 'companyAdmin', 'invoiceMember', 'technician']) {
    const next = await measure('contractor_invoice_first', '0147', actor, 'select public.list_contractor_invoices_rows_v2() result');
    if (next.hasMore) await measure('contractor_invoice_continuation', '0147', actor,
      'select public.list_contractor_invoices_rows_v2(p_cursor=>$1) result', [next.nextCursor]);
  }
  await measure('staff_invoice_first', '0147', 'manager', 'select public.list_staff_invoices_rows_v2() result', [], { role: 'service_role' });
  for (const actor of ['manager', 'contractor']) {
    await measure('compact_invoice_detail', '0147', actor, 'select public.get_invoice_summary_v1($1) result', [high]);
    const page = await measure('invoice_lines_first', '0147', actor, 'select public.list_invoice_lines_page_v1($1) result', [high]);
    await measure('invoice_lines_continuation', '0147', actor, 'select public.list_invoice_lines_page_v1($1,50,$2,8) result', [high, page.nextCursor]);
  }
  await measure('staff_compact_detail', '0147', 'manager', 'select public.get_invoice_summary_v1($1) result', [staff]);
  await measure('maximum_valid_text_line_page', '0147', 'manager', 'select public.list_invoice_lines_page_v1($1,100) result', [maximumText]);
  const sourceIds = (await db.query("select id from public.invoices where invoice_type='contractor' and deleted_at is null order by id limit 100")).rows.map(row => row.id);
  for (const actor of ['manager', 'controller', 'contractor'])
    await measure('source_summary_batch_100', '0147', actor, 'select public.get_invoice_source_summaries_v1($1) result', [sourceIds]);
  if (!contractsOnly) {
    phase = 'plan';
    for (const actor of ['manager', 'contractor', 'companyAdmin'])
      await captureBodyPlan('p1_invoice_reads', 'contractor_rows_v2', actor, 'AFTER');
    await captureBodyPlan('p1_invoice_reads', 'staff_rows_v2', 'controller', 'AFTER');
    const routine = (await db.query("select prosrc from pg_proc where oid='public.list_invoice_lines_page_v1(uuid,integer,text,bigint)'::regprocedure")).rows[0];
    let lineSql = routine.prosrc.slice(routine.prosrc.indexOf('  with candidates as materialized ('), routine.prosrc.indexOf('    into v_result;')) + ';';
    const bindings = { p_invoice_id: `'${high}'::uuid`, v_limit: '50', v_cursor: 'null::jsonb', v_position: 'null::integer', v_id: 'null::uuid', v_version: '8::bigint' };
    for (const [key, value] of Object.entries(bindings)) lineSql = lineSql.replace(new RegExp(`\\b${key}\\b`, 'g'), `(${value})`);
    for (const actorName of ['manager', 'contractor']) {
      const linePlan = await f.as('authenticated', f.actors[actorName], tx => captureIsolatedPlan((query, params) => tx.query(query, params), lineSql));
      report.plans.push({ name: 'invoice_lines_page_body', stage: 'AFTER', actorName, evidence: 'PGLITE_LOCAL',
        visibility: 'expanded exact production line-page SQL body; constants can plan differently from nested RPC', ...planSummary(linePlan) });
      const summaryPlan = await f.as('authenticated', f.actors[actorName], tx => captureIsolatedPlan((query, params) => tx.query(query, params),
        'select public.get_invoice_summary_v1($1)', [high]));
      report.plans.push({ name: 'invoice_summary_outer_rpc', stage: 'AFTER', actorName, evidence: 'PGLITE_LOCAL',
        visibility: 'PL/pgSQL outer plan only; component total is timed, nested operators not represented', ...planSummary(summaryPlan) });
      checks += 2;
    }
  }
  phase = 'audit';
  const audit = await db.query(readFileSync(new URL('../supabase/audits/0147_compact_invoice_reads_and_line_pages_verification.sql', import.meta.url), 'utf8'));
  report.audit = audit.rows; save();
  check(audit.rows.every(row => row.all_checks_pass === true), 'Read-only 0147 catalog audit');
  report.signatures = (await db.query(`select oid::regprocedure::text signature,prosecdef security_definer,proconfig,
    has_function_privilege('anon',oid,'EXECUTE') anon_execute,has_function_privilege('authenticated',oid,'EXECUTE') authenticated_execute,
    has_function_privilege('service_role',oid,'EXECUTE') service_role_execute from pg_proc
    where pronamespace='public'::regnamespace and proname in ('list_contractor_invoices_rows_v2','list_staff_invoices_rows_v2',
    'get_invoice_summary_v1','list_invoice_lines_page_v1','get_work_order_invoice_part_hints_v1','get_invoice_source_summaries_v1') order by proname`)).rows;
  report.indexDecision = 'No new invoice index. Existing index catalog unchanged; all candidate decisions require measured plan evidence.';
  report.checks = checks;
  report.migrationSha256AtEnd = migrationHash();
  same(report.migrationSha256AtEnd, report.migrationSha256AtApply, 'Measured 0147 migration bytes stayed frozen throughout execution');
  report.checks = checks;
  report.localBudgetFailures = report.measurements.filter(metric => metric.version === '0147' && metric.budget === 'FAIL')
    .map(metric => ({ name: metric.name, actor: metric.actorName, p95Ms: metric.databaseRpc.p95Ms, target: metric.targetP95Ms }));
  report.verdict = contractsOnly ? 'CONTRACTS_VERIFIED_PERFORMANCE_NOT_EXECUTED' :
    report.localBudgetFailures.length ? 'REQUIRED_LOCAL_BUDGET_GATE_OPEN' : 'LOCAL_INVOICE_BUDGETS_PASSED';
  save();
  console.log(JSON.stringify({ evidence: 'PGLITE_LOCAL', checks, evidencePath, verdict: report.verdict, localBudgetFailures: report.localBudgetFailures }));
  if (report.localBudgetFailures.length) process.exitCode = 1;
} catch (error) {
  report.failures.push(classifyHarnessFailure(phase, error)); report.checks = checks; save();
  console.error(JSON.stringify({ ...report.failures.at(-1), checks, evidencePath })); process.exitCode = 1;
} finally { if (db) await db.close(); }
