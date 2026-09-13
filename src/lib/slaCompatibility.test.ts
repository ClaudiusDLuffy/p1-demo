import assert from "node:assert/strict";
import test from "node:test";
import { computeSlaBreaches, computeSlaState } from "./slaConfig";
import { slaRemaining } from "./slaDisplay";
import { getSlaDueTime } from "./workOrderView";
import { filterAndSortWorkOrderTable } from "./workOrderTable";

const now = new Date("2026-09-10T12:00:00.000Z");

test("characterization: creation durations remain the existing unapproved sample-derived values", () => {
  const expected = { p1: [2, 4], p2: [4, 8], p3: [24, 48], p4: [48, 72], p5: null } as const;
  for (const priority of ["p1", "p2", "p3", "p4", "p5"] as const) {
    const result = computeSlaBreaches(priority, now);
    const windows = expected[priority];
    assert.equal(result.responseBreachAt?.getTime() ?? null, windows ? now.getTime() + windows[0] * 3_600_000 : null);
    assert.equal(result.resolutionBreachAt?.getTime() ?? null, windows ? now.getTime() + windows[1] * 3_600_000 : null);
  }
});

test("technical compatibility: legacy sorting uses the same dispatch anchor as display", () => {
  const workOrder = {
    priority: "p1",
    dispatchedAt: "2026-09-10T08:00:00.000Z",
    slaStartedAt: "2026-09-10T10:00:00.000Z",
  };
  const remaining = slaRemaining(workOrder, now);
  assert.equal(remaining?.remainingHours, 4);
  assert.equal(getSlaDueTime(workOrder), now.getTime() + (remaining?.remainingHours ?? 0) * 3_600_000);
});

test("technical compatibility: invalid stored dates never produce NaN state or a derived fallback", () => {
  assert.equal(computeSlaState("not-a-date", "2026-09-10T15:00:00Z", null, now), null);
  const invalid = { priority: "p1", dispatchedAt: "2026-09-10T08:00:00Z", responseBreachAt: "not-a-date" };
  assert.equal(slaRemaining(invalid, now), null);
  assert.equal(getSlaDueTime(invalid), null);
});

test("technical compatibility: one invalid stored half does not hide the valid stored half", () => {
  const workOrder = { responseBreachAt: "2026-09-10T14:00:00Z", resolutionBreachAt: "not-a-date" };
  assert.equal(getSlaDueTime(workOrder), Date.parse(workOrder.responseBreachAt));
});

test("technical compatibility: the table SLA sort includes legacy deadlines", () => {
  const rows = [
    { id: "SYNTHETIC-LATE", priority: "p1", dispatchedAt: "2026-09-10T10:00:00Z" },
    { id: "SYNTHETIC-EARLY", priority: "p1", dispatchedAt: "2026-09-10T08:00:00Z" },
  ];
  assert.deepEqual(filterAndSortWorkOrderTable(rows, {}, { column: "sla", direction: "asc" }).map(row => row.id),
    ["SYNTHETIC-EARLY", "SYNTHETIC-LATE"]);
});

test("technical compatibility: completed response is not counted overdue while resolution is future", () => {
  const rows = [{ id: "SYNTHETIC-RESPONDED", responseBreachAt: "2020-01-01T10:00:00Z", resolutionBreachAt: "2099-01-01T12:00:00Z", startTimeRaw: "2020-01-01T09:00:00Z" }];
  assert.deepEqual(filterAndSortWorkOrderTable(rows, { sla: "overdue" }, { column: "sla", direction: "asc" }), []);
});
