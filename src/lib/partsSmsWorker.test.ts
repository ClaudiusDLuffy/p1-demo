import test from "node:test";
import assert from "node:assert/strict";
import { PARTS_SMS_SEND_LIMIT, partsSmsDatabaseRequest, runPartsSmsWorker, type PartsSmsWorkerDependencies } from "./server/partsSmsWorker";
import { ConfigurationError } from "./config/shared";

const id = "00000000-0000-4000-8000-000000000001";
const sid = `SM${"1".repeat(32)}`;
const counts = { recoveredBeforeSend: 0, recoveredUnknown: 0, superseded: 0, notDeliverable: 0 };
function fixture(overrides: Partial<PartsSmsWorkerDependencies> = {}) {
  const calls: string[] = [];
  let claims = 0;
  const deps: PartsSmsWorkerDependencies = {
    start: async runId => { calls.push("start"); return { runId, enabled: true, timezone: "America/New_York", cutoffTime: "14:00" }; },
    enqueue: async () => { calls.push("enqueue"); return { status: "queued", localDate: "2026-09-10", queued: 1, skipped: 0, superseded: 0, parts: 1, workOrders: 1 }; },
    claim: async () => ({ claim: claims++ === 0 ? { id } : null, ...counts }),
    prepare: async () => { calls.push("prepare"); return { id, phoneE164: "+12025550123", localDate: "2026-09-10", requestSignature: "a".repeat(64), parts: 1, workOrders: 1, previewIds: ["SYNTHETIC-WO"] }; },
    send: async () => { calls.push("send"); return { status: "accepted", sid, providerStatus: "queued" }; },
    complete: async (deliveryId, _token, outcome) => {
      calls.push(`complete:${outcome.status}`);
      return { id: deliveryId, state: outcome.status === "accepted" ? "accepted" : outcome.status === "unknown" ? "unknown" : "failed", replayed: false };
    },
    claimStatus: async () => ({ claim: null, stale: 0 }),
    lookup: async () => ({ status: "observed", providerStatus: "delivered" }),
    completeStatus: async deliveryId => ({ id: deliveryId, state: "delivered", replayed: false }),
    finish: async runId => { calls.push("finish"); return { runId, completed: true, replayed: false }; },
    operationId: () => id, now: () => 0, portalUrl: "https://portal.example.test/?view=dashboard",
    ...overrides,
  };
  return { deps, calls };
}

test("parts worker durably starts and prepares before provider send; accepted is not delivered", async () => {
  const f = fixture(); const result = await runPartsSmsWorker(f.deps);
  assert.deepEqual(f.calls, ["start", "enqueue", "prepare", "send", "complete:accepted", "finish"]);
  assert.equal(result.accepted, 1); assert.equal(result.deliveredUpdates, 0);
  assert.equal(result.resultCode, "RUN_COMPLETE"); assert.equal(result.heartbeatConfirmed, true);
  assert.ok(!JSON.stringify(result).includes(sid)); assert.ok(!JSON.stringify(result).includes("1202555"));
});

test("parts worker unknown provider outcome is persisted once without retry", async () => {
  const f = fixture({ send: async () => ({ status: "unknown", code: "TWILIO_UNKNOWN" }) });
  const result = await runPartsSmsWorker(f.deps);
  assert.equal(result.unknown, 1); assert.equal(result.accepted, 0);
  assert.equal(f.calls.filter(call => call.startsWith("complete:")).length, 1);
});

test("parts worker thrown send outcome is conservatively unknown", async () => {
  const f = fixture({ send: async () => { throw new Error("synthetic private transport failure"); } });
  const result = await runPartsSmsWorker(f.deps);
  assert.equal(result.unknown, 1); assert.ok(!JSON.stringify(result).includes("private"));
});

test("parts worker completion loss never downgrades accepted result to failed", async () => {
  let completions = 0;
  const f = fixture({ complete: async () => { completions++; throw new Error("lost commit response"); } });
  const result = await runPartsSmsWorker(f.deps);
  assert.equal(completions, 1); assert.equal(result.completionUnconfirmed, 1);
  assert.equal(result.unknown, 1); assert.equal(result.accepted, 0); assert.equal(result.resultCode, "RUN_PARTIAL");
});

