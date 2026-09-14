import assert from "node:assert/strict";
import test from "node:test";
import { installSyntheticAppEnvironment } from "./config-test-support/syntheticAppEnvironment";

installSyntheticAppEnvironment();
import { randomUUID } from "node:crypto";
import { GraphHttpError } from "./graphClient";
import { financialProviderFailure, sendFinancialProviderEmail } from "./server/financialNotificationProvider";
import { financialNotificationMessagePlan, runFinancialNotificationWorker, validateFinancialNotificationCompletion, type FinancialNotificationMessage, type FinancialWorkerDependencies } from "./server/financialNotificationWorker";
import { createInvoicePaymentHoldNotificationPlan, createInvoiceReviewNotificationPlan } from "./notificationService";

function harness(size = 1) {
  const events = Array.from({ length: size }, () => ({ id: randomUUID(), eventId: randomUUID() }));
  const calls: string[] = [];
  const outcomes: Parameters<FinancialWorkerDependencies["complete"]>[2][] = [];
  let elapsed = 0;
  let cursor = 0;
  const message = (index = 0): FinancialNotificationMessage => ({ ...events[index], family: "invoice_rejected", recipientEmail: "synthetic@example.invalid",
    invoice: { num: "TEST-1", workOrderId: "WOT-TEST", externalWorkOrderId: "WOT-ROOT", storeNumber: "TEST", rejectionReason: "Synthetic correction",
      total: 100, contractorName: "Synthetic contractor" }, actorName: "Synthetic staff", reason: "Synthetic hold reason" });
  const deps: FinancialWorkerDependencies = {
    claim: async () => { calls.push("claim"); return { claims: cursor < events.length ? [events[cursor++]] : [],
      notDeliverable: 0, superseded: 0, recoveredBeforeSend: 0, recoveredUnknown: 0 }; },
    accessToken: async () => { calls.push("auth"); return "synthetic-token"; },
    prepare: async id => { calls.push("prepare"); return message(events.findIndex(event => event.id === id)); },
    send: async () => { calls.push("send"); },
    complete: async (_id, _claim, outcome) => { calls.push("complete"); outcomes.push(outcome); },
    now: () => elapsed, operationId: randomUUID,
  };
  return { deps, events, calls, outcomes, message, advance: (ms: number) => { elapsed += ms; } };
}

