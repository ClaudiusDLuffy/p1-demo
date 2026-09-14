import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";
import { apiFetch } from "./errors/apiFetch";
import { workOrderByIdKey, workOrderDetailsKey } from "./counts/queryKeys";

// Real hook closures with synthetic React/query/transport ports, not browser E2E.
const filename = resolve("src/features/work-orders/useWorkOrders.ts");
const compiled = ts.transpileModule(readFileSync(filename, "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const requireHere = createRequire(import.meta.url);
type Command = (...args: unknown[]) => Promise<unknown>;
const target = "00000000-0000-4000-8000-000000000002";
function harness(fail = false, beforeResult: () => Promise<void> = async () => undefined, pendingTransfer = false) {
  const messages: string[] = [];
  const loading: Record<string, boolean>[] = [];
  const invalidations: unknown[] = [];
  const removals: unknown[] = [];
  const navigation: unknown[] = [];
  const calls: { name: string; args: unknown[] }[] = [];
  const directoryReads: { domain: string; id: string }[] = [];
  const deliveries: string[] = [];
  const workOrder = {
    id: "WOT9400001", status: "assigned", functionalStatus: "Dispatched",
    contractorAssignmentVersion: 2, workflowCycle: 1, lifecycleVersion: 3,
    contractor: "00000000-0000-4000-8000-000000000001", activities: [],
    assignmentTransferPendingVisit: pendingTransfer,
  };
  const workOrders = [workOrder];
  const cache = new Map<unknown, unknown>();
  const keys = Object.fromEntries([
    "WORK_ORDERS_KEY", "WORK_ORDER_PAGES_KEY", "WORK_ORDER_BY_ID_KEY", "WORK_ORDER_DETAILS_KEY",
    "PORTAL_NAVIGATION_SUMMARY_KEY", "CONTRACTOR_WORKLOAD_SUMMARY_KEY", "WO_PARTS_KEY",
    "INVOICES_KEY", "INVOICE_PAGES_KEY", "INVOICE_BY_ID_KEY",
  ].map(key => [key, [key]]));
  cache.set(keys.WORK_ORDERS_KEY, workOrders);
  const commands = new Proxy({}, { get: (_object, name: string) => async (...args: unknown[]) => {
    calls.push({ name, args });
    await beforeResult();
    if (fail) throw new Error("Synthetic failure");
    return {
      applied: true, reason: "assigned", workOrderId: name === "duplicateWorkOrderForReassignment" ? "WOT9400001-1" : workOrder.id,
      assignmentVersion: 3, lifecycleVersion: 4, workflowCycle: 1, contractorId: name === "transitionWorkOrderContractor" ? args[1] : target,
      status: "assigned", functionalStatus: "Dispatched", isCapital: false, capitalStatus: null,
      assignmentStartedAt: "2026-09-08T10:00:00Z", dispatchedAt: "2026-09-08T10:00:00Z",
      deliveryId: "00000000-0000-4000-8000-000000000003", deliveryStatus: "pending",
    };
  } });
  const qc = {
    getQueryData: (key: unknown) => cache.get(key),
    setQueryData: (key: unknown, value: unknown) => cache.set(key, typeof value === "function" ? value(cache.get(key)) : value),
    invalidateQueries: ({ queryKey }: { queryKey: unknown }) => { invalidations.push(queryKey); return Promise.resolve(); },
    removeQueries: ({ queryKey }: { queryKey: unknown }) => removals.push(queryKey),
  };
  const exports: { default?: (props: Record<string, unknown>) => Record<string, Command> } = {};
  const customRequire = (name: string): unknown => {
    if (name.endsWith("/errors/apiFetch")) return { apiFetch: (input: RequestInfo | URL, init?: RequestInit) => apiFetch(input, init, transport) };
    if (name === "react") return {
      useEffect: () => undefined, useRef: (current: unknown) => ({ current }),
      useState: (initial: unknown) => {
        let current = initial;
        return [current, (next: unknown) => {
          current = typeof next === "function" ? next(current) : next;
          if (current && typeof current === "object" && !Array.isArray(current)) loading.push(current as Record<string, boolean>);
        }];
      },
    };
    if (name === "@tanstack/react-query") return { useQueryClient: () => qc };
    if (name.endsWith("/queries")) return { ...keys, workOrderDetailsKey, workOrderByIdKey };
    if (name.endsWith("/db")) return commands;
    if (name.endsWith("/directory/api")) return {
      loadDirectorySelection: async (domain: string, id: string) => {
        directoryReads.push({ domain, id });
        return { id, name: "Synthetic Contractor", company: "Synthetic Company" };
      },
      loadAutoAssignmentCandidate: async () => ({ id: target, name: "Synthetic Contractor", company: "Synthetic Company" }),
    };
    if (name.endsWith("/supabase/client")) return { supabase: () => ({ auth: { getSession: async () => ({ data: { session: { access_token: "synthetic-test-token" } } }) } }) };
    return requireHere(resolve(filename, "..", name));
  };
  const transport: typeof fetch = async (url) => {
    deliveries.push(String(url));
    return Response.json({ success: true, delivery: "sent" });
  };
  runInNewContext(compiled, { exports, require: customRequire, console, Date, Map, Set, Promise, AbortSignal, crypto: globalThis.crypto, fetch: transport }, { filename });
  assert.ok(exports.default);
  const hook = exports.default({
    currentUser: { id: "00000000-0000-4000-8000-000000000004", name: "Synthetic Staff", role: "manager" },
    workOrdersData: workOrders, invoices: [], setInvoices: () => undefined,
    fire: (message: string) => messages.push(message), isManager: true,
    dateNow: () => "Synthetic time", fmt: (value: unknown) => String(value),
    setSelectedWO: (id: unknown) => navigation.push(id), setPage: (page: unknown) => navigation.push(page), setAiNote: () => undefined,
    startDateInput: "2001-01-01", startTimeInput: "00:00",
  });
  return { hook, messages, loading, invalidations, calls, directoryReads, deliveries, cache, keys, workOrders, navigation, removals };
}

test("assignment exact-loads a selected contractor without a preloaded directory or getUser callback", async () => {
  const h = harness();
  assert.equal(await h.hook.doAssign("WOT9400001", target), true);
  assert.deepEqual(h.directoryReads, [{ domain: "assignable_contractors", id: target }]);
  assert.equal(h.calls[0].args[1], target);
});

for (const scenario of [
  { action: "doAssign", args: [target], loading: "assign", success: "Assigned to Synthetic Contractor. See Receiving dispatch", failure: "Dispatch failed", command: "transitionWorkOrderContractor", receiving: true },
  { action: "doReassign", args: [target], loading: "reassign", success: "Reassigned to Synthetic Contractor.", failure: "Reassign failed", command: "transitionWorkOrderContractor", receiving: true },
  { action: "doUnassign", args: [], loading: "unassign", success: "Work order unassigned.", failure: "Unassign failed", command: "transitionWorkOrderContractor", receiving: false },
  { action: "doAdministrativeTransfer", args: [target, "Emergency visit transfer", true], loading: "administrativeTransfer", success: "Visit administratively closed", failure: "Administrative transfer failed", command: "administrativelyCloseVisitAndTransfer", receiving: true },
  { action: "doRejectUnassignedWO", args: ["Synthetic valid reason"], loading: "rejectUnassignedWO", success: "Work order WOT9400001 rejected and removed from dispatch.", failure: "Reject failed", command: "rejectUnassignedWorkOrder", receiving: false },
  { action: "doDuplicateForReassignment", args: [], loading: "duplicateForReassignment", success: "Created WOT9400001-1.", failure: "Duplicate failed", command: "duplicateWorkOrderForReassignment", receiving: false },
]) {
  test(`assignment UI characterization: ${scenario.action}`, async () => {
    const h = harness();
    await h.hook[scenario.action]("WOT9400001", ...scenario.args);
    // Receiving status refresh is optional after the assignment commits.
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.ok(h.messages.some(message => message.startsWith(scenario.success)));
    assert.equal(h.loading.at(0)?.[`${scenario.loading}_WOT9400001`], true);
    assert.equal(h.loading.at(-1)?.[`${scenario.loading}_WOT9400001`], false);
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0].name, scenario.command);
    if (scenario.command !== "administrativelyCloseVisitAndTransfer") assert.equal(h.calls[0].args[0], "WOT9400001");
    if (scenario.command === "transitionWorkOrderContractor") assert.equal(h.calls[0].args[2], 2);
    const context = scenario.command === "administrativelyCloseVisitAndTransfer" ? h.calls[0].args[0] : h.calls[0].args.at(-1);
    assert.ok(context && typeof context === "object" && "expectedAssignmentVersion" in context && "expectedWorkflowCycle" in context && "expectedLifecycleVersion" in context && "operationId" in context);
    assert.equal(context.expectedAssignmentVersion, 2);
    assert.equal(context.expectedWorkflowCycle, 1);
    assert.equal(context.expectedLifecycleVersion, 3);
    assert.equal(typeof context.operationId, "string");
    if (scenario.command === "administrativelyCloseVisitAndTransfer") {
      assert.equal(h.calls[0].args[1], target);
      assert.equal(h.calls[0].args[2], "Emergency visit transfer");
      assert.equal(h.calls[0].args[3], true);
      assert.ok(h.invalidations.some(key => JSON.stringify(key) === JSON.stringify(["work-order-visits", "billing", "WOT9400001"])));
      assert.ok(h.messages.some(message => message.includes("Duration requires review")));
    }
    assert.equal(h.deliveries.includes("/api/notifications/dispatch"), scenario.receiving);
    if (scenario.action === "doRejectUnassignedWO") { assert.ok(h.navigation.includes("dashboard")); assert.equal(h.removals.length, 2); }
    if (scenario.action === "doDuplicateForReassignment") assert.ok(h.navigation.includes("WOT9400001-1"));
  });
  test(`assignment failure remains visible: ${scenario.action}`, async () => {
    const h = harness(true);
    await h.hook[scenario.action]("WOT9400001", ...scenario.args);
    assert.ok(h.messages.some(message => message.startsWith(scenario.failure)));
    assert.equal(h.loading.at(-1)?.[`${scenario.loading}_WOT9400001`], false);
    assert.equal(h.deliveries.length, 0);
    assert.ok(h.invalidations.includes(h.keys.WORK_ORDER_DETAILS_KEY));
    assert.equal(h.cache.get(h.keys.WORK_ORDERS_KEY), h.workOrders);
  });
}

