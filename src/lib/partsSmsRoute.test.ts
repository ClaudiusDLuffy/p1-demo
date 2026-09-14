import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { NextRequest } from "next/server";
import ts from "typescript";
import { configurationFixture } from "./config-test-support/runtimeConfig";
import { safeLog } from "./observability/safeLogger";

function harness() {
  const env: Record<string, string> = { CRON_SECRET: "synthetic-cron-secret" };
  const calls: { force?: boolean; signal?: AbortSignal }[] = [];
  const logs: unknown[] = [];
  let failure = false;
  const summary = { runId: "00000000-0000-4000-8000-000000000001", evaluation: "queued", localDate: "2026-09-10", resultCode: "RUN_COMPLETE",
    heartbeatConfirmed: true, eligible: 1, parts: 1, workOrders: 1, claimed: 1, accepted: 1, unknown: 0, deliveredUpdates: 0,
    recurrenceQueued: 0, recurrenceBlocked: 0 };
  const route: { GET?: (request: NextRequest) => Promise<Response>; POST?: (request: NextRequest) => Promise<Response>; maxDuration?: number } = {};
  const filename = resolve("src/app/api/notifications/parts-order/route.ts");
  const requireHere = createRequire(import.meta.url);
  runInNewContext(ts.transpileModule(readFileSync(filename, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { exports: route, Buffer, process: { env }, console: { info: (value: unknown) => logs.push(value) }, require: (name: string) =>
      name === "../../../../lib/server/partsSmsWorker" ? { drainPartsSms: async (options: { force?: boolean; signal?: AbortSignal }) => {
        calls.push(options); if (failure) throw new Error("private synthetic provider response"); return summary;
      } } : name.endsWith("/observability/safeLogger") ? { safeLog: (...args: Parameters<typeof safeLog>) => safeLog(args[0], args[1], args[2], value => logs.push(value)) }
        : configurationFixture(name, env) ?? requireHere(name.startsWith(".") ? resolve(filename, "..", name) : name) });
  assert.ok(route.GET); assert.ok(route.POST);
  const get = route.GET; const post = route.POST;
  const call = (method = "GET", authorization = "Bearer synthetic-cron-secret", query = "") => (method === "POST" ? post : get)(new NextRequest(`http://localhost/api/notifications/parts-order${query}`, { method, headers: { authorization } }));
  return { call, calls, logs, env, summary, route, fail: () => { failure = true; } };
}

for (const authorization of ["", "Bearer invalid", "Basic synthetic-cron-secret", "Bearer synthetic-cron-secret-extra"]) {
  test(`parts cron rejects invalid service authentication (${authorization ? "supplied" : "missing"}) before worker`, async () => {
    const h = harness(); assert.equal((await h.call("GET", authorization)).status, 401); assert.equal(h.calls.length, 0);
  });
}
test("parts cron is fail-closed without CRON_SECRET", async () => {
  const h = harness(); delete h.env.CRON_SECRET; const response = await h.call();
  assert.equal(response.status, 503); assert.equal((await response.json()).code, "CONFIG_INCOMPLETE"); assert.equal(h.calls.length, 0);
});
test("parts cron GET/POST share bounded queue execution and preserve service force", async () => {
  const h = harness(); assert.equal(h.route.GET, h.route.POST); assert.equal(h.route.maxDuration, 60);
  const response = await h.call(); const body = await response.json();
  assert.equal(response.status, 200); assert.equal(body.status, "completed"); assert.equal(body.accepted, 1); assert.equal(body.deliveredUpdates, 0);
  await h.call("POST", "Bearer synthetic-cron-secret", "?force=1");
  assert.equal(h.calls[0]?.force, false); assert.equal(h.calls[1]?.force, true);
  assert.equal(h.logs.length, 2); assert.ok(h.calls[0]?.signal instanceof AbortSignal);
});
test("parts cron never consumes browser recipient or message payload", async () => {
  const h = harness(); await h.call("POST", "Bearer synthetic-cron-secret", "?phone=arbitrary&body=arbitrary&sid=arbitrary");
  assert.deepEqual(Object.keys(h.calls[0] ?? {}).sort(), ["force", "signal"]);
});
test("parts cron does not expose provider/database exceptions", async () => {
  const h = harness(); h.fail(); const response = await h.call();
  assert.equal(response.status, 503); const body = await response.json();
  assert.deepEqual(body, { error: "This service is temporarily unavailable. Saved work remains unchanged.", code: "PARTS_SMS_RUN_UNAVAILABLE", correlationId: response.headers.get("X-Request-ID") });
  assert.doesNotMatch(JSON.stringify(body), /private synthetic provider response/);
});
for (const code of ["TWILIO_NOT_CONFIGURED", "DATABASE_UNAVAILABLE", "TIME_BUDGET_EXCEEDED"]) {
  test(`parts cron reports safe ${code} summary`, async () => {
    const h = harness(); h.summary.resultCode = code;
    const response = await h.call(); assert.equal(response.status, 503); assert.equal((await response.json()).resultCode, code);
  });
}
test("parts cron unknown/mixed outcomes are partial, never sent or delivered", async () => {
  const h = harness(); h.summary.resultCode = "RUN_PARTIAL"; h.summary.unknown = 1;
  const response = await h.call(); assert.equal(response.status, 207); assert.equal((await response.json()).status, "partial");
});
test("parts cron reports a blocked recurrence as completed policy evaluation, not SMS delivery or worker failure", async () => {
  const h = harness(); h.summary.recurrenceBlocked = 1; h.summary.accepted = 0; h.summary.claimed = 0;
  const response = await h.call(); const body = await response.json();
  assert.equal(response.status, 200); assert.equal(body.status, "completed");
  assert.equal(body.recurrenceBlocked, 1); assert.equal(body.recurrenceQueued, 0);
  assert.equal(body.accepted, 0); assert.equal(body.deliveredUpdates, 0);
  assert.doesNotMatch(JSON.stringify(h.logs), /phone|body|signature|providerMessageId/i);
});
test("parts cron returns additive safe recurrence counts without accepting a browser-selected source chain", async () => {
  const h = harness(); h.summary.recurrenceQueued = 1;
  const response = await h.call("POST", "Bearer synthetic-cron-secret", "?recipient=arbitrary&signature=arbitrary&recurrenceAfterEventId=arbitrary&noSendProof=true");
  assert.equal(response.status, 200); assert.equal((await response.json()).recurrenceQueued, 1);
  assert.deepEqual(Object.keys(h.calls[0] ?? {}).sort(), ["force", "signal"]);
  assert.doesNotMatch(JSON.stringify(h.calls), /recipient|signature|recurrenceAfter|noSendProof/i);
});
test("parts cron preserves disabled/before-cutoff/empty evaluation aliases", async () => {
  for (const evaluation of ["disabled", "unscheduled", "before_cutoff", "nothing_to_send"]) {
    const h = harness(); h.summary.evaluation = evaluation;
    const body = await (await h.call()).json(); assert.equal(body.status, evaluation === "disabled" ? "unscheduled" : evaluation);
  }
});
test("repository owns exactly one staggered three-minute parts schedule without changing email schedules", () => {
  const manifest: unknown = JSON.parse(readFileSync(resolve("vercel.json"), "utf8"));
  assert.ok(manifest && typeof manifest === "object" && "crons" in manifest && Array.isArray(manifest.crons));
  const schedules = manifest.crons.map((row: unknown) => {
    assert.ok(row && typeof row === "object" && "path" in row && typeof row.path === "string" && "schedule" in row && typeof row.schedule === "string");
    return { path: row.path, schedule: row.schedule };
  });
  assert.deepEqual(schedules.filter(row => row.path.includes("parts")), [{ path: "/api/notifications/parts-order", schedule: "2-59/3 * * * *" }]);
  assert.deepEqual(schedules.filter(row => row.path.includes("dispatch")), [{ path: "/api/notifications/dispatch/drain", schedule: "*/3 * * * *" }]);
  assert.deepEqual(schedules.filter(row => row.path.includes("financial")), [{ path: "/api/notifications/financial/drain", schedule: "1-59/3 * * * *" }]);
  assert.equal(new Set(schedules.map(row => row.path)).size, schedules.length);
});
