import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { NextRequest } from "next/server";
import ts from "typescript";
import { configurationFixture } from "./config-test-support/runtimeConfig";

type Handler = (request: NextRequest) => Promise<Response>;
function compileRoute(path: string, replacements: Record<string, unknown>, extras: Record<string, unknown> = {}) {
  const filename = resolve(path); const requireHere = createRequire(import.meta.url);
  const exports: { POST?: Handler; GET?: Handler } = {};
  const source = ts.transpileModule(readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  runInNewContext(source, { exports, Buffer, AbortSignal, ...extras, require: (name: string) =>
    Object.hasOwn(replacements, name) ? replacements[name] : requireHere(name.startsWith(".") ? resolve(filename, "..", name) : name) }, { filename });
  assert.ok(exports.POST); return exports;
}

function compatibilityHarness() {
  const userId = randomUUID(); const contractorId = randomUUID(); const deliveryId = randomUUID();
  const profile: { active: boolean; role: string } = { active: true, role: "manager" };
  let profileMissing = false; let invalidAuth = false; let dbError = false; let bodyReads = 0; let rpcCalls = 0;
  let permissions: { permission: string }[] = [];
  let state = "pending"; let missing = false;
  const safeDelivery = () => ({ id: deliveryId, rootId: deliveryId, workOrderId: "WOT-SYNTHETIC", assignmentVersion: 2,
    state, attemptCount: 1, createdAt: "2026-09-09T00:00:00Z", lastAttemptAt: null, completedAt: null, code: null,
    canResend: state === "unknown", canResolve: state === "unknown" });
  const caller = {
    auth: { getUser: async () => ({ data: { user: invalidAuth ? null : { id: userId } }, error: invalidAuth ? {} : null }) },
    rpc: () => ({ abortSignal: async () => { rpcCalls++; return { data: { kind: missing ? "missing_intent" : "current", delivery: missing ? null : safeDelivery() }, error: null }; } }),
  };
  const sb = { from: (table: string) => {
    const result = () => ({ error: dbError ? { message: "synthetic-private-SQL" } : null,
      data: table === "profiles" ? profileMissing ? null : { ...profile, id: userId }
        : table === "staff_permission_grants" ? permissions
          : { id: "WOT-SYNTHETIC", contractor_id: contractorId, contractor_assignment_version: 2, deleted_at: null } });
    const chain = { select: () => chain, eq: () => chain, is: () => chain, maybeSingle: async () => result(),
      then: (fn: (value: ReturnType<typeof result>) => unknown) => Promise.resolve(result()).then(fn) };
    return chain;
  } };
  const route = compileRoute("src/app/api/notifications/dispatch/route.ts", {
    "../../../../lib/config/server/supabase": configurationFixture("/config/server/supabase"),
    "@supabase/supabase-js": { createClient: () => caller },
    "../../../../lib/supabase/server": { createServerClient: () => sb },
  }, { process: { env: {} } });
  const call = async (authorization = "Bearer synthetic", body: unknown = { workOrderId: "WOT-SYNTHETIC", contractorId }) => {
    const request = new NextRequest("http://localhost/api/notifications/dispatch", { method: "POST", headers: { authorization } });
    Object.defineProperty(request, "json", { value: async () => { bodyReads++; return body; } });
    assert.ok(route.POST); return route.POST(request);
  };
  return { call, profile, contractorId, deliveryId, counts: () => ({ bodyReads, rpcCalls }),
    invalid: () => { invalidAuth = true; }, missingProfile: () => { profileMissing = true; },
    controller: () => { permissions = [{ permission: "invoice_controller" }]; },
    failDb: () => { dbError = true; }, setState: (value: string) => { state = value; }, missingIntent: () => { missing = true; } };
}

for (const mode of ["anonymous", "invalid", "missing-profile", "inactive", "controller", "contractor"] as const) {
  test(`compatibility dispatch denies ${mode} before reading body`, async () => {
    const h = compatibilityHarness();
    if (mode === "invalid") h.invalid(); if (mode === "missing-profile") h.missingProfile();
    if (mode === "inactive") h.profile.active = false; if (mode === "controller") h.controller();
    if (mode === "contractor") h.profile.role = "contractor";
    const response = await h.call(mode === "anonymous" ? "" : "Bearer synthetic");
    assert.equal(response.status, ["anonymous", "invalid"].includes(mode) ? 401 : 403);
    assert.deepEqual(h.counts(), { bodyReads: 0, rpcCalls: 0 });
  });
}

test("stale compatibility calls report authoritative queue/unknown/sent state", async () => {
  for (const state of ["pending", "unknown", "sent", "not_deliverable", "manually_resolved"]) {
    const h = compatibilityHarness(); h.setState(state);
    const response = await h.call(); assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { success: true, status: state === "pending" ? "queued" : state, deliveryId: h.deliveryId });
  }
});

test("missing intent and arbitrary recipient fields cannot produce queued success", async () => {
  const missing = compatibilityHarness(); missing.missingIntent(); assert.equal((await missing.call()).status, 409);
  const arbitrary = compatibilityHarness();
  assert.equal((await arbitrary.call("Bearer synthetic", { workOrderId: "WOT-SYNTHETIC", recipientEmail: "synthetic@example.invalid" })).status, 400);
  assert.equal(arbitrary.counts().rpcCalls, 0);
  assert.equal((await arbitrary.call("Bearer synthetic", { workOrderId: "WOT-SYNTHETIC", contractorId: randomUUID() })).status, 409);
});

test("compatibility profile failure does not expose raw SQL/provider details", async () => {
  const h = compatibilityHarness(); h.failDb(); const response = await h.call();
  assert.equal(response.status, 503); assert.doesNotMatch(await response.text(), /synthetic-private-SQL/);
});

test("cron GET and POST share service authentication and safe configuration checks", async () => {
  let drained = 0;
  const env: Record<string, string> = { CRON_SECRET: "synthetic-test-secret" };
  const route = compileRoute("src/app/api/notifications/dispatch/drain/route.ts", {
    "../../../../../lib/config/server/cron": configurationFixture("/config/server/cron", env),
    "../../../../../lib/config/server/graph": configurationFixture("/config/server/graph", env),
    "../../../../../lib/server/receivingDispatchWorker": { drainReceivingDispatches: async () => { drained++; return { claimed: 0, sent: 0 }; } },
  }, { process: { env } });
  assert.equal(route.GET, route.POST); assert.ok(route.GET);
  assert.equal((await route.GET(new NextRequest("http://localhost/drain"))).status, 401);
  const request = () => new NextRequest("http://localhost/drain", { headers: { authorization: "Bearer synthetic-test-secret" } });
  assert.equal((await route.GET(request())).status, 503); assert.equal(drained, 1, "Lease recovery remains active during provider configuration failure");
  for (const key of ["OUTLOOK_TENANT_ID", "OUTLOOK_CLIENT_ID", "OUTLOOK_CLIENT_SECRET", "OUTLOOK_USER_EMAIL"]) env[key] = "synthetic";
  env.OUTLOOK_USER_EMAIL = "synthetic@example.invalid";
  assert.equal((await route.GET(request())).status, 200); assert.equal(drained, 2);
});
