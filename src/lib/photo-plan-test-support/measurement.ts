/** Test-only accounting. It never connects to a database or changes a query. */
export const PHOTO_WARM_P95_BUDGET_MS = 500;
export const PHOTO_MINIMUM_WARMUPS = 5;
export const PHOTO_MINIMUM_MEASURED_SAMPLES = 30;

/** Safe basename for exact-plan artifacts, including PostgreSQL plan_cache_mode names. */
export function assertPhotoPlanArtifactName(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^photo-plan-[a-z0-9_-]+$/.test(value)) {
    throw new Error("Invalid photo plan artifact name");
  }
}

export type PhotoMeasurementCategory =
  | "fresh_process_cold"
  | "same_session_warm"
  | "same_backend_reset_diagnostic";

export interface PhotoReadMeasurementSample {
  readonly category: PhotoMeasurementCategory;
  readonly phase: "cold" | "warmup" | "measured" | "diagnostic";
  readonly actor: string;
  readonly variant: string;
  readonly parent: string;
  readonly inputCursor: string | null;
  readonly limit: number;
  readonly sampleIndex: number;
  /** Engine instance/process + observed backend, not a fabricated new session. */
  readonly sessionIdentity: string;
  readonly status: "success" | "failure";
  readonly sessionSetupMs: number | null;
  readonly rpcCallMs: number | null;
  readonly applicationReadMs: number | null;
  readonly initializedReadTotalMs: number | null;
  readonly serializationMs: number | null;
  readonly responseBytes: number | null;
  readonly resultSha256: string | null;
  readonly cursor: string | null;
  readonly hasMore: boolean | null;
  readonly queryCount: number;
  readonly countQueryCount: number;
}

export interface PhotoReadExpectedResult {
  readonly actor: string;
  readonly variant: string;
  readonly parent: string;
  readonly inputCursor: string | null;
  readonly limit: number;
  /** Established by separate role-equivalent correctness checks, not by latency. */
  readonly actorAuthorized: boolean;
  readonly responseBytes: number;
  readonly resultSha256: string;
  readonly cursor: string | null;
  readonly hasMore: boolean;
}

export interface PhotoExperimentIdentity {
  readonly fixtureSha256: string;
  readonly productionFunctionSha256: string;
  readonly fixtureRows: Readonly<Record<string, number>>;
}

export interface PhotoSamplingPlan {
  readonly warmups: number;
  readonly measured: number;
  readonly sessionIdentity: string;
}

export interface PhotoDistribution {
  readonly samples: readonly number[];
  readonly count: number;
  readonly minimumMs: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly maximumMs: number;
}

const finiteTime = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;
const integer = (value: unknown): value is number => finiteTime(value) && Number.isSafeInteger(value);
const hash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);

/** Nearest rank; original order and all outliers are retained in samples. */
export function photoDistribution(values: readonly number[]): PhotoDistribution {
  if (!values.length || Array.from(values).some(value => !finiteTime(value))) throw new Error("Invalid measurement samples");
  const ordered = [...values].sort((left, right) => left - right);
  const rank = (fraction: number) => ordered[Math.ceil(ordered.length * fraction) - 1];
  return { samples: [...values], count: values.length, minimumMs: ordered[0],
    p50Ms: rank(0.5), p95Ms: rank(0.95), maximumMs: ordered[ordered.length - 1] };
}

