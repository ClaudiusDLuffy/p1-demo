import assert from "node:assert/strict";
import test from "node:test";
import { createActivityVisitReadHarness, rawPage, record, respond } from "./activity-visit-read-test-support/harness";
import { ACTIVITY_ID, ACTIVITY_AUTHOR, ACTIVITY_PARENT, activityFixture, expectedActivity } from "./activity-visit-read-test-support/activity-fixtures";

const parent = { id: ACTIVITY_PARENT, storeTimezone: "America/New_York" };
const firstItem = (value: unknown): Record<string, unknown> => {
  const items: unknown = record(value).items;
  assert.ok(Array.isArray(items));
  return record(items[0]);
};

test("activity real facade preserves exact first-page DTO bytes, key order, one query and private-field exclusion", async () => {
  const raw = activityFixture({ server_private_extra: "must not escape" });
  const harness = createActivityVisitReadHarness([respond(rawPage([raw]))]);
  const page = await harness.loadActivities(parent);
  const expected = { items: [expectedActivity()], nextCursor: null, hasMore: false, totalCount: null, aggregates: undefined };
  assert.deepEqual(page, expected);
  assert.equal(JSON.stringify(page), JSON.stringify(expected));
  assert.equal(Object.keys(firstItem(page)).length, 21);
  assert.deepEqual(harness.calls, [{ name: "list_work_order_activities_rows_v1",
    args: { p_work_order_id: ACTIVITY_PARENT, p_limit: 30, p_cursor: null }, signal: undefined }]);
  assert.equal(harness.remainingPlans(), 0);
});

for (const [label, limit, expected] of [
  ["default", undefined, 30], ["one", 1, 1], ["maximum", 100, 100], ["over maximum", 101, 100],
  ["zero", 0, 1], ["negative", -4, 1], ["fractional", 17.9, 17], ["nonfinite", NaN, 25],
] as const) test(`activity real facade ${label} page limit stays compatible`, async () => {
  const harness = createActivityVisitReadHarness([respond(rawPage([]))]);
  assert.deepEqual(await harness.loadActivities(parent, null, limit), { items: [], nextCursor: null, hasMore: false, totalCount: null, aggregates: undefined });
  assert.equal(harness.calls.length, 1); assert.equal(harness.calls[0].args.p_limit, expected);
});

test("activity real facade preserves opaque continuation bytes and performs no count query", async () => {
  const cursor = "eyJjcmVhdGVkIjoiMjAyNi0wOS0wNVQxMjowMDowMFoiLCJpZCI6ImE3NjAwMDAwLTAwMDAtNDAwMC04MDAwLTAwMDAwMDAwMDAwMSJ9";
  const harness = createActivityVisitReadHarness([respond(rawPage([activityFixture()], cursor)), respond(rawPage([]))]);
  const first = record(await harness.loadActivities(parent));
  assert.equal(first.nextCursor, cursor); assert.equal(first.hasMore, true); assert.equal(first.totalCount, null);
  await harness.loadActivities(parent, cursor);
  assert.equal(harness.calls[1].args.p_cursor, cursor); assert.equal(harness.calls.length, 2);
});

test("activity real facade accepts existing JSON envelope and explicit finite aggregate representation", async () => {
  const harness = createActivityVisitReadHarness([respond(JSON.stringify({ ...rawPage([activityFixture()]), totalCount: 1, aggregates: { amount: "1.25" } }))]);
  const page = record(await harness.loadActivities(parent));
  assert.equal(page.totalCount, 1); assert.deepEqual(page.aggregates, { amount: 1.25 });
});

const channelCases: readonly [string, Record<string, unknown>, Record<string, unknown>][] = [
  ["general contractor message", {}, {}],
  ["staff internal note", { activity_channel: "internal_note", is_staff_only: true }, { activityChannel: "internal_note", isStaffOnly: true }],
  ["field note requiring 7-Eleven sync", { activity_channel: "field_note", requires_7eleven_sync: true }, { activityChannel: "field_note", requiresSevenElevenSync: true }],
  ["system event", { activity_channel: "system_event", type: "system" }, { activityChannel: "system_event", type: "system" }],
  ["legacy custom type", { activity_channel: "legacy", type: "historic_custom_type", event_key: "custom_legacy_event" }, { activityChannel: "legacy", type: "historic_custom_type", eventKey: "custom_legacy_event" }],
];
for (const [label, rawPatch, expectedPatch] of channelCases) test(`activity real facade maps ${label} without recomputing visibility`, async () => {
  const harness = createActivityVisitReadHarness([respond(rawPage([activityFixture(rawPatch)]))]);
  assert.deepEqual(firstItem(await harness.loadActivities(parent)), expectedActivity(expectedPatch));
});

