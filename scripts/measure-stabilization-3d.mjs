import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { AppError } from "../src/lib/errors/AppError.ts";
import { normalizeUnknownError } from "../src/lib/errors/normalizeUnknown.ts";
import { errorResponse } from "../src/lib/errors/httpBoundary.ts";
import { createRequestContext } from "../src/lib/observability/requestContext.ts";
import { redact, redactText, REDACTION_LIMITS } from "../src/lib/observability/redaction.ts";
import { readBoundedBody } from "../src/lib/http/boundedBody.ts";
import { CLIENT_DIAGNOSTIC_BODY_BYTES } from "../src/lib/observability/clientReportContracts.ts";
import { getCronConfig } from "../src/lib/config/server/cron.ts";
import { getGraphConfig } from "../src/lib/config/server/graph.ts";
import { getTwilioConfig } from "../src/lib/config/server/twilio.ts";
import { absoluteOrigin, strictBoolean } from "../src/lib/config/shared.ts";
import { evaluateSla } from "../src/lib/sla/evaluation.ts";

// Run: node --import tsx scripts/measure-stabilization-3d.mjs
// Synthetic CPU/local-stream measurements only. No environment credentials,
// database, network, provider, filesystem writes or hosted throughput claim.
const samples = 9;
const warmups = 2;
const results = [];
let sink = 0;
const round = value => Number(value.toFixed(3));
function summary(name, operations, times) {
  const ordered = [...times].sort((a, b) => a - b);
  results.push({ name, operationsPerSample: operations, samples,
    medianMs: round(ordered[Math.floor(ordered.length / 2)]), maxMs: round(ordered.at(-1)),
    minMs: round(ordered[0]), medianUsPerOperation: round(ordered[Math.floor(ordered.length / 2)] * 1_000 / operations) });
}
function measure(name, operations, operation) {
  for (let index = 0; index < warmups; index++) operation();
  const times = [];
  for (let index = 0; index < samples; index++) {
    const start = performance.now(); operation(); times.push(performance.now() - start);
  }
  summary(name, operations, times);
}
async function measureAsync(name, operations, operation) {
  for (let index = 0; index < warmups; index++) await operation();
  const times = [];
  for (let index = 0; index < samples; index++) {
    const start = performance.now(); await operation(); times.push(performance.now() - start);
  }
  summary(name, operations, times);
}

const correlationId = "91000000-0000-4000-8000-000000000001";
const failures = [new Error("SYNTHETIC_FAILURE"), { code: "42501", message: "SYNTHETIC_DATABASE_FAILURE" },
  new AppError("DELIVERY_UNKNOWN", { correlationId }), new AppError("VALIDATION_FAILED", { fieldErrors: [{ path: ["lines", 1, "qty"] }] })];
measure("normalize_10000_mixed_errors", 10_000, () => {
  for (let index = 0; index < 10_000; index++) sink += normalizeUnknownError(failures[index % failures.length]).status;
});

const text = "synthetic-safe-text ".repeat(2_000).slice(0, CLIENT_DIAGNOSTIC_BODY_BYTES);
assert.equal(text.length, 25_000);
measure("redactor_25000_character_input", 100, () => {
  for (let index = 0; index < 100; index++) {
    const output = redactText(text);
    assert.ok(output.length <= REDACTION_LIMITS.string);
    sink += output.length;
  }
});
function nested(depth) {
  return depth === 0 ? { text, flag: true } : { text, children: Array.from({ length: 24 }, (_, index) => ({ index })), next: nested(depth - 1) };
}
const nestedFixture = Object.fromEntries(Array.from({ length: 40 }, (_, index) => [`key${index}`, nested(6)]));
measure("redactor_over_limit_width_depth_and_arrays", 100, () => {
  for (let index = 0; index < 100; index++) sink += JSON.stringify(redact(nestedFixture)).length;
});

const bytes = new TextEncoder().encode(" ".repeat(CLIENT_DIAGNOSTIC_BODY_BYTES));
await measureAsync("bounded_body_exact_25000_byte_cap", 100, async () => {
  for (let index = 0; index < 100; index++) {
    const stream = new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } });
    const result = await readBoundedBody(stream, { maximum: CLIENT_DIAGNOSTIC_BODY_BYTES, timeoutMs: 3_000 });
    assert.equal(result.length, CLIENT_DIAGNOSTIC_BODY_BYTES);
    sink += result.length;
  }
});

const request = new Request("https://synthetic.invalid/api/client-errors", { headers: { "X-Request-ID": correlationId } });
measure("small_safe_error_response", 1_000, () => {
  for (let index = 0; index < 1_000; index++) {
    const context = createRequestContext(request, "/api/client-errors");
    context.failureLogged = true; // Measure projection, not console/sink I/O.
    const response = errorResponse(failures[0], context);
    assert.equal(response.status, 500);
    sink += response.status;
  }
});

const syntheticConfiguration = Object.freeze({ CRON_SECRET: "synthetic-local-benchmark-token", ENABLED: "false" });
measure("configuration_validation_fixed_synthetic_inputs", 1_000, () => {
  for (let index = 0; index < 1_000; index++) {
    assert.equal(getCronConfig(syntheticConfiguration).secret, syntheticConfiguration.CRON_SECRET);
    assert.equal(strictBoolean(syntheticConfiguration, "ENABLED", "cron"), false);
    assert.equal(absoluteOrigin("https://synthetic.invalid", "app_environment", "APP_URL"), "https://synthetic.invalid");
    assert.equal(getGraphConfig({}).status, "disabled");
    assert.equal(getTwilioConfig({}).status, "disabled");
    sink++;
  }
});

const now = new Date("2026-09-10T12:00:00.000Z");
const fixtures = [
  { priority: "p1", dispatchedAt: "2026-09-10T00:00:00.000Z" },
  { priority: "p2", dispatchedAt: "2026-09-10T04:00:00.000Z", responseBreachAt: "2026-09-10T08:00:00.000Z", resolutionBreachAt: "2026-09-10T16:00:00.000Z" },
  { priority: "p3", resolutionBreachAt: "2026-09-11T08:00:00.000Z" },
  { priority: "p4", responseBreachAt: "invalid" },
  { priority: "p5" },
];
const list = Array.from({ length: 10_000 }, (_, index) => fixtures[index % fixtures.length]);
measure("sla_10000_mixed_list_evaluations_and_sort", 10_000, () => {
  const evaluated = list.map((workOrder, index) => ({ index, result: evaluateSla(workOrder, now) }));
  evaluated.sort((a, b) => (a.result.dueTime ?? Number.MAX_SAFE_INTEGER) - (b.result.dueTime ?? Number.MAX_SAFE_INTEGER) || a.index - b.index);
  sink += evaluated.filter(item => item.result.breached).length;
});

assert.ok(Number.isFinite(sink) && sink > 0);
console.log(JSON.stringify({ kind: "local_synthetic_only", node: process.version, samples, warmups,
  claims: "CPU/local-stream timings only; no hosted, database or provider throughput certification.", results }, null, 2));