test("invalid rejection reason performs no mutation", async () => {
  const h = harness();
  assert.equal(await h.hook.doRejectUnassignedWO("WOT9400001", "bad"), false);
  assert.equal(h.calls.length, 0);
  assert.deepEqual(h.messages, ["Enter a rejection reason between 5 and 500 characters."]);
});

test("receiving start uses a fresh full-precision timestamp, not rounded or stale arrival form inputs", async () => {
  const h = harness(false, undefined, true);
  const before = Date.now();
  await h.hook.doStartWork("WOT9400001", "Receiving contractor starts its own visit");
  const after = Date.now();
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].name, "startWorkOrderVisit");
  assert.equal(h.calls[0].args[1], true);
  const input = h.calls[0].args[0];
  assert.ok(input && typeof input === "object" && "checkedInAt" in input && typeof input.checkedInAt === "string");
  const checkedIn = Date.parse(input.checkedInAt);
  assert.ok(checkedIn >= before && checkedIn <= after);
});

test("repeated assignment click keeps one pending command and its loading indicator", async () => {
  let finish: () => void = () => undefined;
  const pending = new Promise<void>(resolve => { finish = resolve; });
  const h = harness(false, () => pending);
  const first = h.hook.doAssign("WOT9400001", target);
  assert.equal(await h.hook.doAssign("WOT9400001", target), false);
  assert.equal(await h.hook.doUnassign("WOT9400001"), false);
  assert.equal(h.calls.length, 1);
  assert.equal(h.loading.at(-1)?.assign_WOT9400001, true);
  finish();
  assert.equal(await first, true);
  assert.equal(h.loading.at(-1)?.assign_WOT9400001, false);
});

test("uncertain assignment retry preserves captured operation and versions in the real hook", async () => {
  const h = harness(true);
  await h.hook.doAssign("WOT9400001", target);
  await h.hook.doAssign("WOT9400001", target);
  assert.equal(h.calls.length, 2);
  assert.deepEqual(h.calls[0].args, h.calls[1].args);
  assert.equal(h.deliveries.length, 0);
});

test("manual creation facade owns assignment atomically and preserves the ordinary creation message", async () => {
  const { exerciseAssignmentFacade } = await import("./assignment-test-support/facade");
  await exerciseAssignmentFacade("create");
});
test("ordinary assignment-related prose is not promoted to a reserved authoritative event", async () => {
  const { exerciseAssignmentFacade } = await import("./assignment-test-support/facade");
  await exerciseAssignmentFacade("communication");
});
