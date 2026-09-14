// Test-only plan inspection; importing this module creates no DB and runs no query.
// Disposable synthetic execution remains gated by verified preservation and baseline evidence.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

export const approvedEngineDir = '/private/tmp/p1-phase6a-sql-engine.ED2BUV';
export const exactPhotoRpcSql = 'select public.list_work_order_photos_rows_v1(p_work_order_id=>$1,p_limit=>$2,p_cursor=>$3) result';
export const exactExplainPrefix = 'explain (analyze,buffers,verbose,settings,format json) ';
const sha256 = value => createHash('sha256').update(value).digest('hex');
const signatures = [
  'public.list_work_order_photos_rows_v1(text,integer,text)',
  'p1_read_contracts.validate_v1(text,jsonb)',
  'p1_read_contracts.work_order_photos_v1(text,text,integer,text)',
  'public.private_object_metadata_read(text,uuid)',
  'public.private_object_binding_access(uuid,uuid)',
  'public.private_object_actor_access(uuid,text,boolean)',
  'public.profile_has_staff_permission(uuid,text)',
  'public.portal_encode_cursor(jsonb)',
  'public.portal_decode_cursor(text)',
  'auth.uid()',
];
const relations = ['public.photos', 'public.private_object_bindings', 'public.work_orders',
  'public.profiles', 'public.organizations', 'public.contractor_technicians',
  'public.staff_permission_grants', 'storage.objects'];
const sourcePaths = ['src/lib/db.ts', 'src/lib/counts/readRpc.ts',
  'supabase/migrations/0076_cursor_pagination_and_portal_indexes.sql',
  'supabase/migrations/0080_fix_pagination_cursor_codec.sql',
  'supabase/migrations/0132_expand_canonical_storage_photo_workflows.sql',
  'supabase/migrations/0133_contract_canonical_storage_photo_workflows.sql',
  'supabase/migrations/0145_count_independent_page_reads.sql'];
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const errorFacts = error => ({ name: record(error) && typeof error.name === 'string' ? error.name : 'Error',
  code: record(error) && typeof error.code === 'string' ? error.code : null,
  message: record(error) && typeof error.message === 'string' ? error.message : String(error) });

export function existingAutoExplainExtension() {
  const requireEngine = createRequire(`${approvedEngineDir}/package.json`);
  return requireEngine('@electric-sql/pglite/contrib/auto_explain').auto_explain;
}

