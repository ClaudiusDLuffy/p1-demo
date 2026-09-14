import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";
import { createUnsavedChangesHarness } from "./forms/test-support/unsavedChangesHarness";
import { deliverySchema, currentSchema, dispatchOperator, dispatchPresentation, dispatchStateSchema,
  DispatchOperatorError, historyItemSchema, operationSchema, operatorScope, parseDispatchCursor,
  parseDispatchPage, safeDispatchError, type DispatchDelivery, type DispatchState } from "../features/receiving-dispatch/contracts";

const delivery: DispatchDelivery = { id: "10000000-0000-4000-8000-000000000001", rootId: "10000000-0000-4000-8000-000000000001",
  workOrderId: "SYNTHETIC-1", assignmentVersion: 4, state: "unknown", attemptCount: 1,
  createdAt: "2026-09-09T01:00:00+00:00", lastAttemptAt: "2026-09-09T01:01:00+00:00", completedAt: null,
  code: "GRAPH_OUTCOME_UNKNOWN", canResend: true, canResolve: true };
const profile = { id: "synthetic-staff", active: true, role: "manager", staffPermissions: [] };

for (const state of dispatchStateSchema.options) {
  test(`operator presentation safely maps ${state}`, () => {
    const view = dispatchPresentation({ ...delivery, state });
    assert.ok(view.label && view.guidance);
    if (!["unknown", "not_deliverable", "failed"].includes(state)) {
      assert.equal(view.canResend, false);
      assert.equal(view.canResolve, false);
    }
    if (state === "unknown") assert.match(view.guidance, /may already have received/);
    if (state === "manually_resolved") { assert.equal(view.label, "Contacted another way"); assert.match(view.guidance, /does not confirm email/); }
  });
}
test("known-unsent retry and terminal failure are not inferred from count alone", () => {
  assert.equal(dispatchPresentation({ ...delivery, state: "failed", code: "GRAPH_RATE_LIMITED" }).label, "Retry scheduled");
  assert.equal(dispatchPresentation({ ...delivery, state: "failed", code: "GRAPH_RATE_LIMITED" }).canResend, false);
  assert.equal(dispatchPresentation({ ...delivery, state: "failed", code: "GRAPH_SEND_REJECTED" }).canResend, true);
  assert.equal(dispatchPresentation({ ...delivery, state: "failed", code: "GRAPH_RATE_LIMITED", attemptCount: 3 }).canResend, true);
  assert.equal(dispatchPresentation({ ...delivery, canResend: false }).canResend, false);
});
for (const role of ["manager", "dispatcher", "back_office"]) test(`operator ${role} requires current active non-controller profile`, () => {
  assert.ok(dispatchOperator({ ...profile, role }));
  assert.equal(dispatchOperator({ ...profile, role, active: false }), null);
  assert.equal(dispatchOperator({ ...profile, role, staffPermissions: ["invoice_controller"] }), null);
  assert.ok(dispatchOperator({ ...profile, role, staffPermissions: ["quickbooks_handoff"] }));
});
for (const role of ["contractor", "contractor_admin", "technician", "report_only", "invoice_controller", "service_role"])
  test(`operator surface is hidden from ${role}`, () => assert.equal(dispatchOperator({ ...profile, role }), null));
