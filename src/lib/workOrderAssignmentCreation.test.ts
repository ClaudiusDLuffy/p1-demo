import assert from "node:assert/strict";
import test from "node:test";
import { AssignmentCommandError } from "./workOrderAssignmentCommands";
import { createWorkOrderCreationAttempt, manualWorkOrderSchema } from "./workOrderCreationCommand";
import { createEmailWorkOrder, emailWorkOrderCreationId } from "./workOrderEmailCreation";
import type { Database } from "./supabase/database.types";

const contractorId = "76000000-0000-4000-8000-000000000001";
const activityId = "76000000-0000-4000-8000-000000000002";
const otherId = "76000000-0000-4000-8000-000000000003";
const timestamp = "2026-09-08T10:00:00.000Z";
const manual = { id: "WOT9760001", source: "manual", status: "assigned", functionalStatus: "Dispatched",
  priority: "p2", contractor: contractorId, summary: "Synthetic assignment creation", nte: 250,
  dispatchedAt: timestamp, slaStartedAt: timestamp };
const sourceMessageId = "synthetic-message@example.invalid";
type WorkOrderInsert = Database["public"]["Tables"]["work_orders"]["Insert"];
const emailRow: WorkOrderInsert = { id: "WOT9760002", source: "email_intake", status: "assigned", functional_status: "New",
  contractor_id: contractorId, priority: "p2", summary: "Synthetic intake", dispatched_at: timestamp,
  created_at: timestamp, priority_source_message_id: sourceMessageId, priority_source_received_at: timestamp };
function emailResult(row: WorkOrderInsert = emailRow) {
  return { applied: true, reason: "created", workOrderId: row.id,
    operationId: emailWorkOrderCreationId(sourceMessageId, row.id), assignmentVersion: row.contractor_id ? 1 : 0,
    workflowCycle: 0, lifecycleVersion: 0, activityId: row.contractor_id ? activityId : null,
    contractorId: row.contractor_id ?? null };
}
function unconfirmed(error: unknown) {
  return error instanceof AssignmentCommandError && error.code === "ASSIGNMENT_UNCONFIRMED";
}

test("manual creation attempt captures parsed form, operation and initial SLA time once", async () => {
  const input = { ...manual };
  const attempt = createWorkOrderCreationAttempt(input);
  const captured: unknown[] = [];
  await attempt.run(async (row, operationId, startedAt) => {
    captured.push({ row, operationId, startedAt });
    assert.equal(startedAt, timestamp);
    assert.equal(row.dispatchedAt, timestamp);
    assert.match(operationId, /^[0-9a-f-]{36}$/);
  });
  input.summary = "Changed after attempt creation";
  await attempt.run(async (row, operationId, startedAt) => { captured.push({ row, operationId, startedAt }); });
  assert.deepEqual(captured[0], captured[1]);
});

test("manual creation retry ignores fresh click dispatch time but retains accepted input and UUID", async () => {
  const attempt = createWorkOrderCreationAttempt(manual);
  let firstOperation: string | undefined;
  let firstTime: string | undefined;
  await assert.rejects(attempt.run(async (_row, operationId, startedAt) => {
    firstOperation = operationId; firstTime = startedAt; throw new Error("Synthetic lost response");
  }), unconfirmed);
  assert.equal(attempt.matches({ ...manual, dispatchedAt: "2026-09-08T11:00:00.000Z" }), true);
  await attempt.run(async (row, operationId, startedAt) => {
    assert.equal(row.dispatchedAt, timestamp);
    assert.equal(operationId, firstOperation);
    assert.equal(startedAt, firstTime);
  });
});

test("manual creation attempt detects changed business fields, target and source", () => {
  const attempt = createWorkOrderCreationAttempt(manual);
  for (const patch of [{ contractor: otherId }, { summary: "Different command" }, { nte: 251 },
    { priority: "p1" }, { id: "WOT9760099" }]) assert.equal(attempt.matches({ ...manual, ...patch }), false);
  assert.throws(() => attempt.matches({ ...manual, source: "email_intake" }));
});

test("manual creation boundary rejects non-boolean flags, invalid IDs, states and nonfinite values", () => {
  for (const patch of [{ isCapital: "false" }, { contractor: "not-a-uuid" }, { status: "completed" },
    { nte: Number.NaN }, { nte: Infinity }, { nte: -1 }, { dispatchedAt: "tomorrow" }, { priority: "other" }]) {
    assert.equal(manualWorkOrderSchema.safeParse({ ...manual, ...patch }).success, false);
  }
});