for (const event of ["check_in", "job_paused", "check_out", "job_completed", "invoice_submitted", "invoice_approved", "priority_changed", "custom_legacy_event"]) {
  test(`activity real facade retains authoritative ${event} event key and payload`, async () => {
    const lifecycle = ["check_in", "job_paused", "check_out", "job_completed"].includes(event);
    const channel = lifecycle ? "field_note" : "system_event";
    const harness = createActivityVisitReadHarness([respond(rawPage([activityFixture({ activity_channel: channel,
      requires_7eleven_sync: lifecycle, type: "system", event_key: event })]))]);
    assert.deepEqual(firstItem(await harness.loadActivities(parent)), expectedActivity({ activityChannel: channel,
      requiresSevenElevenSync: lifecycle, type: "system", eventKey: event }));
  });
}

for (const role of ["manager", "dispatcher", "back_office", "contractor", "system"]) test(`activity mapper preserves stored author role ${role}, not authorization policy`, async () => {
  const harness = createActivityVisitReadHarness([respond(rawPage([activityFixture({ entered_by_role: role })]))]);
  assert.equal(firstItem(await harness.loadActivities(parent)).enteredByRole, role);
});

for (const cycle of [-1, 0, 2, 3]) test(`activity real facade retains schema-valid workflow cycle ${cycle} without filtering`, async () => {
  const harness = createActivityVisitReadHarness([respond(rawPage([activityFixture({ workflow_cycle: cycle })]))]);
  assert.equal(firstItem(await harness.loadActivities(parent)).workflowCycle, cycle);
});

test("activity real facade retains nullable legacy author/type/timestamp and epoch display", async () => {
  const harness = createActivityVisitReadHarness([respond(rawPage([activityFixture({ author_id: null, type: null, created_at: null })]))]);
  assert.deepEqual(firstItem(await harness.loadActivities(parent)), expectedActivity({ authorId: null, type: null, createdAt: null, time: "Dec 31, 7:00 PM" }));
});

for (const value of [null, false, 0, ""] as const) test(`activity real facade preserves existing JSON scalar ${String(value)} fallback`, async () => {
  const harness = createActivityVisitReadHarness([respond(rawPage([activityFixture({ event_data: value })]))]);
  assert.deepEqual(firstItem(await harness.loadActivities(parent)).eventData, {});
});

test("activity real facade preserves sync/attention/override evidence without leaking raw parent assignment facts", async () => {
  const at = "2026-09-06T12:00:00Z";
  const harness = createActivityVisitReadHarness([respond(rawPage([activityFixture({ is_staff_override: true,
    override_for_contractor_id: ACTIVITY_AUTHOR, synced_to_7eleven_at: at, synced_to_7eleven_by: ACTIVITY_AUTHOR,
    requires_contractor_attention: true, contractor_attention_acknowledged_at: at, contractor_attention_acknowledged_by: ACTIVITY_AUTHOR })]))]);
  assert.deepEqual(firstItem(await harness.loadActivities(parent)), expectedActivity({ isStaffOverride: true,
    overrideForContractorId: ACTIVITY_AUTHOR, syncedToSevenElevenAt: at, syncedToSevenElevenBy: ACTIVITY_AUTHOR,
    requiresContractorAttention: true, contractorAcknowledgedAt: at, contractorAcknowledgedBy: ACTIVITY_AUTHOR }));
});

for (const [label, workOrder, time] of [
  ["explicit UTC", { id: ACTIVITY_PARENT, storeTimezone: "UTC" }, "Sep 5, 12:00 PM"],
  ["state timezone", { id: ACTIVITY_PARENT, storeState: "CA" }, "Sep 5, 5:00 AM"],
  ["default timezone", { id: ACTIVITY_PARENT }, "Sep 5, 8:00 AM"],
] as const) test(`activity real facade preserves ${label}`, async () => {
  const harness = createActivityVisitReadHarness([respond(rawPage([activityFixture()]))]);
  assert.equal(firstItem(await harness.loadActivities(workOrder)).time, time);
});

