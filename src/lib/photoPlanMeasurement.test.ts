import assert from "node:assert/strict";
import test from "node:test";
import { assertPhotoPlanArtifactName, decomposePhotoPhaseMarkers, photoDistribution, summarizePhotoReadSamples,
  type PhotoReadMeasurementSample, type PhotoPhaseMarkers } from "./photo-plan-test-support/measurement";

const identity = { fixtureSha256: "a".repeat(64), productionFunctionSha256: "b".repeat(64),
  fixtureRows: { work_orders: 50000, photos: 25122, private_object_bindings: 25121 } };
const expected = { actor: "manager", variant: "default_first", parent: "SYNTHETIC-PERF-000002",
  inputCursor: null, limit: 24, actorAuthorized: true, responseBytes: 1428,
  resultSha256: "c".repeat(64), cursor: "synthetic-existing-cursor", hasMore: true };
const samplingPlan = { warmups: 5, measured: 30, sessionIdentity: "synthetic-process-1:engine-1:backend-42" };
function sample(sampleIndex: number, patch: Partial<PhotoReadMeasurementSample> = {}): PhotoReadMeasurementSample {
  return { category: "same_session_warm", phase: sampleIndex < 5 ? "warmup" : "measured",
    actor: expected.actor, variant: expected.variant, parent: expected.parent,
    inputCursor: expected.inputCursor, limit: expected.limit, sampleIndex, sessionIdentity: samplingPlan.sessionIdentity, status: "success",
    sessionSetupMs: 2, rpcCallMs: 20, applicationReadMs: 22, initializedReadTotalMs: 24,
    serializationMs: 1, responseBytes: expected.responseBytes, resultSha256: expected.resultSha256,
    cursor: expected.cursor, hasMore: expected.hasMore, queryCount: 1, countQueryCount: 0, ...patch };
}
const samples = () => Array.from({ length: 35 }, (_, index) => sample(index));
const summarize = (rows: readonly PhotoReadMeasurementSample[]) => summarizePhotoReadSamples({ identity, expected, samplingPlan, samples: rows });

for (const name of ["photo-plan-11-auto", "photo-plan-24-force_custom_plan", "photo-plan-25-force_generic_plan"]) {
  test(`photo plan artifact filename accepts actual producer name ${name}`, () => {
    assert.doesNotThrow(() => assertPhotoPlanArtifactName(name));
  });
}
for (const [label, value] of [
  ["traversal", "photo-plan-../outside"], ["slash", "photo-plan-1/auto"],
  ["backslash", "photo-plan-1\\auto"], ["non-string", 24], ["missing suffix", "photo-plan-"],
] as const) {
  test(`photo plan artifact filename rejects ${label}`, () => {
    assert.throws(() => assertPhotoPlanArtifactName(value), { message: "Invalid photo plan artifact name" });
  });
}

test("photo measurement retains five warmups but excludes them from thirty measured samples", () => {
  const rows = samples().map(row => row.phase === "warmup"
    ? { ...row, rpcCallMs: 5000, applicationReadMs: 5002, initializedReadTotalMs: 5004 } : row);
  const result = summarize(rows);
  assert.equal(result.passed, true);
  assert.equal(result.samples.length, 35);
  assert.equal(result.warmupCount, 5);
  assert.equal(result.distributions.warmApplicationRead?.count, 30);
  assert.equal(result.distributions.warmApplicationRead?.p95Ms, 22);
});

for (const [name, mutation, code] of [
  ["missing measured sample", (rows: PhotoReadMeasurementSample[]) => rows.slice(0, -1), "INSUFFICIENT_MEASURED_SAMPLES"],
  ["missing warmup", (rows: PhotoReadMeasurementSample[]) => rows.slice(1), "INSUFFICIENT_WARMUPS"],
  ["mixed cold category", (rows: PhotoReadMeasurementSample[]) => [sample(0, { category: "fresh_process_cold" }), ...rows.slice(1)], "MIXED_MEASUREMENT_CATEGORIES"],
  ["reset transaction is not a new session or warm sample", (rows: PhotoReadMeasurementSample[]) => [sample(0, { category: "same_backend_reset_diagnostic" }), ...rows.slice(1)], "MIXED_MEASUREMENT_CATEGORIES"],
  ["late warmup", (rows: PhotoReadMeasurementSample[]) => [...rows.slice(1), rows[0]], "WARMUP_AFTER_MEASURED_SAMPLE"],
  ["duplicate sample", (rows: PhotoReadMeasurementSample[]) => [...rows, rows[5]], "INVALID_OR_DUPLICATE_SAMPLE_INDEX"],
  ["missing interior sample replaced by later sample", (rows: PhotoReadMeasurementSample[]) => [...rows.slice(0, 10), ...rows.slice(11), sample(35)], "NONCONTIGUOUS_OR_REORDERED_SAMPLES"],
] satisfies readonly [string, (rows: PhotoReadMeasurementSample[]) => PhotoReadMeasurementSample[], string][]) {
  test(`photo measurement rejects ${name}`, () => {
    const result = summarize(mutation(samples()));
    assert.equal(result.passed, false);
    assert.ok(result.issues.includes(code));
  });
}