export async function capturePhotoCatalog(db) {
  // Owner catalog inspection only. Never count it as an authenticated query benchmark.
  const functions = (await db.query(`select p.oid::regprocedure::text signature,
    n.nspname schema,p.proname name,
    pg_get_functiondef(p.oid) definition,p.prosrc,pg_get_userbyid(p.proowner) owner,
    l.lanname language,p.prosecdef,p.provolatile,p.proleakproof,p.proconfig,p.proacl::text acl
    from pg_proc p join pg_language l on l.oid=p.prolang join pg_namespace n on n.oid=p.pronamespace
    where p.oid in (select to_regprocedure(s) from unnest($1::text[]) s) order by signature`, [signatures])).rows;
  assert.equal(functions.length, signatures.length, 'Every current helper must exist');
  for (const row of functions) {
    assert.ok(record(row) && typeof row.definition === 'string' && typeof row.prosrc === 'string');
    row.definitionSha256 = sha256(row.definition);
    row.sourceSha256 = sha256(row.prosrc);
  }
  const qualifiedNames = new Set(signatures.map(signature => signature.slice(0, signature.indexOf('('))));
  const helperGraph = functions.map(fn => {
    const calls = [...new Set([...fn.prosrc.matchAll(/\b(public|auth|p1_read_contracts)\.([a-z_][a-z_0-9]*)\s*\(/g)]
      .map(match => `${match[1]}.${match[2]}`))].sort();
    const unknown = calls.filter(name => !qualifiedNames.has(name));
    assert.deepEqual(unknown, [], `Helper graph changed under ${fn.schema}.${fn.name}; inspect exact definitions`);
    return { owner: `${fn.schema}.${fn.name}`, signature: fn.signature, sourceSha256: fn.sourceSha256, calls };
  });
  const tableFacts = (await db.query(`select c.oid::regclass::text relation,
    pg_get_userbyid(c.relowner) owner,c.relrowsecurity,c.relforcerowsecurity,c.relacl::text acl,
    c.reltuples,c.relpages,c.relallvisible,pg_relation_size(c.oid)::text relation_bytes,
    pg_total_relation_size(c.oid)::text total_bytes
    from pg_class c where c.oid in (select to_regclass(s) from unnest($1::text[]) s)
    order by relation`, [relations])).rows;
  const policies = (await db.query(`select p.polrelid::regclass::text relation,p.polname,p.polcmd,p.polpermissive,
    array(select r.rolname from pg_roles r where r.oid=any(p.polroles) order by r.rolname) roles,
    pg_get_expr(p.polqual,p.polrelid) predicate,pg_get_expr(p.polwithcheck,p.polrelid) with_check
    from pg_policy p where p.polrelid in (select to_regclass(s) from unnest($1::text[]) s)
    order by relation,p.polname`, [relations])).rows;
  const indexes = (await db.query(`select i.indrelid::regclass::text relation,
    i.indexrelid::regclass::text name,pg_get_indexdef(i.indexrelid) definition,
    i.indisunique,i.indisprimary,i.indisvalid,i.indisready,
    pg_get_expr(i.indpred,i.indrelid) predicate,pg_relation_size(i.indexrelid)::text bytes
    from pg_index i where i.indrelid in (select to_regclass(s) from unnest($1::text[]) s)
    order by relation,name`, [relations])).rows;
  const roles = (await db.query(`select rolname,rolsuper,rolbypassrls,rolcanlogin,rolinherit
    from pg_roles where rolname in ('anon','authenticated','service_role',session_user,current_user)
      or oid in (select proowner from pg_proc where oid in
        (select to_regprocedure(s) from unnest($1::text[]) s)) order by rolname`, [signatures])).rows;
  const settings = (await db.query(`select name,setting,unit,source,boot_val,reset_val
    from pg_settings where name in ('server_version','server_version_num','plan_cache_mode',
      'jit','jit_above_cost','jit_inline_above_cost','jit_optimize_above_cost','row_security',
      'search_path','TimeZone','work_mem','shared_buffers','effective_cache_size','random_page_cost',
      'seq_page_cost','cpu_operator_cost','cpu_tuple_cost','default_statistics_target',
      'track_io_timing','shared_preload_libraries','session_preload_libraries') order by name`)).rows;
  const stats = (await db.query(`select s.schemaname,s.tablename,s.attname,s.null_frac,s.n_distinct,s.correlation
    from pg_stats s where (quote_ident(s.schemaname)||'.'||quote_ident(s.tablename))=any($1::text[])
    order by s.schemaname,s.tablename,s.attname`, [relations])).rows;
  const identity = (await db.query(`select version() version,pg_backend_pid() backend_pid,
    session_user,current_user,current_setting('request.jwt.claim.role',true) claim_role,
    current_setting('request.jwt.claim.sub',true) claim_sub`)).rows[0];
  const sourceHashes = Object.fromEntries(sourcePaths.map(path => [path,
    sha256(readFileSync(`/Users/nxs/projects/p1-demo/${path}`))]));
  return { identity, sourceHashes, functions, helperGraph, tableFacts, policies, indexes, roles, settings, stats,
    // Definition parity excludes sampled statistics, counters and catalog OIDs.
    definitionSha256: sha256(JSON.stringify({
      functions: functions.map(({ signature, definitionSha256 }) => ({ signature, definitionSha256 })),
      policies, indexes: indexes.map(({ relation, name, definition }) => ({ relation, name, definition })),
    })) };
}

export function exactGeneratedInnerSelect(catalog) {
  assert.ok(record(catalog) && Array.isArray(catalog.functions));
  const fn = catalog.functions.find(row => record(row) && row.signature ===
    'p1_read_contracts.work_order_photos_v1(text,text,integer,text)');
  assert.ok(fn && fn.language === 'sql' && fn.prosecdef === false && fn.provolatile === 's');
  assert.ok(Array.isArray(fn.proconfig) && fn.proconfig.some(value =>
    typeof value === 'string' && value.replaceAll(' ', '') === 'search_path=pg_catalog,public'));
  const source = fn.prosrc;
  assert.ok(typeof source === 'string' && /^\s*with args as \(/i.test(source));
  assert.ok(source.includes('filtered as not materialized') && source.includes('from public.photos photo'));
  // This exact frozen function has no comments or dollar-quoted strings inside
  // its body. Refuse future syntax instead of accidentally rewriting a literal.
  assert.ok(!source.includes('--') && !source.includes('/*') && !source.includes('$$'));
  const binds = new Map([['p_read_mode', '$1::text'], ['p_work_order_id', '$2::text'],
    ['p_limit', '$3::integer'], ['p_cursor', '$4::text']]);
  const counts = new Map([...binds.keys()].map(key => [key, 0]));
  const parameterized = source.replace(/'(?:[^']|'')*'|\b(?:p_read_mode|p_work_order_id|p_limit|p_cursor)\b/g, token => {
    if (token.startsWith("'")) return token;
    counts.set(token, counts.get(token) + 1);
    return binds.get(token);
  });
  assert.ok([...counts.values()].every(count => count > 0));
  return { signature: fn.signature, source, sourceSha256: sha256(source), parameterized,
    parameterizedSha256: sha256(parameterized), substitutions: Object.fromEntries(counts),
    qualification: 'equivalent_inner_query_plan: exact generated SQL body with bound variable substitution only; unchanged actor/RLS, not proof of function cached plan' };
}