test("financial empty queue never obtains provider credentials", async () => {
  const h = harness(0); assert.equal((await runFinancialNotificationWorker(h.deps)).claimed, 0);
  assert.deepEqual(h.calls, ["claim"]);
});
test("financial send is owned by claim then durable prepare then completion", async () => {
  const h = harness(); const result = await runFinancialNotificationWorker(h.deps);
  assert.deepEqual(h.calls, ["claim", "auth", "prepare", "send", "complete", "claim"]);
  assert.equal(result.sent, 1); assert.equal(h.outcomes[0].providerStatus, 202);
});
test("financial maximum batch is 25 with strictly sequential provider operations", async () => {
  const h = harness(100); const result = await runFinancialNotificationWorker(h.deps, 1000);
  assert.equal(result.sent, 25);
  for (let offset = 0; offset < h.calls.length; offset += 5) assert.deepEqual(h.calls.slice(offset, offset + 5), ["claim", "auth", "prepare", "send", "complete"]);
});
test("financial admission closes after ten seconds without abandoning an in-flight completion", async () => {
  const h = harness(3); h.deps.send = async () => { h.advance(15_000); };
  assert.equal((await runFinancialNotificationWorker(h.deps)).claimed, 1); assert.equal(h.outcomes[0].status, "sent");
});
test("financial claim failure has no provider side effect", async () => {
  const h = harness(); h.deps.claim = async () => { throw new Error("synthetic database timeout"); };
  await assert.rejects(runFinancialNotificationWorker(h.deps)); assert.equal(h.calls.includes("send"), false);
});
test("financial lost prepare response leaves lease recovery in charge", async () => {
  const h = harness(); h.deps.prepare = async () => { throw new Error("synthetic lost response"); };
  const result = await runFinancialNotificationWorker(h.deps);
  assert.equal(result.completionUnconfirmed, 1); assert.equal(h.outcomes.length, 0); assert.equal(h.calls.includes("send"), false);
});
test("financial superseded or invalid recipient preparation never calls Graph", async () => {
  const h = harness(); h.deps.prepare = async () => null;
  assert.equal((await runFinancialNotificationWorker(h.deps)).skipped, 1); assert.equal(h.calls.includes("send"), false);
});
for (const change of ["recipient", "event", "payload"] as const) {
  test(`financial invalid ${change} payload is known unsent and not forwarded`, async () => {
    const h = harness(); h.deps.prepare = async () => change === "payload" ? {} : {
      ...h.message(), ...(change === "recipient" ? { recipientEmail: "invalid" } : { eventId: randomUUID() }),
    };
    await runFinancialNotificationWorker(h.deps);
    assert.equal(h.outcomes[0].code, "FINANCIAL_MESSAGE_INVALID"); assert.equal(h.calls.includes("send"), false);
  });
}
for (const status of [408, 500, 502, 503]) {
  test(`financial Graph ${status} is unknown, never ordinary retry`, async () => {
    const h = harness(); h.deps.send = async () => { throw new GraphHttpError("Synthetic send", new Response(null, { status })); };
    assert.equal((await runFinancialNotificationWorker(h.deps)).unknown, 1); assert.equal(h.outcomes[0].retryAfterSeconds, null);
  });
}
test("financial accepted-then-timeout cannot cause another automatic send", async () => {
  const h = harness(); let accepted = 0;
  h.deps.send = async () => { accepted++; throw new DOMException("Synthetic abort", "TimeoutError"); };
  await runFinancialNotificationWorker(h.deps); await runFinancialNotificationWorker(h.deps);
  assert.equal(accepted, 1); assert.equal(h.outcomes[0].status, "unknown");
});
test("financial provider success with lost completion is not reported sent", async () => {
  const h = harness(); h.deps.complete = async () => { throw new Error("synthetic completion lost"); };
  const result = await runFinancialNotificationWorker(h.deps);
  assert.equal(result.sent, 0); assert.equal(result.unknown, 1); assert.equal(result.completionUnconfirmed, 1);
});
test("financial completion receipts must confirm the exact delivery and provider outcome", async () => {
  const h = harness();
  for (const value of [null, {}, { id: randomUUID(), state: "sent", replayed: false }, { id: h.events[0].id, state: "unknown", replayed: false }]) {
    assert.throws(() => validateFinancialNotificationCompletion(value, h.events[0].id, "sent"), /COMPLETION_UNCONFIRMED/);
  }
  validateFinancialNotificationCompletion({ id: h.events[0].id, state: "sent", replayed: true }, h.events[0].id, "sent");
  h.deps.complete = async id => { validateFinancialNotificationCompletion(null, id, "sent"); };
  const result = await runFinancialNotificationWorker(h.deps); assert.equal(result.sent, 0); assert.equal(result.completionUnconfirmed, 1);
});
test("financial rate limit preserves Retry-After and stops this batch", async () => {
  const h = harness(3); h.deps.send = async () => { throw new GraphHttpError("Synthetic send", new Response(null, { status: 429, headers: { "retry-after": "900" } })); };
  assert.equal((await runFinancialNotificationWorker(h.deps)).claimed, 1);
  assert.equal(h.outcomes[0].code, "GRAPH_RATE_LIMITED"); assert.equal(h.outcomes[0].retryAfterSeconds, 900);
});
test("financial superseded known-unsent completion confirms the original attempt, never provider delivery", () => {
  const id = randomUUID();
  for (const replayed of [false, true]) {
    validateFinancialNotificationCompletion({ id, state: "failed", deliveryState: "superseded", replayed }, id, "failed");
    validateFinancialNotificationCompletion({ id, state: "unknown", deliveryState: "unknown", replayed }, id, "unknown");
    validateFinancialNotificationCompletion({ id, state: "sent", deliveryState: "sent", replayed }, id, "sent");
  }
  for (const state of ["sent", "unknown"] as const) {
    assert.throws(() => validateFinancialNotificationCompletion({ id, state, deliveryState: "superseded", replayed: false }, id, state), /COMPLETION_UNCONFIRMED/);
  }
  assert.throws(() => validateFinancialNotificationCompletion({ id, state: "failed", deliveryState: "sent", replayed: false }, id, "failed"), /COMPLETION_UNCONFIRMED/);
});
test("financial overlong provider embargo is terminal instead of retrying early", () => {
  const result = financialProviderFailure(new GraphHttpError("Synthetic send", new Response(null, { status: 429, headers: { "retry-after": "90000" } })), true);
  assert.equal(result.code, "GRAPH_RETRY_WINDOW_EXCEEDED"); assert.equal(result.retryAfterSeconds, null);
});
test("financial deterministic rejection and pre-send timeout remain distinct", () => {
  assert.equal(financialProviderFailure(new GraphHttpError("Synthetic send", new Response(null, { status: 400 })), true).code, "GRAPH_SEND_REJECTED");
  assert.equal(financialProviderFailure(new DOMException("synthetic", "TimeoutError"), false).code, "GRAPH_AUTH_RETRYABLE");
});
test("financial configuration failure cannot hammer the remaining queue", async () => {
  const h = harness(20); h.deps.accessToken = async () => { throw new Error("Graph authentication is not configured"); };
  assert.equal((await runFinancialNotificationWorker(h.deps)).claimed, 1);
  assert.equal(h.outcomes[0].code, "GRAPH_CONFIG_UNAVAILABLE"); assert.equal(h.calls.includes("prepare"), false);
});
test("financial claim classification and lease recovery remain visible without sending", async () => {
  const h = harness();
  h.deps.claim = async () => ({ claims: [], notDeliverable: 1, superseded: 0, recoveredBeforeSend: 1, recoveredUnknown: 2 });
  const result = await runFinancialNotificationWorker(h.deps, 2);
  assert.equal(result.claimed, 0); assert.equal(result.notDeliverable, 2); assert.equal(result.recoveredUnknown, 4);
  assert.equal(result.recoveredBeforeSend, 2); assert.equal(h.calls.includes("auth"), false);
});
test("financial prepare terminal classifications are reported without a second completion", async () => {
  for (const status of ["not_deliverable", "superseded", "failed"] as const) {
    const h = harness(); h.deps.prepare = async () => ({ status });
    const result = await runFinancialNotificationWorker(h.deps);
    assert.equal(status === "not_deliverable" ? result.notDeliverable : result[status], 1);
    assert.equal(h.outcomes.length, 0); assert.equal(h.calls.includes("send"), false);
  }
});
test("financial expired superseded claims are bounded recovery, not new provider attempts", async () => {
  const h = harness(0);
  h.deps.claim = async () => ({ claims: [], notDeliverable: 0, superseded: 101, recoveredBeforeSend: 0, recoveredUnknown: 0 });
  const result = await runFinancialNotificationWorker(h.deps, 1);
  assert.equal(result.superseded, 101); assert.equal(result.claimed, 0); assert.equal(h.calls.includes("send"), false);
  h.deps.claim = async () => ({ claims: [], notDeliverable: 0, superseded: 102, recoveredBeforeSend: 0, recoveredUnknown: 0 });
  await assert.rejects(runFinancialNotificationWorker(h.deps, 1));
});
test("financial summaries cannot contain private provider errors or recipients", async () => {
  const h = harness(); h.deps.send = async () => { throw new Error("synthetic-secret synthetic@example.invalid private-invoice-body"); };
  const result = await runFinancialNotificationWorker(h.deps);
  assert.doesNotMatch(JSON.stringify({ result, outcomes: h.outcomes }), /synthetic-secret|@|private-invoice-body/);
});
for (const family of ["invoice_rejected", "invoice_rejection_retracted", "payment_hold_placed", "payment_hold_released"] as const) {
  test(`financial ${family} retains the existing exact subject/body template`, () => {
    const m = { ...harness().message(), family };
    const plan = financialNotificationMessagePlan(m);
    const expected = family.startsWith("invoice_") ? createInvoiceReviewNotificationPlan({ event: family === "invoice_rejected" ? "rejected" : "retraction", recipients: [m.recipientEmail], invoice: { ...m.invoice, workOrderId: "WOT-TEST" } })
      : createInvoicePaymentHoldNotificationPlan({ event: family === "payment_hold_placed" ? "placed" : "released", recipients: [m.recipientEmail], invoice: m.invoice, actorName: m.actorName || "P1 staff", reason: m.reason || "" });
    assert.deepEqual(plan, expected); assert.doesNotMatch(plan.body, /previous contractor|outgoing|assignment history/i);
  });
}
test("financial Graph adapter requires actual 202 acceptance and uses a cancellation signal", async () => {
  const original = globalThis.fetch;
  const configured = { OUTLOOK_TENANT_ID: "synthetic-tenant", OUTLOOK_CLIENT_ID: "synthetic-client", OUTLOOK_CLIENT_SECRET: "synthetic-secret", OUTLOOK_USER_EMAIL: "synthetic-sender@example.invalid" };
  const previous = Object.fromEntries(Object.keys(configured).map(key => [key, process.env[key]]));
  Object.assign(process.env, configured);
  let status = 202;
  globalThis.fetch = async (_url, init) => { assert.ok(init?.signal); return new Response(null, { status }); };
  try {
    await sendFinancialProviderEmail("synthetic-token", "synthetic@example.invalid", "Synthetic", "Synthetic");
    status = 200;
    await assert.rejects(sendFinancialProviderEmail("synthetic-token", "synthetic@example.invalid", "Synthetic", "Synthetic"), /acceptance could not be confirmed/);
  } finally {
    globalThis.fetch = original;
    for (const key of Object.keys(configured)) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
  }
});
test("financial legacy hold/release without a work order retains its valid template and delivery", async () => {
  for (const family of ["payment_hold_placed", "payment_hold_released"] as const) {
    const h = harness(); const m = { ...h.message(), family, invoice: { ...h.message().invoice, workOrderId: null } };
    h.deps.prepare = async () => m;
    assert.equal((await runFinancialNotificationWorker(h.deps)).sent, 1);
    const plan = financialNotificationMessagePlan(m);
    assert.equal(plan.subject, createInvoicePaymentHoldNotificationPlan({ event: family === "payment_hold_placed" ? "placed" : "released",
      recipients: [m.recipientEmail], invoice: m.invoice, actorName: m.actorName || "P1 staff", reason: m.reason || "" }).subject);
  }
  const h = harness(); h.deps.prepare = async () => ({ ...h.message(), invoice: { ...h.message().invoice, workOrderId: null } });
  await runFinancialNotificationWorker(h.deps); assert.equal(h.outcomes[0].code, "FINANCIAL_MESSAGE_INVALID");
});
test("financial accepted-without-response cancels at the named 15-second boundary", async () => {
  const original = globalThis.fetch;
  const configured = { OUTLOOK_TENANT_ID: "synthetic-tenant", OUTLOOK_CLIENT_ID: "synthetic-client", OUTLOOK_CLIENT_SECRET: "synthetic-secret", OUTLOOK_USER_EMAIL: "synthetic-sender@example.invalid" };
  const previous = Object.fromEntries(Object.keys(configured).map(key => [key, process.env[key]]));
  Object.assign(process.env, configured);
  let accepted = 0;
  globalThis.fetch = async (_url, init) => {
    accepted++;
    const signal = init?.signal; assert.ok(signal);
    return new Promise<Response>((_resolve, reject) => {
      if (signal.aborted) reject(signal.reason);
      else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  };
  const keepAlive = setTimeout(() => undefined, 25_000);
  const start = performance.now();
  try {
    await assert.rejects(sendFinancialProviderEmail("synthetic-token", "synthetic@example.invalid", "Synthetic", "Synthetic"), error => {
      assert.equal(financialProviderFailure(error, true).status, "unknown"); return true;
    });
    const elapsed = performance.now() - start;
    assert.ok(elapsed >= 14_000 && elapsed < 24_000); assert.equal(accepted, 1);
    console.info("financial_provider_timeout_measurement", { durationMs: Math.round(elapsed), acceptedSynthetic: accepted });
  } finally {
    clearTimeout(keepAlive); globalThis.fetch = original;
    for (const key of Object.keys(configured)) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
  }
});
test("financial fake-provider worker local resource measurements", async () => {
  const timings: Record<string, number> = {};
  for (const size of [0, 1, 25]) {
    const h = harness(size); const start = performance.now(); await runFinancialNotificationWorker(h.deps);
    timings[`batch${size}Ms`] = Number((performance.now() - start).toFixed(3));
  }
  const mixed = harness(25); let sent = 0;
  mixed.deps.send = async () => { if (++sent % 3 === 0) throw new Error("synthetic lost response"); };
  const start = performance.now(); const summary = await runFinancialNotificationWorker(mixed.deps);
  timings.mixed25Ms = Number((performance.now() - start).toFixed(3));
  assert.equal(summary.sent, 17); assert.equal(summary.unknown, 8);
  const left = harness(25); const right = harness(25);
  const overlap = performance.now(); await Promise.all([runFinancialNotificationWorker(left.deps), runFinancialNotificationWorker(right.deps)]);
  timings.twoIndependentFakeWorkersMs = Number((performance.now() - overlap).toFixed(3));
  console.info("financial_worker_local_measurements", timings);
});