for (const [name, patch, code] of [
  ["timeout", { status: "failure", rpcCallMs: null, applicationReadMs: null }, "FAILED_SAMPLE_RETAINED"],
  ["query result hash", { resultSha256: "d".repeat(64) }, "RESULT_PARITY_MISMATCH"],
  ["response bytes", { responseBytes: 1429 }, "RESULT_PARITY_MISMATCH"],
  ["cursor", { cursor: "different-cursor" }, "RESULT_PARITY_MISMATCH"],
  ["hasMore", { hasMore: false }, "RESULT_PARITY_MISMATCH"],
  ["actor", { actor: "otherCompany" }, "QUERY_IDENTITY_MISMATCH"],
  ["parent", { parent: "SYNTHETIC-FOREIGN-PARENT" }, "QUERY_IDENTITY_MISMATCH"],
  ["input cursor", { inputCursor: "foreign-position" }, "QUERY_IDENTITY_MISMATCH"],
  ["page limit", { limit: 25 }, "QUERY_IDENTITY_MISMATCH"],
  ["spliced session", { sessionIdentity: "synthetic-process-2:engine-2:backend-42" }, "SESSION_IDENTITY_MISMATCH"],
  ["second query", { queryCount: 2 }, "ONE_RPC_ZERO_COUNT_VIOLATION"],
  ["count query", { countQueryCount: 1 }, "ONE_RPC_ZERO_COUNT_VIOLATION"],
  ["negative time", { rpcCallMs: -1 }, "INVALID_MEASUREMENT_TIME"],
  ["nonfinite time", { applicationReadMs: Number.POSITIVE_INFINITY }, "INVALID_MEASUREMENT_TIME"],
  ["excluded RPC work", { applicationReadMs: 19, initializedReadTotalMs: 21 }, "INVALID_TIMING_BOUNDARIES"],
  ["double-counted session setup", { initializedReadTotalMs: 26 }, "INVALID_TIMING_BOUNDARIES"],
] satisfies readonly [string, Partial<PhotoReadMeasurementSample>, string][]) {
  test(`photo measurement fails safely for ${name} without dropping the sample`, () => {
    const rows = samples(); rows[10] = sample(10, patch);
    const result = summarize(rows);
    assert.equal(result.passed, false);
    assert.ok(result.issues.includes(code));
    assert.equal(result.samples.length, 35);
    assert.equal(result.measuredCount, 30);
    assert.equal(result.distributions.warmApplicationRead, null);
  });
}