function validateVariant(variant) {
  assert.ok(record(variant));
  assert.match(variant.actor, /^80000000-0000-4000-8000-\d{12}$/);
  assert.match(variant.parent, /^SYNTHETIC-PERF-\d{6}$/);
  assert.ok(Number.isInteger(variant.limit) && variant.limit >= 1 && variant.limit <= 100);
  assert.ok(variant.cursor === null || typeof variant.cursor === 'string' && variant.cursor.length <= 4096);
}

async function actorQuery(db, variant, sql, args, options = {}) {
  validateVariant(variant);
  assert.ok(sql === exactPhotoRpcSql || sql.startsWith(exactExplainPrefix) || options.innerQuery === true);
  const mode = options.planCacheMode ?? 'auto';
  assert.ok(['auto', 'force_custom_plan', 'force_generic_plan'].includes(mode));
  return db.transaction(async tx => {
    if (options.nested) {
      // Set instrumentation as the unchanged owner, then run the actual query
      // as authenticated. No privilege or function changes.
      await tx.exec(`set local auto_explain.log_analyze=on;set local auto_explain.log_buffers=on;
        set local auto_explain.log_verbose=on;set local auto_explain.log_settings=on;
        set local auto_explain.log_format=json;set local auto_explain.log_level=notice;
        set local auto_explain.log_nested_statements=on;set local auto_explain.log_timing=on;
        set local auto_explain.sample_rate=1;set local client_min_messages=notice;
        set local auto_explain.log_min_duration=0;`);
    }
    await tx.exec(`set local plan_cache_mode=${mode};set local role authenticated;`);
    if (options.innerQuery === true) {
      // The public RPC/helper pin this setting themselves. A directly explained
      // body must pin it too; never substitute the caller's wider search path.
      await tx.exec('set local search_path=pg_catalog,public');
    }
    await tx.query("select set_config('request.jwt.claim.role',$1,true),set_config('request.jwt.claim.sub',$2,true)",
      ['authenticated', variant.actor]);
    await tx.exec('set transaction read only');
    const context = (await tx.query(`select current_user,session_user,pg_backend_pid() backend_pid,
      current_setting('role') role,current_setting('request.jwt.claim.role',true) claim_role,
      current_setting('request.jwt.claim.sub',true) claim_sub,current_setting('row_security') row_security,
      current_setting('transaction_read_only') transaction_read_only,current_setting('plan_cache_mode') plan_cache_mode,
      current_setting('search_path') search_path`)).rows[0];
    assert.ok(record(context));
    assert.equal(context.current_user, 'authenticated');
    assert.equal(context.role, 'authenticated');
    assert.equal(context.claim_role, 'authenticated');
    assert.equal(context.claim_sub, variant.actor);
    assert.equal(context.row_security, 'on');
    assert.equal(context.transaction_read_only, 'on');
    assert.equal(context.plan_cache_mode, mode);
    if (options.innerQuery === true) assert.equal(context.search_path.replaceAll(' ', ''), 'pg_catalog,public');
    assert.ok(Array.isArray(options.contextRecords), 'Plan query requires retained actual actor context');
    options.contextRecords.push({ sqlSha256: sha256(sql), innerQuery: options.innerQuery === true,
      scope: 'Same transaction caller immediately before target query; nested definer identity remains the unmodified function owner',
      ...context });
    return tx.query(sql, args, options.onNotice ? { onNotice: options.onNotice } : {});
  });
}

