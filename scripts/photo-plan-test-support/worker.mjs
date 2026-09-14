// Test-only synthetic photo-read timing worker; no production implementation authority.
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir, platform, arch, release, cpus, totalmem } from 'node:os';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';

const moduleEntry = performance.now();
const supportImportStarted = performance.now();
const { root, sha256, publishedPath, publishedSha256, rpcName, rpcSql, bootPhotoFixture, loadRealFacade, recordFixtureFacts } =
  await import('/Users/nxs/projects/p1-demo/scripts/photo-plan-test-support/experiment.mjs');
const supportImportEnded = performance.now();
const summaryCorePath = '/Users/nxs/projects/p1-demo/src/lib/photo-plan-test-support/measurement.ts';
const { assertPhotoPlanArtifactName, summarizePhotoReadSamples } = await import(pathToFileURL(summaryCorePath));
const planProbePath = '/Users/nxs/projects/p1-demo/scripts/photo-plan-test-support/plans.mjs';
const { existingAutoExplainExtension, captureWorkerPhotoPlans } = await import(pathToFileURL(planProbePath));
assert.equal(process.cwd(), root);
const runIndex = Number(process.argv.find(arg => arg.startsWith('--process-index='))?.slice(16));
assert.ok(Number.isInteger(runIndex) && runIndex >= 1 && runIndex <= 5);
const output = mkdtempSync(join(tmpdir(), `p1-phase7c3p-photo-measured-${runIndex}-`));
const report = {
  version: 1, result: 'INCOMPLETE', output, runIndex, pid: process.pid, startedAt: new Date().toISOString(),
  engineScope: 'Synthetic isolated in-memory PGlite; no PostgREST, hosted SQL, provider Storage, or real customer data',
  source: { publishedPath, publishedSha256, summaryCorePath, summaryCoreSha256: sha256(readFileSync(summaryCorePath)),
    planProbePath, planProbeSha256: sha256(readFileSync(planProbePath)) }, sources: {},
  hardware: { node: process.version, platform: platform(), arch: arch(), osRelease: release(), cpuCount: cpus().length,
    cpuModel: cpus()[0]?.model ?? null, memoryBytes: totalmem() },
  phases: [{ name: 'process_to_module_entry_ms', elapsedMs: moduleEntry, start: 0, end: moduleEntry,
    qualification: 'Node performance timeline through this module entry, not parent-spawn wall clock' },
    { name: 'support_module_import_ms', elapsedMs: supportImportEnded - supportImportStarted, start: supportImportStarted, end: supportImportEnded }],
  methodology: {
    warmups: 5, measured: 30, percentile: 'nearest-rank', budgetMs: 500, outlierTrimming: false,
    productionBoundary: 'Original public db.ts loadWorkOrderPhotosPage + boundedReadRpc; only Supabase transport injected',
    originalSessionBoundary: 'Unchanged fixture.read/actorTransactions retained, instrumented by db/tx proxy without moving role setup',
    applicationRead: 'Exact authorized tx.query dispatch through real facade result return: RPC/materialization + COMMIT + mapper/current construction',
    initializedReadTotal: 'Real facade invocation through return; contains genuine session setup and application read, excludes serialization/bootstrap',
    sessionSetup: 'Facade invocation through exact tx.query dispatch; includes BEGIN, role/JWT/read-only setup plus separately itemized pre-dispatch overhead',
    rpcCall: 'Exact authorized tx.query dispatch through installed-client raw result; SQL vs client decode not separately observable here',
    serialization: 'JSON.stringify only, measured separately; byte counting and SHA after timer',
    cache: 'Default plan_cache_mode auto for all primary runs; official dense fixture and ANALYZE precede first photo RPC; no historical-photo priming',
    freshProcess: 'Fresh Node process and newly created in-memory PGlite database; NOT physical disk/OS-cache cold',
    trueNewSessions: { result: 'UNAVAILABLE', reason: 'Installed PGlite is single-user/single-connection; no native local PostgreSQL or running local Docker engine verified',
      resetDiagnosticsAreSubstitute: false },
    mainGate: 'Only same_session_warm measured applicationReadMs is compared against unchanged <=500 ms; cold/reset diagnostics are separate',
  },
  samples: [], summaries: [], unsupportedVariants: [], correctness: [], resets: [], failures: [], publicFixtures: {}, rawFixtures: {},
};
const frozenDenseReference = {
  source: '/private/tmp/p1-7c3-photo-cold-diagnostic-Q4IRK1/evidence.json',
  first: { responseBytes: 1428, resultSha256: '70453efd0dd1815ba7a8fbf8f8a75204328cf969cf2fd3087cbb9ecda6600a47',
    cursor: 'eyJpZCI6ICJhODEwMDAwMC0wMDAwLTQwMDAtODAwMC0wMDAwMDAwMDAwODEiLCAiY3JlYXRlZCI6ICIyMDI2LTA5LTA1VDA4OjAwOjI3KzA4OjAwIn0', hasMore: true },
  continuation: { responseBytes: 1423, resultSha256: '177fdc8dc4005bb657f829c1596295eb75800774af2dba972afea243d0f11dd0',
    cursor: 'eyJpZCI6ICJhODEwMDAwMC0wMDAwLTQwMDAtODAwMC0wMDAwMDAwMDAwNTciLCAiY3JlYXRlZCI6ICIyMDI2LTA5LTA1VDA4OjAwOjE5KzA4OjAwIn0', hasMore: true },
};
report.contractReference = { ...frozenDenseReference, sourceSha256: sha256(readFileSync(frozenDenseReference.source)),
  purpose: 'Frozen public bytes/hash/cursor parity oracle only; no prior timing or test totals reused' };
