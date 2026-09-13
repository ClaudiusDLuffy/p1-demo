import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { GraphHttpError } from "./graphClient";
import { receivingDispatchProviderFailure, runReceivingDispatchWorker, type ReceivingDispatchWorkerDependencies } from "./server/receivingDispatchWorker";

function harness(size = 1) {
  const ids = Array.from({ length: size }, () => randomUUID());
  const calls: string[] = [];
  const completions: { id: string; outcome: Parameters<ReceivingDispatchWorkerDependencies["complete"]>[2] }[] = [];
  let elapsed = 0;
  let index = 0;
  const deps: ReceivingDispatchWorkerDependencies = {
    claim: async () => { calls.push("claim"); return index < ids.length ? [{ id: ids[index++] }] : []; },
    accessToken: async () => { calls.push("auth"); return "synthetic-test-token"; },
    prepare: async id => {
      calls.push("prepare");
      return { id, contractorEmail: "synthetic@example.invalid", contractorName: "Synthetic contractor",
        workOrder: { id: "WOT-SYNTHETIC", incidentId: null, storeNumber: "TEST", city: null, state: null,
          address: null, priority: "p1", summary: "Synthetic task", description: null, externalWorkOrderId: null } };
    },
    send: async () => { calls.push("send"); },
    complete: async (id, _token, outcome) => { calls.push("complete"); completions.push({ id, outcome }); },
    now: () => elapsed, operationId: randomUUID,
  };
  return { deps, ids, calls, completions, advance: (ms: number) => { elapsed += ms; } };
}

test("empty receiving drain does not obtain credentials or invoke provider", async () => {
  const h = harness(0); const result = await runReceivingDispatchWorker(h.deps);
  assert.equal(result.claimed, 0); assert.deepEqual(h.calls, ["claim"]);
});

test("receiving worker claims, authorizes, atomically prepares then sends and completes", async () => {
  const h = harness(); const result = await runReceivingDispatchWorker(h.deps);
  assert.equal(result.sent, 1);
  assert.deepEqual(h.calls, ["claim", "auth", "prepare", "send", "complete", "claim"]);
  assert.equal(h.completions[0].outcome.status, "sent");
});

test("maximum batch stays 25 and each delivery is completed before next claim", async () => {
  const h = harness(100); const result = await runReceivingDispatchWorker(h.deps, 1000);
  assert.equal(result.claimed, 25); assert.equal(result.sent, 25);
  for (let i = 0; i < h.calls.length; i += 5) assert.deepEqual(h.calls.slice(i, i + 5), ["claim", "auth", "prepare", "send", "complete"]);
});

test("slow delivery stops new claims within start window while completing current send", async () => {
  const h = harness(5); h.deps.send = async () => { h.advance(15000); };
  const result = await runReceivingDispatchWorker(h.deps);
  assert.equal(result.sent, 1); assert.equal(result.claimed, 1);
});

for (const status of [408, 500, 502, 503]) {
  test(`Graph ${status} is unknown and cannot become an automatic retry`, async () => {
    const h = harness(); h.deps.send = async () => { throw new GraphHttpError("Synthetic send", new Response(null, { status })); };
    const result = await runReceivingDispatchWorker(h.deps);
    assert.equal(result.unknown, 1); assert.equal(result.failed, 0);
    assert.equal(h.completions[0].outcome.code, "GRAPH_OUTCOME_UNKNOWN");
  });
}

test("accepted-then-timeout is unknown with no second send during drain", async () => {
  const h = harness(); let accepted = 0;
  h.deps.send = async () => { accepted++; throw new Error("Synthetic network timeout"); };
  await runReceivingDispatchWorker(h.deps);
  assert.equal(accepted, 1); assert.equal(h.completions[0].outcome.status, "unknown");
});

test("unknown provider payload cannot leak through outcome summaries", () => {
  const outcome = receivingDispatchProviderFailure(new Error("synthetic-private-body synthetic@example.invalid"), true);
  assert.deepEqual(outcome, { status: "unknown", code: "GRAPH_OUTCOME_UNKNOWN", providerStatus: null });
});

