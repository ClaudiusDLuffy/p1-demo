import assert from "node:assert/strict";
import test from "node:test";
import { createVisitReadRepository } from "../features/work-orders/data/visitReadRepository";
import { mapVisit } from "../features/work-orders/data/visitMappers";
import { parseVisitReadPage, parseVisitReadRow } from "../features/work-orders/data/visitReadValidators";
import { AppError } from "./errors/AppError";
import { calculateTripHours } from "./billingRules";
import { requiresVisitDurationReview } from "./visitDurationReview";
import { createActivityVisitReadHarness, rawPage, respond } from "./activity-visit-read-test-support/harness";
import { administrativeVisitRow, visitActor, visitExpected, visitId, visitParent, visitRow, visitStaff } from "./activity-visit-read-test-support/visitFixtures";

const invalid = (cause: unknown) => {
  assert.ok(cause instanceof AppError);
  assert.equal(cause.code, "INTERNAL_ERROR");
  assert.doesNotMatch(cause.message, /SQL|provider|Synthetic|reason|contractor|visitId/i);
  return true;
};

for (const key of Object.keys(visitRow())) {
  test(`visit fixed RPC validator rejects missing ${key}`, () => {
    const row = visitRow();
    delete row[key];
    assert.throws(() => parseVisitReadRow(row, visitParent), invalid);
  });
}

const malformedRows: readonly [string, Record<string, unknown>][] = [
  ["invalid visit UUID", { id: "visit-not-uuid" }],
  ["invalid parent type", { work_order_id: 19 }],
  ["empty parent", { work_order_id: "" }],
  ["cross-parent row", { work_order_id: "WOT-900002" }],
  ["invalid contractor UUID", { contractor_id: "foreign-company" }],
  ["null contractor", { contractor_id: null }],
  ["invalid check-in actor", { checked_in_by: "actor" }],
  ["null check-in actor", { checked_in_by: null }],
  ["invalid checkout actor", { checked_out_by: "actor" }],
  ["invalid visit technician", { technician_profile_id: "technician" }],
  ["invalid check-in timestamp", { check_in_at: "yesterday" }],
  ["invalid checkout timestamp", { check_out_at: "tomorrow" }],
  ["invalid privacy timestamp", { created_at: "old cycle" }],
  ["invalid update timestamp", { updated_at: false }],
  ["non-ISO numeric date", { created_at: "123" }],
  ["calendar rollover date", { created_at: "2026-02-30T08:00:00Z" }],
  ["non-leap day", { created_at: "2025-02-29T08:00:00Z" }],
  ["PostgreSQL-disallowed year zero", { created_at: "0000-01-01T08:00:00Z" }],
  ["unknown timezone offset", { created_at: "2026-09-10T08:00:00+99:00" }],
  ["timestamp without timezone", { created_at: "2026-09-10T08:00:00" }],
  ["checkout before check-in", { check_out_at: "2026-09-10T07:59:59.999Z" }],
  ["checkout one microsecond before check-in", { check_in_at: "2026-09-10T08:00:00.123456+00:00", check_out_at: "2026-09-10T08:00:00.123455+00:00" }],
  ["closed visit without closer", { checked_out_by: null }],
  ["open visit with closer", { check_out_at: null }],
  ["open visit with checkout event", { check_out_at: null, checked_out_by: null, check_out_activity_id: visitActor }],
  ["malformed check-in activity UUID", { check_in_activity_id: "activity" }],
  ["unknown closure kind", { closure_kind: "contractor_checkout" }],
  ["coerced review boolean", { duration_review_required: "false" }],
  ["normal visit marked unverified", { duration_review_required: true }],
  ["normal visit with administrative time", { administrative_closed_at: "2026-09-10T10:00:00.000Z" }],
  ["normal visit with administrative actor", { administrative_closed_by: visitStaff }],
  ["normal visit with administrative reason", { administrative_close_reason: "Synthetic reason" }],
  ["normal visit with administrative operation", { administrative_transfer_operation_id: visitActor }],
];
for (const [label, patch] of malformedRows) {
  test(`visit validator safely rejects ${label}`, () => {
    assert.throws(() => parseVisitReadRow(visitRow(patch), visitParent), invalid);
    assert.throws(() => parseVisitReadPage(rawPage([visitRow(patch)]), visitParent), invalid);
  });
}

