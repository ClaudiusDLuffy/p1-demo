import assert from "node:assert/strict";
import test from "node:test";
import { calculateTripHours, calculateTrips } from "./billingRules";
import { AssignmentCommandError, createAssignmentAttempts, createAssignmentCommands, safeAssignmentError } from "./workOrderAssignmentCommands";
import { administrativeTransferRequestSchema } from "./workOrderAssignmentContracts";
import { canAssignWorkOrder } from "./workOrderDispatchActions";
import { assignmentBoundaryPatch } from "./workOrderAssignmentBoundary";

test("normal transfer exposes the specific open-visit conflict without provider detail", () => {
  const error = safeAssignmentError({ code: "PT409", details: "active_visit_requires_checkout", message: "internal SQL detail" });
  assert.equal(error.code, "active_visit_requires_checkout");
  assert.match(error.message, /open visit.*check out/i);
  assert.doesNotMatch(error.message, /SQL/);
});

test("administratively closed visit duration is never automatically included in billing hours", () => {
  const trip = {
    checkInAt: "2026-09-08T08:00:00Z", checkOutAt: "2026-09-08T10:00:00Z",
    closureKind: "administrative_transfer", durationReviewRequired: true,
  };
  assert.equal(calculateTripHours(trip, "UTC"), null);
  assert.deepEqual(calculateTrips([trip], "UTC"), []);
});

test("administrative provenance excludes time even if a malformed client flag is false", () => {
  const trip = {
    checkInAt: "2026-09-08T08:00:00Z", checkOutAt: "2026-09-08T10:00:00Z",
    closureKind: "administrative_transfer", durationReviewRequired: false,
  };
  assert.equal(calculateTripHours(trip, "UTC"), null);
});

test("normal checked-out visit hours retain existing calculation", () => {
  const trip = { checkInAt: "2026-09-08T08:00:00Z", checkOutAt: "2026-09-08T10:00:00Z" };
  assert.equal(calculateTripHours(trip, "UTC")?.totalHours, 2);
});

test("staff can select a receiving assignment for administratively transferred unassigned WIP, not arbitrary WIP", () => {
  const work = { isOperationalStaff: true, contractorId: null, status: "wip", functionalStatus: "Work in Progress" };
  assert.equal(canAssignWorkOrder(work), false);
  assert.equal(canAssignWorkOrder({ ...work, assignmentTransferPendingVisit: true }), true);
  assert.equal(canAssignWorkOrder({ ...work, assignmentTransferPendingVisit: true, isInvoiceController: true }), false);
});

const operationId = "81000000-0000-4000-8000-000000000001";
const contractorId = "81000000-0000-4000-8000-000000000002";
const activityId = "81000000-0000-4000-8000-000000000003";
const visitId = "81000000-0000-4000-8000-000000000004";
const context = { workOrderId: "WOT9800001", expectedAssignmentVersion: 2, expectedWorkflowCycle: 1, expectedLifecycleVersion: 3, operationId };
const timestamp = "2026-09-09T10:00:00Z";
const response = {
  applied: true, reason: "reassigned", workOrderId: context.workOrderId, operationId,
  assignmentVersion: 3, workflowCycle: 1, lifecycleVersion: 4, activityId, contractorId,
  status: "wip", functionalStatus: "Work in Progress", isCapital: false, capitalStatus: null,
  assignmentStartedAt: timestamp, dispatchedAt: timestamp, deliveryId: null, deliveryStatus: null,
  receivingVisitRequired: true, administrativeClosedVisitId: visitId, administrativeClosedAt: timestamp,
  administrativeClosureActivityId: activityId, durationReviewRequired: true,
};

test("administrative cache patch preserves WIP and pending receiver state while clearing outgoing field identity", () => {
  const patch = assignmentBoundaryPatch({ contractor: "outgoing" }, response);
  assert.equal(patch.status, "wip");
  assert.equal(patch.functionalStatus, "Work in Progress");
  assert.equal(patch.assignmentTransferPendingVisit, true);
  assert.equal(patch.assignedTechnicianProfileId, null);
  assert.equal(patch.technicianOnJob, null);
  assert.equal(patch.startTimeRaw, null);
  assert.equal(patch.contractorAssignmentVersion, 3);
});

