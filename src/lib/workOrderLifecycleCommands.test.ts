import assert from "node:assert/strict";
import test from "node:test";
import {
  createLifecycleCommands, lifecycleContextFor, LifecycleCommandError, safeLifecycleError,
  type LifecycleTransport,
} from "./workOrderLifecycleCommands";
import { isReservedLifecycleEvent, RESERVED_LIFECYCLE_EVENTS } from "./workOrderLifecycleContracts";

const context = {
  workOrderId: "WOTTEST001", expectedAssignmentVersion: 2, expectedWorkflowCycle: 1,
  expectedLifecycleVersion: 3, operationId: "00000000-0000-4000-8000-000000000001",
};
const result = {
  applied: true, reason: "applied", workOrderId: context.workOrderId,
  operationId: context.operationId, assignmentVersion: 2, workflowCycle: 1, lifecycleVersion: 4,
  activityId: "00000000-0000-4000-8000-000000000002", workOrderStatus: "wip",
  functionalStatus: "Work in Progress", parts: [],
};
const checkedInAt = "2026-09-08T10:00:00Z";
function fixture(data: unknown = result, error: unknown = null) {
  const calls: { name: string; args: unknown }[] = [];
  const transport: LifecycleTransport = async (name, args) => {
    calls.push({ name, args });
    return { data, error };
  };
  return { commands: createLifecycleCommands(transport), calls };
}

test("ETA forwards the snapshot versions and operation ID, never caller identity", async () => {
  const f = fixture();
  assert.equal((await f.commands.setEta({ ...context, eta: checkedInAt })).applied, true);
  assert.deepEqual(f.calls, [{ name: "set_work_order_eta_v1", args: {
    p_work_order_id: "WOTTEST001", p_expected_assignment_version: 2,
    p_expected_workflow_cycle: 1, p_expected_lifecycle_version: 3,
    p_operation_id: context.operationId, p_eta: checkedInAt,
  } }]);
});

test("start and resume use distinct owning commands with the same version contract", async () => {
  const f = fixture();
  await f.commands.start({ ...context, checkedInAt, notes: "Synthetic note" });
  await f.commands.start({ ...context, checkedInAt, notes: "Synthetic note" }, true);
  assert.deepEqual(f.calls.map(call => call.name), ["start_work_order_visit_v1", "resume_work_order_visit_v1"]);
});

test("pause sends structured parts in the same operation, without client line writes", async () => {
  const f = fixture();
  await f.commands.pause({ ...context, checkedOutAt: checkedInAt, reason: "Awaiting parts", notes: "",
    parts: [{ description: " Motor ", partNumber: "M1", qty: 2, expectedReturnDate: "2026-09-10" }],
    legacyPartNeeded: "Motor (M1)", legacyPartEta: "2026-09-10",
  });
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].name, "pause_work_order_for_parts_v1");
  assert.deepEqual(f.calls[0].args, {
    p_work_order_id: context.workOrderId, p_expected_assignment_version: 2,
    p_expected_workflow_cycle: 1, p_expected_lifecycle_version: 3, p_operation_id: context.operationId,
    p_check_out_at: checkedInAt, p_reason: "Awaiting parts", p_notes: "",
    p_parts: [{ description: "Motor", partNumber: "M1", qty: 2, expectedReturnDate: "2026-09-10" }],
    p_legacy_part_needed: "Motor (M1)", p_legacy_part_eta: "2026-09-10",
  });
});

test("completion retains equipment fields and optional year/resolution without financial input", async () => {
  const f = fixture();
  await f.commands.complete({ ...context, completedAt: checkedInAt, assetMake: " Make ", assetModel: "Model",
    assetSerial: "Serial", assetYear: null, resolutionCode: null, resolutionNotes: null,
  });
  assert.equal(f.calls[0].name, "complete_work_order_field_v1");
  assert.ok(!JSON.stringify(f.calls).includes("p_activity_text"));
  assert.ok(!JSON.stringify(f.calls).includes("invoice"));
});