test("parts worker uncertain prepare response does not call provider or attempt a compensating completion", async () => {
  const f = fixture({ prepare: async () => { throw new Error("send-start may have committed"); } });
  const result = await runPartsSmsWorker(f.deps);
  assert.equal(result.completionUnconfirmed, 1); assert.ok(!f.calls.includes("send"));
  assert.ok(!f.calls.some(call => call.startsWith("complete:")));
});

for (const state of ["superseded", "not_deliverable"] as const) {
  test(`parts worker does not send a ${state} prepared claim`, async () => {
    const f = fixture({ prepare: async () => ({ status: state }) });
    const result = await runPartsSmsWorker(f.deps);
    assert.ok(!f.calls.includes("send")); assert.equal(result[state === "superseded" ? "superseded" : "notDeliverable"], 1);
  });
}

test("parts worker rejects corrupt or wrong-ID trusted payload without sending", async () => {
  const f = fixture({ prepare: async () => ({ id: "wrong", phoneE164: "invalid" }) });
  const result = await runPartsSmsWorker(f.deps);
  assert.equal(result.failed, 1); assert.ok(!f.calls.includes("send"));
});

test("parts worker known-unsent retry is bounded and stops provider outage bursts", async () => {
  const f = fixture({ claim: async () => ({ claim: { id }, ...counts }), send: async () => ({ status: "known_unsent_retryable", code: "TWILIO_BEFORE_SEND_CANCELLED" }) });
  const result = await runPartsSmsWorker(f.deps);
  assert.equal(result.retryableFailed, 1); assert.equal(result.claimed, 1);
});

test("parts worker missing provider config persists safe not-deliverable and stops the batch", async () => {
  const f = fixture({ claim: async () => ({ claim: { id }, ...counts }), send: async () => ({ status: "known_unsent_terminal", code: "TWILIO_NOT_CONFIGURED" }),
    complete: async () => ({ id, state: "not_deliverable", replayed: false }) });
  const result = await runPartsSmsWorker(f.deps);
  assert.equal(result.claimed, 1); assert.equal(result.notDeliverable, 1); assert.equal(result.resultCode, "TWILIO_NOT_CONFIGURED");
});

test("parts worker claim count and concurrency remain bounded at maximum recipients", async () => {
  let sending = 0; let peak = 0;
  const f = fixture({ claim: async () => ({ claim: { id }, ...counts }), send: async () => {
    sending++; peak = Math.max(peak, sending); await Promise.resolve(); sending--;
    return { status: "accepted", sid, providerStatus: "queued" };
  } });
  const result = await runPartsSmsWorker(f.deps, { limit: 100_000 });
  assert.equal(result.claimed, PARTS_SMS_SEND_LIMIT); assert.equal(peak, 1);
});

test("parts worker admission window stops new claims without discarding prior completion", async () => {
  let elapsed = 0;
  const f = fixture({ now: () => elapsed, send: async () => { elapsed = 30_000; return { status: "accepted", sid, providerStatus: "queued" }; } });
  const result = await runPartsSmsWorker(f.deps);
  assert.equal(result.accepted, 1); assert.equal(result.claimed, 1);
});

test("parts worker records expired pre-send and ambiguous send-start recoveries", async () => {
  const f = fixture({ claim: async () => ({ claim: null, ...counts, recoveredBeforeSend: 2, recoveredUnknown: 3 }) });
  const result = await runPartsSmsWorker(f.deps);
  assert.equal(result.recoveredBeforeSend, 2); assert.equal(result.recoveredUnknown, 3);
});

test("configuration failure permits bounded recovery but never starts or fabricates a provider outcome", async () => {
  let claimed = 0;
  const f = fixture({ configurationError: new ConfigurationError("CONFIG_INVALID", "app_environment"),
    claim: async () => { claimed++; return { claim: { id }, ...counts, recoveredBeforeSend: 1, recoveredUnknown: 2 }; },
    finish: async (runId, summary, result) => {
      assert.equal(result, "RUN_PARTIAL"); assert.equal(Object.values(summary).every(value => typeof value === "number"), true);
      return { runId, completed: true, replayed: false };
    } });
  const result = await runPartsSmsWorker(f.deps);
  assert.equal(claimed, 1); assert.equal(result.configurationCode, "CONFIG_INVALID");
  assert.equal(result.recoveredBeforeSend, 1); assert.equal(result.recoveredUnknown, 2);
  assert.equal(result.unknown, 0); assert.equal(result.notDeliverable, 0);
  assert.equal(f.calls.includes("prepare"), false); assert.equal(f.calls.includes("send"), false);
  assert.equal(f.calls.some(value => value.startsWith("complete:")), false);
  // The subsequent valid run may reclaim the same pre-start event; no provider
  // outcome or ambiguous attempt was invented by configuration handling.
  delete f.deps.configurationError;
  f.deps.claim = async () => ({ claim: claimed++ === 1 ? { id } : null, ...counts, recoveredBeforeSend: 1 });
  f.deps.finish = async runId => ({ runId, completed: true, replayed: false });
  assert.equal((await runPartsSmsWorker(f.deps)).accepted, 1);
});