for (const [label, patch] of [
  ["missing review flag", { duration_review_required: false }],
  ["open administrative visit", { check_out_at: null, checked_out_by: null }],
  ["missing observation timestamp", { administrative_closed_at: null }],
  ["missing administrative actor", { administrative_closed_by: null }],
  ["missing operation identity", { administrative_transfer_operation_id: null }],
  ["invalid operation UUID", { administrative_transfer_operation_id: "operation" }],
  ["missing reason", { administrative_close_reason: null }],
  ["empty reason", { administrative_close_reason: "   " }],
  ["oversized reason", { administrative_close_reason: "x".repeat(501) }],
] satisfies readonly [string, Record<string, unknown>][]) {
  test(`visit administrative validator rejects ${label}`, () => {
    assert.throws(() => parseVisitReadRow(administrativeVisitRow(patch), visitParent), invalid);
  });
}

const malformedPages: readonly [string, unknown][] = [
  ["null", null], ["array", []], ["scalar", 7], ["invalid JSON", "{"],
  ["missing rows", { nextCursor: null, hasMore: false }],
  ["wrong rows", { items: {}, nextCursor: null, hasMore: false }],
  ["string continuation flag", { ...rawPage([]), hasMore: "false" }],
  ["missing cursor", { items: [], hasMore: false }],
  ["empty cursor", { ...rawPage([]), nextCursor: "" }],
  ["continuation without cursor", { ...rawPage([]), hasMore: true }],
  ["cursor without continuation", { ...rawPage([]), nextCursor: "opaque" }],
  ["negative count", { ...rawPage([]), totalCount: -1 }],
  ["fractional count", { ...rawPage([]), totalCount: 0.5 }],
  ["string count", { ...rawPage([]), totalCount: "0" }],
  ["nonfinite count", { ...rawPage([]), totalCount: Number.POSITIVE_INFINITY }],
  ["nonfinite aggregate", { ...rawPage([]), aggregates: { count: "Infinity" } }],
  ["boolean aggregate", { ...rawPage([]), aggregates: { count: true } }],
  ["duplicate visit IDs", rawPage([visitRow(), visitRow()])],
  ["equivalent UUID case duplicate", rawPage([visitRow({ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }),
    visitRow({ id: "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA" })])],
  ["multiple open visits", rawPage([visitRow({ check_out_at: null, checked_out_by: null }),
    visitRow({ id: visitActor, check_out_at: null, checked_out_by: null })])],
  ["oversized page", rawPage(Array.from({ length: 101 }, (_, index) => visitRow({ id: `11111111-1111-4111-8111-${String(index).padStart(12, "0")}` })))],
];
for (const [label, value] of malformedPages) {
  test(`visit page validator rejects ${label}`, () => {
    assert.throws(() => parseVisitReadPage(value, visitParent), invalid);
  });
}

test("visit mapper exactly preserves nullable open representation, public keys and parent binding", () => {
  const value = visitRow({ check_out_at: null, checked_out_by: null });
  const parsed = parseVisitReadRow(value, visitParent);
  assert.deepEqual(mapVisit(parsed), visitExpected({ checkOutAt: null, closedBy: null }));
  assert.equal(Object.keys(parsed).length, 12);
  assert.equal(Object.keys(mapVisit(parsed)).length, 12);
});

for (const timestamp of ["2024-02-29T08:15:20Z", "2026-09-10T08:15:20.123456+00:00", "2026-09-10T08:15:20.123-05:30"]) {
  test(`visit validator preserves valid PostgreSQL timestamp bytes ${timestamp}`, () => {
    const mapped = mapVisit(parseVisitReadRow(visitRow({ check_in_at: timestamp, check_out_at: null, checked_out_by: null }), visitParent));
    assert.equal(mapped.checkInAt, timestamp);
  });
}

test("visit mapper retains exact normal checked-out duration without owning billing arithmetic", () => {
  const mapped = mapVisit(parseVisitReadRow(visitRow(), visitParent));
  assert.deepEqual(mapped, visitExpected());
  assert.equal(calculateTripHours(mapped, "UTC", new Date("2026-09-10T12:00:00Z"))?.totalHours, 2);
  assert.equal(requiresVisitDurationReview(mapped), false);
});

for (const corrected of [false, true]) {
  test(`visit ${corrected ? "corrected" : "original"} administrative mapping remains unverified and excluded from billing`, () => {
    const raw = administrativeVisitRow(corrected ? {
      check_in_at: "2026-09-10T08:15:00.000Z", check_out_at: "2026-09-10T09:45:00.000Z",
    } : {});
    const parsed = parseVisitReadRow(raw, visitParent);
    const mapped = mapVisit(parsed);
    assert.equal(mapped.closedBy, visitStaff);
    assert.equal(mapped.closureKind, "administrative_transfer");
    assert.equal(mapped.durationReviewRequired, true);
    assert.equal(mapped.administrativeClosedAt, "2026-09-10T10:00:00.000Z");
    assert.equal(calculateTripHours(mapped, "UTC", new Date("2026-09-10T12:00:00Z")), null);
    assert.equal(requiresVisitDurationReview(mapped), true);
    assert.ok(!Object.hasOwn(parsed, "administrative_close_reason"));
    assert.ok(!Object.hasOwn(parsed, "administrative_transfer_operation_id"));
    assert.ok(!Object.hasOwn(mapped, "correctionId"));
    assert.ok(!Object.hasOwn(mapped, "workflowCycle"));
    assert.ok(!Object.hasOwn(mapped, "assignmentVersion"));
  });
}