test("anonymous missing-profile stale/missing active and malformed profiles do not enable queries", () => {
  for (const candidate of [null, undefined, {}, { ...profile, active: undefined }, { ...profile, staffPermissions: "manager" }]) assert.equal(dispatchOperator(candidate), null);
  const authorized = dispatchOperator(profile); assert.ok(authorized);
  assert.deepEqual(operatorScope(authorized), ["synthetic-staff", "manager"]);
});
test("delivery/current/history projection strips provider and recipient data", () => {
  const safe = deliverySchema.parse({ ...delivery, recipient_email: "synthetic@example.invalid", provider_body: "fake sensitive response" });
  assert.equal("recipient_email" in safe, false); assert.equal("provider_body" in safe, false);
  assert.equal(currentSchema.safeParse({ kind: "current", delivery: null }).success, false);
  assert.equal(currentSchema.safeParse({ kind: "missing_intent", delivery }).success, false);
  assert.equal(historyItemSchema.safeParse({ id: `attempt:${delivery.id}`, kind: "attempt", state: "unknown",
    createdAt: delivery.createdAt, completedAt: null, reason: null, code: null, sequence: 1 }).success, true);
});
test("page parser bounds rows and continuation without exact count or raw cursor retention", () => {
  const page = parseDispatchPage({ items: [delivery], hasMore: true, nextCursor: { id: delivery.id, createdAt: delivery.createdAt } }, deliverySchema);
  assert.ok(page.nextCursor); assert.deepEqual(parseDispatchCursor(page.nextCursor), { id: delivery.id, createdAt: delivery.createdAt });
  assert.throws(() => parseDispatchPage({ items: Array.from({ length: 26 }, () => delivery), hasMore: false, nextCursor: null }, deliverySchema));
  assert.throws(() => parseDispatchPage({ items: [], hasMore: true, nextCursor: null }, deliverySchema));
  for (const bad of ["not json", "[]", "null", '{"nested":{}}', "x".repeat(2049)]) assert.throws(() => parseDispatchCursor(bad));
});
test("operation schema rejects empty/long reasons and arbitrary recipient input", () => {
  const operation = { deliveryId: delivery.id, assignmentVersion: 4, operationId: "20000000-0000-4000-8000-000000000001", reason: "  Confirmed contact  " };
  assert.equal(operationSchema.parse(operation).reason, "Confirmed contact");
  for (const reason of ["", " ", "x".repeat(501)]) assert.equal(operationSchema.safeParse({ ...operation, reason }).success, false);
  assert.equal(operationSchema.safeParse({ ...operation, recipient: "synthetic@example.invalid" }).success, false);
});
test("operator errors allow only known safe codes and never echo raw provider/database data", () => {
  assert.equal(safeDispatchError({ message: "STALE_ASSIGNMENT", details: "private response" }).code, "STALE_ASSIGNMENT");
  assert.equal(safeDispatchError({ code: "42501", message: "Active operational P1 staff required" }).code, "FORBIDDEN");
  for (const code of ["PGRST301", "PGRST302", "PT401"]) {
    const error = safeDispatchError({ code, message: "synthetic raw token gateway detail" });
    assert.equal(error.code, "AUTH_REQUIRED"); assert.equal(error.uncertain, false); assert.doesNotMatch(error.message, /gateway|token/);
  }
  assert.equal(safeDispatchError({ message: "SQL failure with token/recipient/document" }).code, "DELIVERY_UNCONFIRMED");
  assert.doesNotMatch(safeDispatchError(new Error("fake secret")).message, /secret/);
});

