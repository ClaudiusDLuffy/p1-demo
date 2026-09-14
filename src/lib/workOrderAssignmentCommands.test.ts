import assert from "node:assert/strict";
import test from "node:test";
import { AssignmentCommandError, createAssignmentAttempts, createAssignmentCommands, safeAssignmentError } from "./workOrderAssignmentCommands";
import type { AssignmentContext, AssignmentFunctions } from "./workOrderAssignmentContracts";

const operationId = "75000000-0000-4000-8000-000000000001";
const contractorId = "75000000-0000-4000-8000-000000000002";
const actorId = "75000000-0000-4000-8000-000000000003";
const activityId = "75000000-0000-4000-8000-000000000004";
const deliveryId = "75000000-0000-4000-8000-000000000005";
const context: AssignmentContext = { workOrderId: "WOT9750001", expectedAssignmentVersion: 2,
  expectedWorkflowCycle: 1, expectedLifecycleVersion: 7, operationId };
const workOrder = { id: context.workOrderId, contractorAssignmentVersion: 2, workflowCycle: 1, lifecycleVersion: 7 };
const timestamp = "2026-09-08T10:00:00.000Z";
const common = { applied: true, reason: "reassigned", workOrderId: context.workOrderId, operationId,
  assignmentVersion: 3, workflowCycle: 1, lifecycleVersion: 8, activityId };
const transitionResult = { ...common, contractorId, status: "assigned", functionalStatus: "Dispatched",
  isCapital: false, capitalStatus: null, assignmentStartedAt: timestamp, dispatchedAt: timestamp,
  deliveryId, deliveryStatus: "pending" };
const rejectionResult = { ...common, reason: "rejected", assignmentVersion: 2, lifecycleVersion: 7,
  rejectedAt: timestamp, rejectedBy: actorId };
const duplicateResult = { ...common, reason: "duplicated", workOrderId: "WOT9750001-1",
  sourceWorkOrderId: context.workOrderId, rootWorkOrderId: context.workOrderId, duplicateSequence: 1,
  assignmentVersion: 0, workflowCycle: 0, lifecycleVersion: 0, deliveryId, deliveryStatus: "pending" };
const creationRow = { id: context.workOrderId, contractor_id: contractorId, status: "assigned",
  functional_status: "Dispatched", priority: "p2", source: "manual" };
const creationResult = { ...common, reason: "created", contractorId, assignmentVersion: 1, workflowCycle: 0, lifecycleVersion: 0 };

function unconfirmed(error: unknown) {
  return error instanceof AssignmentCommandError && error.code === "ASSIGNMENT_UNCONFIRMED";
}

test("assignment adapters send one narrow RPC with captured versions and caller operation identity", async () => {
  const calls: Array<{ name: keyof AssignmentFunctions; args: unknown }> = [];
  const commands = createAssignmentCommands(async (name, args) => {
    calls.push({ name, args });
    const results = { administrative_close_visit_and_transfer_v1: null, transition_work_order_contractor_v1: transitionResult, reject_unassigned_work_order_v1: rejectionResult,
      duplicate_work_order_for_reassignment_v1: duplicateResult, create_work_order_with_assignment_v1: creationResult };
    return { data: results[name], error: null };
  });
  assert.equal((await commands.transition(context, contractorId)).assignmentVersion, 3);
  assert.equal((await commands.reject(context, "  Outside our service area  ")).rejectedBy, actorId);
  assert.equal((await commands.duplicate(context)).workOrderId, "WOT9750001-1");
  assert.equal((await commands.create(operationId, creationRow)).contractorId, contractorId);
  const args = { p_work_order_id: context.workOrderId, p_expected_assignment_version: 2,
    p_expected_workflow_cycle: 1, p_expected_lifecycle_version: 7, p_operation_id: operationId };
  assert.deepEqual(calls, [
    { name: "transition_work_order_contractor_v1", args: { ...args, p_new_contractor_id: contractorId } },
    { name: "reject_unassigned_work_order_v1", args: { ...args, p_reason: "Outside our service area" } },
    { name: "duplicate_work_order_for_reassignment_v1", args: { p_source_work_order_id: context.workOrderId,
      p_expected_assignment_version: 2, p_expected_workflow_cycle: 1, p_expected_lifecycle_version: 7, p_operation_id: operationId } },
    { name: "create_work_order_with_assignment_v1", args: { p_operation_id: operationId, p_work_order: creationRow } },
  ]);
});

