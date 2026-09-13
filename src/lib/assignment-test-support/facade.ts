import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { lifecycleContextFor } from "../workOrderLifecycleCommands";

const filename = resolve("src/lib/db.ts");
const requireHere = createRequire(import.meta.url);
const context = lifecycleContextFor({ id: "WOT9400021", contractorAssignmentVersion: 2, workflowCycle: 1, lifecycleVersion: 3 },
  "00000000-0000-4000-8000-000000000010");
const contractor = "00000000-0000-4000-8000-000000000011";
type Facade = {
  transitionWorkOrderContractor: (id: string, target: string | null, version: number, input: typeof context) => Promise<unknown>;
  rejectUnassignedWorkOrder: (id: string, reason: string, input: typeof context) => Promise<unknown>;
  duplicateWorkOrderForReassignment: (id: string, input: typeof context) => Promise<unknown>;
  deleteWorkOrder: (id: string, author: string) => Promise<unknown>;
  insertWorkOrder: (input: unknown, text: string, author: string, operationId: string, startedAt: string) => Promise<unknown>;
  insertActivity: (id: string, author: string, text: string) => Promise<unknown>;
};
export async function exerciseAssignmentFacade(kind: "transition" | "reject" | "duplicate" | "legacyDelete" | "create" | "communication") {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const writes: { table: string; row: Record<string, unknown> }[] = [];
  const exports: Partial<Facade> = {};
  const client = {
    auth: { getUser: async () => ({ data: { user: { id: contractor } } }) },
    from(table: string) {
      if (kind !== "create" && kind !== "communication") throw new Error("Assignment facade must not perform raw persistence");
      const query = {
        select: () => query, eq: () => query,
        single: async () => ({ data: { id: context.workOrderId, status: "assigned", created_at: "2026-09-08T10:00:00Z" }, error: null }),
        insert: async (row: Record<string, unknown>) => {
          assert.equal(table, "activities", "Parent creation must never be a raw insert");
          writes.push({ table, row }); return { error: null };
        },
        upsert: async (row: Record<string, unknown>) => { writes.push({ table, row }); return { error: null }; },
      };
      return query;
    },
    rpc: async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      return { error: null, data: {
        applied: true, operationId: context.operationId, reason: kind === "create" ? "created" : kind === "transition" ? "reassigned" : kind === "reject" ? "rejected" : "duplicated",
        workOrderId: kind === "duplicate" ? "WOT9400021-1" : context.workOrderId,
        assignmentVersion: kind === "create" ? 1 : kind === "transition" ? 3 : kind === "duplicate" ? 0 : 2,
        workflowCycle: ["create", "duplicate"].includes(kind) ? 0 : 1, lifecycleVersion: kind === "transition" ? 4 : ["create", "duplicate"].includes(kind) ? 0 : 3,
        activityId: "00000000-0000-4000-8000-000000000012", contractorId: contractor,
        status: "assigned", functionalStatus: "Dispatched", isCapital: false, capitalStatus: null,
        assignmentStartedAt: "2026-09-08T10:00:00Z", dispatchedAt: "2026-09-08T10:00:00Z",
        deliveryId: "00000000-0000-4000-8000-000000000013", deliveryStatus: "pending",
        rejectedAt: "2026-09-08T10:00:00Z", rejectedBy: "00000000-0000-4000-8000-000000000014",
        sourceWorkOrderId: context.workOrderId, rootWorkOrderId: context.workOrderId, duplicateSequence: 1,
      } };
    },
  };
  runInNewContext(ts.transpileModule(readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { exports, console, Date, Map, Set, crypto: globalThis.crypto,
    require: (name: string) => name === "./supabase/client" ? { supabase: () => client } : requireHere(resolve(filename, "..", name)),
  }, { filename });
  if (kind === "communication") {
    assert.ok(exports.insertActivity);
    for (const text of ["Assigned to someone in this note", "Reassigned from a previous note", "Work order unassigned by discussion"]) {
      await exports.insertActivity(context.workOrderId, "Synthetic author", text);
    }
    assert.equal(writes.length, 3);
    assert.ok(writes.every(write => write.row.event_key === "assignment"));
    assert.equal(calls.length, 0);
    return;
  }
  if (kind === "create") {
    assert.ok(exports.insertWorkOrder);
    await exports.insertWorkOrder({ id: context.workOrderId, priority: "p4", source: "manual", contractor,
      status: "assigned", functionalStatus: "Dispatched", dispatchedAt: "2026-09-08T10:00:00Z" },
    "Work order created manually by Synthetic staff.", "System", context.operationId, "2026-09-08T10:00:00Z");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, "create_work_order_with_assignment_v1");
    assert.equal(calls[0].args.p_operation_id, context.operationId);
    const row = calls[0].args.p_work_order;
    assert.ok(row && typeof row === "object" && "contractor_id" in row && "sla_started_at" in row);
    assert.equal(row.contractor_id, contractor);
    assert.equal(row.sla_started_at, "2026-09-08T10:00:00.000Z");
    assert.ok(!("created_by" in row) && !("deleted_by" in row));
    assert.equal(writes.length, 1);
    assert.equal(writes[0].row.event_key, "system");
    return;
  }
  if (kind === "legacyDelete") {
    assert.ok(exports.deleteWorkOrder);
    await assert.rejects(exports.deleteWorkOrder(context.workOrderId, "Forged author"), /Use Reject work order/);
    assert.equal(calls.length, 0);
    return;
  }
  if (kind === "transition") { assert.ok(exports.transitionWorkOrderContractor); await exports.transitionWorkOrderContractor(context.workOrderId, contractor, 2, context); }
  if (kind === "reject") { assert.ok(exports.rejectUnassignedWorkOrder); await exports.rejectUnassignedWorkOrder(context.workOrderId, "Synthetic rejection reason", context); }
  if (kind === "duplicate") { assert.ok(exports.duplicateWorkOrderForReassignment); await exports.duplicateWorkOrderForReassignment(context.workOrderId, context); }
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, kind === "transition" ? "transition_work_order_contractor_v1"
    : kind === "reject" ? "reject_unassigned_work_order_v1" : "duplicate_work_order_for_reassignment_v1");
  assert.equal(calls[0].args.p_operation_id, context.operationId);
  assert.equal(calls[0].args.p_expected_assignment_version, 2);
  assert.equal(calls[0].args.p_expected_workflow_cycle, 1);
  assert.equal(calls[0].args.p_expected_lifecycle_version, 3);
  assert.equal(calls[0].args[kind === "duplicate" ? "p_source_work_order_id" : "p_work_order_id"], context.workOrderId);
}