/** Bootstrap costs are reported but never input to the initialized-read percentile. */
export function summarizePhotoReadSamples(input: {
  readonly identity: PhotoExperimentIdentity;
  readonly expected: PhotoReadExpectedResult;
  readonly samplingPlan: PhotoSamplingPlan;
  readonly samples: readonly PhotoReadMeasurementSample[];
}) {
  const { identity, expected, samplingPlan, samples } = input;
  const issues: string[] = [];
  const add = (code: string) => { if (!issues.includes(code)) issues.push(code); };
  if (!hash(identity.fixtureSha256) || !hash(identity.productionFunctionSha256)) add("INVALID_EXPERIMENT_IDENTITY");
  if (!Object.keys(identity.fixtureRows).length || Object.values(identity.fixtureRows).some(value => !integer(value))) {
    add("INVALID_FIXTURE_COUNTS");
  }
  if (!expected.actorAuthorized) add("UNAUTHORIZED_ACTOR_IS_NOT_A_PERFORMANCE_PASS");
  if (!hash(expected.resultSha256) || !integer(expected.responseBytes) || !expected.responseBytes) add("INVALID_EXPECTED_RESULT");
  const warmups = samples.filter(sample => sample.phase === "warmup");
  const measured = samples.filter(sample => sample.phase === "measured");
  if (!integer(samplingPlan.warmups) || !integer(samplingPlan.measured)
    || samplingPlan.warmups < PHOTO_MINIMUM_WARMUPS || samplingPlan.measured < PHOTO_MINIMUM_MEASURED_SAMPLES
    || !samplingPlan.sessionIdentity) add("INVALID_SAMPLING_PLAN");
  if (warmups.length !== samplingPlan.warmups || measured.length !== samplingPlan.measured) add("DECLARED_SAMPLE_COUNT_MISMATCH");
  if (warmups.length < PHOTO_MINIMUM_WARMUPS) add("INSUFFICIENT_WARMUPS");
  if (measured.length < PHOTO_MINIMUM_MEASURED_SAMPLES) add("INSUFFICIENT_MEASURED_SAMPLES");
  if (samples.length !== warmups.length + measured.length) add("MIXED_SAMPLE_PHASES");
  const indices = new Set<number>();
  let measuredSeen = false;
  for (const [index, sample] of samples.entries()) {
    if (sample.category !== "same_session_warm") add("MIXED_MEASUREMENT_CATEGORIES");
    if (!integer(sample.sampleIndex) || indices.has(sample.sampleIndex)) add("INVALID_OR_DUPLICATE_SAMPLE_INDEX");
    indices.add(sample.sampleIndex);
    if (sample.sampleIndex !== index) add("NONCONTIGUOUS_OR_REORDERED_SAMPLES");
    if (sample.sessionIdentity !== samplingPlan.sessionIdentity) add("SESSION_IDENTITY_MISMATCH");
    if (sample.phase === "measured") measuredSeen = true;
    if (sample.phase === "warmup" && measuredSeen) add("WARMUP_AFTER_MEASURED_SAMPLE");
    if (sample.actor !== expected.actor || sample.variant !== expected.variant || sample.parent !== expected.parent
      || sample.inputCursor !== expected.inputCursor || sample.limit !== expected.limit) add("QUERY_IDENTITY_MISMATCH");
    if (sample.status !== "success") { add("FAILED_SAMPLE_RETAINED"); continue; }
    if (sample.queryCount !== 1 || sample.countQueryCount !== 0) add("ONE_RPC_ZERO_COUNT_VIOLATION");
    if (sample.resultSha256 !== expected.resultSha256 || sample.responseBytes !== expected.responseBytes
      || sample.cursor !== expected.cursor || sample.hasMore !== expected.hasMore) add("RESULT_PARITY_MISMATCH");
    const { sessionSetupMs, rpcCallMs, applicationReadMs, initializedReadTotalMs, serializationMs } = sample;
    if (!finiteTime(sessionSetupMs) || !finiteTime(rpcCallMs) || !finiteTime(applicationReadMs)
      || !finiteTime(initializedReadTotalMs) || !finiteTime(serializationMs)) { add("INVALID_MEASUREMENT_TIME"); continue; }
    // Setup is outside applicationRead; RPC/raw materialization and mapping are inside it.
    if (rpcCallMs > applicationReadMs + 0.001
      || Math.abs(sessionSetupMs + applicationReadMs - initializedReadTotalMs) > 0.01) add("INVALID_TIMING_BOUNDARIES");
  }
  // Do not silently omit failed/timed-out/invalid samples to manufacture a percentile.
  const valid = issues.length === 0;
  const metric = (name: "sessionSetupMs" | "rpcCallMs" | "applicationReadMs" | "initializedReadTotalMs" | "serializationMs") => {
    if (!valid) return null;
    const values: number[] = [];
    for (const sample of measured) {
      const value = sample[name];
      if (!finiteTime(value)) throw new Error("Invalid measurement sample");
      values.push(value);
    }
    return photoDistribution(values);
  };
  const distributions = { sessionSetup: metric("sessionSetupMs"), warmRpc: metric("rpcCallMs"),
    warmApplicationRead: metric("applicationReadMs"), serialization: metric("serializationMs"),
    initializedReadTotal: metric("initializedReadTotalMs") };
  const p95 = distributions.warmApplicationRead?.p95Ms;
  if (p95 !== undefined && p95 > PHOTO_WARM_P95_BUDGET_MS) add("WARM_APPLICATION_READ_OVER_BUDGET");
  return { passed: issues.length === 0, issues, budgetMs: PHOTO_WARM_P95_BUDGET_MS,
    warmupCount: warmups.length, measuredCount: measured.length, failureCount: samples.filter(sample => sample.status !== "success").length,
    identity, expected, samplingPlan, distributions, samples: [...samples],
    methodology: "One same-session category; five or more excluded warmups; thirty or more measured samples; nearest rank; no trimmed samples" };
}

export interface PhotoPhaseMarkers {
  readonly commandStart: number;
  readonly processEntry: number;
  readonly importsComplete: number;
  readonly engineReady: number;
  readonly migrationsComplete: number;
  readonly fixtureComplete: number;
  readonly statisticsComplete: number;
  readonly sessionReady: number;
  readonly rpcComplete: number;
  readonly mappingComplete: number;
  readonly serializationComplete: number;
  readonly commandComplete: number;
}

/** Synthetic methodology oracle. Markers share one monotonic origin, never wall-clock dates. */
export function decomposePhotoPhaseMarkers(markers: PhotoPhaseMarkers) {
  const ordered = [markers.commandStart, markers.processEntry, markers.importsComplete, markers.engineReady,
    markers.migrationsComplete, markers.fixtureComplete, markers.statisticsComplete, markers.sessionReady,
    markers.rpcComplete, markers.mappingComplete, markers.serializationComplete, markers.commandComplete];
  if (ordered.some((value, index) => !finiteTime(value) || (index > 0 && value < ordered[index - 1]))) {
    throw new Error("Invalid monotonic phase markers");
  }
  return { coldProcess: markers.processEntry - markers.commandStart,
    moduleImport: markers.importsComplete - markers.processEntry,
    databaseBootstrap: markers.statisticsComplete - markers.importsComplete,
    databaseEngineStart: markers.engineReady - markers.importsComplete,
    migrationApply: markers.migrationsComplete - markers.engineReady,
    fixtureLoad: markers.fixtureComplete - markers.migrationsComplete,
    analyzeStatistics: markers.statisticsComplete - markers.fixtureComplete,
    sessionSetup: markers.sessionReady - markers.statisticsComplete,
    warmRpc: markers.rpcComplete - markers.sessionReady,
    mapping: markers.mappingComplete - markers.rpcComplete,
    warmApplicationRead: markers.mappingComplete - markers.sessionReady,
    serialization: markers.serializationComplete - markers.mappingComplete,
    initializedReadTotal: markers.mappingComplete - markers.statisticsComplete,
    completeCommand: markers.commandComplete - markers.commandStart };
}
