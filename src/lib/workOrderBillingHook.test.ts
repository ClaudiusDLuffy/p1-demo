import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";

const filename = resolve("src/features/work-orders/useWorkOrders.ts");
const compiled = ts.transpileModule(readFileSync(filename, "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const requireHere = createRequire(import.meta.url);
function harness(failure = false, invoiceReview = false) {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const messages: string[] = [];
  const invalidations: unknown[] = [];
  const loading: unknown[] = [];
  const invoiceCalls: string[] = [];
  const workOrder = { id: "WOT-SYNTHETIC", status: "completed", functionalStatus: "Completed",
    contractorAssignmentVersion: 2, workflowCycle: 1, lifecycleVersion: 7, activities: [] };
  const workOrders = [workOrder];
  const keys = Object.fromEntries(["WORK_ORDERS_KEY", "WORK_ORDER_PAGES_KEY", "WORK_ORDER_BY_ID_KEY",
    "WORK_ORDER_DETAILS_KEY", "PORTAL_NAVIGATION_SUMMARY_KEY", "CONTRACTOR_WORKLOAD_SUMMARY_KEY"]
    .map(key => [key, [key]]));
  const restored: unknown[] = [];
  const qc = { getQueryData: () => workOrders, setQueryData: (_key: unknown, value: unknown) => restored.push(value),
    invalidateQueries: (value: unknown) => { invalidations.push(value); return Promise.resolve(); } };
  const exports: { default?: (props: Record<string, unknown>) => Record<string, (...args: string[]) => Promise<unknown>> } = {};
  const customRequire = (name: string): unknown => {
    if (name === "react") return { useEffect: () => undefined, useRef: (current: unknown) => ({ current }),
      useState: (initial: unknown) => {
        let value = initial;
        return [value, (next: unknown) => { value = typeof next === "function" ? next(value) : next; loading.push(value); }];
      } };
    if (name === "@tanstack/react-query") return { useQueryClient: () => qc };
    if (name.endsWith("/queries")) return { ...keys, workOrderDetailsKey: (id: string) => ["details", id] };
    if (name.endsWith("/db")) return new Proxy({}, { get: (_target, name: string) => async () => {
      if (invoiceReview && name === "loadInvoiceSummaryById") {
        invoiceCalls.push(name);
        return { projection: "summary", id: "synthetic-invoice", num: "TEST", wot: workOrder.id,
          lineCount: 1001, invoiceVersion: 0 };
      }
      if (invoiceReview && name === "reviewContractorInvoice") {
        invoiceCalls.push(name); return { workOrderStatus: "pending_invoice" };
      }
      throw new Error("Raw data-layer mutation forbidden");
    } });
    if (name.endsWith("/supabase/client")) return { supabase: () => ({ rpc: async (rpc: string, args: Record<string, unknown>) => {
      calls.push({ name: rpc, args });
      if (failure) return { data: null, error: { code: "XX000", message: "private SQL content" } };
      return { error: null, data: { applied: true, reason: "applied", workOrderId: workOrder.id,
        operationId: args.p_operation_id, assignmentVersion: 2, workflowCycle: 1, lifecycleVersion: 8,
        workOrderStatus: "pending_invoice", functionalStatus: "Completed", activityId: "00000000-0000-4000-8000-000000000003" } };
    } }) };
    return requireHere(resolve(filename, "..", name));
  };
  runInNewContext(compiled, { exports, require: customRequire, Date, Map, Set, Promise, crypto: globalThis.crypto }, { filename });
  assert.ok(exports.default);
  const hook = exports.default({ currentUser: { name: "Synthetic Staff", role: "manager" }, workOrdersData: workOrders,
    invoices: [], setInvoices: () => undefined, fire: (message: string) => messages.push(message), dateNow: () => "Synthetic time", isManager: true });
  return { hook, calls, messages, invalidations, loading, restored, workOrders, invoiceCalls };
}
test("billing-ready UI uses one command, prevents double click, refreshes detail and retains success wording", async () => {
  const h = harness();
  const first = h.hook.doMoveToInvoice("WOT-SYNTHETIC");
  assert.equal(await h.hook.doMoveToInvoice("WOT-SYNTHETIC"), false);
  assert.equal(await first, true);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].name, "mark_work_order_ready_for_billing_v1");
  assert.deepEqual(h.messages, ["Moved to Pending 7-Eleven Submission"]);
  assert.match(JSON.stringify(h.invalidations), /WORK_ORDER_DETAILS_KEY/);
  assert.match(JSON.stringify(h.loading.at(-1)), /"moveToInvoice_WOT-SYNTHETIC":false/);
});
test("billing-ready uncertain failure restores the cache and retries the same operation without leaking SQL", async () => {
  const h = harness(true);
  assert.equal(await h.hook.doMoveToInvoice("WOT-SYNTHETIC"), false);
  assert.equal(await h.hook.doMoveToInvoice("WOT-SYNTHETIC"), false);
  assert.deepEqual(h.calls[0].args, h.calls[1].args);
  assert.equal(h.restored[0], h.workOrders);
  assert.match(h.messages[0], /^Update failed:/);
  assert.doesNotMatch(h.messages.join(" "), /private SQL/);
});
test("unused raw mark-paid compatibility callback fails closed without reads or writes", async () => {
  const h = harness();
  assert.equal(await h.hook.doMarkPaid("00000000-0000-4000-8000-000000000003"), false);
  assert.equal(h.calls.length, 0);
  assert.match(h.messages[0], /payables|handoff/i);
});
test("review of an unloaded historical invoice needs no full document or line hydration", async () => {
  const h = harness(false, true);
  assert.equal(await h.hook.doApproveInvoice("synthetic-invoice"), true);
  assert.deepEqual(h.invoiceCalls, ["loadInvoiceSummaryById", "reviewContractorInvoice"]);
  assert.equal(h.calls.length, 0);
  assert.match(h.messages.at(-1) || "", /Invoice #TEST approved/);
});