test("unassignment preserves explicit nulls and accepts a consistent already-applied result", async () => {
  const commands = createAssignmentCommands(async () => ({ data: { ...transitionResult, applied: false, reason: "already_applied",
    contractorId: null, status: "unassigned", functionalStatus: "New", assignmentStartedAt: null, dispatchedAt: null,
    deliveryStatus: "sent" }, error: null }));
  const result = await commands.transition(context, null);
  assert.equal(result.contractorId, null);
  assert.equal(result.assignmentStartedAt, null);
  assert.equal(result.deliveryStatus, "sent");
  assert.equal(result.applied, false);
});

test("malformed captured context, target and reason fail before transport", async () => {
  let calls = 0;
  const commands = createAssignmentCommands(async () => { calls++; return { data: transitionResult, error: null }; });
  for (const changed of [{ ...context, operationId: "invalid" }, { ...context, expectedAssignmentVersion: -1 },
    { ...context, expectedLifecycleVersion: Number.NaN }, { ...context, unexpectedActor: actorId }]) {
    await assert.rejects(commands.transition(changed, contractorId));
  }
  await assert.rejects(commands.transition(context, "not-a-uuid"));
  await assert.rejects(commands.reject(context, "tiny"));
  await assert.rejects(commands.reject(context, "x".repeat(501)));
  await assert.rejects(commands.create("invalid-operation", creationRow));
  await assert.rejects(commands.create(operationId, { ...creationRow, contractor_id: "invalid" }));
  assert.equal(calls, 0);
});

test("transition rejects wrong operation, target, family, boolean and every version mismatch", async () => {
  for (const patch of [{ operationId: activityId }, { workOrderId: "WOT9750999" }, { contractorId: actorId },
    { reason: "rejected" }, { applied: "true" }, { applied: false }, { reason: "already_applied" },
    { assignmentVersion: 2 }, { workflowCycle: 2 }, { lifecycleVersion: 7 }, { lifecycleVersion: 999 },
    { assignmentVersion: "3" }, { activityId: "not-a-uuid" }, { dispatchedAt: "tomorrow" }]) {
    const commands = createAssignmentCommands(async () => ({ data: { ...transitionResult, ...patch }, error: null }));
    await assert.rejects(commands.transition(context, contractorId), unconfirmed, JSON.stringify(patch));
  }
});

test("rejection rejects mismatched identity, versions and command-family output", async () => {
  for (const patch of [{ operationId: activityId }, { workOrderId: "WOT9750999" }, { assignmentVersion: 3 },
    { workflowCycle: 9 }, { lifecycleVersion: 8 }, { reason: "assigned" }, { rejectedBy: "spoof" }]) {
    const commands = createAssignmentCommands(async () => ({ data: { ...rejectionResult, ...patch }, error: null }));
    await assert.rejects(commands.reject(context, "Outside our service area"), unconfirmed, JSON.stringify(patch));
  }
});

test("duplicate validates clean copy versions, source and root suffix rather than trusting arbitrary IDs", async () => {
  for (const patch of [{ operationId: activityId }, { sourceWorkOrderId: "OTHER" }, { workOrderId: context.workOrderId },
    { workOrderId: "WOT9750999-1" }, { duplicateSequence: 2 }, { assignmentVersion: 1 }, { workflowCycle: 1 },
    { lifecycleVersion: 1 }, { reason: "created" }, { deliveryId: "invalid" }]) {
    const commands = createAssignmentCommands(async () => ({ data: { ...duplicateResult, ...patch }, error: null }));
    await assert.rejects(commands.duplicate(context), unconfirmed, JSON.stringify(patch));
  }
});

test("creation checks accepted target, operation, initial versions and assignment evidence", async () => {
  for (const patch of [{ operationId: activityId }, { workOrderId: "OTHER" }, { contractorId: actorId },
    { assignmentVersion: 0 }, { workflowCycle: 1 }, { lifecycleVersion: 1 }, { activityId: null }, { reason: "assigned" }]) {
    const commands = createAssignmentCommands(async () => ({ data: { ...creationResult, ...patch }, error: null }));
    await assert.rejects(commands.create(operationId, creationRow), unconfirmed, JSON.stringify(patch));
  }
  const unassigned = createAssignmentCommands(async () => ({ data: { ...creationResult, contractorId: null,
    assignmentVersion: 0, activityId: null }, error: null }));
  assert.equal((await unassigned.create(operationId, { ...creationRow, contractor_id: null })).assignmentVersion, 0);
});

test("unknown or incomplete RPC responses remain uncertain and do not become request-validation failures", async () => {
  for (const data of [null, false, [], "provider output", {}, { ...transitionResult, lifecycleVersion: "8" }]) {
    const commands = createAssignmentCommands(async () => ({ data, error: null }));
    await assert.rejects(commands.transition(context, contractorId), unconfirmed);
  }
});

