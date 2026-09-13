// Test-only isolated fixture and timing support; no production or provider operations.
// Exact published fixture statements are selected by AST, not duplicated or relaxed.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';
import { performance } from 'node:perf_hooks';

export const root = '/Users/nxs/projects/p1-demo';
export const sha256 = value => createHash('sha256').update(value).digest('hex');
const requireHere = createRequire(join(root, 'package.json'));
export const ts = requireHere('typescript');
export const publishedPath = join(root, 'scripts/verify-phase-7c3-photo-metadata-parity.mjs');
export const publishedText = readFileSync(publishedPath, 'utf8');
export const publishedSha256 = sha256(publishedText);
export const rpcName = 'list_work_order_photos_rows_v1';
export const rpcSql = `select public.${rpcName}(p_work_order_id=>$1,p_limit=>$2,p_cursor=>$3) result`;

export function selectPublishedStatements(names) {
  const ast = ts.createSourceFile(publishedPath, publishedText, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const found = new Map();
  for (const statement of ast.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name && names.includes(statement.name.text)) {
      found.set(statement.name.text, statement.getText(ast));
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && names.includes(declaration.name.text)) {
          assert.equal(statement.declarationList.declarations.length, 1);
          found.set(declaration.name.text, statement.getText(ast));
        }
      }
    }
  }
  assert.deepEqual([...found.keys()].sort(), [...names].sort());
  return [...found.values()].join('\n');
}

export function makeObservedDatabase(realDb, phaseLog, sampleRef) {
  function observedTx(tx) {
    return new Proxy(tx, { get(target, name) {
      const original = Reflect.get(target, name, target);
      if (typeof original !== 'function') return original;
      if (name !== 'query' && name !== 'exec') return original.bind(target);
      return async (...args) => {
        const sql = String(args[0]);
        const start = performance.now();
        const sample = sampleRef.current;
        const isRpc = sql === rpcSql;
        if (isRpc && sample) sample.rpcStart = start;
        try { return await original.apply(target, args); }
        finally {
          const end = performance.now();
          if (sample) {
            sample.transportStatements.push({ kind: isRpc ? 'authorized_rpc' :
              /^set local role /i.test(sql) ? 'role_setup' : sql.includes("set_config('request.jwt.claim.role'") ? 'claim_setup' :
              /^set transaction read only$/i.test(sql) ? 'read_only_setup' : 'other',
              sql, params: structuredClone(args[1] ?? []), start, end, elapsedMs: end - start });
            if (isRpc) sample.rpcEnd = end;
          }
          if (/^analyze\b/i.test(sql.trim())) phaseLog.push({ name: 'analyze_statistics_ms', start, end, elapsedMs: end - start, sql });
        }
      };
    } });
  }
  return new Proxy(realDb, { get(target, name) {
    const original = Reflect.get(target, name, target);
    if (typeof original !== 'function') return original;
    if (name === 'transaction') return async (callback, ...rest) => {
      const sample = sampleRef.current;
      const begin = performance.now();
      if (sample) sample.transactionStart = begin;
      try {
        return await original.call(target, async tx => {
          if (sample) sample.transactionEntered = performance.now();
          try { return await callback(observedTx(tx)); }
          finally { if (sample) sample.transactionCallbackEnd = performance.now(); }
        }, ...rest);
      } finally { if (sample) sample.transactionEnd = performance.now(); }
    };
    if (name === 'query' || name === 'exec') return observedTx(target)[name];
    return original.bind(target);
  } });
}

