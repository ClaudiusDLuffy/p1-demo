import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";
import { createUnsavedChangesHarness } from "./forms/test-support/unsavedChangesHarness";
import { canActOnNotice, canReviewNotices, FinancialNoticeError, financialReviewSelection, noticeFamilySchema,
  noticeEventPresentation, noticeHistoryLabel, noticeHistorySchema, noticeOperator, noticeOperationSchema, noticePresentation, noticePriorOutcomeLabel, noticeSchema, noticeStateSchema,
  parseNoticeCursor, parseNoticePage, parseNoticeStatus, safeNoticeError, type FinancialNotice } from "../features/financial-notifications/contracts";

const delivery: FinancialNotice = { id: "10000000-0000-4000-8000-000000000001", rootId: "10000000-0000-4000-8000-000000000001",
  eventId: "20000000-0000-4000-8000-000000000001", invoiceId: "30000000-0000-4000-8000-000000000001",
  sourceEventId: "40000000-0000-4000-8000-000000000001", workOrderId: "SYNTHETIC-INVOICE-WO", family: "invoice_rejected",
  reviewRevision: 2, recipientKind: "contractor", state: "unknown", attemptCount: 1,
  createdAt: "2026-09-09T01:00:00+00:00", lastAttemptAt: null, completedAt: null, code: "GRAPH_OUTCOME_UNKNOWN",
  current: true, recipientLabel: "Synthetic Supplier", canResend: true, canResolve: true,
  supersededBySourceEventId: null, supersededAt: null, canAnnotateHistory: false };
const profile = { id: "synthetic-staff", role: "manager", active: true, staffPermissions: [] };

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
  const filename = resolve("src/features/financial-notifications", name);
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

for (const state of noticeStateSchema.options) test(`financial notification presentation maps ${state} without false delivered claims`, () => {
  const view = noticePresentation({ ...delivery, state });
  assert.ok(view.label && view.guidance);
  if (!["unknown", "failed", "not_deliverable"].includes(state)) { assert.equal(view.canResend, false); assert.equal(view.canResolve, false); }
  if (state === "unknown") assert.match(view.guidance, /may already have received/);
  if (state === "manually_resolved") assert.match(view.guidance, /not marked sent/);
  if (state === "pending") assert.match(view.guidance, /action was saved/);
});
test("only known-unsent codes with remaining attempts are labeled automatic retry", () => {
  assert.equal(noticePresentation({ ...delivery, state: "failed", code: "GRAPH_RATE_LIMITED" }).canResend, false);
  assert.equal(noticePresentation({ ...delivery, state: "failed", code: "GRAPH_RATE_LIMITED", attemptCount: 3 }).canResend, true);
  assert.equal(noticePresentation({ ...delivery, state: "failed", code: "GRAPH_CONFIG_UNAVAILABLE" }).label, "Delivery failed");
});
for (const family of ["payment_hold_placed", "payment_hold_released"] as const) {
  for (const state of noticeStateSchema.options) test(`older ${family} ${state} is historical without relabeling its original outcome`, () => {
    const older = { ...delivery, family, state, current: false, canResend: true, canResolve: true, canAnnotateHistory: true,
      supersededBySourceEventId: "60000000-0000-4000-8000-000000000001", supersededAt: "2026-09-09T02:00:00+00:00" };
    const view = noticeEventPresentation(older, older.supersededBySourceEventId);
    assert.equal(view.label, "Superseded by a later hold change"); assert.equal(view.current, false);
    assert.equal(view.originalLabel, noticePresentation(older).label);
    assert.equal(view.canResend, false); assert.equal(view.canResolve, false);
    assert.equal(view.canAnnotateHistory, state === "unknown" || state === "superseded");
    assert.equal(older.state, state);
  });
}
test("latest effective hold retains its actual queued/sending/retry/sent/unknown/manual labels", () => {
  for (const state of noticeStateSchema.options) {
    const current = { ...delivery, family: "payment_hold_placed" as const, state };
    const view = noticeEventPresentation(current, current.sourceEventId);
    assert.equal(view.label, noticePresentation(current).label);
    assert.equal(view.current, true); assert.equal(view.canAnnotateHistory, false);
    if (state === "unknown") { assert.equal(view.canResend, true); assert.match(view.guidance, /may already have received/); }
  }
});
test("hold source mismatch fails closed for actions even if a stale projection claims current", () => {
  const view = noticeEventPresentation({ ...delivery, family: "payment_hold_placed" }, "60000000-0000-4000-8000-000000000001");
  assert.equal(view.current, false); assert.equal(view.canResend, false); assert.equal(view.canResolve, false);
});
test("latest-hold policy does not alter invoice rejection/retraction presentation or action semantics", () => {
  for (const family of ["invoice_rejected", "invoice_rejection_retracted"] as const) {
    for (const state of noticeStateSchema.options) {
      const original = { ...delivery, family, state };
      const old = noticePresentation(original); const candidate = noticeEventPresentation(original, "60000000-0000-4000-8000-000000000001");
      assert.equal(candidate.label, old.label); assert.equal(candidate.guidance, old.guidance);
      assert.equal(candidate.canResend, old.canResend); assert.equal(candidate.canResolve, old.canResolve);
    }
  }
});
for (const role of ["manager", "dispatcher", "back_office"]) test(`financial ${role} visibility separates review from controller/handoff capabilities`, () => {
  const staff = noticeOperator({ ...profile, role }); assert.ok(staff);
  assert.equal(canReviewNotices(staff), true);
  assert.equal(canActOnNotice(staff, "payment_hold_placed"), true);
  assert.equal(canActOnNotice(staff, "payment_hold_released"), false);
  const controller = noticeOperator({ ...profile, role, staffPermissions: ["invoice_controller", "quickbooks_handoff"] }); assert.ok(controller);
  assert.equal(canReviewNotices(controller), false); assert.equal(canActOnNotice(controller, "invoice_rejected"), false);
  assert.equal(canActOnNotice(controller, "payment_hold_placed"), true); assert.equal(canActOnNotice(controller, "payment_hold_released"), true);
  assert.equal(noticeOperator({ ...profile, role, active: false }), null);
});
for (const role of ["contractor", "contractor_admin", "technician", "report_only", "service_role", "invoice_controller"])
  test(`nonstaff ${role} cannot gain financial notice access with forged additive grant`, () => assert.equal(noticeOperator({ ...profile, role, staffPermissions: ["quickbooks_handoff"] }), null));
