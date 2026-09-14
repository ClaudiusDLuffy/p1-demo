import assert from "node:assert/strict";
import test from "node:test";
import { createBillingReadyAttempt } from "./workOrderBillingCommands";

const operationId = "00000000-0000-4000-8000-000000000001";
const workOrder = { id: "WOT-SYNTHETIC", contractorAssignmentVersion: 2, workflowCycle: 1, lifecycleVersion: 7 };
const result = { applied: true, reason: "applied", workOrderId: workOrder.id, operationId,
  assignmentVersion: 2, workflowCycle: 1, lifecycleVersion: 8,
  workOrderStatus: "pending_invoice", functionalStatus: "Completed",
  activityId: "00000000-0000-4000-8000-000000000002" };

test("billing-ready captures versions and calls one authoritative command", async () => {
  const attempt = createBillingReadyAttempt(workOrder, operationId);
  const response = await attempt(async (name, args) => {
    assert.equal(name, "mark_work_order_ready_for_billing_v1");
    assert.deepEqual(args, { p_work_order_id: workOrder.id, p_operation_id: operationId,
      p_expected_assignment_version: 2, p_expected_workflow_cycle: 1, p_expected_lifecycle_version: 7 });
    return { data: result, error: null };
  });
  assert.equal(response.workOrderStatus, "pending_invoice");
});

test("billing-ready rejects missing captured versions before a request", () => {
  assert.throws(() => createBillingReadyAttempt({ id: workOrder.id }), /Refresh the work order/);
});

test("billing-ready lost-response retry retains operation and captured versions", async () => {
  const source = { ...workOrder };
  const attempt = createBillingReadyAttempt(source, operationId);
  let original: unknown;
  await assert.rejects(attempt(async (_name, args) => {
    original = args;
    return { data: null, error: new Error("network uncertainty") };
  }), /could not be confirmed/);
  source.lifecycleVersion = 900;
  const replay = await attempt(async (_name, args) => {
    assert.deepEqual(args, original);
    return { data: { ...result, applied: false, reason: "already_applied" }, error: null };
  });
  assert.equal(replay.applied, false);
});

test("billing-ready rejects mismatched successful responses", async () => {
  for (const patch of [{ workOrderId: "OTHER" }, { operationId: result.activityId },
    { assignmentVersion: 8 }, { workflowCycle: 2 }, { workOrderStatus: "paid" }, { reason: "already_applied" }]) {
    await assert.rejects(createBillingReadyAttempt(workOrder, operationId)(async () => ({
      data: { ...result, ...patch }, error: null,
    })), /could not be confirmed/);
  }
});

test("billing-ready exposes safe conflicts and never provider details", async () => {
  for (const [code, message] of [["PT409", /changed in another session/], ["42501", /no longer have permission/],
    ["XX000", /could not be confirmed/]] as const) {
    await assert.rejects(createBillingReadyAttempt(workOrder, operationId)(async () => ({
      data: null, error: { code, message: "/private/sensitive.sql: internal stack" },
    })), message);
  }
});
