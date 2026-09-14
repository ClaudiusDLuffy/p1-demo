import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import type { PartsSmsWorkerSummary } from "./server/partsSmsWorker";
import { ConfigurationError } from "./config/shared";

const deliveryId = "00000000-0000-4000-8000-000000000001";
const sid = `SM${"1".repeat(32)}`;
function harness(mode: "send" | "status" | "completion_lost" | "database_error" | "recurrence", configurationError?: ConfigurationError) {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const messages: { phoneE164: string; body: string }[] = [];
  const lookedUp: string[] = [];
  let claimCount = 0; let statusCount = 0; let token: unknown;
  const filename = resolve("src/lib/server/partsSmsWorker.ts");
  const requireHere = createRequire(import.meta.url);
  const exports: { drainPartsSms?: () => Promise<PartsSmsWorkerSummary> } = {};
  const sb = { rpc: (name: string, args: Record<string, unknown>) => ({ abortSignal: async (signal: AbortSignal) => {
    assert.ok(signal instanceof AbortSignal); assert.equal(signal.aborted, false); calls.push({ name, args });
    let data: unknown;
    if (name === "start_parts_sms_run_v1") data = { runId: args.p_run_id, enabled: true, timezone: "America/New_York", cutoffTime: "14:00" };
    else if (name === "enqueue_parts_sms_deliveries_v1") {
      if (mode === "database_error") return { data: null, error: { message: "synthetic private database detail" } };
      data = { status: "queued", localDate: "2026-09-10", queued: 1, skipped: 0, superseded: 0, parts: 2, workOrders: 1,
        recurrenceQueued: mode === "recurrence" ? 1 : 0 };
    } else if (name === "claim_parts_sms_status_v1") data = { claim: mode === "status" && statusCount++ === 0 ? { id: deliveryId, providerMessageId: sid } : null, stale: 0 };
    else if (name === "claim_parts_sms_delivery_v1") {
      token = args.p_claim_token; data = { claim: mode !== "status" && claimCount++ === 0 ? { id: deliveryId } : null, recoveredBeforeSend: 0, recoveredUnknown: 0, superseded: 0, notDeliverable: 0 };
    } else if (name === "prepare_parts_sms_send_v1") {
      assert.equal(args.p_claim_token, token); assert.equal(args.p_delivery_id, deliveryId);
      data = { id: deliveryId, phoneE164: "+12025550123", localDate: "2026-09-10", requestSignature: "a".repeat(64), parts: 2, workOrders: 1, previewIds: ["SYNTHETIC-WO"] };
    } else if (name === "complete_parts_sms_delivery_v1") {
      assert.equal(args.p_claim_token, token); assert.equal(args.p_outcome, "accepted"); assert.equal(args.p_provider_message_id, sid);
      if (mode === "completion_lost") return { data: null, error: { message: "synthetic committed response lost" } };
      data = { id: deliveryId, state: "accepted", replayed: false };
    } else if (name === "complete_parts_sms_status_v1") {
      assert.equal(args.p_provider_message_id, sid); assert.equal(args.p_status, "delivered");
      data = { id: deliveryId, state: "delivered", replayed: false };
    } else if (name === "finish_parts_sms_run_v1") data = { runId: args.p_run_id, completed: true, replayed: false };
    else throw new Error(`Unexpected command ${name}`);
    return { data, error: null };
  } }) };
  const replacements: Record<string, unknown> = {
    "../supabase/server": { createServerClient: () => sb },
    "../config/server/twilio": { getTwilioConfig: () => configurationError?.feature === "twilio"
      ? { status: "invalid", error: configurationError } : { status: "configured", value: { accountSid: `AC${"1".repeat(32)}`, username: "synthetic", password: "synthetic", from: "+12025550123" } } },
    "../config/server/appEnvironment": { getPortalOrigin: () => {
      if (configurationError?.feature === "app_environment") throw configurationError;
      return "https://portal.example.test";
    } },
    "./twilioPartsSms": { createTwilioPartsSms: () => ({
      send: async (message: { phoneE164: string; body: string }, signal: AbortSignal) => {
        assert.ok(signal instanceof AbortSignal); messages.push({ phoneE164: message.phoneE164, body: message.body }); return { status: "accepted", sid, providerStatus: "queued" };
      },
      lookup: async (stored: string) => { lookedUp.push(stored); return { status: "observed", providerStatus: "delivered" }; },
    }) },
  };
  runInNewContext(ts.transpileModule(readFileSync(filename, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { exports, AbortSignal, AbortController, setTimeout, clearTimeout, process: { env: { NEXT_PUBLIC_APP_URL: "https://portal.example.test", VERCEL_GIT_COMMIT_SHA: "a".repeat(40) } },
      require: (name: string) => Object.hasOwn(replacements, name) ? replacements[name] : requireHere(name.startsWith(".") ? resolve(filename, "..", name) : name) });
  assert.ok(exports.drainPartsSms);
  return { run: exports.drainPartsSms, calls, messages, lookedUp };
}

test("production parts worker wiring uses command-only RPCs and existing safe message policy", async () => {
  const h = harness("send"); const result = await h.run();
  assert.equal(result.accepted, 1); assert.equal(result.heartbeatConfirmed, true);
  assert.deepEqual(h.messages, [{ phoneE164: "+12025550123", body: "P1 parts alert: 2 part requests across 1 work order.\nSYNTHETIC-WO\nhttps://portal.example.test/?view=dashboard" }]);
  assert.deepEqual(h.calls.map(call => call.name), ["start_parts_sms_run_v1", "enqueue_parts_sms_deliveries_v1", "claim_parts_sms_status_v1", "claim_parts_sms_delivery_v1", "prepare_parts_sms_send_v1", "complete_parts_sms_delivery_v1", "claim_parts_sms_delivery_v1", "finish_parts_sms_run_v1"]);
  const finish = h.calls.find(call => call.name === "finish_parts_sms_run_v1");
  assert.ok(finish); assert.doesNotMatch(JSON.stringify(finish.args), /1202555|SYNTHETIC-WO|SM1111|https:/);
  assert.equal(finish.args.p_result_code, "RUN_COMPLETE");
});

test("production parts status wiring resolves only a stored SID and never creates an SMS", async () => {
  const h = harness("status"); const result = await h.run();
  assert.deepEqual(h.lookedUp, [sid]); assert.equal(h.messages.length, 0); assert.equal(result.deliveredUpdates, 1);
});

test("production parts completion uncertainty leaves the original attempt to lease recovery", async () => {
  const h = harness("completion_lost"); const result = await h.run();
  assert.equal(result.completionUnconfirmed, 1); assert.equal(result.unknown, 1); assert.equal(h.messages.length, 1);
  assert.equal(h.calls.filter(call => call.name === "complete_parts_sms_delivery_v1").length, 1);
  assert.equal(h.calls.at(-1)?.args.p_result_code, "RUN_PARTIAL");
});

test("production parts database failure records safe run evidence without provider calls", async () => {
  const h = harness("database_error"); const result = await h.run();
  assert.equal(result.resultCode, "DATABASE_UNAVAILABLE"); assert.equal(h.messages.length, 0);
  assert.doesNotMatch(JSON.stringify(result), /private|database detail/);
});
for (const feature of ["twilio", "app_environment"] as const) {
  test(`production ${feature} configuration failure keeps recovery alive without durable send start`, async () => {
    const h = harness("send", new ConfigurationError("CONFIG_INCOMPLETE", feature));
    const result = await h.run();
    assert.equal(result.configurationCode, "CONFIG_INCOMPLETE"); assert.equal(result.heartbeatConfirmed, true);
    assert.equal(h.messages.length, 0); assert.equal(result.unknown, 0);
    assert.ok(h.calls.some(call => call.name === "claim_parts_sms_delivery_v1"));
    assert.ok(!h.calls.some(call => ["prepare_parts_sms_send_v1", "complete_parts_sms_delivery_v1"].includes(call.name)));
  });
}
test("production recurrence wiring uses the existing service enqueue and guarded send lifecycle without client source identity", async () => {
  const h = harness("recurrence"); const result = await h.run();
  assert.equal(result.recurrenceQueued, 1); assert.equal(result.accepted, 1); assert.equal(h.messages.length, 1);
  const enqueue = h.calls.find(call => call.name === "enqueue_parts_sms_deliveries_v1");
  assert.ok(enqueue); assert.equal(JSON.stringify(enqueue.args), JSON.stringify({ p_force: false }));
  const finish = h.calls.find(call => call.name === "finish_parts_sms_run_v1");
  assert.ok(finish);
  const summary = finish.args.p_summary;
  assert.ok(summary && typeof summary === "object" && "recurrenceQueued" in summary);
  assert.equal(summary.recurrenceQueued, 1);
  assert.doesNotMatch(JSON.stringify(finish.args), /phone|body|signature|providerMessageId|1202555|SYNTHETIC-WO/);
  assert.ok(h.calls.findIndex(call => call.name === "prepare_parts_sms_send_v1") < h.calls.findIndex(call => call.name === "complete_parts_sms_delivery_v1"));
});
