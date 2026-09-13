import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";
import type { IntakeResult } from "./emailIntakeProcessor";

const filename = resolve("src/lib/emailIntakeProcessor.ts");
const requireHere = createRequire(import.meta.url);
const contractorId = "00000000-0000-4000-8000-000000000051";
async function intake(billingOnly = false, failure = false) {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const writes: { table: string; row: unknown }[] = [];
  const notifications: unknown[] = [];
  const logs: unknown[] = [];
  const sb = {
    from(table: string) {
      const done = Promise.resolve({ data: [], error: null });
      const query = {
        select: () => query, eq: () => query, order: () => query, is: () => query,
        maybeSingle: async () => ({ data: null, error: null }),
        insert: async (row: unknown) => { writes.push({ table, row }); return { error: null }; },
        upsert: async (row: unknown) => { writes.push({ table, row }); return { error: null }; },
        then: done.then.bind(done),
      };
      return query;
    },
    rpc: async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      return failure ? { data: null, error: { code: "22023", message: "SQL internal synthetic secret detail" } } : {
        error: null, data: { applied: true, reason: "created", workOrderId: "WOT9400051", operationId: args.p_operation_id,
          assignmentVersion: billingOnly ? 0 : 1, lifecycleVersion: 0, workflowCycle: 0,
          contractorId: billingOnly ? null : contractorId, activityId: billingOnly ? null : "00000000-0000-4000-8000-000000000052" },
      };
    },
  };
  const exports: { processEmail?: (email: unknown, folder: string) => Promise<IntakeResult> } = {};
  const source = readFileSync(filename, "utf8");
  runInNewContext(ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { exports, Date, Set, process: { env: {} }, console: { error: (...args: unknown[]) => logs.push(args) },
    require(name: string): unknown {
      if (name === "server-only") return {};
      // Log transport is exercised with the real adapter in the provenance tests;
      // this fixture isolates the existing creation/dispatch command contract.
      if (name === "./server/emailIntakeLog") return { recordTrustedEmailIntakeResult: async () => ({ reason: "recorded" }) };
      if (name === "./supabase/server") return { createServerClient: () => sb };
      if (name === "./graphClient") return { getAccessToken: async () => null };
      if (name === "./emailParser") return { isConfirmedWorkOrderIntakeEmail: () => true, parseDispatchEmail: () => ({
        emailType: "TYPE_DISPATCHED", wotId: "WOT9400051", priority: "p4", parseConfidence: "high", state: "VA",
        doNotDispatch: billingOnly, storeNumber: "94005", city: "Synthetic", summary: "Synthetic work", description: "Synthetic description", nte: 0,
      }) };
      if (name === "./intakeStatePolicy") return { intakeStateBlockReason: () => null, intakeStateActivationDecision: () => ({ action: "process" }) };
      if (name === "./autoDispatch") return { resolveContractor: async () => ({ contractorId, contractorEmail: "synthetic@example.invalid", contractorName: "Synthetic contractor", reason: "synthetic matching" }) };
      if (name === "./notificationService") return {};
      if (["./emailPriorityEscalationProcessor", "./emailAssignmentRemovalProcessor"].includes(name)) return {};
      return requireHere(resolve(filename, "..", name));
    },
  }, { filename });
  assert.ok(exports.processEmail);
  const result = await exports.processEmail({ id: "synthetic-message-51", subject: "Synthetic dispatch", receivedDateTime: "2026-09-08T09:00:00Z" }, "synthetic-folder");
  return { result, calls, writes, notifications, logs };
}

for (const billingOnly of [false, true]) test(`initial email creation preserves ${billingOnly ? "billing-only" : "assigned New"} flow`, async () => {
  const h = await intake(billingOnly);
  assert.equal(h.result.action, "created", h.result.reason);
  assert.equal(h.result.workOrderId, "WOT9400051");
  assert.equal(h.result.contractorAssigned, billingOnly ? null : contractorId);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].name, "create_email_work_order_with_assignment_v1");
  const row = h.calls[0].args.p_work_order;
  assert.ok(row && typeof row === "object" && "functional_status" in row && "status" in row);
  assert.equal(row.functional_status, billingOnly ? "Completed" : "New");
  assert.equal(row.status, billingOnly ? "pending_invoice" : "assigned");
  assert.equal(h.writes.filter(write => write.table === "work_orders").length, 0);
  assert.equal(h.notifications.length, 0);
  assert.equal(h.writes.filter(write => write.table === "activities").length, billingOnly ? 1 : 0);
});
test("ineligible email assignment fails safely, creates no raw record, and sends no receiving dispatch", async () => {
  const h = await intake(false, true);
  assert.equal(h.result.action, "failed");
  assert.equal(h.notifications.length, 0);
  assert.equal(h.writes.filter(write => ["work_orders", "activities"].includes(write.table)).length, 0);
  assert.doesNotMatch(h.result.reason, /SQL internal|secret detail/);
});