type Element = { type: unknown; props: Record<string, unknown> };
function elements(value: unknown): Element[] {
  if (Array.isArray(value)) return value.flatMap(elements);
  if (!value || typeof value !== "object" || !("props" in value) || !("type" in value) || !value.props || typeof value.props !== "object") return [];
  const element = { type: value.type, props: value.props as Record<string, unknown> };
  return [element, ...elements(element.props.children)];
}
function visibleText(value: unknown): string {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(visibleText).join(" ");
  if (value && typeof value === "object" && "props" in value && value.props && typeof value.props === "object" && "children" in value.props) return visibleText(value.props.children);
  return "";
}
function moduleHarness(name: string, mocks: Record<string, unknown> = {}) {
  const dismissal = createUnsavedChangesHarness();
  const filename = resolve("src/features/receiving-dispatch", name);
  const compiled = ts.transpileModule(readFileSync(filename, "utf8"), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText;
  const requireHere = createRequire(import.meta.url);
  const state: unknown[] = []; let cursor = 0;
  const effects: (() => unknown)[] = [];
  const exports: Record<string, unknown> = {};
  runInNewContext(compiled, { exports, crypto: { randomUUID: () => "20000000-0000-4000-8000-000000000001" },
    document: { activeElement: null }, HTMLElement: class {}, setTimeout, clearTimeout,
    require: (path: string) => {
      if (path in mocks) return mocks[path];
      if (path.endsWith("/useUnsavedChangesGuard")) return { useUnsavedChangesGuard: dismissal.useGuard };
      if (path.endsWith("/ui/Modal")) return { Modal: "shared-modal" };
      if (path === "react") return {
        useId: () => "synthetic-dialog",
        useCallback: (fn: unknown) => fn,
        useEffect: (fn: () => unknown) => { effects.push(fn); },
        useState: (initial: unknown) => {
          const slot = cursor++;
          if (!(slot in state)) state[slot] = typeof initial === "function" ? initial() : initial;
          return [state[slot], (next: unknown) => { state[slot] = typeof next === "function" ? next(state[slot]) : next; }];
        },
        useRef: (initial: unknown) => { const slot = cursor++; if (!(slot in state)) state[slot] = { current: initial }; return state[slot]; },
      };
      return requireHere(path.startsWith(".") ? resolve(filename, "..", path) : path);
    } }, { filename });
  return { exports, effects, call: (name: string, ...args: unknown[]) => {
    cursor = 0;
    const fn = exports[name]; assert.equal(typeof fn, "function");
    return (fn as (...input: unknown[]) => unknown)(...args);
  }, render: (props: Record<string, unknown>) => {
    cursor = 0;
    assert.equal(typeof exports.default, "function");
    return elements((exports.default as (props: Record<string, unknown>) => unknown)(props));
  } };
}
function find(tree: Element[], type: string) { const value = tree.find(item => item.type === type); assert.ok(value); return value; }
function invoke(element: Element, handler: string, payload?: unknown) {
  const fn = element.props[handler]; assert.equal(typeof fn, "function");
  return (fn as (payload?: unknown) => unknown)(payload);
}
function byText(tree: Element[], value: string) { const found = tree.find(item => item.type === "button" && visibleText(item.props.children).replace(/\s+/g, " ").trim() === value); assert.ok(found, value); return found; }
const tick = () => new Promise<void>(done => setImmediate(done));

test("real reconciliation dialog names warning/reason/confirmation and prevents silent Escape dismissal", () => {
  const h = moduleHarness("DispatchReconciliationDialog.tsx", { "./api": { reconcileDispatch: async () => undefined } });
  const props = { delivery, action: "resend", onClose: () => undefined, onCommitted: () => undefined, onConflict: () => undefined };
  let tree = h.render(props);
  assert.match(visibleText(tree[0]), /may already have received.*duplicate/);
  assert.equal(find(tree, "shared-modal").props.title, "Confirm dispatch resend");
  assert.ok(find(tree, "shared-modal").props.initialFocusRef);
  assert.equal(find(tree, "textarea").props.maxLength, 500);
  assert.equal(find(tree, "textarea").props.required, true);
  assert.equal(byText(tree, "Confirm resend").props.disabled, true);
  invoke(find(tree, "textarea"), "onChange", { target: { value: "Approved duplicate risk" } });
  invoke(find(h.render(props), "shared-modal"), "onRequestClose", "escape");
  assert.ok(find(h.render(props), "DiscardChangesDialog"));
  tree = h.render(props); invoke(find(tree, "input"), "onChange", { target: { checked: true } });
  assert.equal(byText(h.render(props), "Confirm resend").props.disabled, false);
  invoke(find(h.render(props), "textarea"), "onChange", { target: { value: "Changed reason" } });
  assert.equal(byText(h.render(props), "Confirm resend").props.disabled, true);
});
test("real dialog double-submit guard and uncertain retry preserve exact operation and reason", async () => {
  let finish: (result: unknown) => void = () => undefined;
  const calls: unknown[] = [];
  let request = new Promise<unknown>(done => { finish = done; });
  const h = moduleHarness("DispatchReconciliationDialog.tsx", { "./api": { reconcileDispatch: async (_action: unknown, input: unknown) => {
    calls.push(input); const result = await request; if (result instanceof Error) throw result; return result;
  } } });
  const committed: unknown[] = []; let closed = 0;
  const props = { delivery, action: "resend", onClose: () => { closed++; }, onCommitted: (result: unknown) => committed.push(result), onConflict: () => undefined };
  invoke(find(h.render(props), "textarea"), "onChange", { target: { value: "  Requested after phone review  " } });
  invoke(find(h.render(props), "input"), "onChange", { target: { checked: true } });
  const form = find(h.render(props), "form");
  invoke(form, "onSubmit", { preventDefault() {} }); invoke(form, "onSubmit", { preventDefault() {} });
  assert.equal(calls.length, 1); assert.equal(byText(h.render(props), "Saving…").props.disabled, true);
  finish(new DispatchOperatorError("DELIVERY_UNCONFIRMED")); await tick();
  const failed = h.render(props);
  assert.equal(find(failed, "textarea").props.disabled, true); assert.equal(find(failed, "textarea").props.value, "  Requested after phone review  ");
  assert.ok(failed.some(item => item.props.role === "alert")); assert.equal(closed, 0);
  request = Promise.resolve({ status: "queued", deliveryId: delivery.id, operationId: "20000000-0000-4000-8000-000000000001", replayed: true });
  invoke(find(failed, "form"), "onSubmit", { preventDefault() {} }); await tick();
  assert.equal(calls.length, 2); assert.equal(calls[0], calls[1]); assert.equal(committed.length, 1); assert.equal(closed, 1);
});
test("real dialog conflicts refresh and keep entered reason without false success", async () => {
  let refreshes = 0; let successes = 0;
  const h = moduleHarness("DispatchReconciliationDialog.tsx", { "./api": { reconcileDispatch: async () => { throw new DispatchOperatorError("STALE_ASSIGNMENT"); } } });
  const props = { delivery, action: "manual_resolution", onClose: () => undefined, onCommitted: () => { successes++; }, onConflict: () => { refreshes++; } };
  invoke(find(h.render(props), "textarea"), "onChange", { target: { value: "Called contractor" } });
  invoke(find(h.render(props), "input"), "onChange", { target: { checked: true } });
  invoke(find(h.render(props), "form"), "onSubmit", { preventDefault() {} }); await tick();
  const tree = h.render(props); assert.equal(refreshes, 1); assert.equal(successes, 0);
  assert.equal(byText(tree, "Confirm contact").props.disabled, true); assert.match(visibleText(tree[0]), /does not mark the email as sent/);
  assert.equal(find(tree, "textarea").props.value, "Called contractor");
});
test("current-status component renders missing/legacy/current safely and denies other roles", () => {
  let result: unknown = { kind: "missing_intent", delivery: null };
  const h = moduleHarness("ReceivingDispatchStatus.tsx", { "./queries": { useCurrentDispatch: () => ({ data: result, isPending: false, isError: false, isFetching: false, refetch: async () => undefined }) },
    "./DispatchDeliveryReview": { default: "delivery-review" } });
  const props = { profile, workOrderId: delivery.workOrderId, assignmentVersion: delivery.assignmentVersion };
  assert.match(visibleText(h.render(props)[0]), /missing its required dispatch record/);
  result = { kind: "legacy_untracked", delivery: null };
  assert.match(visibleText(h.render(props)[0]), /earlier assignment/);
  assert.deepEqual(h.render({ ...props, profile: { ...profile, role: "contractor" } }), []);
  result = { kind: "current", delivery };
  assert.ok(h.render(props).some(item => item.props.delivery === delivery));
});
test("queue component provides bounded continuation, safe work-order navigation and filters", () => {
  const cursors: unknown[] = []; const filters: unknown[] = []; const opened: string[] = [];
  const h = moduleHarness("ReceivingDispatchQueue.tsx", {
    "../../lib/useCursorPagination": { useCursorPagination: () => ({ position: { cursor: null, page: 1 }, previous: () => undefined, next: (cursor: unknown) => cursors.push(cursor) }) },
    "./queries": { useUnresolvedDispatch: (_profile: unknown, state: unknown, search: unknown) => { filters.push([state, search]); return { data: { items: [delivery], hasMore: true, nextCursor: "opaque" }, isFetching: false, isError: false, refetch: async () => undefined }; } },
    "./DispatchDeliveryReview": { default: "review", dispatchTime: () => "safe time" },
  });
  const props = { profile, onOpenWorkOrder: (id: string) => opened.push(id) };
  let tree = h.render(props);
  invoke(byText(tree, "Open SYNTHETIC-1"), "onClick"); assert.deepEqual(opened, [delivery.workOrderId]);
  invoke(byText(tree, "More dispatches"), "onClick"); assert.deepEqual(cursors, ["opaque"]);
  invoke(find(tree, "select"), "onChange", { target: { value: "unknown" } }); tree = h.render(props);
  assert.deepEqual(filters.at(-1), ["unknown", ""]); assert.equal(find(tree, "input").props.maxLength, 100);
  assert.doesNotMatch(visibleText(tree[0]), /recipient_email|provider_body|@example/);
  assert.deepEqual(h.render({ ...props, profile: { ...profile, active: false } }), []);
});
test("review component forbids resend for sent/pending/retry and describes queued/manual outcomes truthfully", () => {
  const h = moduleHarness("DispatchDeliveryReview.tsx", {
    "@tanstack/react-query": { useQueryClient: () => ({}) },
    "./queries": { invalidateDispatch: async () => undefined },
    "./DispatchReconciliationDialog": { default: "reconciliation-dialog" },
  });
  for (const state of ["pending", "sending", "sent", "superseded"] satisfies DispatchState[]) {
    assert.equal(h.render({ profile, delivery: { ...delivery, state } }).some(item => item.type === "button" && visibleText(item.props.children) === "Resend with reason"), false);
  }
  let tree = h.render({ profile, delivery }); invoke(byText(tree, "Resend with reason"), "onClick");
  tree = h.render({ profile, delivery }); const dialog = tree.find(item => item.props.action === "resend"); assert.ok(dialog);
  invoke(dialog, "onCommitted", { status: "queued" });
  assert.match(visibleText(h.render({ profile, delivery })[0]), /Resend queued. Delivery has not yet been confirmed/);
  invoke(dialog, "onCommitted", { status: "manually_resolved" });
  assert.match(visibleText(h.render({ profile, delivery })[0]), /Email delivery is not marked sent/);
});
test("new client modules contain no provider/server boundary and integrations stay feature-local", () => {
  for (const file of ["contracts.ts", "api.ts", "queries.ts", "DispatchReconciliationDialog.tsx", "DispatchDeliveryReview.tsx", "ReceivingDispatchStatus.tsx", "ReceivingDispatchQueue.tsx"]) {
    const source = readFileSync(resolve("src/features/receiving-dispatch", file), "utf8");
    assert.doesNotMatch(source, /from\s+["'][^"']*(?:server\/|graphClient|node:|receivingDispatchWorker)/);
    assert.doesNotMatch(source, /sendMail|recipient_email|service_role|invalidateQueries\(\)/);
  }
  assert.match(readFileSync("src/components/PortalShell.tsx", "utf8"), /page === "staff_work"[\s\S]*?<ReceivingDispatchQueue/);
  assert.match(readFileSync("src/features/work-orders/WorkOrderDetail.tsx", "utf8"), /<ReceivingDispatchStatus[\s\S]*?assignmentVersion=\{woData.contractorAssignmentVersion\}/);
});

function exported(h: ReturnType<typeof moduleHarness>, name: string) {
  const fn = h.exports[name]; assert.equal(typeof fn, "function");
  return fn as (...args: unknown[]) => unknown;
}
test("RPC current reader binds expected work order/version and consumes abort signal", async () => {
  const calls: unknown[] = []; const signals: unknown[] = [];
  let data: unknown = { kind: "current", delivery };
  const h = moduleHarness("api.ts", { "../../lib/supabase/client": { supabase: () => ({ rpc: (name: string, args: unknown) => {
    calls.push({ name, args }); return { abortSignal: async (signal: unknown) => { signals.push(signal); return { data, error: null }; } };
  } }) } });
  const read = exported(h, "readCurrentDispatch"); const signal = new AbortController().signal;
  const result = await read(delivery.workOrderId, 4, signal); assert.deepEqual(result, { kind: "current", delivery }); assert.equal(signals[0], signal);
  assert.equal((calls[0] as { name: string }).name, "get_receiving_dispatch_current_v1");
  data = { kind: "current", delivery: { ...delivery, assignmentVersion: 3 } };
  await assert.rejects(async () => read(delivery.workOrderId, 4, signal), /could not be confirmed/);
  data = { kind: "current", delivery: { ...delivery, workOrderId: "OTHER" } };
  await assert.rejects(async () => read(delivery.workOrderId, 4, signal), /could not be confirmed/);
});
test("RPC unresolved/history readers always request bounded pages and parse server continuation", async () => {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const h = moduleHarness("api.ts", { "../../lib/supabase/client": { supabase: () => ({ rpc: (name: string, args: Record<string, unknown>) => {
    calls.push({ name, args }); return { abortSignal: async () => ({ data: { items: [], hasMore: false, nextCursor: null }, error: null }) };
  } }) } });
  await exported(h, "readUnresolvedDispatch")("unknown", "SYNTHETIC", null, new AbortController().signal);
  await exported(h, "readDispatchHistory")(delivery.id, null, new AbortController().signal);
  assert.equal(calls.length, 2); assert.equal(calls[0].args.p_limit, 25); assert.equal(calls[1].args.p_limit, 25);
  assert.equal(calls[0].args.p_state, "unknown"); assert.equal(calls[0].args.p_cursor, null);
  await assert.rejects(async () => exported(h, "readUnresolvedDispatch")("all", "", "bad", new AbortController().signal));
  assert.equal(calls.length, 2);
});
test("RPC resend sends only immutable operation inputs and never claims queued as sent", async () => {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  let response: unknown = { status: "queued", deliveryId: delivery.id, operationId: "20000000-0000-4000-8000-000000000001", replayed: false };
  let failure: unknown = null;
  const h = moduleHarness("api.ts", { "../../lib/supabase/client": { supabase: () => ({ rpc: async (name: string, args: Record<string, unknown>) => {
    calls.push({ name, args }); return { data: response, error: failure };
  } }) } });
  const operation = { deliveryId: delivery.id, assignmentVersion: 4, operationId: "20000000-0000-4000-8000-000000000001", reason: "  Approved resend  " };
  const command = exported(h, "reconcileDispatch");
  const result = await command("resend", operation); assert.equal((result as { status: string }).status, "queued");
  assert.equal(calls[0].name, "request_receiving_dispatch_resend_v1");
  assert.deepEqual(Object.keys(calls[0].args).sort(), ["p_assignment_version", "p_delivery_id", "p_operation_id", "p_reason"]);
  assert.equal(calls[0].args.p_reason, "Approved resend");
  response = { ...(response as object), status: "sent" };
  await assert.rejects(async () => command("resend", operation), /could not be confirmed/);
  response = { status: "queued", deliveryId: delivery.id, operationId: "30000000-0000-4000-8000-000000000001", replayed: true };
  await assert.rejects(async () => command("resend", operation), /could not be confirmed/);
  failure = { message: "FORBIDDEN", details: "synthetic private provider data" };
  await assert.rejects(async () => command("resend", operation), /do not have permission/);
});
test("manual RPC command stays distinct and rejects malformed reason before network work", async () => {
  const calls: string[] = [];
  const operation = { deliveryId: delivery.id, assignmentVersion: 4, operationId: "20000000-0000-4000-8000-000000000001", reason: "Confirmed telephone contact" };
  const h = moduleHarness("api.ts", { "../../lib/supabase/client": { supabase: () => ({ rpc: async (name: string) => {
    calls.push(name); return { data: { status: "manually_resolved", deliveryId: delivery.id, operationId: operation.operationId, replayed: true }, error: null };
  } }) } });
  const command = exported(h, "reconcileDispatch");
  await assert.rejects(async () => command("manual_resolution", { ...operation, reason: "" }), /Enter a reason/);
  assert.equal(calls.length, 0);
  const result = await command("manual_resolution", operation); assert.equal((result as { status: string }).status, "manually_resolved");
  assert.deepEqual(calls, ["resolve_receiving_dispatch_out_of_band_v1"]);
});
test("query contracts isolate identities and versions, pass cancellation and bound visible refresh", async () => {
  const configs: Record<string, unknown>[] = []; const signals: unknown[] = [];
  const h = moduleHarness("queries.ts", {
    "@tanstack/react-query": { useQuery: (options: Record<string, unknown>) => { configs.push(options); return options; } },
    "./api": { readCurrentDispatch: (_workOrder: unknown, _version: unknown, signal: unknown) => { signals.push(signal); return null; },
      readUnresolvedDispatch: () => null, readDispatchHistory: () => null },
  });
  const useCurrent = exported(h, "useCurrentDispatch");
  useCurrent(profile, delivery.workOrderId, 4); const first = configs.at(-1); assert.ok(first);
  useCurrent({ ...profile, id: "another-staff" }, delivery.workOrderId, 4); assert.notDeepEqual(first.queryKey, configs.at(-1)?.queryKey);
  useCurrent(profile, delivery.workOrderId, 5); assert.notDeepEqual(first.queryKey, configs.at(-1)?.queryKey);
  useCurrent({ ...profile, active: false }, delivery.workOrderId, 4); assert.equal(configs.at(-1)?.enabled, false);
  assert.equal(first.refetchIntervalInBackground, false); assert.equal(first.retry, false);
  const signal = new AbortController().signal; const queryFn = first.queryFn; assert.equal(typeof queryFn, "function");
  (queryFn as (input: { signal: AbortSignal }) => unknown)({ signal }); assert.equal(signals[0], signal);
  exported(h, "useUnresolvedDispatch")(profile, "unknown", "SYNTHETIC", "cursor-a"); const page = configs.at(-1); assert.ok(page);
  exported(h, "useUnresolvedDispatch")(profile, "unknown", "SYNTHETIC", "cursor-b"); assert.notDeepEqual(page.queryKey, configs.at(-1)?.queryKey);
  const invalidations: Record<string, unknown>[] = [];
  const operator = dispatchOperator(profile); assert.ok(operator);
  await exported(h, "invalidateDispatch")({ invalidateQueries: async (config: Record<string, unknown>) => { invalidations.push(config); } }, operator, delivery.workOrderId, 4);
  assert.equal(invalidations.length, 3);
  for (const config of invalidations) { assert.ok(Array.isArray(config.queryKey)); assert.equal(config.queryKey[0], "receiving-dispatch"); assert.equal(config.queryKey[1], profile.id); }
});
test("notification delegates modal resource ownership and dirty backdrop dismissal to shared contracts", async () => {
  const h = moduleHarness("DispatchReconciliationDialog.tsx", { "./api": {} });
  let closed = 0;
  const props = { delivery, action: "resend", onClose: () => { closed++; }, onCommitted: () => undefined, onConflict: () => undefined };
  invoke(find(h.render(props), "textarea"), "onChange", { target: { value: "Synthetic reason" } });
  invoke(find(h.render(props), "shared-modal"), "onRequestClose", "backdrop");
  assert.equal(closed, 0);
  invoke(find(h.render(props), "DiscardChangesDialog"), "onKeepEditing");
  assert.equal(find(h.render(props), "textarea").props.value, "Synthetic reason");
  invoke(byText(h.render(props), "Cancel"), "onClick");
  invoke(find(h.render(props), "DiscardChangesDialog"), "onDiscard"); await tick();
  assert.equal(closed, 1);
  assert.equal(h.render(props).some(item => item.type === "dialog"), false);
});
test("successful resend/manual notice survives current-event replacement and queue-row removal", () => {
  let data: unknown = { kind: "current", delivery };
  const status = moduleHarness("ReceivingDispatchStatus.tsx", {
    "./queries": { useCurrentDispatch: () => ({ data, isError: false, isPending: false, isFetching: false }) },
    "./DispatchDeliveryReview": { default: "review" },
  });
  const props = { profile, workOrderId: delivery.workOrderId, assignmentVersion: 4 };
  const review = status.render(props).find(item => item.props.delivery === delivery); assert.ok(review);
  invoke(review, "onNotice", "Resend queued. Delivery has not yet been confirmed.");
  data = { kind: "current", delivery: { ...delivery, id: "30000000-0000-4000-8000-000000000001", state: "pending" } };
  assert.match(visibleText(status.render(props)[0]), /Resend queued/);
  let items = [delivery];
  const queue = moduleHarness("ReceivingDispatchQueue.tsx", {
    "../../lib/useCursorPagination": { useCursorPagination: () => ({ position: { cursor: null, page: 1 }, previous: () => undefined, next: () => undefined }) },
    "./queries": { useUnresolvedDispatch: () => ({ data: { items, hasMore: false, nextCursor: null }, isFetching: false, isError: false }) },
    "./DispatchDeliveryReview": { default: "review", dispatchTime: () => "safe time" },
  });
  const queueProps = { profile, onOpenWorkOrder: () => undefined };
  invoke(byText(queue.render(queueProps), "Review dispatch"), "onClick");
  const queueReview = queue.render(queueProps).find(item => item.props.delivery === delivery); assert.ok(queueReview);
  invoke(queueReview, "onNotice", "Contact recorded another way. Email delivery is not marked sent.");
  items = [];
  assert.match(visibleText(queue.render(queueProps)[0]), /Contact recorded another way/);
});
test("real shared cursor hook resets page for filter/search/identity changes without collecting rows", () => {
  const h = moduleHarness("../../lib/useCursorPagination.ts");
  type Pagination = { position: { page: number; cursor: string | null }; next: (cursor: string) => void };
  const first = h.call("useCursorPagination", "staff-a:unknown:work-a") as Pagination;
  first.next("cursor-a");
  const second = h.call("useCursorPagination", "staff-a:unknown:work-a") as Pagination;
  assert.equal(second.position.page, 2); assert.equal(second.position.cursor, "cursor-a");
  for (const signature of ["staff-a:failed:work-a", "staff-a:unknown:work-b", "staff-b:unknown:work-a"]) {
    const changed = h.call("useCursorPagination", signature) as Pagination;
    assert.equal(changed.position.page, 1); assert.equal(changed.position.cursor, null);
  }
  assert.match(readFileSync("src/features/receiving-dispatch/ReceivingDispatchQueue.tsx", "utf8"), /useCursorPagination\(JSON.stringify\(\[operator\?\.id, state, search, reset\]\)\)/);
});
