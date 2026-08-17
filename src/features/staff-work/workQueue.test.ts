import assert from "node:assert/strict";
import test from "node:test";

import {
  buildStaffWorkRows,
  filterStaffWorkRows,
  latestContractorActivityAt,
} from "./workQueue";

const baseWorkOrder = {
  id: "WOT1",
  status: "assigned",
  createdAt: "2026-08-01T00:00:00Z",
  updatedAt: "2026-08-02T00:00:00Z",
  activities: [],
};

test("latestContractorActivityAt ignores staff activity", () => {
  assert.equal(latestContractorActivityAt({
    ...baseWorkOrder,
    activities: [
      { enteredByRole: "manager", createdAt: "2026-08-03T00:00:00Z" },
      { enteredByRole: "contractor", createdAt: "2026-08-02T00:00:00Z" },
    ],
  }), "2026-08-02T00:00:00Z");
});

test("latestContractorActivityAt uses the list summary before details load", () => {
  assert.equal(latestContractorActivityAt({
    ...baseWorkOrder,
    latestContractorActivityAt: "2026-08-04T00:00:00Z",
    activities: [],
  }), "2026-08-04T00:00:00Z");
});

test("queue merges unread, todo, and ready labels into one work-order row", () => {
  const workOrder = {
    ...baseWorkOrder,
    activities: [
      { enteredByRole: "contractor", createdAt: "2026-08-03T00:00:00Z" },
    ],
  };
  const rows = buildStaffWorkRows({
    workOrders: [workOrder],
    todos: [{
      id: "todo-1",
      workOrderId: "WOT1",
      ownerId: "staff-1",
      createdBy: "staff-1",
      note: null,
      createdAt: "2026-08-02T00:00:00Z",
      updatedAt: "2026-08-02T00:00:00Z",
    }],
    reads: [],
    profiles: [{ id: "staff-1", name: "Lynzy" }],
    readyWorkOrderIds: new Set(["WOT1"]),
    currentUserId: "staff-1",
  });

  assert.equal(rows.length, 1);
  assert.equal(rows[0].isUnread, true);
  assert.equal(rows[0].isMyTodo, true);
  assert.equal(rows[0].isReadyToBill, true);
  assert.equal(rows[0].todoOwner.name, "Lynzy");
});

test("personal read position and filters are login-specific", () => {
  const workOrder = {
    ...baseWorkOrder,
    activities: [
      { enteredByRole: "contractor", createdAt: "2026-08-03T00:00:00Z" },
    ],
  };
  const rows = buildStaffWorkRows({
    workOrders: [workOrder],
    todos: [],
    reads: [{
      userId: "staff-1",
      workOrderId: "WOT1",
      readThroughAt: "2026-08-03T00:00:00Z",
    }],
    profiles: [],
    readyWorkOrderIds: new Set(["WOT1"]),
    currentUserId: "staff-1",
  });

  assert.equal(rows[0].isUnread, false);
  assert.equal(filterStaffWorkRows(rows, "unread").length, 0);
  assert.equal(filterStaffWorkRows(rows, "ready").length, 1);
});
