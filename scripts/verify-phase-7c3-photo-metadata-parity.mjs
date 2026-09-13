// DRAFT: reviewed by root before execution; no production/provider access.
// Current full db.ts facade + actual boundedReadRpc, only Supabase transport injected.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdtempSync, existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { runInNewContext } from 'node:vm';
import { tmpdir } from 'node:os';

const root = process.cwd();
await import(pathToFileURL(join(root, 'scripts/pagination-test-support/syntheticSqlPrivacy.mjs')));
const { createDatabase, applyThrough, seedPerformanceFixture, workOrderId, syntheticId } =
  await import(pathToFileURL(join(root, 'scripts/query-performance-test-support/fixtures.mjs')));
const requireHere = createRequire(join(root, 'package.json'));
const ts = requireHere('typescript');
const mode = process.argv.find(value => value.startsWith('--mode='))?.slice(7) || 'before';
assert.ok(['before', 'after', 'smoke'].includes(mode));
const baselinePath = process.argv.find(value => value.startsWith('--baseline='))?.slice(11);
assert.ok(mode !== 'after' || baselinePath, 'After mode requires the sealed before artifact');
const output = mkdtempSync(join(tmpdir(), `p1-7c3-photo-metadata-${mode}-`));
const hash = value => createHash('sha256').update(value).digest('hex');
const warmups = mode === 'smoke' ? 0 : 3;
const iterations = mode === 'smoke' ? 1 : 20;
const report = { version: 1, mode, output, startedAt: new Date().toISOString(), result: 'INCOMPLETE',
  methodology: { warmups, iterations, percentile: 'nearest-rank',
    boundary: 'Complete real db.ts public photo page facade and real boundedReadRpc; only Supabase request transport injected',
    scope: 'Disposable PGlite actual canonical RLS/role/JWT GUC; not hosted/PostgREST/browser or real Storage bytes',
    exactMetadata: 'No public exact-photo metadata read exists; not invented or measured',
    cursor: 'Existing positional created/id cursor; parent and RLS reapplied, no signed scope binding added',
    performance: 'Existing local p95 <=500ms; no relative percentage tolerance exists in prior accepted records',
    storageEvidence: 'Synthetic storage.objects RLS rows only; no Storage HTTP/provider/binary IO' },
  sources: {}, measurements: [], roleReads: [], roleChecks: [], privacyChecks: [], cursorChecks: [],
  rawFixtures: {}, publicFixtures: {}, failures: [] };
