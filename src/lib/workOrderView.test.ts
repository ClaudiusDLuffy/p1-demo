import assert from "node:assert/strict";
import test from "node:test";
import {
  getWorkOrderActionReasons,
  getWorkOrderProgressSteps,
  isInternalWorkOrderActivity,
  prioritizePendingSevenElevenUpdates,
  sortWorkOrders,
  workOrderHasPendingSevenElevenSync,
  workOrderNeedsAction,
} from "./workOrderView";

test("staff action reasons cover operational and billing follow-up", () => {
  assert.deepEqual(
    getWorkOrderActionReasons({
      status: "unassigned",
      hasUnreadNotes: true,
      pendingSevenElevenSyncCount: 1,
    }, true),
    ["Assignment needed", "Unread activity", "7-Eleven update pending"],
  );
  assert.deepEqual(
    getWorkOrderActionReasons({ status: "pending_invoice" }, true),
    ["Invoice needed"],
  );
});

test("contractors only receive their explicit action requests", () => {
  assert.equal(
    workOrderNeedsAction({ status: "assigned", pendingContractorAttentionCount: 1 }, false),
    true,
  );
  assert.equal(
    workOrderNeedsAction({ status: "unassigned", hasUnreadNotes: true }, false),
    false,
  );
});

test("closed work orders never remain action-required", () => {
  assert.equal(
    workOrderNeedsAction({
      status: "closed",
      hasUnreadNotes: true,
      pendingSevenElevenSyncCount: 3,
    }, true),
    false,
  );
});

test("an overdue SLA does not make an otherwise active work order action-required", () => {
  assert.deepEqual(
    getWorkOrderActionReasons({
      status: "wip",
      resolutionBreachAt: "2026-07-25T13:26:00.000Z",
    }, true),
    [],
  );
});

test("pending 7-Eleven updates are detected from either count or summary flag", () => {
  assert.equal(workOrderHasPendingSevenElevenSync({ pendingSevenElevenSyncCount: 2 }), true);
  assert.equal(workOrderHasPendingSevenElevenSync({ hasPendingSevenElevenSync: true }), true);
  assert.equal(workOrderHasPendingSevenElevenSync({ pendingSevenElevenSyncCount: 0 }), false);
});

test("pending 7-Eleven updates rise first without changing the selected order within groups", () => {
  const sorted = sortWorkOrders([
    { id: "ordinary-newest", createdAt: "2026-08-06T15:00:00Z" },
    { id: "sync-oldest", createdAt: "2026-08-06T13:00:00Z", pendingSevenElevenSyncCount: 1 },
    { id: "sync-newest", createdAt: "2026-08-06T14:00:00Z", pendingSevenElevenSyncCount: 1 },
  ], "newest");

  assert.deepEqual(
    prioritizePendingSevenElevenUpdates(sorted).map(row => row.id),
    ["sync-newest", "sync-oldest", "ordinary-newest"],
  );
});

test("started work advances progress even when no ETA was entered", () => {
  assert.deepEqual(
    getWorkOrderProgressSteps({
      status: "wip",
      contractor: "pro_ops",
      dispatchedAt: "2026-07-25T09:27:00.000Z",
      startTime: "2026-07-27T13:45:00.000Z",
    }).slice(0, 4),
    [
      { label: "Created", done: true },
      { label: "Dispatched", done: true },
      { label: "Work started", done: true },
      { label: "Asset captured", done: false },
    ],
  );
});

test("reassignment activity is private even for legacy rows", () => {
  assert.equal(
    isInternalWorkOrderActivity({
      text: "Reassigned from Pro-Ops to Derek Starnes by P1 Service.",
      eventKey: "assignment",
      isStaffOnly: false,
    }),
    true,
  );
  assert.equal(
    isInternalWorkOrderActivity({
      text: "Assignment changed.",
      eventKey: "work_order_reassigned",
    }),
    true,
  );
});

test("identity-bearing assignment activity is private", () => {
  assert.equal(
    isInternalWorkOrderActivity({
      text: "Dispatched to Pro-Ops.",
      eventKey: "assignment",
      isStaffOnly: false,
    }),
    true,
  );
});

test("ordinary operational activity remains contractor-visible", () => {
  assert.equal(
    isInternalWorkOrderActivity({
      text: "Checked in and started work.",
      eventKey: "check_in",
      isStaffOnly: false,
    }),
    false,
  );
});