export async function probeAutoExplain(db) {
  const capability = { installedBundle: true, runtimeLoaded: false, settings: [], failure: null };
  try {
    await db.exec("load 'auto_explain';");
    capability.runtimeLoaded = true;
    capability.settings = (await db.query(`select name,setting,context from pg_settings
      where name like 'auto_explain.%' order by name`)).rows;
    for (const name of ['log_analyze','log_buffers','log_verbose','log_settings','log_format',
      'log_level','log_nested_statements','log_timing','sample_rate','log_min_duration']) {
      assert.ok(capability.settings.some(row => row.name === `auto_explain.${name}`), `Missing ${name}`);
    }
  } catch (error) { capability.failure = errorFacts(error); }
  return capability;
}

export async function captureExactPhotoPlans(db, variant, catalog, { nested = false, planCacheMode = 'auto' } = {}) {
  validateVariant(variant);
  const args = [variant.parent, variant.limit, variant.cursor];
  const contextRecords = [];
  const notices = [];
  let noticeCount = 0;
  const onNotice = notice => {
    noticeCount++;
    if (notices.length < 25000) notices.push({ message: String(notice.message),
      severity: notice.severity ?? null, code: notice.code ?? null,
      detail: notice.detail ?? null, where: notice.where ?? null });
  };
  const actual = await actorQuery(db, variant, exactPhotoRpcSql, args, { nested, onNotice, planCacheMode, contextRecords });
  assert.equal(actual.rows.length, 1);
  const raw = actual.rows[0].result;
  assert.ok(record(raw) && Array.isArray(raw.items) && typeof raw.hasMore === 'boolean');
  const bytes = Buffer.byteLength(JSON.stringify(raw));
  const exactPlan = await actorQuery(db, variant, exactExplainPrefix + exactPhotoRpcSql, args, { planCacheMode, contextRecords });
  const inner = exactGeneratedInnerSelect(catalog);
  const innerArgs = ['rows', ...args];
  const innerActual = await actorQuery(db, variant, inner.parameterized, innerArgs, { innerQuery: true, planCacheMode, contextRecords });
  assert.equal(innerActual.rows.length, 1);
  const innerRaw = Object.values(innerActual.rows[0])[0];
  assert.deepEqual(innerRaw, raw, 'Equivalent inner SELECT changed authorized fields/order/cursor/row set');
  const innerPlan = await actorQuery(db, variant, exactExplainPrefix + inner.parameterized, innerArgs,
    { innerQuery: true, planCacheMode, contextRecords });
  const parsedNotices = notices.map(notice => {
    const jsonText = notice.message.match(/\bplan:\s*([\s\S]+)$/)?.[1];
    if (!jsonText) return { ...notice, plan: null };
    try { return { ...notice, plan: JSON.parse(jsonText) }; }
    catch { return { ...notice, plan: null }; }
  });
  assert.ok(noticeCount <= 25000, 'Nested notices exceeded explicit bound; incomplete capture is not a pass');
  return { variant, planCacheMode, contextRecords, rawResult: raw, rawResultBytes: bytes,
    rawResultSha256: sha256(JSON.stringify(raw)), nextCursor: raw.nextCursor,
    exact: { sql: exactExplainPrefix + exactPhotoRpcSql, args, result: exactPlan.rows,
      qualification: 'Actual unchanged public function, authenticated role and exact JWT GUC, read-only transaction' },
    inner: { ...inner, args: innerArgs, result: innerPlan.rows, rawResultParity: true },
    nested: { requested: nested, noticeCount, notices: parsedNotices,
      metadataHelperCandidateNotices: parsedNotices.filter(notice => record(notice.plan) &&
        JSON.stringify(notice.plan).includes('private_object_bindings') &&
        JSON.stringify(notice.plan).includes('p_purpose')).length,
      qualification: 'Instrumentation only, not benchmark samples; inspect exact Query Text and nodes before attributing helper cost' } };
}