export async function createTimedDatabase(report, phase, options = {}) {
  const engineDirectory = process.env.P1_SQL_TEST_ENGINE_DIR;
  assert.equal(engineDirectory, '/private/tmp/p1-phase6a-sql-engine.ED2BUV');
  const engineRequire = createRequire(join(engineDirectory, 'package.json'));
  let PGlite, pg_trgm, pgcrypto;
  await phase('database_module_import_ms', async () => {
    ({ PGlite } = engineRequire('@electric-sql/pglite'));
    ({ pg_trgm } = engineRequire('@electric-sql/pglite/contrib/pg_trgm'));
    ({ pgcrypto } = engineRequire('@electric-sql/pglite/contrib/pgcrypto'));
    report.enginePackage = JSON.parse(readFileSync(join(engineDirectory, 'node_modules/@electric-sql/pglite/package.json'), 'utf8')).version;
  });
  const additionalExtensions = options.additionalExtensions ?? {};
  assert.ok(Object.keys(additionalExtensions).every(name => ['auto_explain', 'pg_stat_statements'].includes(name)));
  let db;
  await phase('database_engine_start_ms', async () => {
    db = new PGlite({ extensions: { pg_trgm, pgcrypto, ...additionalExtensions } });
    await db.waitReady;
  });
  const { initializeSupabaseFixtureDatabase } = await import(pathToFileURL(join(root, 'scripts/lifecycle-test-support/engine-fixtures.mjs')));
  await phase('supabase_synthetic_schema_initialize_ms', async () => {
    await initializeSupabaseFixtureDatabase(db);
    // These are the same grant/identity statements from the approved existing createDatabase.
    await db.exec(`grant select on storage.buckets to anon, authenticated, service_role;
      grant select, insert, update, delete on storage.objects to anon, authenticated, service_role;
      alter table storage.objects add constraint synthetic_storage_object_identity unique(bucket_id,name);`);
  });
  return db;
}

export async function bootPhotoFixture({ report, phase, sampleRef, databaseOptions = {} }) {
  await import(pathToFileURL(join(root, 'scripts/pagination-test-support/syntheticSqlPrivacy.mjs')));
  const { applyThrough, seedPerformanceFixture, workOrderId, syntheticId } =
    await import(pathToFileURL(join(root, 'scripts/query-performance-test-support/fixtures.mjs')));
  const realDb = await createTimedDatabase(report, phase, databaseOptions);
  const db = makeObservedDatabase(realDb, report.phases, sampleRef);
  await phase('migration_apply_through_144_ms', () => applyThrough(db, 144));
  const fixture = await phase('historical_fixture_load_including_scoped_analyze_ms',
    () => seedPerformanceFixture(db, { workOrders: 50000, largeDirectories: true }));
  const selectedNames = ['historicalSupplement', 'photoId', 'bindingId', 'objectId', 'photoPath', 'cases', 'casePath',
    'ownerChange', 'insertPhoto', 'seedPhotoCases'];
  const selected = selectPublishedStatements(selectedNames);
  report.officialFixture = { path: publishedPath, sha256: publishedSha256, selectedStatementsSha256: sha256(selected), selectedNames };
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const helpers = await new AsyncFunction('assert', 'db', 'fixture', 'report', 'root', 'ts', 'readFileSync', 'join', 'hash',
    'syntheticId', 'workOrderId', `${selected}\nreturn { historicalSupplement, seedPhotoCases, photoId, cases };`)(
    assert, db, fixture, report, root, ts, readFileSync, join, sha256, syntheticId, workOrderId);
  await phase('historical_invoice_fixture_supplement_ms', () => helpers.historicalSupplement());
  await phase('migration_apply_145_146_ms', () => applyThrough(db, 146, 145));
  await phase('official_photo_fixture_load_including_scoped_analyze_ms', () => helpers.seedPhotoCases());
  // Owner-only counts may warm relation data buffers, as the frozen runner does.
  // They do not execute the photo RPC/RLS helper or prime that function's plan.
  report.scale = (await db.query(`select (select count(*) from public.work_orders)::integer work_orders,
    (select count(*) from public.activities)::integer activities,(select count(*) from public.invoices)::integer invoices,
    (select count(*) from public.invoice_lines)::integer invoice_lines,(select count(*) from public.photos)::integer photos,
    (select count(*) from public.private_object_bindings)::integer bindings`)).rows[0];
  assert.deepEqual(report.scale, { work_orders: 50000, activities: 101000, invoices: 10007, invoice_lines: 11212, photos: 25122, bindings: 25121 });
  report.engine = (await db.query(`select version() version,pg_backend_pid() backend_pid,current_user,
    current_setting('plan_cache_mode') plan_cache_mode,current_setting('timezone') timezone`)).rows[0];
  report.autoExplainBeforePrimaryTiming = (await db.query("select name,setting from pg_settings where name like 'auto_explain.%' order by name")).rows;
  assert.ok(report.autoExplainBeforePrimaryTiming.length === 0 || report.autoExplainBeforePrimaryTiming.some(
    row => row.name === 'auto_explain.log_min_duration' && row.setting === '-1'), 'Plan logging must be disabled throughout primary timing');
  // Reading catalog definitions executes neither function body nor RLS predicate.
  report.productionFunctionDefinitions = (await db.query(`select oid::regprocedure::text signature,pg_get_functiondef(oid) definition
    from pg_proc where oid in ('public.list_work_order_photos_rows_v1(text,integer,text)'::regprocedure,
    'p1_read_contracts.work_order_photos_v1(text,text,integer,text)'::regprocedure,
    'public.private_object_metadata_read(text,uuid)'::regprocedure,'public.private_object_binding_access(uuid,uuid)'::regprocedure)
    order by signature`)).rows;
  assert.equal(report.productionFunctionDefinitions.length, 4);
  report.productionFunctionSha256 = sha256(JSON.stringify(report.productionFunctionDefinitions));
  report.fixtureIdentity = sha256(JSON.stringify({ selectedStatementsSha256: sha256(selected),
    historicalSupplement: report.supplement, scale: report.scale,
    fixtureBuilderSha256: sha256(readFileSync(join(root, 'scripts/query-performance-test-support/fixtures.mjs'))),
    actorTransactionsSha256: sha256(readFileSync(join(root, 'scripts/lifecycle-test-support/engine-fixtures.mjs'))) }));
  return { db, realDb, fixture, workOrderId, syntheticId, helpers };
}

