import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { NextRequest } from "next/server";
import ts from "typescript";
import { financialHttpError, financialRpcError, readFinancialRequest } from "./server/financialNotificationHttp";
import { configurationFixture } from "./config-test-support/runtimeConfig";
import { ConfigurationError } from "./config/shared";

type Handler = (request: NextRequest) => Promise<Response>;
type Routes = { POST: Handler; PATCH: Handler; GET: Handler };
function compile<T extends object>(path: string, replacements: Record<string, unknown>, extra: Record<string, unknown> = {}): T {
  const filename = resolve(path); const requireHere = createRequire(import.meta.url);
  const exports = {};
  const source = ts.transpileModule(readFileSync(filename, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  runInNewContext(source, { exports, Buffer, AbortSignal, fetch, setTimeout, clearTimeout, TextDecoder, Uint8Array, ...extra,
    require: (name: string) => Object.hasOwn(replacements, name) ? replacements[name] : requireHere(name.startsWith(".") ? resolve(filename, "..", name) : name) }, { filename });
  // Test-only CommonJS VM boundary; callers exercise the actual compiled exports.
  return exports as T;
}
const httpPath = "src/lib/server/financialNotificationHttp.ts";
function routeHarness(kind: "review" | "hold") {
  const invoiceId = randomUUID(); const eventId = randomUUID(); const operationId = randomUUID();
  const calls: { name: string; args: unknown }[] = [];
  let denied = false; let release = true; let dbError: unknown = null; let invalidResult = false;
  let state = "queued"; let applied = true;
  const caller = { rpc: (name: string, args: unknown) => ({ abortSignal: async () => {
    calls.push({ name, args }); return { error: dbError, data: invalidResult ? { unexpected: "private-provider-body" }
      : kind === "review" ? { success: true, recipientCount: 2, notification: { status: state, eventId }, recipientEmail: "private@example.invalid" }
        : { applied, invoiceId, invoiceNum: "TEST", operationId, replayed: false, notificationStatus: state,
          notifications: state === "not_required" ? [] : [{ eventId, sourceEventId: randomUUID(), family: "payment_hold_placed", status: state }] } };
  } }) };
  const http = { financialHttpError, financialRpcError, readFinancialRequest,
    authorizeFinancialRequest: async () => denied ? { error: financialHttpError("FORBIDDEN", "Forbidden", 403) } : { caller, canRelease: release } };
  const prefix = kind === "review" ? "../../../../lib/server/financialNotificationHttp" : "../../../lib/server/financialNotificationHttp";
  const route = compile<Routes>(kind === "review" ? "src/app/api/notifications/invoice-review/route.ts" : "src/app/api/contractor-invoice-holds/route.ts",
    { [prefix]: http, "../../../lib/server/staffAuthorization": {} });
  const body = () => kind === "review" ? { invoiceId, event: "rejected" } : { invoiceId, action: "hold", reason: "Synthetic reason", operationId, expectedSourceEventId: null };
  const call = (value: unknown = body()) => route[kind === "review" ? "POST" : "PATCH"](new NextRequest("http://localhost/api/synthetic", {
    method: kind === "review" ? "POST" : "PATCH", body: JSON.stringify(value), headers: { "Content-Type": "application/json" },
  }));
  return { call, body, calls, invoiceId, operationId, deny: () => { denied = true; }, withoutRelease: () => { release = false; },
    fail: (error: unknown) => { dbError = error; }, malformed: () => { invalidResult = true; },
    setState: (value: string) => { state = value; }, noop: () => { applied = false; state = "not_required"; } };
}

test("financial compatibility route only returns an existing immutable event", async () => {
  const h = routeHarness("review"); const response = await h.call();
  assert.equal(response.status, 200); assert.equal(h.calls[0].name, "get_financial_notification_review_compatibility_v1");
  assert.doesNotMatch(await response.text(), /private|recipientEmail|@/);
});
for (const state of ["queued", "processing", "sent", "unknown", "not_deliverable", "superseded", "failed", "manually_resolved"]) {
  test(`financial compatibility preserves ${state} on repeated requests`, async () => {
    const h = routeHarness("review"); h.setState(state);
    const first = await h.call(); const second = await h.call();
    assert.equal((await first.json()).notification.status, state); assert.equal((await second.json()).notification.status, state);
    assert.ok(h.calls.every(call => call.name.startsWith("get_")));
  });
}
test("financial compatibility missing intent fails safely without creating one", async () => {
  const h = routeHarness("review"); h.fail({ code: "PT404", message: "DELIVERY_NOT_FOUND" });
  assert.equal((await h.call()).status, 409); assert.equal(h.calls.length, 1);
});
test("financial routes reject arbitrary recipient and actor input", async () => {
  for (const kind of ["review", "hold"] as const) {
    const h = routeHarness(kind); assert.equal((await h.call({ ...h.body(), recipientEmail: "synthetic@example.invalid", actorId: randomUUID() })).status, 400);
    assert.equal(h.calls.length, 0);
  }
});
test("financial hold route commits through caller-bound versioned RPC and returns queued separately", async () => {
  const h = routeHarness("hold"); const response = await h.call(); assert.equal(response.status, 200);
  const result = await response.json(); assert.equal(result.result.applied, true); assert.equal(result.notification.status, "queued");
  assert.equal(result.notificationWarning, null); assert.equal(h.calls[0].name, "set_contractor_invoice_payment_hold_with_notification_v1");
  assert.deepEqual(JSON.parse(JSON.stringify(h.calls[0].args)), { p_invoice_id: h.invoiceId, p_action: "place", p_reason: "Synthetic reason", p_operation_id: h.operationId, p_expected_source_event_id: null });
});
test("financial hold no-op is not a new notification and is never reported sent", async () => {
  const h = routeHarness("hold"); h.noop(); const result = await (await h.call()).json();
  assert.equal(result.result.applied, false); assert.equal(result.notification.status, "not_required");
});
test("financial hold stale browser must refresh its observed source and operation", async () => {
  const h = routeHarness("hold"); const response = await h.call({ invoiceId: h.invoiceId, action: "release", reason: "Synthetic reason" });
  assert.equal(response.status, 409); assert.equal(h.calls.length, 0);
});
test("financial hold release preserves handoff permission denial", async () => {
  const h = routeHarness("hold"); h.withoutRelease(); assert.equal((await h.call({ ...h.body(), action: "release" })).status, 403);
  assert.equal(h.calls.length, 0);
});
test("financial request failures never expose raw SQL/provider text", async () => {
  for (const kind of ["review", "hold"] as const) {
    const h = routeHarness(kind); h.fail({ message: "synthetic-secret private@example.invalid SQL SELECT" });
    const response = await h.call(); assert.equal(response.status, 503); assert.doesNotMatch(await response.text(), /synthetic-secret|@|SELECT/);
    const bad = routeHarness(kind); bad.malformed(); assert.equal((await bad.call()).status, 503);
  }
});
test("financial route authorization happens before request-body consumption", async () => {
  const h = routeHarness("review"); h.deny(); assert.equal((await h.call("invalid body")).status, 403); assert.equal(h.calls.length, 0);
});
test("financial request body has an actual byte limit and rejects malformed JSON", async () => {
  for (const body of ["not-json", JSON.stringify({ reason: "x".repeat(17_000) })]) {
    await assert.rejects(readFinancialRequest(new NextRequest("http://localhost/test", { method: "POST", body })));
  }
});

function authorizationHarness(configurationError?: ConfigurationError) {
  let role = "manager"; let active = true; let missing = false; let invalid = false;
  let permissions: string[] = []; let dbError = false;
  const caller = { auth: { getUser: async () => ({ error: invalid ? {} : null, data: { user: invalid ? null : { id: randomUUID() } } }) } };
  const sb = { from: (table: string) => {
    const result = () => ({ error: dbError ? { message: "private SQL" } : null,
      data: table === "profiles" ? missing ? null : { id: randomUUID(), role, active } : permissions.map(permission => ({ permission })) });
    const chain = { select: () => chain, eq: () => chain, abortSignal: () => chain, maybeSingle: async () => result(),
      then: (fn: (value: ReturnType<typeof result>) => unknown) => Promise.resolve(result()).then(fn) };
    return chain;
  } };
  const http = compile<typeof import("./server/financialNotificationHttp")>(httpPath, {
    "@supabase/supabase-js": { createClient: () => caller }, "../supabase/server": { createServerClient: () => sb },
    "../config/server/supabase": configurationError
      ? { getServerPublicSupabaseConfig: () => { throw configurationError; } }
      : configurationFixture("/config/server/supabase"),
  }, { process: { env: {} } });
  const call = (allowController = false, bearer = "Bearer synthetic") => http.authorizeFinancialRequest(new NextRequest("http://localhost/test", { headers: { authorization: bearer } }), allowController);
  return { call, role: (value: string) => { role = value; }, inactive: () => { active = false; }, missing: () => { missing = true; },
    invalid: () => { invalid = true; }, permissions: (values: string[]) => { permissions = values; }, dbError: () => { dbError = true; } };
}
test("financial authorization preserves configuration failures for the safe outer boundary", async () => {
  const error = new ConfigurationError("CONFIG_INCOMPLETE", "supabase_public");
  const h = authorizationHarness(error);
  assert.equal((await h.call(false, "")).error?.status, 401, "Anonymous callers never evaluate configuration");
  await assert.rejects(h.call(), cause => cause === error);
});
for (const mode of ["anonymous", "invalid", "missing", "inactive", "contractor", "controller"] as const) {
  test(`financial review authorization denies ${mode} using current database profile`, async () => {
    const h = authorizationHarness();
    if (mode === "invalid") h.invalid(); if (mode === "missing") h.missing(); if (mode === "inactive") h.inactive();
    if (mode === "contractor") h.role("contractor"); if (mode === "controller") h.permissions(["invoice_controller"]);
    const result = await h.call(false, mode === "anonymous" ? "" : "Bearer synthetic");
    assert.ok("error" in result); assert.equal(result.error?.status, mode === "anonymous" || mode === "invalid" ? 401 : 403);
  });
}
for (const role of ["manager", "dispatcher", "back_office"]) {
  test(`financial active ${role} allowed; controller permission limits review but not hold reads`, async () => {
    const h = authorizationHarness(); h.role(role); assert.ok("caller" in await h.call());
    h.permissions(["invoice_controller", "quickbooks_handoff"]); const result = await h.call(true);
    assert.ok("caller" in result); assert.equal(result.canRelease, true);
  });
}
test("financial cron is independent, authenticated, bounded, and records configuration outages", async () => {
  let calls = 0; let configured = false; let fail = false;
  const logs: unknown[] = [];
  const route = compile<Routes>("src/app/api/notifications/financial/drain/route.ts", {
    "../../../../../lib/config/server/cron": configurationFixture("/config/server/cron", { CRON_SECRET: "synthetic-secret" }),
    "../../../../../lib/config/server/graph": { graphDeliveryConfigurationError: () => configured ? null : new ConfigurationError("FEATURE_DISABLED", "graph") },
    "../../../../../lib/server/financialNotificationWorker": { drainFinancialNotifications: async () => { calls++; if (fail) throw new Error("private-provider-body"); return { claimed: 0, sent: 0 }; } },
  }, { process: { env: { CRON_SECRET: "synthetic-secret" } }, console: { info: (...args: unknown[]) => logs.push(args) } });
  assert.equal(route.GET, route.POST);
  for (const value of ["", "Bearer incorrect", "Bearer synthetic-secret extra"]) {
    assert.equal((await route.GET(new NextRequest("http://localhost/drain", { headers: { authorization: value } }))).status, 401);
  }
  assert.equal(calls, 0);
  const request = () => new NextRequest("http://localhost/drain", { headers: { authorization: "Bearer synthetic-secret" } });
  assert.equal((await route.GET(request())).status, 503); assert.equal(calls, 1);
  configured = true; assert.equal((await route.GET(request())).status, 200);
  fail = true; assert.equal((await route.GET(request())).status, 503);
  assert.doesNotMatch(JSON.stringify(logs), /private-provider-body|synthetic-secret|@/);
  const manifest: unknown = JSON.parse(readFileSync("vercel.json", "utf8"));
  assert.ok(manifest && typeof manifest === "object" && "crons" in manifest && Array.isArray(manifest.crons));
  const crons = manifest.crons as { path: string; schedule: string }[];
  assert.equal(crons.filter(cron => cron.path === "/api/notifications/financial/drain").length, 1);
  assert.equal(crons.find(cron => cron.path === "/api/notifications/financial/drain")?.schedule, "1-59/3 * * * *");
  assert.equal(crons.find(cron => cron.path === "/api/notifications/dispatch/drain")?.schedule, "*/3 * * * *");
});