export function flattenExplainNodes(rawPlan) {
  const found = [];
  function visit(value, path) {
    if (Array.isArray(value)) { value.forEach((child, index) => visit(child, `${path}[${index}]`)); return; }
    if (!record(value)) return;
    if (typeof value['Node Type'] === 'string') {
      const actual = value['Actual Rows'], estimated = value['Plan Rows'];
      found.push({ path, ...value,
        actualEstimatedRatio: typeof actual === 'number' && typeof estimated === 'number' && estimated !== 0
          ? actual / estimated : null,
        Plans: undefined });
    }
    for (const [key, child] of Object.entries(value)) if (record(child) || Array.isArray(child)) visit(child, `${path}.${key}`);
  }
  visit(rawPlan, '$');
  return found;
}

/** Capture after primary warm distributions, before reset controls; never rewrite a warm gate result. */
export async function captureWorkerPhotoPlans({ db, fixture, report, save, onArtifact }) {
  assert.equal(typeof save, 'function');
  assert.equal(typeof onArtifact, 'function', 'Persist full plan artifacts separately; do not retain every notice in the summary');
  assert.ok(Array.isArray(report.summaries) && Array.isArray(report.productionFunctionDefinitions));
  const planReport = { phase: 'AFTER_ALL_PRIMARY_WARM_BEFORE_RESET_CONTROLS', result: 'INCOMPLETE', capability: null,
    engineLimitation: 'Single-user WASM backend; no true new PostgreSQL sessions or hosted-plan attestation',
    requested: [], artifacts: [], failures: [], nestedScope: null, catalogArtifact: null };
  report.planEvidence = planReport;
  const persist = async (name, value) => {
    const ref = await onArtifact(name, value);
    assert.ok(record(ref) && typeof ref.path === 'string' && typeof ref.sha256 === 'string');
    return ref;
  };
  try {
    const catalog = await capturePhotoCatalog(db);
    for (const frozen of report.productionFunctionDefinitions) {
      const current = catalog.functions.find(fn => fn.signature === frozen.signature);
      assert.ok(current, `Missing frozen function ${frozen.signature}`);
      assert.equal(current.definition, frozen.definition, `Function changed since timing: ${frozen.signature}`);
    }
    planReport.catalogArtifact = await persist('photo-plan-catalog', catalog);
    planReport.capability = await probeAutoExplain(db);
    await save();
    const eligible = report.summaries.filter(summary => record(summary.expected) &&
      summary.expected.actorAuthorized === true && Number.isFinite(summary.distributions?.warmApplicationRead?.p95Ms) &&
      Array.isArray(summary.samples) && summary.samples.length >= 35);
    assert.ok(eligible.length > 0, 'No role-correct measured query variants to explain');
    assert.ok(eligible.length <= 128, 'Explicit diagnostic variant bound exceeded');
    const worst = [...eligible].sort((left, right) =>
      right.distributions.warmApplicationRead.p95Ms - left.distributions.warmApplicationRead.p95Ms)[0];
    const sameWorstScope = eligible.filter(summary => summary.expected.actor === worst.expected.actor &&
      summary.expected.parent === worst.expected.parent);
    const first = sameWorstScope.find(summary => summary.expected.inputCursor === null && summary.expected.limit === 24) ??
      sameWorstScope.find(summary => summary.expected.inputCursor === null);
    const continuation = sameWorstScope.find(summary => summary.expected.inputCursor !== null &&
      summary.expected.limit === first?.expected.limit) ?? sameWorstScope.find(summary => summary.expected.inputCursor !== null);
    const nestedTargets = new Set([first, continuation].filter(Boolean));
    planReport.nestedScope = { slowestMeasured: { actor: worst.expected.actor, variant: worst.expected.variant,
      parent: worst.expected.parent, p95Ms: worst.distributions.warmApplicationRead.p95Ms },
      targets: [...nestedTargets].map(summary => ({ actor: summary.expected.actor, variant: summary.expected.variant,
        parent: summary.expected.parent, inputCursor: summary.expected.inputCursor, limit: summary.expected.limit })),
      continuationAvailable: Boolean(continuation),
      qualification: 'Actual nested instrumentation only for this representative first/continuation pair, after all primary warm variants and before reset controls; auto variants precede supplemental forced modes; not every variant or a retroactive plan trace of timed calls' };
    const canCaptureNested = planReport.capability.runtimeLoaded === true && planReport.capability.failure === null;
    const runOne = async (summary, mode, nested) => {
      const expected = summary.expected;
      const variant = { actor: fixture.actors[expected.actor], parent: expected.parent,
        limit: expected.limit, cursor: expected.inputCursor };
      const request = { actor: expected.actor, variant: expected.variant, parent: expected.parent,
        limit: expected.limit, inputCursor: expected.inputCursor, mode, nestedRequested: nested };
      planReport.requested.push(request);
      try {
        const result = await captureExactPhotoPlans(db, variant, catalog, { nested, planCacheMode: mode });
        const fixtureKey = `${expected.actor}:${expected.variant}`;
        assert.ok(Object.hasOwn(report.rawFixtures, fixtureKey), 'Timing raw result fixture missing');
        assert.deepEqual(result.rawResult, report.rawFixtures[fixtureKey], 'Plan result differs from actual measured raw RPC');
        result.expectedMeasuredPublic = { responseBytes: expected.responseBytes,
          resultSha256: expected.resultSha256, cursor: expected.cursor, hasMore: expected.hasMore };
        result.parentInputSha256 = sha256(JSON.stringify(variant));
        result.catalogDefinitionSha256 = catalog.definitionSha256;
        result.exact.nodes = flattenExplainNodes(result.exact.result);
        result.inner.nodes = flattenExplainNodes(result.inner.result);
        const name = `photo-plan-${String(planReport.artifacts.length + 1).padStart(2, '0')}-${mode}`;
        const artifact = await persist(name, result);
        planReport.artifacts.push({ ...request, artifact, result: 'EXACT_AND_INNER_CAPTURED',
          rawResultSha256: result.rawResultSha256, rawResultBytes: result.rawResultBytes,
          nestedNoticeCount: result.nested.noticeCount,
          nestedCandidateCount: result.nested.metadataHelperCandidateNotices,
          nestedProof: nested ? 'RAW_NOTICES_REQUIRE_QUERY_TEXT_AND_NODE_REVIEW' : 'NOT_REQUESTED' });
      } catch (error) { planReport.failures.push({ ...request, failure: errorFacts(error) }); }
      await save();
    };
    // All actually measured authorized variants get exact and inner plans.
    // The first/continuation representative alone gets full nested logging.
    for (const summary of eligible) await runOne(summary, 'auto', canCaptureNested && nestedTargets.has(summary));
    // Supplemental mode experiment only; it does not change primary measurements.
    for (const mode of ['force_custom_plan', 'force_generic_plan']) {
      for (const summary of nestedTargets) await runOne(summary, mode, canCaptureNested);
    }
    planReport.result = planReport.failures.length ? 'CAPTURE_COMPLETED_WITH_RETAINED_FAILURES' :
      canCaptureNested ? 'LOCAL_CAPTURE_COMPLETED_NOT_MIGRATION_APPROVAL' : 'LOCAL_CAPTURE_COMPLETED_NESTED_CAPABILITY_UNAVAILABLE';
  } catch (error) {
    planReport.result = 'PLAN_CAPTURE_INCOMPLETE';
    planReport.failures.push({ stage: 'catalog_or_capability_or_dispatch', failure: errorFacts(error) });
  }
  await save();
  return planReport;
}