const save = () => writeFileSync(join(output, 'evidence.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
const dist = values => { const sorted = [...values].sort((a, b) => a - b); return {
  p50Ms: sorted[Math.ceil(sorted.length * .5) - 1], p95Ms: sorted[Math.ceil(sorted.length * .95) - 1], samples: values }; };
let db, fixture, actor, role = 'authenticated', calls = [], sqlElapsed = 0, lastRaw;
const rpcName = 'list_work_order_photos_rows_v1';
const transport = { rpc(name, args) {
  assert.equal(name, rpcName, 'No unrelated RPC, count, mutation or collection');
  assert.deepEqual(Object.keys(args).sort(), ['p_cursor', 'p_limit', 'p_work_order_id']);
  let signal;
  const request = { abortSignal(value) { signal = value; return request; }, async then(fulfilled) {
    signal?.throwIfAborted(); calls.push({ name, args, signalPresent: Boolean(signal) });
    const started = performance.now();
    try {
      const result = await fixture.read(actor, `select public.${rpcName}(p_work_order_id=>$1,p_limit=>$2,p_cursor=>$3) result`,
        [args.p_work_order_id, args.p_limit, args.p_cursor], role);
      lastRaw = result.rows[0]?.result; sqlElapsed += performance.now() - started;
      return fulfilled({ data: lastRaw, error: null });
    } catch (error) { sqlElapsed += performance.now() - started; return fulfilled({ data: null, error }); }
  } }; return request;
} };
const cache = new Map();
function load(filename) {
  const absolute = resolve(filename);
  if (cache.has(absolute)) return cache.get(absolute).exports;
  if (absolute === join(root, 'src/lib/supabase/client.ts')) return { supabase: () => transport };
  const source = readFileSync(absolute, 'utf8'); report.sources[absolute.slice(root.length + 1)] = hash(source);
  const loadedModule = { exports: {} }; cache.set(absolute, loadedModule);
  const request = name => {
    if (!name.startsWith('.') && !name.startsWith('@/')) return requireHere(name);
    const target = name.startsWith('@/') ? join(root, 'src', name.slice(2)) : resolve(dirname(absolute), name);
    const file = [target, `${target}.ts`, `${target}.tsx`, join(target, 'index.ts')]
      .find(path => existsSync(path) && statSync(path).isFile());
    assert.ok(file, `Unresolved production dependency ${name}`);
    if (file === join(root, 'src/lib/supabase/client.ts') || file === join(root, 'src/lib/counts/readRpc.ts') ||
      file.startsWith(join(root, 'src/features/work-orders/data/')) || file.startsWith(join(root, 'src/features/photos/data/'))) return load(file);
    return requireHere(file);
  };
  runInNewContext(ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText,
  { exports: loadedModule.exports, module: loadedModule, require: request, Date, console, Map, Set, Promise,
    AbortController, AbortSignal, DOMException, URL, crypto: globalThis.crypto,
    fetch: () => { throw new Error('Real provider/network access prohibited'); } }, { filename: absolute });
  return loadedModule.exports;
}
async function historicalSupplement() {
  const filename = join(root, 'scripts/verify-performance-and-invoice-payload-closeout.mjs');
  const source = readFileSync(filename, 'utf8'); const ast = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const block = ast.statements.find(ts.isTryStatement).tryBlock;
  const transaction = block.statements.find(node => ts.isExpressionStatement(node) && node.getText(ast).startsWith('await db.transaction(async tx =>'));
  assert.ok(transaction); const text = transaction.getText(ast);
  assert.ok(text.includes('SYNTHETIC-FRACTIONAL') && text.includes('disable trigger user') && text.includes('enable trigger user'));
  report.supplement = { source: filename, sourceSha256: hash(source), transactionSha256: hash(text) };
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  await new AsyncFunction('db', 'f', 'syntheticId', 'workOrderId', 'high', 'staff', 'empty', 'maximumText', text)(db, fixture,
    syntheticId, workOrderId, syntheticId('92', 1), syntheticId('92', 2), syntheticId('92', 3), syntheticId('92', 4));
}
const photoId = n => `a8100000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const bindingId = n => `a8200000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const objectId = n => `a8300000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const photoPath = (parent, n, suffix = photoId(n)) => `wo/${parent}/${suffix}`;
const cases = [
  { label: 'canonical', n: 201, suffix: photoId(201) },
  { label: 'missing_object', n: 202, suffix: 'synthetic-missing.jpg', object: false },
  ...['jpg', 'png', 'webp', 'gif', 'tiff', 'heic', 'heif', 'bmp'].map((extension, i) =>
    ({ label: `reviewed_${extension}`, n: 203 + i, suffix: `Synthetic reviewed.${extension}` })),
  { label: 'null_uploader_caption', n: 211, suffix: 'Synthetic null author.jpg', uploader: null },
  { label: 'before_assignment', n: 212, suffix: 'Synthetic prior assignment.jpg', created: '2026-09-02T12:00:00Z' },
  { label: 'null_created', n: 213, suffix: 'Synthetic null timestamp.jpg', created: null },
  { label: 'deletion_pending', n: 214, suffix: 'Synthetic pending deletion.jpg', state: 'deletion_pending' },
  { label: 'deleted_binding', n: 215, suffix: 'Synthetic deleted binding.jpg', state: 'deleted' },
  { label: 'missing_binding', n: 216, suffix: 'Synthetic missing binding.jpg', binding: false },
  { label: 'older_binding_versions', n: 217, suffix: 'Synthetic older binding versions.jpg', version: 1, cycle: 1 },
  { label: 'reviewed_two_segment', n: 218, path: `wo/${workOrderId(22)}`, binding: false, registerReview: true },
];
const casePath = (parent, item) => item.path ?? photoPath(parent, item.n, item.suffix);
async function ownerChange(tables, run) {
  const allowed = new Set(['work_orders', 'photos', 'private_object_bindings']);
  assert.ok(tables.every(table => allowed.has(table)));
  await db.transaction(async tx => {
    for (const table of tables) await tx.exec(`alter table public.${table} disable trigger user`);
    await run(tx);
    for (const table of tables) await tx.exec(`alter table public.${table} enable trigger user`);
  });
}
async function insertPhoto(tx, parent, n, options = {}) {
  const actorId = options.uploader === null ? null : fixture.actors.reportTechnician;
  const created = Object.hasOwn(options, 'created') ? options.created : '2026-09-05T12:00:00Z';
  const path = options.path ?? photoPath(parent, n, options.suffix);
  await tx.query(`insert into public.photos(id,work_order_id,storage_path,uploader_id,uploader_name,caption,created_at)
    values($1,$2,$3,$4,$5,$6,$7)`, [photoId(n), parent, path, actorId,
    actorId ? 'Synthetic photo uploader' : null, options.caption ?? null, created]);
  if (options.object !== false) await tx.query(`insert into storage.objects(id,bucket_id,name,owner,metadata)
    values($1,'photos',$2,$3,'{}')`, [objectId(n), path, fixture.actors.reportTechnician]);
  if (options.binding !== false) await tx.query(`insert into public.private_object_bindings(id,bucket,object_path,storage_object_id,purpose,
    work_order_id,photo_id,actor_id,assignment_version,workflow_cycle,validation,review_reference,state)
    values($1,'photos',$2,$3,'photo',$4,$5,$6,$7,$8,$9,$10,$11)`,
  [bindingId(n), path, objectId(n), parent, photoId(n), fixture.actors.reportTechnician, options.version ?? 2,
    options.cycle ?? 3, options.label === 'canonical' ? 'new_validated' : 'legacy_reviewed',
    options.label === 'canonical' ? null : 'SYNTHETIC-C3-PHOTO-READ-FIXTURE', options.state ?? 'finalized']);
  return path;
}
async function seedPhotoCases() {
  const parent = workOrderId(22), a = fixture.actors;
  await ownerChange(['work_orders', 'photos', 'private_object_bindings'], async tx => {
    await tx.query(`update public.work_orders set contractor_id=$2,assigned_technician_profile_id=$3,
      contractor_assignment_version=2,contractor_assignment_started_at='2026-09-03T00:00:00Z',workflow_cycle=3,
      status='wip',functional_status='Work in Progress',deleted_at=null where id=$1`, [parent, a.companyAdmin, a.reportTechnician]);
    for (let n = 1; n <= 104; n++) await insertPhoto(tx, workOrderId(2), n, {
      created: new Date(Date.UTC(2026, 8, 5, 0, 0, Math.floor(n / 3))).toISOString(), suffix: `Synthetic density ${n}.jpg` });
    for (const item of cases) await insertPhoto(tx, parent, item.n, item);
  });
  // Exact authoritative legacy owner-review command, not an invented permissive
  // binding fixture. This proves the current SQL permits reviewed wo/<parent>
  // with no third segment; no provider bytes or real legacy records are used.
  for (const item of cases.filter(item => item.registerReview)) {
    const values = ['photo', photoId(item.n), objectId(item.n), 'Synthetic C3 two-segment compatibility review'];
    const first = (await db.query('select public.register_verified_legacy_object_v1($1,$2,$3,$4) result', values)).rows[0].result;
    const replay = (await db.query('select public.register_verified_legacy_object_v1($1,$2,$3,$4) result', values)).rows[0].result;
    assert.equal(first.validation, 'legacy_reviewed'); assert.equal(first.bindingId, replay.bindingId);
    report.legacyReview = { command: 'register_verified_legacy_object_v1', metadataId: photoId(item.n), objectId: objectId(item.n),
      path: casePath(parent, item), authoritativeReview: true, replayBindingStable: true };
  }
  await db.exec('analyze public.photos; analyze public.private_object_bindings; analyze public.work_orders; analyze storage.objects');
  report.photoCases = cases.map(item => ({ ...item, id: photoId(item.n), path: casePath(parent, item) }));
}
async function metric(name, actorName, invoke) {
  actor = fixture.actors[actorName]; role = 'authenticated';
  const total = [], database = []; let value, payload, queryLog;
  for (let i = 0; i < warmups + iterations; i++) {
    calls = []; sqlElapsed = 0; const started = performance.now(); value = await invoke(); const elapsed = performance.now() - started;
    payload = JSON.stringify(value); queryLog = calls; assert.equal(calls.length, 1); assert.equal(value.totalCount, null);
    assert.ok(value.items.every(item => typeof item === 'string'));
    if (i >= warmups) { total.push(elapsed); database.push(sqlElapsed); }
  }
  const measured = { name, actorName, total: dist(total), database: dist(database), bytes: Buffer.byteLength(payload),
    publicSha256: hash(payload), queryCount: queryLog.length, queryLog, targetP95Ms: 500, withinLocalBudget: dist(total).p95Ms <= 500 };
  report.measurements.push(measured); report.rawFixtures[name] = lastRaw; report.publicFixtures[name] = value; save();
  assert.ok(measured.withinLocalBudget); console.log(JSON.stringify({ measurement: name, ...measured.total, bytes: measured.bytes }));
  return value;
}
async function captureRead(read, parent, name) {
  calls = [];
  try { const value = await read(parent, null, 100); return { name, status: 'returned', paths: value.items,
    payloadSha256: hash(JSON.stringify(value)), queryCount: calls.length }; }
  catch (error) { return { name, status: 'rejected', code: error.code || null, nameOfError: error.name, queryCount: calls.length }; }
}
async function roles(read) {
  for (const actorName of [...Object.keys(fixture.actors), 'missingProfile', 'anonymous']) {
    actor = actorName === 'missingProfile' ? photoId(999) : fixture.actors[actorName] || null;
    role = actorName === 'anonymous' ? 'anon' : 'authenticated';
    const item = { actorName };
    for (const [name, parent] of [['report_parent', workOrderId(22)], ['invoice_technician_parent', workOrderId(2)], ['standalone_parent', workOrderId(1)]])
      item[name] = await captureRead(read, parent, name);
    report.roleReads.push(item);
  }
  const get = name => { const value = report.roleReads.find(item => item.actorName === name); assert.ok(value); return value; };
  const fields = ['report_parent', 'invoice_technician_parent', 'standalone_parent'];
  for (const actorName of ['manager', 'dispatcher', 'backOffice', 'controller', 'quickbooksOnly', 'handoffOnly']) {
    for (const name of fields) { assert.equal(get(actorName)[name].status, 'returned'); assert.ok(get(actorName)[name].paths.length > 0);
      assert.deepEqual(get(actorName)[name].paths, get('manager')[name].paths); }
    report.roleChecks.push({ actorName, result: 'PASS', rule: 'Active operational base role reads finalized accessible-parent metadata' });
  }
  for (const actorName of ['invoiceMember', 'formerTechnician', 'inactive', 'otherCompany', 'secondAdmin', 'missingProfile']) {
    for (const name of fields) { assert.equal(get(actorName)[name].status, 'returned'); assert.deepEqual(get(actorName)[name].paths, []); }
    report.roleChecks.push({ actorName, result: 'PASS', rule: 'Inaccessible, inactive, missing, noncanonical-admin or unassigned actor excluded' });
  }
  for (const [actorName, names] of [['contractor', ['standalone_parent']], ['companyAdmin', ['report_parent', 'invoice_technician_parent']],
    ['reportTechnician', ['report_parent']], ['technician', ['invoice_technician_parent']]]) {
    for (const name of fields) { assert.equal(get(actorName)[name].status, 'returned'); assert.equal(get(actorName)[name].paths.length > 0, names.includes(name)); }
    report.roleChecks.push({ actorName, result: 'PASS', rule: 'Only own current canonical/individual/assigned-technician parents visible' });
  }
  for (const name of fields) assert.equal(get('anonymous')[name].status, 'rejected');
  report.roleChecks.push({ actorName: 'anonymous', result: 'PASS', rule: 'Anonymous rows-RPC execution denied' });
  assert.equal(report.roleChecks.length, 17); save();
}
async function privacy(read) {
  const parent = workOrderId(22), a = fixture.actors;
  const path = label => { const item = report.photoCases.find(item => item.label === label); assert.ok(item); return item.path; };
  role = 'authenticated'; actor = a.manager; const staff = (await read(parent, null, 100)).items;
  actor = a.reportTechnician; const reportPaths = (await read(parent, null, 100)).items;
  for (const item of cases) {
    const hidden = ['deletion_pending', 'deleted_binding', 'missing_binding'].includes(item.label);
    assert.equal(staff.includes(path(item.label)), !hidden);
    assert.equal(reportPaths.includes(path(item.label)), !hidden && !['before_assignment', 'null_created'].includes(item.label));
  }
  report.privacyChecks.push({ name: 'Finalized binding required; staff retains older/null-created metadata, contractor requires assignment-start cutoff', result: 'PASS' });
  assert.ok(reportPaths.includes(path('older_binding_versions')));
  report.privacyChecks.push({ name: 'Read helper does not invent binding assignment/workflow equality', result: 'PASS' });
  for (const extension of ['heic', 'heif', 'bmp']) assert.ok(reportPaths.includes(path(`reviewed_${extension}`)));
  report.privacyChecks.push({ name: 'Reviewed historical format paths remain unchanged; metadata is not new-content validation', result: 'PASS' });
  assert.ok(reportPaths.includes(path('reviewed_two_segment')));
  report.privacyChecks.push({ name: 'Actual owner-reviewed two-segment legacy object path remains exact and readable', result: 'PASS' });
  for (const [label, count] of [['canonical', 1], ['missing_object', 0], ['deletion_pending', 0], ['missing_binding', 0]]) {
    const rows = await fixture.read(a.reportTechnician, "select id,name from storage.objects where bucket_id='photos' and name=$1", [path(label)]);
    assert.equal(rows.rows.length, count);
  }
  report.privacyChecks.push({ name: 'Synthetic Storage RLS exact binding; missing object may retain metadata but cannot produce a download', result: 'PASS' });
  for (const denied of [a.formerTechnician, a.technician, a.otherCompany, a.inactive]) {
    assert.equal((await fixture.read(denied, "select id from storage.objects where bucket_id='photos' and name=$1", [path('canonical')])).rows.length, 0);
  }
  report.privacyChecks.push({ name: 'Former/different technician, other company and inactive actor cannot read exact synthetic object', result: 'PASS' });
  for (const status of ['closed', 'capital', 'pending_capital_completion']) {
    await ownerChange(['work_orders'], tx => tx.query('update public.work_orders set status=$2 where id=$1', [parent, status]));
    actor = a.reportTechnician; assert.deepEqual((await read(parent, null, 100)).items, reportPaths);
    report.privacyChecks.push({ name: `${status}: current authorized metadata visibility preserved`, result: 'PASS' });
  }
  await ownerChange(['work_orders'], tx => tx.query("update public.work_orders set status='wip',deleted_at='2026-09-06T00:00:00Z' where id=$1", [parent]));
  for (const current of [a.manager, a.companyAdmin, a.reportTechnician]) { actor = current; assert.deepEqual((await read(parent)).items, []); }
  report.privacyChecks.push({ name: 'Deleted parent denies photo metadata to staff and contractors under canonical access helper', result: 'PASS' });
  await ownerChange(['work_orders'], tx => tx.query(`update public.work_orders set deleted_at=null,contractor_id=$2,assigned_technician_profile_id=null,
    contractor_assignment_version=3,contractor_assignment_started_at='2026-09-07T00:00:00Z' where id=$1`, [parent, a.contractor]));
  for (const current of [a.companyAdmin, a.reportTechnician, a.contractor]) { actor = current; assert.deepEqual((await read(parent)).items, []); }
  report.privacyChecks.push({ name: 'Receiving contractor gains no pre-epoch metadata; outgoing company and technician lose parent access', result: 'PASS' });
  await ownerChange(['work_orders'], tx => tx.query(`update public.work_orders set contractor_id=$2,assigned_technician_profile_id=$3,
    contractor_assignment_version=2,contractor_assignment_started_at='2026-09-03T00:00:00Z' where id=$1`, [parent, a.companyAdmin, a.reportTechnician]));
  save();
}
async function cursors(read) {
  const parent = workOrderId(2); actor = fixture.actors.manager; role = 'authenticated';
  const all = []; let cursor = null, pages = 0;
  do {
    calls = []; const page = await read(parent, cursor, 17); assert.equal(calls.length, 1); assert.equal(page.totalCount, null);
    assert.ok(page.items.every(path => path.startsWith(`wo/${parent}/`))); all.push(...page.items);
    cursor = page.hasMore ? page.nextCursor : null; assert.ok(++pages <= 20, 'Test traversal is explicitly bounded');
  } while (cursor);
  assert.equal(all.length, 105); assert.equal(new Set(all).size, 105);
  report.cursorChecks.push({ name: 'Static 105-row traversal includes tied timestamps, no duplicate/skip/count', result: 'PASS', pages, pathsSha256: hash(JSON.stringify(all)) });
  const first = await read(parent); assert.equal(first.items.length, 24);
  const max = await read(parent, null, 101); assert.equal(max.items.length, 100);
  report.cursorChecks.push({ name: 'Default24 and overmax clamp100 unchanged', result: 'PASS' });
  const foreign = await read(workOrderId(22), first.nextCursor);
  assert.ok(foreign.items.every(path => path.startsWith(`wo/${workOrderId(22)}/`) || path === `wo/${workOrderId(22)}`));
  report.cursorChecks.push({ name: 'Positional cursor bytes reused unchanged; receiving query still enforces its exact parent and RLS', result: 'CHARACTERIZED', paths: foreign.items });
  await assert.rejects(read(parent, 'not a valid cursor!'));
  report.cursorChecks.push({ name: 'Malformed cursor safely rejected by existing authoritative SQL', result: 'PASS' });
  await assert.rejects(read(parent, Buffer.from(JSON.stringify({ created: 'bad-date', id: photoId(1) })).toString('base64url')));
  report.cursorChecks.push({ name: 'Malformed cursor position safely rejected without fallback', result: 'PASS' });
  const raw = await db.query(`select id,work_order_id,storage_path,uploader_id,uploader_name,caption,created_at
    from public.photos where work_order_id=$1 order by created_at desc nulls last,id desc limit 40`, [parent]);
  const removed = raw.rows[30]; assert.ok(removed && !first.items.includes(removed.storage_path));
  const inserted = photoPath(parent, 999);
  await ownerChange(['photos', 'private_object_bindings'], async tx => {
    await insertPhoto(tx, parent, 999, { created: '2026-09-08T00:00:00Z', label: 'canonical' });
    await tx.query('delete from public.photos where id=$1', [removed.id]);
  });
  try {
    const next = await read(parent, first.nextCursor);
    assert.ok(next.items.every(path => !first.items.includes(path) && path !== removed.storage_path && path !== inserted));
    report.cursorChecks.push({ name: 'Later insert/finalize and deletion do not duplicate first-page paths or change count independence', result: 'PASS', paths: next.items });
  } finally {
    await ownerChange(['photos', 'private_object_bindings'], async tx => {
      await tx.query('delete from public.photos where id=$1', [photoId(999)]);
      await tx.query('delete from public.private_object_bindings where id=$1', [bindingId(999)]);
      await tx.query('delete from storage.objects where id=$1', [objectId(999)]);
      await tx.query(`insert into public.photos(id,work_order_id,storage_path,uploader_id,uploader_name,caption,created_at)
        values($1,$2,$3,$4,$5,$6,$7)`, [removed.id, removed.work_order_id, removed.storage_path,
        removed.uploader_id, removed.uploader_name, removed.caption, removed.created_at]);
    });
  }
  save();
}
try {
  console.log(JSON.stringify({ phase: 'schema', mode, output })); db = await createDatabase(); await applyThrough(db, 144);
  fixture = await seedPerformanceFixture(db, { workOrders: mode === 'smoke' ? 100 : 50000, largeDirectories: mode !== 'smoke' });
  await historicalSupplement(); await applyThrough(db, 146, 145); await seedPhotoCases();
  report.scale = (await db.query(`select (select count(*) from public.work_orders)::integer work_orders,
    (select count(*) from public.activities)::integer activities,(select count(*) from public.invoices)::integer invoices,
    (select count(*) from public.invoice_lines)::integer invoice_lines,(select count(*) from public.photos)::integer photos`)).rows[0];
  if (mode !== 'smoke') for (const [key, expected] of Object.entries({ work_orders: 50000, activities: 101000, invoices: 10007, invoice_lines: 11212 }))
    assert.equal(report.scale[key], expected);
  const facade = load(join(root, 'src/lib/db.ts')), signal = new AbortController().signal;
  const read = (id, cursor = null, limit = 24) => facade.loadWorkOrderPhotosPage(id, cursor, limit, signal);
  const first = await metric('photo_metadata_first_page', 'manager', () => read(workOrderId(2)));
  assert.equal(first.items.length, 24); assert.ok(first.hasMore && first.nextCursor);
  const next = await metric('photo_metadata_continuation', 'manager', () => read(workOrderId(2), first.nextCursor));
  assert.ok(next.items.every(path => !first.items.includes(path)));
  await metric('photo_metadata_current_technician', 'reportTechnician', () => read(workOrderId(22)));
  await roles(read); await privacy(read); await cursors(read);
  if (baselinePath) {
    const text = readFileSync(baselinePath, 'utf8'), baseline = JSON.parse(text); assert.equal(baseline.result, 'PASS');
    report.baseline = { path: baselinePath, sha256: hash(text) }; assert.deepEqual(report.scale, baseline.scale);
    for (const value of report.measurements) {
      const before = baseline.measurements.find(item => item.name === value.name); assert.ok(before);
      assert.equal(value.bytes, before.bytes); assert.equal(value.publicSha256, before.publicSha256);
      assert.equal(JSON.stringify(value.queryLog), JSON.stringify(before.queryLog));
      value.beforeAfter = { beforeP50Ms: before.total.p50Ms, beforeP95Ms: before.total.p95Ms,
        p95DifferenceMs: value.total.p95Ms - before.total.p95Ms, localBudgetDecision: 'PASS',
        relativeTolerance: 'NOT_DEFINED_BY_EXISTING_RECORDS' };
    }
    for (const name of ['roleReads', 'roleChecks', 'privacyChecks', 'cursorChecks', 'legacyReview'])
      assert.equal(JSON.stringify(report[name]), JSON.stringify(baseline[name]), `${name} byte parity`);
  }
  report.result = 'PASS';
} catch (error) { report.result = 'FAIL'; report.failures.push({ message: error.message, stack: error.stack }); process.exitCode = 1; }
finally { report.completedAt = new Date().toISOString(); save(); await db?.close(); console.log(JSON.stringify({ result: report.result, output })); }