test("financial schemas strip private fields and bind finite bounded page/status/cursors", () => {
  const parsed = noticeSchema.parse({ ...delivery, recipientEmail: "synthetic@example.invalid", providerResponse: "fake secret" });
  assert.equal("recipientEmail" in parsed, false); assert.equal("providerResponse" in parsed, false);
  const page = parseNoticeStatus({ items: [delivery], hasMore: true, nextCursor: { version: 1, id: delivery.id }, latestHoldSourceEventId: null });
  assert.ok(page.nextCursor); assert.deepEqual(parseNoticeCursor(page.nextCursor), { version: 1, id: delivery.id });
  assert.throws(() => parseNoticePage({ items: Array.from({ length: 26 }, () => delivery), hasMore: false, nextCursor: null }, noticeSchema));
  assert.throws(() => parseNoticeStatus({ items: [], hasMore: false, nextCursor: null }));
  for (const invalid of ["[]", "null", "bad", '{"nested":{}}', "x".repeat(2049)]) assert.throws(() => parseNoticeCursor(invalid));
});
test("reasoned operation accepts no recipient or provider state and financial selection binds every review revision", () => {
  const operation = { eventId: delivery.eventId, deliveryId: delivery.id, operationId: "50000000-0000-4000-8000-000000000001", reason: "  Phone confirmation  " };
  assert.equal(noticeOperationSchema.parse(operation).reason, "Phone confirmation");
  for (const reason of ["", " ", "x".repeat(501)]) assert.equal(noticeOperationSchema.safeParse({ ...operation, reason }).success, false);
  assert.equal(noticeOperationSchema.safeParse({ ...operation, recipientEmail: "synthetic@example.invalid" }).success, false);
  assert.deepEqual(financialReviewSelection([{ id: delivery.invoiceId, reviewRevision: 2 }]), { invoiceIds: [delivery.invoiceId], expectedRevisions: { [delivery.invoiceId]: 2 } });
  for (const invalid of [[], [{ id: delivery.invoiceId, reviewRevision: "2" }], [{ id: delivery.invoiceId, reviewRevision: 0 }], [{ id: delivery.invoiceId }], Array.from({ length: 101 }, () => ({ id: delivery.invoiceId, reviewRevision: 2 }))]) assert.equal(financialReviewSelection(invalid), null);
});
test("financial errors distinguish definitive permission/version denial from uncertain network outcome", () => {
  for (const code of ["42501", "PT403"]) assert.equal(safeNoticeError({ code, message: "fake SQL detail" }).code, "FORBIDDEN");
  for (const code of ["PGRST301", "PGRST302", "PT401"]) assert.equal(safeNoticeError({ code }).code, "AUTH_REQUIRED");
  for (const message of ["EVENT_NOT_CURRENT", "STALE_REVIEW", "STALE_HOLD", "HOLD_NOTIFICATION_SUPERSEDED", "INVALID_CURSOR", "OPERATION_REUSED"]) assert.equal(safeNoticeError({ message }).uncertain, false);
  assert.equal(safeNoticeError(new Error("fake token/customer data")).uncertain, true);
  assert.doesNotMatch(safeNoticeError(new Error("fake token/customer data")).message, /token|customer/);
});
test("real financial dialog clearly identifies recipient and requires reason, confirmation and duplicate warning", () => {
  const h = moduleHarness("FinancialNoticeDialog.tsx", { "./api": {} });
  const props = { delivery, action: "resend", onClose: () => undefined, onCommitted: () => undefined, onConflict: () => undefined };
  let tree = h.render(props);
  assert.match(visibleText(tree[0]), /Synthetic Supplier/); assert.match(visibleText(tree[0]), /may already have received.*duplicate/);
  assert.equal(find(tree, "textarea").props.maxLength, 500); assert.equal(find(tree, "textarea").props.required, true);
  assert.equal(byText(tree, "Confirm resend").props.disabled, true);
  invoke(find(tree, "textarea"), "onChange", { target: { value: "Requested after confirmed phone review" } });
  invoke(find(h.render(props), "shared-modal"), "onRequestClose", "escape");
  assert.ok(find(h.render(props), "DiscardChangesDialog"));
  invoke(find(h.render(props), "input"), "onChange", { target: { checked: true } });
  tree = h.render(props); assert.equal(byText(tree, "Confirm resend").props.disabled, false);
  invoke(find(tree, "textarea"), "onChange", { target: { value: "Changed reason" } });
  assert.equal(byText(h.render(props), "Confirm resend").props.disabled, true);
});
test("real financial dialog locks duplicate click and preserves source/event/operation payload after lost response", async () => {
  let finish: (result: unknown) => void = () => undefined;
  const calls: unknown[] = []; let request = new Promise<unknown>(done => { finish = done; }); let committed = 0;
  const h = moduleHarness("FinancialNoticeDialog.tsx", { "./api": { reconcileFinancialNotice: async (_action: unknown, input: unknown) => {
    calls.push(input); const outcome = await request; if (outcome instanceof Error) throw outcome; return outcome;
  } } });
  const props = { delivery, action: "resend", onClose: () => undefined, onCommitted: () => { committed++; }, onConflict: () => undefined };
  invoke(find(h.render(props), "textarea"), "onChange", { target: { value: "  Explicit review  " } });
  invoke(find(h.render(props), "input"), "onChange", { target: { checked: true } });
  const form = find(h.render(props), "form"); invoke(form, "onSubmit", { preventDefault() {} }); invoke(form, "onSubmit", { preventDefault() {} });
  assert.equal(calls.length, 1); assert.equal(byText(h.render(props), "Saving…").props.disabled, true);
  finish(new FinancialNoticeError("RESULT_UNCONFIRMED")); await tick();
  assert.equal(find(h.render(props), "textarea").props.disabled, true); assert.equal(committed, 0);
  request = Promise.resolve({ status: "queued" }); invoke(find(h.render(props), "form"), "onSubmit", { preventDefault() {} }); await tick();
  assert.equal(calls[0], calls[1]); assert.equal(committed, 1);
  assert.equal((calls[0] as { eventId: string }).eventId, delivery.eventId);
});
test("real manual dialog makes no provider claim and refreshes safe conflict without losing reason", async () => {
  let conflicts = 0; let successes = 0;
  const h = moduleHarness("FinancialNoticeDialog.tsx", { "./api": { reconcileFinancialNotice: async () => { throw new FinancialNoticeError("STALE_REVIEW"); } } });
  const props = { delivery, action: "manual_resolution", onClose: () => undefined, onCommitted: () => { successes++; }, onConflict: () => { conflicts++; } };
  invoke(find(h.render(props), "textarea"), "onChange", { target: { value: "Telephone contact recorded" } });
  invoke(find(h.render(props), "input"), "onChange", { target: { checked: true } });
  invoke(find(h.render(props), "form"), "onSubmit", { preventDefault() {} }); await tick();
  const tree = h.render(props); assert.equal(conflicts, 1); assert.equal(successes, 0);
  assert.equal(find(tree, "textarea").props.value, "Telephone contact recorded");
  assert.equal(byText(tree, "Confirm contact").props.disabled, true); assert.match(visibleText(tree[0]), /does not mark the email as sent/);
});
test("review component treats historical and unauthorized families as nonactionable and keeps manual distinct", () => {
  const notices: string[] = [];
  const h = moduleHarness("FinancialNoticeReview.tsx", { "@tanstack/react-query": { useQueryClient: () => ({}) },
    "./queries": { invalidateFinancialNotices: async () => undefined }, "./FinancialNoticeDialog": { default: "dialog" } });
  const props = { profile, delivery, latestHoldSourceEventId: null, onNotice: (message: string) => notices.push(message) };
  for (const input of [{ ...props, delivery: { ...delivery, current: false } }, { ...props, profile: { ...profile, staffPermissions: ["invoice_controller"] } },
    { ...props, delivery: { ...delivery, family: "payment_hold_released" } }, { ...props, delivery: { ...delivery, state: "sent" } }]) {
    assert.equal(h.render(input).some(item => item.type === "button" && visibleText(item.props.children) === "Resend with reason"), false);
  }
  invoke(byText(h.render(props), "Resend with reason"), "onClick");
  const dialog = h.render(props).find(item => item.props.action === "resend"); assert.ok(dialog);
  invoke(dialog, "onCommitted", { status: "queued" }); assert.match(notices[0], /Resend queued.*not yet/);
  invoke(dialog, "onCommitted", { status: "manually_resolved" }); assert.match(notices[1], /not marked sent/);
});
test("historical hold card preserves unknown warning and offers only an append-only review note", () => {
  const notices: string[] = [];
  const h = moduleHarness("FinancialNoticeReview.tsx", { "@tanstack/react-query": { useQueryClient: () => ({}) },
    "./queries": { invalidateFinancialNotices: async () => undefined }, "./FinancialNoticeDialog": { default: "dialog" } });
  const older = { ...delivery, family: "payment_hold_placed", current: false, canResend: false, canResolve: false,
    canAnnotateHistory: true, supersededBySourceEventId: "60000000-0000-4000-8000-000000000001", supersededAt: "2026-09-09T02:00:00+00:00" };
  const props = { profile, delivery: older, latestHoldSourceEventId: older.supersededBySourceEventId, onNotice: (message: string) => notices.push(message) };
  let tree = h.render(props);
  assert.match(visibleText(tree[0]), /Superseded by a later hold change/);
  assert.match(visibleText(tree[0]), /Original email outcome:.*Delivery unresolved/);
  assert.match(visibleText(tree[0]), /may already have received this email.*will not be resent/);
  assert.ok(byText(tree, "Review event history"));
  assert.equal(tree.some(item => item.type === "button" && /Resend|Record contact/.test(visibleText(item.props.children))), false);
  invoke(byText(tree, "Add historical review note"), "onClick");
  tree = h.render(props); const dialog = tree.find(item => item.props.action === "history_note"); assert.ok(dialog);
  invoke(dialog, "onCommitted", { status: "historical_note_recorded" });
  assert.match(notices[0], /outcome is unchanged.*no resend was queued/);
  const sentTree = h.render({ ...props, delivery: { ...older, state: "sent" } });
  assert.match(visibleText(sentTree[0]), /provider-confirmed result remains recorded/);
  assert.equal(sentTree.some(item => item.type === "button" && visibleText(item.props.children) === "Add historical review note"), false);
});
test("historical-note controls obey family permissions and never substitute for a current resend", () => {
  const h = moduleHarness("FinancialNoticeReview.tsx", { "@tanstack/react-query": { useQueryClient: () => ({}) },
    "./queries": { invalidateFinancialNotices: async () => undefined }, "./FinancialNoticeDialog": { default: "dialog" } });
  const older = { ...delivery, family: "payment_hold_released", current: false, canAnnotateHistory: true,
    supersededBySourceEventId: "60000000-0000-4000-8000-000000000001", supersededAt: "2026-09-09T02:00:00+00:00" };
  const props = { profile, delivery: older, latestHoldSourceEventId: older.supersededBySourceEventId, onNotice: () => undefined };
  assert.equal(h.render(props).some(item => item.type === "button" && visibleText(item.props.children) === "Add historical review note"), false);
  assert.ok(byText(h.render({ ...props, profile: { ...profile, staffPermissions: ["quickbooks_handoff"] } }), "Add historical review note"));
  assert.deepEqual(h.render({ ...props, profile: { ...profile, active: false } }), []);
});
test("historical-note dialog requires bounded reason/confirmation and preserves one UUID after uncertain retry", async () => {
  const calls: { action: string; input: unknown }[] = []; let succeed = false; const commits: unknown[] = [];
  const h = moduleHarness("FinancialNoticeDialog.tsx", { "./api": { reconcileFinancialNotice: async (action: string, input: unknown) => {
    calls.push({ action, input }); if (!succeed) throw new FinancialNoticeError("RESULT_UNCONFIRMED"); return { status: "historical_note_recorded" };
  } } });
  const props = { delivery: { ...delivery, family: "payment_hold_placed", current: false }, action: "history_note",
    onClose: () => undefined, onCommitted: (result: unknown) => commits.push(result), onConflict: () => undefined };
  let tree = h.render(props);
  assert.match(visibleText(tree[0]), /may already have received.*does not change the original outcome, claim contact, or authorize a resend/);
  assert.equal(byText(tree, "Save historical note").props.disabled, true); assert.equal(find(tree, "textarea").props.maxLength, 500);
  invoke(find(tree, "textarea"), "onChange", { target: { value: "Later release reviewed; old email outcome remains unknown." } });
  invoke(find(h.render(props), "input"), "onChange", { target: { checked: true } });
  const form = find(h.render(props), "form"); invoke(form, "onSubmit", { preventDefault() {} }); invoke(form, "onSubmit", { preventDefault() {} });
  await tick(); assert.equal(calls.length, 1); assert.equal(calls[0].action, "history_note");
  tree = h.render(props); assert.equal(find(tree, "textarea").props.disabled, true); assert.equal(commits.length, 0);
  succeed = true; invoke(find(tree, "form"), "onSubmit", { preventDefault() {} }); await tick();
  assert.equal(calls[0].input, calls[1].input); assert.equal(commits.length, 1);
});
test("system classification and staff historical notes keep bounded history and original outcomes distinct", () => {
  const row = { id: `supersession:${delivery.id}`, kind: "system_no_longer_required", state: "not_deliverable",
    createdAt: delivery.createdAt, completedAt: delivery.createdAt, reason: null, sequence: 0, code: "HOLD_NOTIFICATION_SUPERSEDED" };
  assert.match(noticeHistoryLabel(noticeHistorySchema.parse(row)), /system classification/);
  const note = noticeHistorySchema.parse({ ...row, id: `operation:${delivery.id}`, kind: "historical_note", state: "unknown", reason: "Original unknown reviewed." });
  assert.match(noticeHistoryLabel(note), /original outcome preserved/); assert.equal(note.state, "unknown");
  assert.match(noticeHistoryLabel({ ...note, state: "superseded" }), /no longer required.*staff review note/);
  assert.match(noticeHistoryLabel({ ...note, kind: "supersession", state: "sent" }), /original outcome preserved/);
  assert.throws(() => parseNoticePage({ items: Array.from({ length: 26 }, () => row), hasMore: false, nextCursor: null }, noticeHistorySchema));
  assert.equal(noticeHistorySchema.safeParse({ ...note, reason: "x".repeat(501) }).success, false);
});
test("system supersession classification does not replace recorded prior delivery facts", () => {
  for (const [state, label] of [["pending", "Queued"], ["claimed", "Claimed before sending started"], ["failed", "Failed attempt"],
    ["not_deliverable", "Email unavailable"], ["unknown", "Delivery unresolved"], ["sent", "Sent"]] as const) {
    assert.equal(noticePriorOutcomeLabel(state), label);
    assert.equal(noticeHistoryLabel({ kind: "system_no_longer_required", state, sequence: 0, code: "HOLD_NOTIFICATION_SUPERSEDED" }),
      "Notification no longer required — system classification");
  }
});
test("rendered historical card and system history preserve email-unavailable outcome with system attribution", () => {
  const row = { id: `supersession:${delivery.id}`, kind: "system_no_longer_required", state: "not_deliverable",
    createdAt: delivery.createdAt, completedAt: delivery.createdAt, reason: "A later payment-hold source event committed.",
    sequence: 0, code: "RECIPIENT_NOT_DELIVERABLE" };
  const h = moduleHarness("FinancialNoticeReview.tsx", { "@tanstack/react-query": { useQueryClient: () => ({}) },
    "../../lib/useCursorPagination": { useCursorPagination: () => ({ position: { page: 1, cursor: null }, previous: () => undefined, next: () => undefined }) },
    "./queries": { invalidateFinancialNotices: async () => undefined, useFinancialNoticeHistory: () => ({
      data: { items: [row], hasMore: false, nextCursor: null }, isFetching: false, isError: false,
    }) }, "./FinancialNoticeDialog": { default: "dialog" } });
  const older = { ...delivery, family: "payment_hold_placed", state: "superseded", current: false, canAnnotateHistory: true,
    supersededBySourceEventId: "60000000-0000-4000-8000-000000000001", supersededAt: "2026-09-09T02:00:00+00:00" };
  const props = { profile, delivery: older, latestHoldSourceEventId: older.supersededBySourceEventId, onNotice: () => undefined };
  let tree = h.render(props); assert.match(visibleText(tree[0]), /Historical delivery status:.*Superseded/);
  assert.doesNotMatch(visibleText(tree[0]), /Original email outcome:.*Superseded/);
  invoke(byText(tree, "Review event history"), "onClick"); tree = h.render(props);
  const child = tree.find(item => typeof item.type === "function" && item.props.eventId === delivery.eventId); assert.ok(child);
  const history = (child.type as (props: Record<string, unknown>) => unknown)(child.props);
  assert.match(visibleText(history), /system classification.*Recorded prior delivery status:.*Email unavailable/);
  assert.match(visibleText(history).replace(/\s+/g, " "), /System reason: A later payment-hold source event committed/);
  assert.doesNotMatch(visibleText(history), /Staff reason:/);
});
test("financial queue exposes safe references, filtered families, continuation and invoice navigation only", () => {
  const cursors: unknown[] = []; const opens: string[] = [];
  const h = moduleHarness("FinancialNoticeQueue.tsx", {
    "../../lib/useCursorPagination": { useCursorPagination: () => ({ position: { page: 1, cursor: null }, previous: () => undefined, next: (cursor: unknown) => cursors.push(cursor) }) },
    "./queries": { useFinancialNoticeQueue: () => ({ data: { items: [delivery], hasMore: true, nextCursor: "safe-cursor" }, isFetching: false, isError: false }) },
    "./FinancialNoticeReview": { noticeTime: () => "safe time" },
  });
  const props = { profile, onOpenInvoice: (id: string) => opens.push(id) };
  let tree = h.render(props); invoke(byText(tree, "More invoice notices"), "onClick"); assert.deepEqual(cursors, ["safe-cursor"]);
  invoke(byText(tree, "Open invoice to review"), "onClick"); assert.deepEqual(opens, [delivery.invoiceId]);
  assert.doesNotMatch(visibleText(tree[0]), /Synthetic Supplier|@|Resend with reason/);
  tree = h.render({ ...props, profile: { ...profile, staffPermissions: ["invoice_controller"] } });
  assert.equal(tree.filter(item => item.type === "option").some(item => item.props.value === "invoice_rejected"), false);
  assert.equal(tree.filter(item => item.type === "option").some(item => item.props.value === "payment_hold_placed"), true);
  assert.deepEqual(h.render({ ...props, profile: { ...profile, active: false } }), []);
});
test("missing-recipient placeholder cannot be manually recorded as contacted without an identified person", () => {
  const h = moduleHarness("FinancialNoticeReview.tsx", { "@tanstack/react-query": { useQueryClient: () => ({}) },
    "./queries": { invalidateFinancialNotices: async () => undefined }, "./FinancialNoticeDialog": { default: "dialog" } });
  const tree = h.render({ profile, delivery: { ...delivery, state: "not_deliverable", recipientKind: "missing", recipientLabel: null }, latestHoldSourceEventId: null, onNotice: () => undefined });
  assert.equal(tree.some(item => item.type === "button" && visibleText(item.props.children) === "Record contact another way"), false);
  assert.ok(byText(tree, "Resend with reason"));
});
test("invoice status keeps durable success notice across recipient-row replacement", () => {
  let rows = [delivery];
  const h = moduleHarness("FinancialNoticeStatus.tsx", {
    "../../lib/useCursorPagination": { useCursorPagination: () => ({ position: { page: 1, cursor: null }, previous: () => undefined, next: () => undefined }) },
    "./queries": { useFinancialNoticeStatus: () => ({ data: { items: rows, hasMore: false, nextCursor: null, latestHoldSourceEventId: null }, isFetching: false, isError: false }) },
    "./FinancialNoticeReview": { default: "review" },
  });
  const props = { profile, invoiceId: delivery.invoiceId, invoiceVersion: 7, reviewRevision: 2 };
  const child = h.render(props).find(item => item.props.delivery === delivery); assert.ok(child);
  invoke(child, "onNotice", "Resend queued. Email delivery has not yet been confirmed.");
  rows = []; assert.match(visibleText(h.render(props)[0]), /Resend queued/);
});
test("financial API parses unknown results and never claims delivery for a queue receipt", async () => {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const operation = { eventId: delivery.eventId, deliveryId: delivery.id, operationId: "50000000-0000-4000-8000-000000000001", reason: "Approved contact" };
  let data: unknown = { status: "queued", eventId: delivery.eventId, deliveryId: delivery.id, operationId: operation.operationId, replayed: false, deliveryCount: 1 };
  const h = moduleHarness("api.ts", { "../../lib/supabase/client": { supabase: () => ({ rpc: async (name: string, args: Record<string, unknown>) => { calls.push({ name, args }); return { data, error: null }; } }) } });
  const command = h.exports.reconcileFinancialNotice as (action: string, input: unknown) => Promise<{ status: string }>;
  assert.equal((await command("resend", operation)).status, "queued");
  assert.deepEqual(Object.keys(calls[0].args).sort(), ["p_delivery_id", "p_event_id", "p_operation_id", "p_reason"]);
  data = { ...(data as object), status: "sent" }; await assert.rejects(() => command("resend", operation), /could not be confirmed/);
  data = { status: "manually_resolved", eventId: delivery.eventId, deliveryId: delivery.id, operationId: operation.operationId, replayed: true, deliveryCount: 0 };
  assert.equal((await command("manual_resolution", operation)).status, "manually_resolved");
});
test("historical note API invokes only its command and rejects provider-sent or mismatched success", async () => {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const operation = { eventId: delivery.eventId, deliveryId: delivery.id, operationId: "50000000-0000-4000-8000-000000000001", reason: "Historical unknown reviewed." };
  let data: unknown = { status: "historical_note_recorded", eventId: delivery.eventId, deliveryId: delivery.id, operationId: operation.operationId, replayed: false, deliveryCount: 0 };
  const h = moduleHarness("api.ts", { "../../lib/supabase/client": { supabase: () => ({ rpc: async (name: string, args: Record<string, unknown>) => { calls.push({ name, args }); return { data, error: null }; } }) } });
  const command = h.exports.reconcileFinancialNotice as (action: string, input: unknown) => Promise<{ status: string }>;
  assert.equal((await command("history_note", operation)).status, "historical_note_recorded");
  assert.equal(calls[0].name, "annotate_financial_notification_history_v1");
  assert.deepEqual(Object.keys(calls[0].args).sort(), ["p_delivery_id", "p_event_id", "p_operation_id", "p_reason"]);
  const valid = data as Record<string, unknown>;
  for (const invalid of [{ ...valid, status: "sent" }, { ...valid, deliveryCount: 1 }, { ...valid, deliveryId: "60000000-0000-4000-8000-000000000001" }]) {
    data = invalid; await assert.rejects(command("history_note", operation), /could not be confirmed/);
  }
  const count = calls.length;
  await assert.rejects(command("history_note", { ...operation, recipientEmail: "synthetic@example.invalid" }), /Check the reason/);
  await assert.rejects(command("send_now", operation), /Check the reason/);
  assert.equal(calls.length, count);
});
test("bounded unresolved API accepts current events but rejects any historical superseded hold projection", async () => {
  const calls: { args: Record<string, unknown>; signal: AbortSignal }[] = [];
  let items = [{ ...delivery, family: "payment_hold_placed", sourceEventId: delivery.sourceEventId }];
  const h = moduleHarness("api.ts", { "../../lib/supabase/client": { supabase: () => ({ rpc: (_name: string, args: Record<string, unknown>) => ({
    abortSignal: async (signal: AbortSignal) => { calls.push({ args, signal }); return { data: { items, hasMore: false, nextCursor: null }, error: null }; },
  }) }) } });
  const read = h.exports.readUnresolvedFinancialNotices as (...args: unknown[]) => Promise<{ items: unknown[] }>;
  const signal = new AbortController().signal;
  assert.equal((await read("all", "all", "", null, signal)).items.length, 1);
  assert.equal(calls[0].signal, signal); assert.equal(calls[0].args.p_limit, 25);
  items = [{ ...items[0], current: false }];
  await assert.rejects(read("all", "all", "", null, signal), /integrity review/);
  items = [{ ...items[0], current: true, supersededBySourceEventId: "60000000-0000-4000-8000-000000000001" }];
  await assert.rejects(read("all", "all", "", null, signal), /integrity review/);
});
test("query scope includes actor/permissions, invoice financial/review versions and exact cursor with cancellation", () => {
  const configs: Record<string, unknown>[] = []; const signals: unknown[] = [];
  const h = moduleHarness("queries.ts", { "@tanstack/react-query": { useQuery: (config: Record<string, unknown>) => { configs.push(config); return config; } },
    "./api": { readFinancialNoticeStatus: (_id: unknown, _cursor: unknown, signal: unknown) => { signals.push(signal); } } });
  const query = h.exports.useFinancialNoticeStatus as (...args: unknown[]) => unknown;
  query(profile, delivery.invoiceId, 7, 2, null); const first = configs.at(-1); assert.ok(first);
  query(profile, delivery.invoiceId, 8, 2, null); assert.notDeepEqual(first.queryKey, configs.at(-1)?.queryKey);
  query({ ...profile, staffPermissions: ["invoice_controller"] }, delivery.invoiceId, 7, 2, null); assert.notDeepEqual(first.queryKey, configs.at(-1)?.queryKey);
  assert.equal(first.refetchIntervalInBackground, false); assert.equal(first.retry, false);
  const signal = new AbortController().signal; (first.queryFn as (input: { signal: AbortSignal }) => unknown)({ signal }); assert.equal(signals[0], signal);
});
test("all financial families are explicit and new browser graph excludes server/provider modules", () => {
  assert.equal(noticeFamilySchema.options.length, 4);
  for (const name of ["contracts.ts", "api.ts", "queries.ts", "FinancialNoticeDialog.tsx", "FinancialNoticeReview.tsx", "FinancialNoticeStatus.tsx", "FinancialNoticeQueue.tsx"]) {
    const code = readFileSync(resolve("src/features/financial-notifications", name), "utf8");
    assert.doesNotMatch(code, /from\s+["'][^"']*(?:server\/|graphClient|node:|receivingDispatch)/);
    assert.doesNotMatch(code, /sendMail|sendEmail|service_role|invalidateQueries\(\)/);
  }
  assert.match(readFileSync("src/features/invoices/InvoiceList.tsx", "utf8"), /selection.expectedRevisions/);
  assert.match(readFileSync("src/features/invoices/InvoiceDetail.tsx", "utf8"), /<FinancialNoticeStatus/);
});