const evidenceFile = join(output, 'evidence.json');
const save = () => writeFileSync(evidenceFile, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
const sampleRef = { current: null };
let database, fixture, workOrderId, facade, actorId, actorName;
const signal = new AbortController().signal;
const phase = async (name, run) => {
  const start = performance.now();
  try { return await run(); }
  finally { const end = performance.now(); report.phases.push({ name, start, end, elapsedMs: end - start }); save(); }
};
const transport = { rpc(name, args) {
  assert.equal(name, rpcName);
  assert.deepEqual(Object.keys(args).sort(), ['p_cursor', 'p_limit', 'p_work_order_id']);
  const request = { abortSignal(value) { assert.equal(value, signal); return request; }, async then(fulfilled) {
    signal.throwIfAborted();
    const sample = sampleRef.current;
    assert.ok(sample, 'All production reads require a recorded sample, including warmups and correctness reads');
    sample.queryLog.push({ name, args: structuredClone(args), requestSignalIdentityPreserved: true });
    sample.transportEntered = performance.now();
    try {
      const raw = await fixture.read(actorId, rpcSql, [args.p_work_order_id, args.p_limit, args.p_cursor]);
      sample.transportResolved = performance.now();
      sample.rawResult = raw.rows[0]?.result;
      return fulfilled({ data: sample.rawResult, error: null });
    } catch (error) {
      sample.transportResolved = performance.now();
      return fulfilled({ data: null, error });
    }
  } }; return request;
} };
const finiteDuration = (end, start) => typeof end === 'number' && typeof start === 'number' ? end - start : null;
const sum = items => items.reduce((total, item) => total + item.elapsedMs, 0);
function finalizeTiming(sample) {
  sample.sessionSetupMs = finiteDuration(sample.rpcStart, sample.facadeStart);
  sample.rpcCallMs = finiteDuration(sample.rpcEnd, sample.rpcStart);
  sample.applicationReadMs = finiteDuration(sample.facadeEnd, sample.rpcStart);
  sample.initializedReadTotalMs = finiteDuration(sample.facadeEnd, sample.facadeStart);
  sample.facadeInclusiveMs = sample.initializedReadTotalMs;
  sample.serializationMs = finiteDuration(sample.serializationEnd, sample.serializationStart);
  sample.roleAndClaimSetupMs = sum(sample.transportStatements.filter(item => ['role_setup', 'claim_setup'].includes(item.kind)));
  sample.readOnlySetupMs = sum(sample.transportStatements.filter(item => item.kind === 'read_only_setup'));
  sample.transactionBeginMs = finiteDuration(sample.transactionEntered, sample.transactionStart);
  sample.transactionCommitMs = finiteDuration(sample.transactionEnd, sample.transactionCallbackEnd);
  sample.mappingAfterTransportMs = finiteDuration(sample.facadeEnd, sample.transportResolved);
  sample.queryCount = sample.queryLog.length;
  sample.countQueryCount = sample.queryLog.filter(item => /count/i.test(item.name)).length;
}
async function attempt(category, samplePhase, variant, sampleIndex) {
  actorName = variant.actor; actorId = fixture.actors[actorName]; assert.ok(actorId);
  const sample = { runIndex, category, phase: samplePhase, actor: actorName, variant: variant.name,
    sessionIdentity: `${process.pid}:instance1:backend${report.engine.backend_pid}`,
    parent: variant.parent, inputCursor: variant.cursor ?? null, limit: variant.limit ?? 24, sampleIndex,
    status: 'pending', queryLog: [], transportStatements: [], responseBytes: null, resultSha256: null,
    cursor: null, hasMore: null, failure: null };
  sampleRef.current = sample; sample.facadeStart = performance.now();
  let value;
  try {
    value = await facade.loadWorkOrderPhotosPage(variant.parent, variant.cursor ?? null, variant.limit ?? 24, signal);
    sample.facadeEnd = performance.now();
    sample.serializationStart = performance.now(); const payload = JSON.stringify(value); sample.serializationEnd = performance.now();
    sample.responseBytes = Buffer.byteLength(payload); sample.resultSha256 = sha256(payload);
    sample.cursor = value.nextCursor; sample.hasMore = value.hasMore; sample.itemCount = value.items.length;
    const fixtureKey = `${variant.actor}:${variant.name}`;
    report.publicFixtures[fixtureKey] ??= value;
    report.rawFixtures[fixtureKey] ??= sample.rawResult;
    sample.rawResultSha256 = sha256(JSON.stringify(sample.rawResult));
    assert.equal(sample.queryLog.length, 1); assert.equal(value.totalCount, null);
    assert.deepEqual(sample.transportStatements.map(item => item.kind), ['role_setup', 'claim_setup', 'read_only_setup', 'authorized_rpc']);
    assert.equal(sample.transportStatements[0].sql, 'set local role authenticated');
    assert.deepEqual(sample.transportStatements[1].params, ['authenticated', actorId]);
    assert.deepEqual(sample.transportStatements[3].params, [variant.parent, variant.limit ?? 24, variant.cursor ?? null]);
    sample.roleEquivalentExecution = { databaseRole: 'authenticated', claimRole: 'authenticated', claimSub: actorId,
      exactRoleAndClaimsRecorded: true, actorContextInferredFromLabelOnly: false };
    assert.ok(Array.isArray(value.items) && value.items.every(path => typeof path === 'string'));
    assert.ok(value.items.every(path => path.startsWith(`wo/${variant.parent}/`) || path === `wo/${variant.parent}`));
    if (variant.expectedEmpty) assert.deepEqual(value.items, []);
    if (variant.requireCanonicalLegacy) {
      assert.ok(value.items.includes(`wo/${variant.parent}/a8100000-0000-4000-8000-000000000201`));
      assert.ok(value.items.includes(`wo/${variant.parent}`));
    }
    if (variant.parent === workOrderId(2) && (variant.limit ?? 24) === 24 &&
      ((variant.cursor ?? null) === null || variant.cursor === frozenDenseReference.first.cursor) && !variant.expectedEmpty) {
      const expected = variant.cursor ? frozenDenseReference.continuation : frozenDenseReference.first;
      for (const name of ['responseBytes', 'resultSha256', 'cursor', 'hasMore']) assert.equal(sample[name], expected[name], `Frozen dense ${name}`);
    }
    sample.status = 'success';
  } catch (error) {
    sample.facadeEnd ??= performance.now(); sample.status = 'failure';
    sample.failure = { name: error instanceof Error ? error.name : 'UnknownFailure', message: error instanceof Error ? error.message : String(error),
      code: typeof error?.code === 'string' ? error.code : null, stack: error instanceof Error ? error.stack : null };
    report.failures.push({ category, phase: samplePhase, actor: actorName, variant: variant.name, sampleIndex, ...sample.failure });
  } finally {
    finalizeTiming(sample); delete sample.rawResult; sampleRef.current = null; report.samples.push(sample); save();
  }
  return sample.status === 'success' ? value : null;
}
async function warmVariant(variant) {
  // This explicit, retained characterization read is outside the warm sample group.
  // It is not used to infer authorization: official SQL role/scope assertions below
  // independently require exact counts and current canonical/legacy visibility.
  const expectedValue = await attempt('correctness_only', 'diagnostic', variant, 0);
  const expectedSample = report.samples.at(-1);
  const expectedCount = variant.expectedEmpty ? 0 : variant.parent === workOrderId(2)
    ? variant.cursor ? (variant.limit === 100 ? 5 : 24) : (variant.limit === 100 ? 100 : 24)
    : variant.parent === workOrderId(22) ? (variant.actor === 'manager' ? 16 : 14) : variant.parent === workOrderId(1) ? 1 : null;
  const roleEquivalentCorrectness = expectedValue !== null && expectedCount !== null && expectedValue.items.length === expectedCount;
  report.correctness.push({ actor: variant.actor, variant: variant.name, parent: variant.parent,
    expectedCount, actualCount: expectedValue?.items.length ?? null,
    result: roleEquivalentCorrectness ? 'PASS' : 'FAIL',
    contract: 'Frozen official fixture and existing photo SQL smoke actor/assignment/current timestamp-cutoff visibility assertions' });
  for (let index = 0; index < 35; index++) await attempt('same_session_warm', index < 5 ? 'warmup' : 'measured', variant, index);
  const samples = report.samples.filter(item => item.category === 'same_session_warm' && item.actor === variant.actor && item.variant === variant.name);
  const summary = summarizePhotoReadSamples({ identity: {
    fixtureSha256: report.fixtureIdentity, productionFunctionSha256: report.productionFunctionSha256, fixtureRows: report.scale },
  samplingPlan: { warmups: 5, measured: 30, sessionIdentity: `${process.pid}:instance1:backend${report.engine.backend_pid}` },
  expected: { actor: variant.actor, variant: variant.name, parent: variant.parent, inputCursor: variant.cursor ?? null,
    limit: variant.limit ?? 24, actorAuthorized: roleEquivalentCorrectness,
    responseBytes: expectedSample.responseBytes ?? 0, resultSha256: expectedSample.resultSha256 ?? '',
    cursor: expectedSample.cursor, hasMore: expectedSample.hasMore ?? false }, samples });
  summary.actor = variant.actor; summary.variant = variant.name;
  report.summaries.push(summary); save();
  console.log(JSON.stringify({ phase: 'warm_variant_complete', actor: summary.actor, variant: summary.variant,
    measured: summary.measuredCount, p50Ms: summary.distributions.warmApplicationRead?.p50Ms,
    p95Ms: summary.distributions.warmApplicationRead?.p95Ms, passed: summary.passed, issues: summary.issues }));
  return expectedValue;
}
async function warmActor(actor, parent, emptyParent, includeLegacy = false) {
  const first = await warmVariant({ actor, parent, name: 'default_first_page', requireCanonicalLegacy: includeLegacy });
  const maximum = await warmVariant({ actor, parent, name: 'maximum_first_page', limit: 100, requireCanonicalLegacy: includeLegacy });
  for (const [name, page, limit] of [['default_continuation', first, 24], ['maximum_continuation', maximum, 100]]) {
    if (page?.hasMore && page.nextCursor) await warmVariant({ actor, parent, name, cursor: page.nextCursor, limit });
    else report.unsupportedVariants.push({ actor, parent, name, reason: 'No continuation exists in unchanged official authorized fixture; cursor not fabricated' });
  }
  await warmVariant({ actor, parent: emptyParent, name: 'empty_parent', expectedEmpty: true });
}

try {
  save(); console.log(JSON.stringify({ phase: 'worker_started', runIndex, output }));
  const boot = await bootPhotoFixture({ report, phase, sampleRef,
    databaseOptions: { additionalExtensions: { auto_explain: existingAutoExplainExtension() } } });
  database = boot.db; fixture = boot.fixture; workOrderId = boot.workOrderId;
  await phase('production_facade_import_transpile_ms', async () => { facade = loadRealFacade(transport, report); });
  const coldFirst = await attempt('fresh_process_cold', 'cold', { actor: 'manager', parent: workOrderId(2), name: 'default_first_page' }, 0);
  if (coldFirst?.hasMore && coldFirst.nextCursor) await attempt('fresh_process_cold', 'cold', {
    actor: 'manager', parent: workOrderId(2), name: 'default_continuation', cursor: coldFirst.nextCursor }, 0);
  else report.unsupportedVariants.push({ category: 'fresh_process_cold', name: 'default_continuation', reason: 'Initial read failed or supplied no cursor; never fabricate cursor' });
  // Every fresh DB repeats the heavy pair under default plan_cache_mode auto, not just its first-call observation.
  if (runIndex === 1) {
    await warmActor('manager', workOrderId(2), workOrderId(30002));
    await warmActor('companyAdmin', workOrderId(2), workOrderId(30002));
    await warmActor('technician', workOrderId(2), workOrderId(30002));
    await warmActor('reportTechnician', workOrderId(22), workOrderId(30007), true);
    await warmActor('contractor', workOrderId(1), workOrderId(30001));
    await warmVariant({ actor: 'manager', parent: workOrderId(22), name: 'canonical_and_reviewed_two_segment_first_page', requireCanonicalLegacy: true });
    await warmVariant({ actor: 'companyAdmin', parent: workOrderId(22), name: 'canonical_and_reviewed_two_segment_first_page', requireCanonicalLegacy: true });
  } else {
    const first = await warmVariant({ actor: 'manager', parent: workOrderId(2), name: 'default_first_page' });
    if (first?.hasMore && first.nextCursor) await warmVariant({ actor: 'manager', parent: workOrderId(2), name: 'default_continuation', cursor: first.nextCursor });
  }
  if (runIndex === 1) {
    // The installed bundle was merely registered during bootstrap. LOAD and all
    // plan instrumentation happen now, AFTER primary auto-mode timings, BEFORE resets.
    await phase('post_primary_plan_evidence_ms', () => captureWorkerPhotoPlans({ db: boot.realDb, fixture, report, save,
      onArtifact(name, value) {
        assertPhotoPlanArtifactName(name);
        const file = join(output, `${name}.json`), text = `${JSON.stringify(value, null, 2)}\n`;
        writeFileSync(file, text, { flag: 'wx', mode: 0o600 });
        return { path: file, sha256: sha256(text), bytes: Buffer.byteLength(text) };
      } }));
    // Supplemental SAME-backend reset observation, explicitly not ten true new sessions.
    for (let index = 0; index < 10; index++) {
      const start = performance.now();
      try {
        await database.exec('discard plans');
        report.resets.push({ index, status: 'success', elapsedMs: performance.now() - start,
          label: 'same_backend_discard_plans_NOT_NEW_SESSION', backend: report.engine.backend_pid,
          priorHistory: 'After primary warm matrix, exact/inner/nested plan capture and supplemental forced custom/generic local transactions; auto mode restored, cache history not pristine' });
        const first = await attempt('same_backend_reset_diagnostic', 'diagnostic', { actor: 'manager', parent: workOrderId(2), name: 'default_first_page' }, index);
        if (first?.hasMore && first.nextCursor) await attempt('same_backend_reset_diagnostic', 'diagnostic', {
          actor: 'manager', parent: workOrderId(2), name: 'default_continuation', cursor: first.nextCursor }, index);
      } catch (error) {
        report.resets.push({ index, status: 'failure', elapsedMs: performance.now() - start, message: error instanceof Error ? error.message : String(error) });
      }
      save();
    }
    for (const actor of ['inactive', 'formerTechnician', 'otherCompany']) {
      const result = await attempt('correctness_only', 'diagnostic', { actor, parent: workOrderId(2), name: 'denied_metadata', expectedEmpty: true }, 0);
      report.correctness.push({ actor, result: result && result.items.length === 0 ? 'PASS' : 'FAIL', classification: 'Correctness, never substitute for authorized performance' });
    }
  }
  // Plans/statistics cannot prime the primary measurements: capture only after all of them.
  await phase('fixture_statistics_evidence_ms', () => recordFixtureFacts(database, report));
  const slowest = [...report.summaries].filter(item => item.distributions.warmApplicationRead)
    .sort((left, right) => right.distributions.warmApplicationRead.p95Ms - left.distributions.warmApplicationRead.p95Ms)[0];
  report.slowestMeasuredAuthorized = slowest ? { actor: slowest.actor, variant: slowest.variant,
    p95Ms: slowest.distributions.warmApplicationRead.p95Ms } : null;
  report.warmGate = report.summaries.length > 0 && report.summaries.every(item => item.passed) ? 'PASS' : 'FAIL';
  report.result = report.failures.length ? 'MEASUREMENT_COMPLETED_WITH_RETAINED_FAILURES' : 'MEASUREMENT_COMPLETED';
} catch (error) {
  report.result = 'EXPERIMENT_EXECUTION_FAILED'; report.failures.push({ name: error instanceof Error ? error.name : 'UnknownFailure',
    message: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : null });
  process.exitCode = 1;
} finally {
  sampleRef.current = null;
  if (database) await phase('database_shutdown_ms', () => database.close());
  report.completedAt = new Date().toISOString(); report.processObservedTotalMs = performance.now();
  for (const recorded of report.phases) {
    if (recorded.name.includes('fixture_load_including_scoped_analyze')) {
      recorded.embeddedAnalyzeMs = report.phases.filter(item => item.name === 'analyze_statistics_ms' && item.start >= recorded.start && item.end <= recorded.end)
        .reduce((total, item) => total + item.elapsedMs, 0);
      recorded.fixtureLoadExcludingAnalyzeMs = recorded.elapsedMs - recorded.embeddedAnalyzeMs;
      recorded.additiveAccounting = 'Use fixtureLoadExcludingAnalyzeMs plus embeddedAnalyzeMs, not this inclusive duration plus ANALYZE again';
    }
  }
  report.sourceStillFrozen = sha256(readFileSync(publishedPath)) === publishedSha256;
  if (!report.sourceStillFrozen) { report.result = 'SOURCE_CHANGED_DURING_EXPERIMENT'; process.exitCode = 1; }
  save(); console.log(JSON.stringify({ result: report.result, warmGate: report.warmGate, runIndex, output }));
}