test("safe assignment errors retain internal cause but never expose provider paths, detail or stack", () => {
  const mappings = [["PT409", "PT409"], ["40001", "PT409"], ["42501", "42501"], ["PT403", "42501"],
    ["22023", "22023"], ["PT422", "22023"], ["23505", "23505"], ["P0002", "P0002"],
    ["PGRST202", "ASSIGNMENT_UNAVAILABLE"], ["42883", "ASSIGNMENT_UNAVAILABLE"], ["XX000", "ASSIGNMENT_UNCONFIRMED"]];
  for (const [code, expected] of mappings) {
    const provider = { code, message: "/private/customer-path: SQL internal details", details: "synthetic secret marker" };
    const error = safeAssignmentError(provider);
    assert.equal(error.code, expected);
    assert.equal(error.cause, provider);
    assert.doesNotMatch(error.message, /private|customer-path|SQL internal|synthetic secret/);
  }
  const known = new AssignmentCommandError("PT409", "Safe conflict");
  assert.equal(safeAssignmentError(known), known);
});

test("assignment transport failures are never automatically retried", async () => {
  let calls = 0;
  const commands = createAssignmentCommands(async () => { calls++; throw new Error("Synthetic transport failure"); });
  await assert.rejects(commands.transition(context, contractorId), unconfirmed);
  assert.equal(calls, 1);
});

test("uncertain assignment attempts retain their operation UUID and captured context for explicit retry", async () => {
  const attempts = createAssignmentAttempts();
  const captured: AssignmentContext[] = [];
  await assert.rejects(attempts.run(workOrder, "transition", contractorId, async input => {
    captured.push(input); throw new Error("Synthetic lost response");
  }), unconfirmed);
  const result = await attempts.run({ ...workOrder }, "transition", contractorId, async input => {
    captured.push(input); return "replayed";
  });
  assert.equal(result, "replayed");
  assert.deepEqual(captured[0], captured[1]);
  assert.match(captured[0].operationId, /^[0-9a-f-]{36}$/);
  assert.equal(captured[0].expectedLifecycleVersion, workOrder.lifecycleVersion);
});

test("an unconfirmed attempt blocks changed target, family or version until the original outcome is reconciled", async () => {
  const attempts = createAssignmentAttempts();
  await assert.rejects(attempts.run(workOrder, "transition", contractorId, async () => { throw new Error("Lost response"); }));
  let changedCalls = 0;
  const execute = async () => { changedCalls++; };
  await assert.rejects(attempts.run(workOrder, "transition", actorId, execute), error => error instanceof AssignmentCommandError && error.code === "PT409");
  await assert.rejects(attempts.run(workOrder, "reject", "Wrong area", execute));
  await assert.rejects(attempts.run({ ...workOrder, lifecycleVersion: 8 }, "transition", contractorId, execute));
  assert.equal(changedCalls, 0);
});

test("assignment attempt rejects overlapping clicks but independent work orders can proceed", async () => {
  const attempts = createAssignmentAttempts();
  let release: () => void = () => { throw new Error("Pending test promise not initialized"); };
  const pending = attempts.run(workOrder, "transition", contractorId, () => new Promise<void>(resolve => { release = resolve; }));
  await assert.rejects(attempts.run(workOrder, "transition", contractorId, async () => undefined),
    error => error instanceof AssignmentCommandError && error.code === "ASSIGNMENT_BUSY");
  assert.equal(await attempts.run({ ...workOrder, id: "WOT9750002" }, "transition", actorId, async () => "independent"), "independent");
  release(); await pending;
});

test("definite conflicts and permission failures release the attempt; malformed success retains it", async () => {
  for (const code of ["PT409", "42501", "22023", "23505", "P0002", "PGRST202"]) {
    const attempts = createAssignmentAttempts();
    await assert.rejects(attempts.run(workOrder, "transition", contractorId, async () => { throw { code }; }));
    assert.equal(await attempts.run(workOrder, "transition", actorId, async () => "new attempt"), "new attempt");
  }
  const attempts = createAssignmentAttempts();
  let retained: string | undefined;
  await assert.rejects(attempts.run(workOrder, "transition", contractorId, async input => {
    retained = input.operationId;
    return createAssignmentCommands(async () => ({ data: {}, error: null })).transition(input, contractorId);
  }), unconfirmed);
  await attempts.run(workOrder, "transition", contractorId, async input => { assert.equal(input.operationId, retained); });
});
