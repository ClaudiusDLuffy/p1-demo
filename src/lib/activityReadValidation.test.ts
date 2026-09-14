import assert from "node:assert/strict";
import test from "node:test";
import { AppError } from "./errors/AppError";
import { createActivityVisitReadHarness, rawPage, record, respond } from "./activity-visit-read-test-support/harness";
import { ACTIVITY_ID, ACTIVITY_PARENT, activityFixture, expectedActivity } from "./activity-visit-read-test-support/activity-fixtures";
import { mapActivityPageRow } from "../features/work-orders/data/activityMappers";
import { parseActivityReadPage, parseActivityReadRow } from "../features/work-orders/data/activityReadValidators";
import { createActivityReadRepository } from "../features/work-orders/data/activityReadRepository";

const isSafeFailure = (error: unknown): boolean => {
  assert.ok(error instanceof AppError); assert.equal(error.code, "INTERNAL_ERROR");
  assert.doesNotMatch(error.message, /Synthetic private|work_order_id|author_id/); return true;
};
const invalidRows: readonly [string, Record<string, unknown>][] = [
  ["activity UUID", { id: "not-a-uuid" }], ["parent empty", { work_order_id: "" }],
  ["parent mismatch", { work_order_id: "SYNTHETIC-OTHER-PARENT" }], ["author UUID", { author_id: "bad" }],
  ["author name", { author_name: null }], ["timestamp text", { created_at: "not-a-date" }],
  ["numeric timestamp", { created_at: "1" }], ["timestamp calendar rollover", { created_at: "2026-02-30T01:00:00Z" }],
  ["timestamp nonleap date", { created_at: "2025-02-29T01:00:00Z" }], ["timestamp missing zone", { created_at: "2026-09-05T01:00:00" }],
  ["note text", { text: 8 }], ["type is not text", { type: false }], ["unknown channel", { activity_channel: "general" }],
  ["unknown author role", { entered_by_role: "admin" }], ["override flag string", { is_staff_override: "false" }],
  ["staff marker string", { is_staff_only: "false" }], ["override UUID", { override_for_contractor_id: "bad" }],
  ["event key wrong type", { event_key: 9 }], ["event JSON nonfinite", { event_data: { value: Infinity } }],
  ["sync flag string", { requires_7eleven_sync: "false" }], ["sync date", { synced_to_7eleven_at: "bad" }],
  ["sync actor", { synced_to_7eleven_by: "bad" }], ["attention flag string", { requires_contractor_attention: "false" }],
  ["ack date", { contractor_attention_acknowledged_at: "bad" }], ["ack actor", { contractor_attention_acknowledged_by: "bad" }],
  ["fractional workflow", { workflow_cycle: 1.5 }], ["workflow numeric string", { workflow_cycle: "2" }],
  ["overflow assignment version", { contractor_assignment_version: 2147483648 }],
  ["fractional assignment", { contractor_assignment_version: 0.5 }],
  ["deleted row returned by active page", { deleted_at: "2026-09-06T00:00:00Z" }],
  ["field note lacks sync", { activity_channel: "field_note" }],
  ["non-field note requests sync", { requires_7eleven_sync: true }],
  ["internal note not staff only", { activity_channel: "internal_note" }],
  ["internal note contractor attention", { activity_channel: "internal_note", is_staff_only: true, requires_contractor_attention: true }],
];
for (const [label, patch] of invalidRows) test(`activity production facade rejects malformed ${label} before public mapping`, async () => {
  const harness = createActivityVisitReadHarness([respond(rawPage([activityFixture(patch)]))]);
  await assert.rejects(harness.loadActivities({ id: ACTIVITY_PARENT }), isSafeFailure);
  assert.equal(harness.calls.length, 1);
});

for (const field of ["id", "work_order_id", "author_id", "author_name", "created_at", "text", "type", "activity_channel",
  "entered_by_role", "is_staff_only", "is_staff_override", "event_key", "event_data", "workflow_cycle", "contractor_assignment_version", "deleted_at"]) {
  test(`activity validator requires raw field ${field} instead of silently defaulting`, () => {
    const row = activityFixture(); delete row[field];
    assert.throws(() => parseActivityReadPage(rawPage([row]), ACTIVITY_PARENT), isSafeFailure);
  });
}