test("visit validation follows PostgreSQL reason code-point and btrim rules without leaking reason", () => {
  for (const reason of ["  " + "😀".repeat(500) + "  ", "\t"]) {
    const mapped = mapVisit(parseVisitReadRow(administrativeVisitRow({ administrative_close_reason: reason }), visitParent));
    assert.equal(mapped.durationReviewRequired, true);
    assert.equal(Object.keys(mapped).length, 12);
  }
});

test("visit validator preserves valid same-timestamp checkout and historical dates without a new duration policy", () => {
  const at = "2026-09-10T08:00:00.000Z";
  const mapped = mapVisit(parseVisitReadRow(visitRow({ check_out_at: at }), visitParent));
  assert.equal(mapped.checkOutAt, mapped.checkInAt);
  assert.equal(calculateTripHours(mapped, "UTC"), null);
});

for (const [label, checkInAt, checkOutAt] of [
  ["microsecond equality", "2026-09-10T08:00:00.123456+00:00", "2026-09-10T08:00:00.123456Z"],
  ["offset-equivalent microseconds", "2026-09-10T08:00:00.123456+00:00", "2026-09-10T03:00:00.123456-05:00"],
  ["one microsecond later", "2026-09-10T08:00:00.123456+00:00", "2026-09-10T08:00:00.123457+00:00"],
] as const) {
  test(`visit validator preserves ${label} without changing timestamp strings`, () => {
    const mapped = mapVisit(parseVisitReadRow(visitRow({ check_in_at: checkInAt, check_out_at: checkOutAt }), visitParent));
    assert.equal(mapped.checkInAt, checkInAt);
    assert.equal(mapped.checkOutAt, checkOutAt);
  });
}

test("visit mapping preserves row order and timestamps while stripping fixed-RPC surplus", () => {
  const rows = [visitRow({ id: visitActor, updated_at: "2026-09-11T08:00:00.000Z" }), visitRow()];
  const page = parseVisitReadPage(rawPage(rows, "opaque-source-cursor"), visitParent);
  assert.deepEqual(page.items.map(mapVisit).map(row => row.id), [visitActor, visitId]);
  assert.ok(!Object.hasOwn(page.items[0], "updated_at"));
  assert.equal(page.nextCursor, "opaque-source-cursor");
  assert.equal(page.totalCount, null);
});

test("visit pure parsing and mapping are deterministic and do not mutate input", () => {
  const input = Object.freeze(administrativeVisitRow());
  const before = JSON.stringify(input);
  const first = mapVisit(parseVisitReadRow(input, visitParent));
  const second = mapVisit(parseVisitReadRow(input, visitParent));
  assert.deepEqual(first, second);
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.equal(JSON.stringify(input), before);
});

test("visit injected repository owns one validated query and preserves input order without another family", async () => {
  const calls: unknown[] = [];
  const controller = new AbortController();
  const repository = createVisitReadRepository({ read: async (name, args, signal) => {
    calls.push({ name, args, signal });
    return rawPage([visitRow()]);
  } });
  const result = await repository.loadWorkOrderVisitsPage(visitParent, "opaque", 11, controller.signal);
  assert.deepEqual(result.items, [visitExpected()]);
  assert.deepEqual(calls, [{ name: "list_work_order_visits_rows_v1", args: {
    p_work_order_id: visitParent, p_limit: 11, p_cursor: "opaque",
  }, signal: controller.signal }]);
});

for (const [label, value] of [
  ["foreign parent", rawPage([visitRow({ work_order_id: "WOT-FOREIGN" })])],
  ["missing administrative evidence", rawPage([administrativeVisitRow({ administrative_closed_by: null })])],
  ["duplicate open result", rawPage([visitRow({ check_out_at: null, checked_out_by: null }),
    visitRow({ id: visitActor, check_out_at: null, checked_out_by: null })])],
] as const) {
  test(`visit real production facade rejects ${label} before exposing DTOs`, async () => {
    const h = createActivityVisitReadHarness([respond(value)]);
    await assert.rejects(h.loadVisits(visitParent), invalid);
    assert.equal(h.calls.length, 1);
    assert.equal(h.remainingPlans(), 0);
  });
}