test("administrative transfer accepts only explicit confirmation and nonempty bounded reason; no backdate or author", async () => {
  let calls = 0;
  const commands = createAssignmentCommands(async () => { calls++; return { data: response, error: null }; });
  for (const patch of [{ reason: " " }, { reason: "x".repeat(501) }, { confirmed: false }, { confirmed: "true" },
    { closedAt: timestamp }, { actorId: contractorId }, { contractorId: "invalid" }]) {
    await assert.rejects(commands.administrativeTransfer(context, { contractorId, reason: "Emergency", confirmed: true, ...patch }));
  }
  assert.equal(calls, 0);
  assert.ok(administrativeTransferRequestSchema.safeParse({ contractorId: null, reason: "x", confirmed: true }).success);
});

test("administrative adapter sends one explicit RPC with versions and operation, never a caller timestamp", async () => {
  const calls: unknown[] = [];
  const commands = createAssignmentCommands(async (name, args) => { calls.push({ name, args }); return { data: response, error: null }; });
  const result = await commands.administrativeTransfer(context, { contractorId, reason: "  Emergency  ", confirmed: true });
  assert.deepEqual(calls, [{ name: "administrative_close_visit_and_transfer_v1", args: {
    p_work_order_id: context.workOrderId, p_expected_assignment_version: 2, p_expected_workflow_cycle: 1,
    p_expected_lifecycle_version: 3, p_operation_id: operationId, p_new_contractor_id: contractorId,
    p_reason: "Emergency", p_confirmed: true,
  } }]);
  assert.equal(result.status, "wip");
  assert.equal(result.durationReviewRequired, true);
});

test("administrative adapter accepts a capital parent without flattening its workflow stage", async () => {
  const capitalResponse = {
    ...response,
    status: "capital",
    functionalStatus: "Work in Progress",
    isCapital: true,
  };
  const commands = createAssignmentCommands(async () => ({ data: capitalResponse, error: null }));
  const result = await commands.administrativeTransfer(
    context,
    { contractorId, reason: "Capital visit emergency", confirmed: true },
  );
  assert.equal(result.status, "capital");
  assert.equal(result.functionalStatus, "Work in Progress");
  assert.equal(result.receivingVisitRequired, true);
});

test("administrative adapter rejects mismatched preserved capital states", async () => {
  for (const patch of [
    { status: "capital", functionalStatus: "Pending Capital Completion" },
    { status: "pending_capital_completion", functionalStatus: "Work in Progress" },
    { status: "wip", functionalStatus: "Pending Capital Approval" },
  ]) {
    const commands = createAssignmentCommands(async () => ({
      data: { ...response, ...patch },
      error: null,
    }));
    await assert.rejects(
      commands.administrativeTransfer(
        context,
        { contractorId, reason: "Invalid state pair", confirmed: true },
      ),
      error => error instanceof AssignmentCommandError
        && error.code === "ASSIGNMENT_UNCONFIRMED",
    );
  }
});

test("administrative adapter rejects missing provenance, wrong target, versions or unverified response", async () => {
  for (const patch of [{ administrativeClosedVisitId: null }, { administrativeClosureActivityId: null },
    { administrativeClosedAt: "yesterday" }, { durationReviewRequired: false }, { receivingVisitRequired: false },
    { operationId: activityId }, { contractorId: visitId }, { lifecycleVersion: 3 }, { assignmentVersion: 2 }, { workflowCycle: 2 }]) {
    const commands = createAssignmentCommands(async () => ({ data: { ...response, ...patch }, error: null }));
    await assert.rejects(commands.administrativeTransfer(context, { contractorId, reason: "Emergency", confirmed: true }),
      error => error instanceof AssignmentCommandError && error.code === "ASSIGNMENT_UNCONFIRMED");
  }
});

test("normal active-visit denial releases the operation so an explicit different administrative action can be attempted", async () => {
  const attempts = createAssignmentAttempts();
  const workOrder = { id: context.workOrderId, contractorAssignmentVersion: 2, workflowCycle: 1, lifecycleVersion: 3 };
  await assert.rejects(attempts.run(workOrder, "transition", contractorId, async () => {
    throw { code: "PT409", details: "active_visit_requires_checkout" };
  }));
  assert.equal(await attempts.run(workOrder, "administrative_transfer", { contractorId, reason: "Emergency", confirmed: true }, async () => "explicit"), "explicit");
});