test("disabled optional provider without pending work does not become a false outage", async () => {
  const f = fixture({ configurationError: new ConfigurationError("FEATURE_DISABLED", "twilio"),
    claim: async () => ({ claim: null, ...counts }),
    enqueue: async () => ({ status: "disabled", localDate: null, queued: 0, skipped: 0, superseded: 0, parts: 0, workOrders: 0 }) });
  const result = await runPartsSmsWorker(f.deps);
  assert.equal(result.resultCode, "RUN_COMPLETE"); assert.equal(result.configurationCode, null);
  assert.equal(result.heartbeatConfirmed, true);
});

test("invalid link configuration does not block safe stored-SID status observation", async () => {
  let statusClaims = 0; let lookedUp = 0;
  const f = fixture({ configurationError: new ConfigurationError("CONFIG_INVALID", "app_environment"),
    claim: async () => ({ claim: null, ...counts }),
    claimStatus: async () => ({ claim: statusClaims++ === 0 ? { id, providerMessageId: sid } : null, stale: 0 }),
    lookup: async value => { assert.equal(value, sid); lookedUp++; return { status: "observed", providerStatus: "delivered" }; } });
  const result = await runPartsSmsWorker(f.deps);
  assert.equal(lookedUp, 1); assert.equal(result.deliveredUpdates, 1); assert.equal(result.accepted, 0);
  assert.equal(f.calls.includes("prepare"), false);
});

test("parts worker empty/disabled evaluation still records heartbeat and status reconciliation", async () => {
  const f = fixture({ enqueue: async () => ({ status: "disabled", localDate: null, queued: 0, skipped: 0, superseded: 0, parts: 0, workOrders: 0 }), claim: async () => ({ claim: null, ...counts }) });
  const result = await runPartsSmsWorker(f.deps);
  assert.equal(result.evaluation, "disabled"); assert.equal(result.claimed, 0); assert.equal(result.heartbeatConfirmed, true);
});

test("parts worker status refresh uses stored SID and never sends on lookup failure", async () => {
  let statusClaims = 0; let observed: unknown;
  const f = fixture({ claim: async () => ({ claim: null, ...counts }),
    claimStatus: async () => ({ claim: statusClaims++ === 0 ? { id, providerMessageId: sid } : null, stale: 0 }),
    lookup: async storedSid => { assert.equal(storedSid, sid); return { status: "unavailable", code: "TWILIO_STATUS_UNAVAILABLE" }; },
    completeStatus: async (_id, _token, outcome) => { observed = outcome; return { id, state: "accepted", replayed: false }; },
  });
  const result = await runPartsSmsWorker(f.deps);
  assert.deepEqual(observed, { status: "unavailable", code: "TWILIO_STATUS_UNAVAILABLE" });
  assert.equal(result.statusUnavailable, 1); assert.equal(result.accepted, 0); assert.ok(!f.calls.includes("send"));
});

test("parts worker provider-confirmed delivery is counted separately from accepted sends", async () => {
  let statusClaims = 0;
  const f = fixture({ claim: async () => ({ claim: null, ...counts }), claimStatus: async () => ({ claim: statusClaims++ === 0 ? { id, providerMessageId: sid } : null, stale: 0 }) });
  const result = await runPartsSmsWorker(f.deps);
  assert.equal(result.deliveredUpdates, 1); assert.equal(result.accepted, 0);
});

test("parts worker does not falsely confirm malformed database completion", async () => {
  const f = fixture({ complete: async () => ({ id, state: "delivered", replayed: false }) });
  const result = await runPartsSmsWorker(f.deps);
  assert.equal(result.accepted, 0); assert.equal(result.completionUnconfirmed, 1);
});