test("command responses are runtime validated and bound to their request identity", async () => {
  for (const data of [null, {}, { ...result, workOrderId: "WOTOTHER" }, { ...result, operationId: "00000000-0000-4000-8000-000000000009" }, { ...result, assignmentVersion: 9 }, { ...result, applied: false, reason: "already_completed" }]) {
    const f = fixture(data);
    await assert.rejects(f.commands.setEta({ ...context, eta: checkedInAt }), LifecycleCommandError);
    assert.equal(f.calls.length, 1);
  }
});

test("a consistent replay preserves the server's already-applied outcome", async () => {
  const f = fixture({ ...result, applied: false, reason: "already_applied" });
  assert.deepEqual(await f.commands.setEta({ ...context, eta: checkedInAt }), { ...result, applied: false, reason: "already_applied" });
});

test("invalid dates and missing version cannot be silently coerced into a new operation", async () => {
  const f = fixture();
  for (const eta of ["", "tomorrow", "2026-02-30T10:00:00Z"]) {
    await assert.rejects(f.commands.setEta({ ...context, eta }), LifecycleCommandError);
  }
  assert.equal(f.calls.length, 0);
  assert.throws(() => lifecycleContextFor({ id: "WOTTEST001", contractorAssignmentVersion: 2, workflowCycle: 1 }), LifecycleCommandError);
  assert.deepEqual(lifecycleContextFor({ id: context.workOrderId, contractorAssignmentVersion: 2, workflowCycle: 1, lifecycleVersion: 3 }, context.operationId), context);
});

test("provider SQL/native details never become user messages and no error automatically retries", async () => {
  for (const code of ["PT409", "42501", "22023", "XX000", "PGRST202"]) {
    const cause = { code, message: "private/path secret provider details", details: "synthetic" };
    const error = safeLifecycleError(cause);
    assert.equal(error.cause, cause);
    assert.doesNotMatch(error.message, /private|secret|provider/);
    const f = fixture(null, cause);
    await assert.rejects(f.commands.setEta({ ...context, eta: checkedInAt }), LifecycleCommandError);
    assert.equal(f.calls.length, 1);
  }
});

test("reviewed lifecycle conflicts provide actionable guidance without exposing arbitrary database text", () => {
  for (const [message, guidance] of [
    ["STALE_ASSIGNMENT", /assignment changed/i],
    ["Work order cannot start or resume from its current state", /current state/i],
    ["The requested visit overlaps existing work", /overlaps another active visit/i],
    ["The active visit does not match this completion", /active visit changed/i],
  ] as const) {
    const error = safeLifecycleError({ code: "PT409", message });
    assert.match(error.message, guidance);
    assert.equal(error.code, "PT409");
  }
  assert.doesNotMatch(
    safeLifecycleError({ code: "PT409", message: "private customer SQL text" }).message,
    /private|customer|SQL/i,
  );
});

test("reviewed lifecycle access conflicts are state guidance, not false permission failures", () => {
  const completed = safeLifecycleError({ code: "42501", message: "Completed field work must be reopened before its status can regress" });
  assert.match(completed.message, /completed work order must be reopened/i);
  assert.doesNotMatch(completed.message, /permission/i);
  const closed = safeLifecycleError({ code: "42501", message: "Closed work orders must be reopened through the reopen workflow" });
  assert.match(closed.message, /closed work order must be reopened/i);
  assert.doesNotMatch(closed.message, /permission/i);
});

test("all actual lifecycle identities are reserved, not arbitrary note prefixes", () => {
  for (const key of RESERVED_LIFECYCLE_EVENTS) assert.equal(isReservedLifecycleEvent(key), true);
  for (const key of ["note", "ai_note", "invoice_submitted", "check_in_question", null, undefined]) assert.equal(isReservedLifecycleEvent(key), false);
});