test("manual creation blocks overlapping clicks and safely normalizes failure details", async () => {
  const attempt = createWorkOrderCreationAttempt(manual);
  let release: () => void = () => { throw new Error("Test promise not initialized"); };
  const pending = attempt.run(() => new Promise<void>(resolve => { release = resolve; }));
  await assert.rejects(attempt.run(async () => undefined), error => error instanceof AssignmentCommandError && error.code === "ASSIGNMENT_BUSY");
  release(); await pending;
  await assert.rejects(attempt.run(async () => { throw new Error("/private/synthetic/sql-details"); }), error => {
    assert.ok(error instanceof AssignmentCommandError);
    assert.doesNotMatch(error.message, /private|sql-details/);
    return true;
  });
});

test("email creation uses stable source/work-order identity and no processing timestamp", () => {
  const first = emailWorkOrderCreationId(sourceMessageId, emailRow.id);
  assert.equal(first, emailWorkOrderCreationId(sourceMessageId, emailRow.id));
  assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.notEqual(first, emailWorkOrderCreationId("another@example.invalid", emailRow.id));
  assert.notEqual(first, emailWorkOrderCreationId(sourceMessageId, "WOT9760099"));
  assert.throws(() => emailWorkOrderCreationId("  ", emailRow.id));
  assert.throws(() => emailWorkOrderCreationId(sourceMessageId, ""));
});

test("email creation calls one trusted RPC and preserves assigned/New source semantics", async () => {
  let calls = 0;
  const response = await createEmailWorkOrder(async (name, args) => {
    calls++;
    assert.equal(name, "create_email_work_order_with_assignment_v1");
    assert.deepEqual(args, { p_operation_id: emailWorkOrderCreationId(sourceMessageId, emailRow.id), p_work_order: emailRow });
    return { data: emailResult(), error: null };
  }, emailRow, sourceMessageId);
  assert.equal(calls, 1);
  assert.equal(response.assignmentVersion, 1);
  assert.equal(emailRow.functional_status, "New");
});

test("email redelivery retains operation identity when processing time changes", async () => {
  const operationIds: string[] = [];
  for (const createdAt of [timestamp, "2026-09-08T12:00:00.000Z"]) {
    await createEmailWorkOrder(async (_name, args) => {
      operationIds.push(args.p_operation_id);
      return { data: { ...emailResult(), applied: operationIds.length === 1,
        reason: operationIds.length === 1 ? "created" : "already_applied" }, error: null };
    }, { ...emailRow, created_at: createdAt }, sourceMessageId);
  }
  assert.equal(operationIds[0], operationIds[1]);
});

test("email creation rejects wrong target, operation, initial versions and missing assignment evidence", async () => {
  for (const patch of [{ operationId: activityId }, { workOrderId: "OTHER" }, { contractorId: otherId },
    { assignmentVersion: 0 }, { workflowCycle: 1 }, { lifecycleVersion: 1 }, { activityId: null },
    { reason: "assigned" }, { applied: "true" }, { applied: false }]) {
    await assert.rejects(createEmailWorkOrder(async () => ({ data: { ...emailResult(), ...patch }, error: null }),
      emailRow, sourceMessageId), unconfirmed, JSON.stringify(patch));
  }
});

test("billing-only email creation retains an unassigned zero-version result", async () => {
  const row: WorkOrderInsert = { ...emailRow, contractor_id: null, status: "pending_invoice", functional_status: "Completed",
    billing_only: true, billing_ready_at: timestamp, dispatched_at: null };
  const result = await createEmailWorkOrder(async () => ({ data: emailResult(row), error: null }), row, sourceMessageId);
  assert.equal(result.contractorId, null);
  assert.equal(result.assignmentVersion, 0);
  assert.equal(result.activityId, null);
});

test("email failure is safe, does not retry automatically and rejects invalid source identity before transport", async () => {
  let calls = 0;
  await assert.rejects(createEmailWorkOrder(async () => {
    calls++; return { data: null, error: { code: "XX000", message: "/private/sensitive-provider-detail" } };
  }, emailRow, sourceMessageId), error => {
    assert.ok(error instanceof AssignmentCommandError);
    assert.equal(error.code, "ASSIGNMENT_UNCONFIRMED");
    assert.doesNotMatch(error.message, /private|sensitive-provider-detail/);
    return true;
  });
  assert.equal(calls, 1);
  await assert.rejects(createEmailWorkOrder(async () => { calls++; return { data: emailResult(), error: null }; }, emailRow, ""));
  assert.equal(calls, 1);
});