test("activity real facade preserves invalid formatter timezone RangeError after its one read", async () => {
  const harness = createActivityVisitReadHarness([respond(rawPage([activityFixture()]))]);
  await assert.rejects(harness.loadActivities({ id: ACTIVITY_PARENT, storeTimezone: "Mars/Synthetic" }), { name: "RangeError" });
  assert.equal(harness.calls.length, 1);
});

for (const workOrder of [null, undefined, { id: "" }]) test(`activity real facade missing parent ${JSON.stringify(workOrder)} fails before query`, async () => {
  const harness = createActivityVisitReadHarness([]);
  await assert.rejects(harness.loadActivities(workOrder), { message: "A work order ID is required" });
  assert.equal(harness.calls.length, 0);
});

test("activity real facade forwards exact signal to supported transport", async () => {
  const controller = new AbortController();
  const harness = createActivityVisitReadHarness([call => {
    assert.strictEqual(call.signal, controller.signal); return { data: rawPage([activityFixture()]), error: null };
  }]);
  await harness.loadActivities(parent, null, 30, controller.signal);
  assert.strictEqual(harness.calls[0].signal, controller.signal);
});

test("activity real facade prevents already-aborted query and continuation after cancellation", async () => {
  const controller = new AbortController(); controller.abort();
  const harness = createActivityVisitReadHarness([]);
  for (const cursor of [null, "existing-cursor"])
    await assert.rejects(harness.loadActivities(parent, cursor, 30, controller.signal), { name: "AbortError" });
  assert.equal(harness.calls.length, 0);
});

test("activity real facade transport abort preserves AbortError and performs no later query", async () => {
  const controller = new AbortController();
  const harness = createActivityVisitReadHarness([call => {
    assert.strictEqual(call.signal, controller.signal); controller.abort();
    return { data: rawPage([activityFixture()]), error: null };
  }]);
  await assert.rejects(harness.loadActivities(parent, null, 30, controller.signal), { name: "AbortError" });
  await assert.rejects(harness.loadActivities(parent, "continuation", 30, controller.signal), { name: "AbortError" });
  assert.equal(harness.calls.length, 1);
});

test("activity real facade cancels held in-flight transport with the identical request-owned signal", async () => {
  const controller = new AbortController();
  let dispatched: () => void = () => { throw new Error("Dispatch marker not initialized"); };
  const pendingDispatch = new Promise<void>(resolve => { dispatched = resolve; });
  const harness = createActivityVisitReadHarness([call => {
    assert.strictEqual(call.signal, controller.signal);
    const held = new Promise<never>((resolve, reject) => {
      void resolve;
      controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true });
    });
    dispatched(); return held;
  }]);
  const pendingRead = harness.loadActivities(parent, null, 30, controller.signal);
  const rejected = assert.rejects(pendingRead, { name: "AbortError" });
  await pendingDispatch; controller.abort(); await rejected;
  await assert.rejects(harness.loadActivities(parent, "continuation", 30, controller.signal), { name: "AbortError" });
  assert.equal(harness.calls.length, 1);
});

for (const [providerCode, safeCode] of [["42501", "FORBIDDEN"], ["22023", "VALIDATION_FAILED"], ["unknown", "INTERNAL_ERROR"]])
  test(`activity real facade normalizes ${providerCode} without exposing provider text`, async () => {
    const harness = createActivityVisitReadHarness([() => ({ data: null, error: { code: providerCode, message: "Synthetic private SQL detail" } })]);
    await assert.rejects(harness.loadActivities(parent), error => {
      assert.equal(record(error).code, safeCode); assert.doesNotMatch(String(error), /Synthetic private/); return true;
    });
    assert.equal(harness.calls.length, 1);
  });

test("activity real facade preserves input immutability and deterministic bytes", async () => {
  const fixture = activityFixture(); Object.freeze(fixture); Object.freeze(parent);
  const before = JSON.stringify(fixture);
  const harness = createActivityVisitReadHarness([respond(rawPage([fixture])), respond(rawPage([fixture]))]);
  assert.equal(JSON.stringify(await harness.loadActivities(parent)), JSON.stringify(await harness.loadActivities(parent)));
  assert.equal(JSON.stringify(fixture), before); assert.equal(firstItem(await createActivityVisitReadHarness([respond(rawPage([fixture]))]).loadActivities(parent)).id, ACTIVITY_ID);
});