test("photo measurement refuses to count a denied actor as a fast authorized read", () => {
  const result = summarizePhotoReadSamples({ identity, expected: { ...expected, actorAuthorized: false }, samplingPlan, samples: samples() });
  assert.equal(result.passed, false);
  assert.ok(result.issues.includes("UNAUTHORIZED_ACTOR_IS_NOT_A_PERFORMANCE_PASS"));
});
test("photo measurement rejects missing function/fixture identity", () => {
  const result = summarizePhotoReadSamples({ identity: { ...identity, productionFunctionSha256: "" }, expected, samplingPlan, samples: samples() });
  assert.equal(result.passed, false);
  assert.ok(result.issues.includes("INVALID_EXPERIMENT_IDENTITY"));
});
test("photo measurement cannot drop attempted samples when thirty successful samples remain", () => {
  const result = summarizePhotoReadSamples({ identity, expected, samplingPlan: { ...samplingPlan, measured: 50 }, samples: samples() });
  assert.equal(result.passed, false);
  assert.ok(result.issues.includes("DECLARED_SAMPLE_COUNT_MISMATCH"));
});
test("photo measurement enforces the unchanged 500ms application-read p95", () => {
  const rows = samples().map(row => ({ ...row, rpcCallMs: 490, applicationReadMs: 501, initializedReadTotalMs: 503 }));
  const result = summarize(rows);
  assert.equal(result.passed, false);
  assert.deepEqual(result.issues, ["WARM_APPLICATION_READ_OVER_BUDGET"]);
  assert.equal(result.distributions.warmRpc?.p95Ms, 490);
  assert.equal(result.distributions.warmApplicationRead?.p95Ms, 501);
  assert.equal(result.budgetMs, 500);
});
test("photo measurement accepts the exact 500ms boundary without rounding", () => {
  const rows = samples().map(row => ({ ...row, rpcCallMs: 490, applicationReadMs: 500, initializedReadTotalMs: 502 }));
  assert.equal(summarize(rows).passed, true);
});
test("photo measurement does not trim slow outliers or mutate input", () => {
  const rows = samples(); rows[34] = sample(34, { rpcCallMs: 8998, applicationReadMs: 9000, initializedReadTotalMs: 9002 });
  const before = structuredClone(rows);
  const result = summarize(rows);
  assert.equal(result.distributions.warmApplicationRead?.maximumMs, 9000);
  assert.equal(result.distributions.warmApplicationRead?.samples.at(-1), 9000);
  assert.deepEqual(rows, before);
});
test("photo percentiles use nearest rank and preserve original raw order", () => {
  assert.deepEqual(photoDistribution([30, 10, 20]), { samples: [30, 10, 20], count: 3,
    minimumMs: 10, p50Ms: 20, p95Ms: 30, maximumMs: 30 });
  assert.throws(() => photoDistribution([]));
  assert.throws(() => photoDistribution([Number.NaN]));
});

const markers: PhotoPhaseMarkers = { commandStart: 0, processEntry: 10, importsComplete: 30,
  engineReady: 100, migrationsComplete: 300, fixtureComplete: 1300, statisticsComplete: 1400,
  sessionReady: 1402, rpcComplete: 1422, mappingComplete: 1424, serializationComplete: 1427, commandComplete: 1430 };
test("photo phase accounting separates every bootstrap category and reports full command duration", () => {
  assert.deepEqual(decomposePhotoPhaseMarkers(markers), { coldProcess: 10, moduleImport: 20,
    databaseBootstrap: 1370, databaseEngineStart: 70, migrationApply: 200, fixtureLoad: 1000,
    analyzeStatistics: 100, sessionSetup: 2, warmRpc: 20, mapping: 2, warmApplicationRead: 22,
    serialization: 3, initializedReadTotal: 24, completeCommand: 1430 });
});
for (const delayed of ["migrationsComplete", "fixtureComplete"] as const) {
  test(`photo phase accounting excludes injected ${delayed} delay from warm RPC/application gate`, () => {
    const keys: readonly (keyof PhotoPhaseMarkers)[] = ["commandStart", "processEntry", "importsComplete", "engineReady",
      "migrationsComplete", "fixtureComplete", "statisticsComplete", "sessionReady", "rpcComplete", "mappingComplete",
      "serializationComplete", "commandComplete"];
    const changed = { ...markers }; let addDelay = false;
    for (const key of keys) { if (key === delayed) addDelay = true; if (addDelay) changed[key] += 10000; }
    const result = decomposePhotoPhaseMarkers(changed);
    assert.equal(result.warmRpc, 20); assert.equal(result.warmApplicationRead, 22);
    assert.equal(result.completeCommand, 11430);
  });
}
test("photo phase accounting includes validation/mapping rather than substituting SQL-only latency", () => {
  const result = decomposePhotoPhaseMarkers({ ...markers, mappingComplete: 2024, serializationComplete: 2027, commandComplete: 2030 });
  assert.equal(result.warmRpc, 20); assert.equal(result.warmApplicationRead, 622);
});
test("photo phase accounting reports slow session setup separately without hiding initialized-read cost", () => {
  const result = decomposePhotoPhaseMarkers({ ...markers, sessionReady: 11402, rpcComplete: 11422,
    mappingComplete: 11424, serializationComplete: 11427, commandComplete: 11430 });
  assert.equal(result.sessionSetup, 10002);
  assert.equal(result.warmApplicationRead, 22);
  assert.equal(result.initializedReadTotal, 10024);
  assert.equal(result.completeCommand, 11430);
});
test("photo phase accounting rejects nonmonotonic or incomplete observations", () => {
  assert.throws(() => decomposePhotoPhaseMarkers({ ...markers, fixtureComplete: 20 }));
  assert.throws(() => decomposePhotoPhaseMarkers({ ...markers, rpcComplete: Number.NaN }));
});