test("parts worker failed heartbeat completion remains visible in response", async () => {
  const f = fixture({ finish: async () => { throw new Error("synthetic unavailable"); } });
  const result = await runPartsSmsWorker(f.deps);
  assert.equal(result.accepted, 1); assert.equal(result.heartbeatConfirmed, false); assert.equal(result.resultCode, "RUN_PARTIAL");
});

test("parts worker cannot proceed without durable run start", async () => {
  const f = fixture({ start: async () => { throw new Error("private database error"); } });
  await assert.rejects(runPartsSmsWorker(f.deps), /PARTS_SMS_RUN_UNAVAILABLE/);
  assert.equal(f.calls.length, 0);
});

test("parts worker records safe failure if event creation fails", async () => {
  const f = fixture({ enqueue: async () => { throw new Error("private database error"); } });
  const result = await runPartsSmsWorker(f.deps);
  assert.equal(result.resultCode, "DATABASE_UNAVAILABLE"); assert.ok(!f.calls.includes("send")); assert.equal(result.heartbeatConfirmed, true);
});

test("parts database deadline aborts even a transport that ignores cancellation", async () => {
  let observed: AbortSignal | undefined;
  const started = performance.now();
  await assert.rejects(partsSmsDatabaseRequest(signal => { observed = signal; return new Promise(() => undefined); }, undefined, 15), /PARTS_SMS_DATABASE_UNAVAILABLE/);
  assert.equal(observed?.aborted, true); assert.ok(performance.now() - started < 500);
});

test("parts database cancellation before request is provably nonexecuting", async () => {
  let writes = 0;
  await assert.rejects(partsSmsDatabaseRequest(async () => { writes++; return { data: null, error: null }; }, AbortSignal.abort()), /PARTS_SMS_DATABASE_UNAVAILABLE/);
  assert.equal(writes, 0);
});

test("parts database failures redact internal details and clear deadline after success", async () => {
  await assert.rejects(partsSmsDatabaseRequest(async () => ({ data: null, error: { message: "synthetic private SQL" } })), /^Error: PARTS_SMS_DATABASE_UNAVAILABLE$/);
  assert.deepEqual(await partsSmsDatabaseRequest(async () => ({ data: { result: true }, error: null })), { result: true });
});

for (const providerStatus of ["failed", "undelivered"] as const) {
  test(`parts provider acceptance with immediate ${providerStatus} remains a visible run failure`, async () => {
    const f = fixture({ send: async () => ({ status: "accepted", sid, providerStatus }),
      complete: async () => ({ id, state: "failed", replayed: false }) });
    const result = await runPartsSmsWorker(f.deps);
    assert.equal(result.accepted, 1); assert.equal(result.failed, 1); assert.equal(result.resultCode, "RUN_PARTIAL");
  });
}

test("parts source recurrence quarantine is an accountable policy result, not a worker failure or successful communication", async () => {
  const f = fixture({ enqueue: async () => ({ status: "queued", localDate: "2026-09-10", queued: 0, skipped: 1, superseded: 1, parts: 1, workOrders: 1, recurrenceBlocked: 1 }),
    claim: async () => ({ claim: null, ...counts }) });
  const result = await runPartsSmsWorker(f.deps);
  assert.equal(result.recurrenceBlocked, 1); assert.equal(result.resultCode, "RUN_COMPLETE"); assert.ok(!f.calls.includes("send"));
  assert.equal(result.accepted, 0); assert.equal(result.deliveredUpdates, 0);
});

test("parts worker records safely queued recurrence separately without inflating eligible recipient count", async () => {
  let recorded: unknown;
  const f = fixture({ enqueue: async () => ({ status: "queued", localDate: "2026-09-10", queued: 1, skipped: 0, superseded: 1,
    parts: 1, workOrders: 1, recurrenceQueued: 1, recurrenceBlocked: 0 }),
    finish: async (runId, summary, code) => { recorded = { summary, code }; return { runId, completed: true, replayed: false }; } });
  const result = await runPartsSmsWorker(f.deps);
  assert.equal(result.recurrenceQueued, 1); assert.equal(result.queued, 1); assert.equal(result.eligible, 1);
  assert.equal(result.accepted, 1); assert.equal(result.deliveredUpdates, 0);
  assert.equal(result.resultCode, "RUN_COMPLETE");
  assert.ok(recorded && typeof recorded === "object" && "summary" in recorded);
  assert.deepEqual(recorded.summary, Object.fromEntries(Object.entries(result).filter(([key]) => !["runId", "evaluation", "localDate", "resultCode", "heartbeatConfirmed", "configurationCode"].includes(key))));
  assert.ok(recorded.summary && typeof recorded.summary === "object");
  assert.ok(Object.keys(recorded.summary).length <= 24);
  assert.doesNotMatch(JSON.stringify(recorded), /phone|body|signature|providerMessageId|1202555|SYNTHETIC-WO/i);
});

