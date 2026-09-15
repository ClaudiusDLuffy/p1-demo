import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";

// Execute the real hook's command closures without a DOM or network. React's
// state/effect and query ports are controlled here; this is not a browser test.
const filename = resolve("src/features/work-orders/useWorkOrders.ts");
const compiled = ts.transpileModule(readFileSync(filename, "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const requireHere = createRequire(import.meta.url);
type Command = (...args: unknown[]) => Promise<unknown>;

function harness(status = "assigned", fail = false) {
  const messages: string[] = [];
  const loading: Record<string, boolean>[] = [];
  const invalidations: unknown[] = [];
  const calls: { name: string; args: unknown[] }[] = [];
  const workOrder = {
    id: "WOTTEST001", status, functionalStatus: status === "parts" ? "Awaiting Parts" : status === "assigned" ? "Dispatched" : "Work in Progress",
    contractorAssignmentVersion: 2, workflowCycle: 1, lifecycleVersion: 3,
    contractor: "00000000-0000-4000-8000-000000000001", activities: [],
  };
  const workOrders = [workOrder];
  const cache = new Map<unknown, unknown>();
  const keys = Object.fromEntries([
    "WORK_ORDERS_KEY", "WORK_ORDER_PAGES_KEY", "WORK_ORDER_BY_ID_KEY", "WORK_ORDER_DETAILS_KEY",
    "PORTAL_NAVIGATION_SUMMARY_KEY", "CONTRACTOR_WORKLOAD_SUMMARY_KEY", "WO_PARTS_KEY",
    "INVOICES_KEY", "INVOICE_PAGES_KEY", "INVOICE_BY_ID_KEY",
  ].map(key => [key, [key]]));
  cache.set(keys.WORK_ORDERS_KEY, workOrders);
  const result = { applied: true, reason: "applied", workOrderId: workOrder.id, operationId: "00000000-0000-4000-8000-000000000002", assignmentVersion: 2, workflowCycle: 1, lifecycleVersion: 4, activityId: "00000000-0000-4000-8000-000000000003", parts: [], workOrderStatus: "wip", functionalStatus: "Work in Progress" };
  const commands = new Proxy({}, { get: (_target, name: string) => async (...args: unknown[]) => {
    calls.push({ name, args });
    if (fail) throw new Error("Synthetic failure");
    return result;
  } });
  const qc = {
    getQueryData: (key: unknown) => cache.get(key),
    setQueryData: (key: unknown, value: unknown) => cache.set(key, typeof value === "function" ? value(cache.get(key)) : value),
    invalidateQueries: ({ queryKey }: { queryKey: unknown }) => { invalidations.push(queryKey); return Promise.resolve(); },
  };
  const exports: { default?: (props: Record<string, unknown>) => Record<string, Command> } = {};
  const customRequire = (name: string): unknown => {
    if (name === "react") return {
      useEffect: () => undefined,
      useRef: (current: unknown) => ({ current }),
      useState: (initial: unknown) => {
        let current = initial;
        return [current, (next: unknown) => {
          current = typeof next === "function" ? next(current) : next;
          if (current && typeof current === "object" && !Array.isArray(current)) loading.push(current as Record<string, boolean>);
        }];
      },
    };
    if (name === "@tanstack/react-query") return { useQueryClient: () => qc };
    if (name.endsWith("/queries")) return { ...keys, workOrderDetailsKey: (id: string) => ["detail", id] };
    if (name.endsWith("/db")) return commands;
    if (name.endsWith("/supabase/client")) return { supabase: () => { throw new Error("Network is forbidden in this test"); } };
    return requireHere(resolve(filename, "..", name));
  };
  runInNewContext(compiled, { exports, require: customRequire, console, Date, Map, Set, Promise, crypto: globalThis.crypto }, { filename });
  assert.ok(exports.default);
  const hook = exports.default({
    currentUser: { id: "00000000-0000-4000-8000-000000000001", name: "Synthetic User", role: "contractor" },
    USERS: [], workOrdersData: workOrders, invoices: [], setInvoices: () => undefined,
    fire: (message: string) => messages.push(message), isManager: false,
    dateNow: () => "Synthetic time", fmt: (value: unknown) => String(value),
    startDateInput: "", startTimeInput: "", pauseDateInput: "", pauseTimeInput: "",
  });
  return { hook, messages, loading, invalidations, calls, cache, keys, workOrders };
}

for (const scenario of [
  { action: "doSetEta", status: "assigned", args: ["2026-09-08T10:00:00Z"], loading: "setEta", success: "ETA set", failure: "ETA save failed" },
  { action: "doStartWork", status: "assigned", args: ["Synthetic check-in"], loading: "startWork", success: "Work started · 7-Eleven update pending", failure: "Start work failed" },
  { action: "doStartWork", status: "parts", args: ["Synthetic resume"], loading: "startWork", success: "Work started · 7-Eleven update pending", failure: "Start work failed" },
  { action: "doPauseWork", status: "wip", args: ["Awaiting parts", "Motor", "M1", "2026-09-10", "Synthetic pause", [{ description: "Motor", partNumber: "M1", qty: 1, expectedReturnDate: "2026-09-10" }]], loading: "pauseWork", success: "Paused — awaiting parts · 7-Eleven update pending", failure: "Pause failed" },
  { action: "doCloseComplete", status: "pending_approval", args: ["Make", "Model", "Serial", "Current Asset Repaired", 2026, "2026-09-08T12:00:00Z", "Synthetic completion"], loading: "closeComplete", success: "Completed", failure: "Close failed" },
]) {
  test(`lifecycle UI characterization: ${scenario.status} ${scenario.action}`, async () => {
    const h = harness(scenario.status);
    assert.equal(await h.hook[scenario.action]("WOTTEST001", ...scenario.args), true,
      "successful command explicitly permits the form's submitted close");
    assert.ok(h.messages.includes(scenario.success));
    assert.equal(h.loading.at(0)?.[`${scenario.loading}_WOTTEST001`], true);
    assert.equal(h.loading.at(-1)?.[`${scenario.loading}_WOTTEST001`], false);
    assert.ok(h.invalidations.includes(h.keys.WORK_ORDER_DETAILS_KEY));
    assert.ok(h.invalidations.includes(h.keys.WORK_ORDER_BY_ID_KEY));
    assert.ok(h.invalidations.includes(h.keys.WORK_ORDER_PAGES_KEY));
    assert.ok(h.calls.length > 0);
    assert.equal(h.calls.length, 1, "one owning command, no separate parent/visit/event/parts mutation");
    assert.equal(h.calls[0].name, scenario.action === "doSetEta" ? "setWorkOrderEta"
      : scenario.action === "doStartWork" ? "startWorkOrderVisit"
      : scenario.action === "doPauseWork" ? "pauseWorkOrderForParts" : "completeWorkOrderOnce");
    if (scenario.action === "doStartWork") assert.equal(h.calls[0].args[1], scenario.status === "parts");
  });
  test(`lifecycle failure restores snapshot: ${scenario.status} ${scenario.action}`, async () => {
    const h = harness(scenario.status, true);
    assert.equal(await h.hook[scenario.action]("WOTTEST001", ...scenario.args), false,
      "failed command keeps authored form values mounted for retry");
    assert.ok(h.messages.some(message => message.startsWith(scenario.failure)));
    if (scenario.action === "doStartWork") assert.ok(!h.messages.includes(scenario.success),
      "a rejected start must not announce that work started");
    assert.equal(h.cache.get(h.keys.WORK_ORDERS_KEY), h.workOrders);
    assert.equal(h.loading.at(-1)?.[`${scenario.loading}_WOTTEST001`], false);
    assert.ok(h.invalidations.includes(h.keys.WORK_ORDER_DETAILS_KEY));
  });
}

test("a rejected start reports the safe failure inside its owning modal", async () => {
  const h = harness("assigned", true);
  const inlineFailures: string[] = [];
  assert.equal(await h.hook.doStartWork(
    "WOTTEST001",
    "Synthetic check-in",
    (message: string) => inlineFailures.push(message),
  ), false);
  assert.deepEqual(inlineFailures, [
    "Start work failed: The action could not be confirmed. Refresh the work order before trying again.",
  ]);
});

test("pause remains unavailable outside Work in Progress", async () => {
  const h = harness("assigned");
  assert.equal(await h.hook.doPauseWork("WOTTEST001", "Awaiting parts", "", "", "", ""), false);
  assert.deepEqual(h.messages, ["Only work in progress can be paused for parts"]);
  assert.equal(h.calls.length, 0);
});

test("a repeated click cannot dispatch two overlapping lifecycle commands", async () => {
  const h = harness("assigned");
  const first = h.hook.doStartWork("WOTTEST001", "Synthetic check-in");
  const repeated = h.hook.doStartWork("WOTTEST001", "Synthetic check-in");
  assert.equal(await repeated, false);
  await first;
  assert.equal(h.calls.length, 1);
});