export function loadRealFacade(transport, report) {
  const cache = new Map();
  function load(filename) {
    const absolute = resolve(filename);
    if (cache.has(absolute)) return cache.get(absolute).exports;
    if (absolute === join(root, 'src/lib/supabase/client.ts')) return { supabase: () => transport };
    const source = readFileSync(absolute, 'utf8'); report.sources[absolute.slice(root.length + 1)] = sha256(source);
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
  return load(join(root, 'src/lib/db.ts'));
}

export async function recordFixtureFacts(db, report) {
  report.fixtureFacts = {};
  const queries = {
    parentDensity: `select work_order_id,count(*)::integer photos from public.photos where work_order_id in
      ('SYNTHETIC-PERF-000002','SYNTHETIC-PERF-000022','SYNTHETIC-PERF-000001') group by work_order_id order by work_order_id`,
    bindingStates: 'select purpose,state,validation,count(*)::integer rows from public.private_object_bindings group by purpose,state,validation order by purpose,state,validation',
    assignmentDistribution: `select contractor_assignment_version,workflow_cycle,(deleted_at is not null) deleted,
      (contractor_id is null) unassigned,(assigned_technician_profile_id is not null) assigned_technician,count(*)::integer rows
      from public.work_orders group by 1,2,3,4,5 order by 1,2,3,4,5`,
    actors: `select p.id,p.role,p.active,p.contractor_organization_id,p.contractor_access_level,
      array(select g.permission::text from public.staff_permission_grants g where g.profile_id=p.id order by g.permission) permissions
      from public.profiles p where p.id::text like '80000000-%' order by p.id`,
    sizes: `select n.nspname schema,c.relname,c.reltuples,c.relpages,c.relallvisible,pg_relation_size(c.oid)::text relation_bytes,
      pg_total_relation_size(c.oid)::text total_bytes from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where n.nspname='public' and c.relname in ('photos','private_object_bindings','work_orders','profiles','organizations','contractor_technicians') order by c.relname`,
    columns: `select schemaname,tablename,attname,null_frac,n_distinct,correlation from pg_stats where schemaname='public' and
      tablename in ('photos','private_object_bindings','work_orders','profiles','organizations','contractor_technicians') order by tablename,attname`,
    indexes: `select i.schemaname,i.tablename,i.indexname,i.indexdef,pg_relation_size((quote_ident(i.schemaname)||'.'||quote_ident(i.indexname))::regclass)::text bytes
      from pg_indexes i where i.schemaname='public' and i.tablename in ('photos','private_object_bindings','work_orders','profiles','organizations','contractor_technicians') order by i.tablename,i.indexname`,
    functions: `select oid::regprocedure::text signature,prosrc,prosecdef,provolatile,proconfig from pg_proc where oid in
      ('public.list_work_order_photos_rows_v1(text,integer,text)'::regprocedure,'p1_read_contracts.work_order_photos_v1(text,text,integer,text)'::regprocedure,
      'public.private_object_metadata_read(text,uuid)'::regprocedure,'public.private_object_binding_access(uuid,uuid)'::regprocedure) order by signature`,
  };
  for (const [key, sql] of Object.entries(queries)) report.fixtureFacts[key] = (await db.query(sql)).rows;
  report.fixtureFactsSha256 = sha256(JSON.stringify(report.fixtureFacts));
}