test("parts worker recurrence replay reports no newly queued unit and does not send without a claim", async () => {
  const f = fixture({ enqueue: async () => ({ status: "queued", localDate: "2026-09-10", queued: 0, skipped: 1, superseded: 0,
    parts: 1, workOrders: 1, recurrenceQueued: 0, recurrenceBlocked: 0 }), claim: async () => ({ claim: null, ...counts }) });
  const result = await runPartsSmsWorker(f.deps);
  assert.equal(result.recurrenceQueued, 0); assert.equal(result.eligible, 1); assert.equal(result.claimed, 0);
  assert.ok(!f.calls.includes("send")); assert.equal(result.resultCode, "RUN_COMPLETE");
});

test("parts worker old enqueue response remains compatible with zero recurrence counters", async () => {
  const result = await runPartsSmsWorker(fixture().deps);
  assert.equal(result.recurrenceQueued, 0); assert.equal(result.recurrenceBlocked, 0);
});

for (const invalid of ["1", -1, 0.5, 26, null]) {
  test(`parts worker rejects invalid recurrence count ${JSON.stringify(invalid)} before any provider call`, async () => {
    const f = fixture({ enqueue: async () => ({ status: "queued", localDate: "2026-09-10", queued: 1, skipped: 0,
      superseded: 0, parts: 1, workOrders: 1, recurrenceQueued: invalid }) });
    const result = await runPartsSmsWorker(f.deps);
    assert.equal(result.resultCode, "DATABASE_UNAVAILABLE"); assert.equal(result.heartbeatConfirmed, true);
    assert.ok(!f.calls.includes("send"));
  });
}

for (const counters of [{ recurrenceQueued: 2, recurrenceBlocked: 0 }, { recurrenceQueued: 0, recurrenceBlocked: 1 }]) {
  test(`parts worker rejects recurrence counters inconsistent with recipient totals ${JSON.stringify(counters)}`, async () => {
    const f = fixture({ enqueue: async () => ({ status: "queued", localDate: "2026-09-10", queued: 1, skipped: 0,
      superseded: 0, parts: 1, workOrders: 1, ...counters }) });
    const result = await runPartsSmsWorker(f.deps);
    assert.equal(result.resultCode, "DATABASE_UNAVAILABLE"); assert.ok(!f.calls.includes("send"));
  });
}

test("parts worker safe recurrence still becomes unknown on provider uncertainty and never compensates with retry", async () => {
  const f = fixture({ enqueue: async () => ({ status: "queued", localDate: "2026-09-10", queued: 1, skipped: 0,
    superseded: 1, parts: 1, workOrders: 1, recurrenceQueued: 1 }), send: async () => ({ status: "unknown", code: "TWILIO_UNKNOWN" }) });
  const result = await runPartsSmsWorker(f.deps);
  assert.equal(result.recurrenceQueued, 1); assert.equal(result.unknown, 1); assert.equal(result.resultCode, "RUN_PARTIAL");
  assert.deepEqual(f.calls.filter(call => call.startsWith("complete:")), ["complete:unknown"]);
});

test("parts worker revalidates a newly queued recurrence and skips it when its source changed before send", async () => {
  const f = fixture({ enqueue: async () => ({ status: "queued", localDate: "2026-09-10", queued: 1, skipped: 0,
    superseded: 1, parts: 1, workOrders: 1, recurrenceQueued: 1 }), prepare: async () => ({ status: "superseded" }) });
  const result = await runPartsSmsWorker(f.deps);
  assert.equal(result.recurrenceQueued, 1); assert.equal(result.superseded, 2); assert.equal(result.accepted, 0);
  assert.ok(!f.calls.includes("send")); assert.ok(!f.calls.some(call => call.startsWith("complete:")));
});