test("explicit 429 records known rejection and stops the current drain", async () => {
  const h = harness(3); h.deps.send = async () => { throw new GraphHttpError("Synthetic send", new Response(null, { status: 429 })); };
  const result = await runReceivingDispatchWorker(h.deps);
  assert.equal(result.claimed, 1); assert.equal(result.failed, 1);
  assert.equal(h.completions[0].outcome.code, "GRAPH_RATE_LIMITED");
});

test("explicit terminal rejection is distinct from unknown and rate limiting", async () => {
  const h = harness(); h.deps.send = async () => { throw new GraphHttpError("Synthetic send", new Response(null, { status: 400 })); };
  await runReceivingDispatchWorker(h.deps);
  assert.equal(h.completions[0].outcome.status, "failed");
  assert.equal(h.completions[0].outcome.code, "GRAPH_SEND_REJECTED");
});

test("token failure before send is safe to classify known unsent without preparing or sending", async () => {
  const h = harness(5); h.deps.accessToken = async () => { throw new Error("Graph token request failed due to a network error"); };
  const result = await runReceivingDispatchWorker(h.deps);
  assert.equal(result.failed, 1); assert.equal(result.claimed, 1);
  assert.equal(h.calls.includes("prepare"), false); assert.equal(h.calls.includes("send"), false);
  assert.equal(h.completions[0].outcome.code, "GRAPH_AUTH_RETRYABLE");
});

test("missing provider configuration is terminal and does not hammer other queued rows", async () => {
  const h = harness(5); h.deps.accessToken = async () => { throw new Error("Graph authentication is not configured"); };
  await runReceivingDispatchWorker(h.deps);
  assert.equal(h.completions.length, 1); assert.equal(h.completions[0].outcome.code, "GRAPH_CONFIG_UNAVAILABLE");
});

test("recipient or assignment rejected at prepare does not send", async () => {
  const h = harness(); h.deps.prepare = async () => null;
  const result = await runReceivingDispatchWorker(h.deps);
  assert.equal(result.skipped, 1); assert.equal(h.calls.includes("send"), false); assert.equal(h.completions.length, 0);
});

test("lost prepare response leaves lease recovery to decide outcome without sending", async () => {
  const h = harness(3); h.deps.prepare = async () => { throw new Error("Synthetic response loss"); };
  const result = await runReceivingDispatchWorker(h.deps);
  assert.equal(result.completionUnconfirmed, 1); assert.equal(h.calls.includes("send"), false); assert.equal(h.completions.length, 0);
});

test("provider confirmation followed by database failure never causes automatic resend", async () => {
  const h = harness(3); h.deps.complete = async () => { throw new Error("Synthetic DB outage"); };
  const result = await runReceivingDispatchWorker(h.deps);
  assert.equal(result.sent, 0); assert.equal(result.unknown, 1); assert.equal(result.completionUnconfirmed, 1);
  assert.equal(h.calls.filter(call => call === "send").length, 1);
});

test("unexpected claims and malformed message data fail closed", async () => {
  const h = harness(); h.deps.claim = async () => [{ id: randomUUID() }, { id: randomUUID() }];
  await assert.rejects(runReceivingDispatchWorker(h.deps)); assert.equal(h.calls.includes("send"), false);
  const malformed = harness(); malformed.deps.prepare = async () => ({ id: malformed.ids[0] });
  assert.equal((await runReceivingDispatchWorker(malformed.deps)).failed, 1);
  assert.equal(malformed.completions[0].outcome.code, "RECEIVING_MESSAGE_INVALID");
  assert.equal(malformed.calls.includes("send"), false);
});

test("repeated sequential and small parallel fake-provider drains retain no mutable worker state", async () => {
  for (let i = 0; i < 20; i++) assert.equal((await runReceivingDispatchWorker(harness().deps)).sent, 1);
  const runs = await Promise.all([runReceivingDispatchWorker(harness().deps), runReceivingDispatchWorker(harness().deps)]);
  assert.deepEqual(runs.map(run => run.sent), [1, 1]);
});