const invalidPages: readonly [string, unknown][] = [
  ["null", null], ["array", []], ["malformed JSON", "{"], ["missing items", { hasMore: false, nextCursor: null }],
  ["items not array", { ...rawPage([]), items: {} }], ["string boolean", { ...rawPage([]), hasMore: "false" }],
  ["empty cursor", { ...rawPage([]), nextCursor: "" }], ["missing cursor", { items: [], hasMore: false }],
  ["cursor without continuation", { ...rawPage([]), nextCursor: "cursor" }], ["continuation without cursor", { ...rawPage([]), hasMore: true }],
  ["negative count", { ...rawPage([]), totalCount: -1 }], ["fractional count", { ...rawPage([]), totalCount: 0.5 }],
  ["numeric text count", { ...rawPage([]), totalCount: "0" }], ["nonfinite aggregate", { ...rawPage([]), aggregates: { total: Infinity } }],
  ["duplicate rows", rawPage([activityFixture(), activityFixture()])],
  ["same UUID in different case", rawPage([activityFixture(), activityFixture({ id: ACTIVITY_ID.toUpperCase() })])],
];
for (const [label, value] of invalidPages) test(`activity production facade rejects malformed ${label} page`, async () => {
  const harness = createActivityVisitReadHarness([respond(value)]);
  await assert.rejects(harness.loadActivities({ id: ACTIVITY_PARENT }), isSafeFailure);
});

test("activity page accepts 100 rows, rejects 101, and strips only unexposed fixed-RPC fields", () => {
  const rows = Array.from({ length: 101 }, (_, index) => activityFixture({ id: `a7700000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`, hidden_field: "Synthetic private" }));
  const page = parseActivityReadPage(rawPage(rows.slice(0, 100)), ACTIVITY_PARENT);
  assert.equal(page.items.length, 100); assert.equal("hidden_field" in page.items[0], false);
  assert.throws(() => parseActivityReadPage(rawPage(rows), ACTIVITY_PARENT), isSafeFailure);
});

for (const date of ["2024-02-29T01:00:00Z", "2026-09-05T12:00:00.123456+00:00", "2026-09-05T12:00:00.123-05:30"]) {
  test(`activity validator retains valid timestamp bytes ${date}`, () => {
    assert.equal(parseActivityReadRow(activityFixture({ created_at: date })).created_at, date);
  });
}

for (const cycle of [-2147483648, -1, 0, 2147483647]) test(`activity validator preserves PostgreSQL signed counter ${cycle}`, () => {
  const row = parseActivityReadRow(activityFixture({ workflow_cycle: cycle, contractor_assignment_version: cycle }));
  assert.equal(row.workflow_cycle, cycle); assert.equal(row.contractor_assignment_version, cycle);
});

for (const type of [null, "", "historic_custom_type", "ai"]) test(`activity validator preserves unconstrained legitimate type ${String(type)}`, () => {
  assert.equal(parseActivityReadRow(activityFixture({ type })).type, type);
});

test("activity pure mapper exactly matches independent fixture and never mutates frozen inputs", () => {
  const row = parseActivityReadRow(activityFixture()); Object.freeze(row); Object.freeze(row.event_data);
  const before = JSON.stringify(row), expected = expectedActivity();
  assert.deepEqual(mapActivityPageRow(row, "America/New_York"), expected);
  assert.equal(JSON.stringify(mapActivityPageRow(row, "America/New_York")), JSON.stringify(expected));
  assert.equal(JSON.stringify(row), before);
  assert.equal(JSON.stringify(mapActivityPageRow(row, "America/New_York")), JSON.stringify(mapActivityPageRow(row, "America/New_York")));
});

test("activity validator preserves object-key ordering and JSON scalar/array event representations", () => {
  for (const event of [{ z: 1, a: ["synthetic", { y: true, b: null }] }, [false, 0, "value"], "synthetic", true, 1]) {
    const row = parseActivityReadRow(activityFixture({ event_data: event }));
    assert.equal(JSON.stringify(row.event_data), JSON.stringify(event));
    assert.equal(JSON.stringify(mapActivityPageRow(row).eventData), JSON.stringify(event));
  }
});

test("activity repository dependency receives exact one-query contract and owns validation before mapping", async () => {
  const controller = new AbortController(), calls: unknown[] = [];
  const repository = createActivityReadRepository({ read: async (name, args, signal) => {
    calls.push({ name, args, signal }); return rawPage([activityFixture()]);
  } });
  const page = await repository.loadWorkOrderActivitiesPage({ id: ACTIVITY_PARENT, storeTimezone: "UTC" }, "opaque", 31, controller.signal);
  assert.deepEqual(calls, [{ name: "list_work_order_activities_rows_v1", args: { p_work_order_id: ACTIVITY_PARENT, p_limit: 31, p_cursor: "opaque" }, signal: controller.signal }]);
  assert.equal(page.items[0].time, "Sep 5, 12:00 PM");
  assert.equal(record(page.items[0]).work_order_id, undefined);
});

