import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { QueryClient, QueryObserver, type QueryObserverOptions } from "@tanstack/react-query";
import { PARTS_SMS_UNKNOWN_WARNING, PartsSmsError, parsePartsSmsCursor, parsePartsSmsPage, partsSmsDeliverySchema,
  partsSmsCount, partsSmsHealthSchema, partsSmsHistorySchema, partsSmsOperator, partsSmsOperationSchema, partsSmsPresentation, partsSmsStateSchema, safePartsSmsError,
  type PartsSmsDelivery, type PartsSmsHealth } from "../features/parts-sms/contracts";
import { partsButton as button, partsFind as find, partsInvoke as invoke, partsModuleHarness, partsVisibleText as text } from "./partsSmsOperatorTestHarness";

const delivery: PartsSmsDelivery = { id: "81000000-0000-4000-8000-000000000001", rootId: "81000000-0000-4000-8000-000000000001",
  recipientId: "81000000-0000-4000-8000-000000000002", recipientName: "Synthetic Staff", localDate: "2026-09-10", timezone: "America/New_York",
  state: "unknown", providerState: null, legacy: false, current: true, attemptCount: 1, createdAt: "2026-09-10T20:00:00Z",
  lastAttemptAt: "2026-09-10T20:00:01Z", completedAt: null, nextAttemptAt: null, code: "TWILIO_UNKNOWN", canResend: true, canResolve: true, statusCheckStale: false };
const profile = { id: "synthetic-staff", active: true, role: "manager", staffPermissions: [] };
const health: PartsSmsHealth = { enabled: true, timezone: "America/New_York", cutoffTime: "17:00", lastStartedAt: null, lastCompletedAt: null,
  lastSuccessfulAt: null, lastResultCode: null, oldestPendingAt: null, unknownCount: 1, notDeliverableCount: 0, staleStatusCount: 0,
  expiredClaimCount: 0, sourceRecurrenceCount: 0, stale: true, cadenceMinutes: 3, currentRunIncomplete: true };
const featureModule = (name: string, mocks: Record<string, unknown> = {}) => partsModuleHarness(`src/features/parts-sms/${name}`, mocks);
const tick = () => new Promise<void>(done => setImmediate(done));
test("actual auth hydration and Dashboard importer expose parts operations only to active operational staff", async () => {
  const controls = { fire() {}, setPage() {}, setSelectedWO() {}, setAiNote() {}, setInvoices() {} };
  for (const actor of [{ active: true, permissions: [], allowed: true }, { active: false, permissions: [], allowed: false },
    { active: true, permissions: ["invoice_controller"], allowed: false }]) {
    const prof = { id: delivery.recipientId, name: "Synthetic Staff", role: "manager", active: actor.active, email: "staff@example.invalid" };
    const auth = partsModuleHarness("src/features/auth/useAuth.ts", {
      "@tanstack/react-query": { useQueryClient: () => ({ clear() {} }) },
      "../../lib/db": { signIn: async () => ({ user: { id: prof.id } }), signOut: async () => undefined },
      "../../lib/constants": { DEMO_ACCOUNTS: [] },
      "../../lib/supabase/client": { getRememberedEmail: () => "", getRememberMePreference: () => false, setRememberMePreference() {},
        supabase: () => ({ rpc: async () => ({ data: {}, error: null }), from: (table: string) => ({ select: () => ({ eq: () => table === "profiles"
          ? { single: async () => ({ data: prof, error: null }) }
          : { data: actor.permissions.map(permission => ({ permission })), error: null } }) }) }) },
    });
    const initial = auth.call("default", controls) as { doLogin: (email: string, password: string) => Promise<void> };
    await initial.doLogin(prof.email, "synthetic-password");
    const hydrated = auth.call("default", controls) as { currentUser: { active: boolean } };
    assert.equal(hydrated.currentUser.active, actor.active);
    const dashboard = partsModuleHarness("src/features/dashboard/Dashboard.tsx", {
      "../../lib/constants": { T: {} }, "../invoices/ControllerExportPanel": { default: "controller-panel" },
      "./DashboardWorkBuckets": { default: "work-buckets" }, "./PartsAlertSettings": { default: "parts-settings" },
      "../parts-sms/PartsSmsOperations": { default: "parts-operations" }, "../work-orders/queries": { useWorkOrdersCountQuery: () => ({}) },
    });
    const tree = dashboard.render({ page: "dashboard", isManager: true, workOrders: [], p1Unassigned: 0, slaBreached: 0,
      invoices: [], currentUser: hydrated.currentUser, search: "", getUser: () => null, ...controls });
    const owner = tree.find(element => element.type === "parts-operations");
    if (actor.permissions.includes("invoice_controller")) { assert.equal(owner, undefined); continue; }
    assert.ok(owner); assert.equal(owner.props.profile, hydrated.currentUser);
    const operations = featureModule("PartsSmsOperations.tsx", {
      "../../lib/useCursorPagination": { useCursorPagination: () => ({ position: { cursor: null, page: 1 } }) },
      "./queries": { usePartsSmsHealth: () => ({ data: health }), usePartsSmsQueue: () => ({ data: { items: [], hasMore: false, nextCursor: null } }) },
      "./PartsSmsReview": { default: "sms-review" },
    });
    const visible = operations.render(owner.props);
    assert.equal(visible.length > 0, actor.allowed);
    if (actor.allowed) assert.match(text(visible[0]), /Parts SMS delivery/);
  }
});
for (const state of partsSmsStateSchema.options) test(`parts SMS presentation maps ${state} without false delivery or automatic unknown retry`, () => {
  const view = partsSmsPresentation({ ...delivery, state }); assert.ok(view.label && view.guidance);
  if (!["unknown", "failed", "not_deliverable"].includes(state)) { assert.equal(view.canResend, false); assert.equal(view.canResolve, false); }
  if (state === "unknown") assert.equal(view.guidance, PARTS_SMS_UNKNOWN_WARNING);
  if (state === "accepted") assert.match(view.guidance, /not confirmation of handset delivery/);
  if (state === "manually_resolved") assert.match(view.guidance, /does not mark SMS delivery as sent or delivered/);
});
test("parts SMS historical/current and scheduled-retry action guards fail closed", () => {
  assert.equal(partsSmsPresentation({ ...delivery, current: false }).canResend, false);
  assert.equal(partsSmsPresentation({ ...delivery, canResend: false }).canResend, false);
  const retry = partsSmsPresentation({ ...delivery, state: "failed", nextAttemptAt: delivery.createdAt });
  assert.equal(retry.label, "Retry scheduled"); assert.equal(retry.canResend, false); assert.equal(retry.canResolve, false);
  assert.equal(partsSmsPresentation({ ...delivery, state: "failed", providerState: "undelivered" }).label, "Undelivered");
  assert.equal(partsSmsPresentation({ ...delivery, state: "sent", legacy: true }).label, "Sent (legacy record)");
});
test("stale accepted/sent permits reasoned contact but never resend or a false delivered result", () => {
  for (const state of ["accepted", "sent"] as const) {
    const view = partsSmsPresentation({ ...delivery, state, statusCheckStale: true });
    assert.equal(view.canResend, false); assert.equal(view.canResolve, true);
    assert.equal(partsSmsPresentation({ ...delivery, state, statusCheckStale: true, canResolve: false }).canResolve, false);
  }
  assert.equal(partsSmsPresentation({ ...delivery, state: "delivered", statusCheckStale: true }).canResolve, false);
});
for (const role of ["manager", "dispatcher", "back_office"]) test(`parts SMS active ${role} access is operational not controller-only`, () => {
  assert.ok(partsSmsOperator({ ...profile, role })); assert.equal(partsSmsOperator({ ...profile, role, active: false }), null);
  assert.equal(partsSmsOperator({ ...profile, role, staffPermissions: ["invoice_controller"] }), null);
  assert.ok(partsSmsOperator({ ...profile, role, staffPermissions: ["quickbooks_handoff"] }));
});
for (const candidate of [null, {}, { ...profile, active: undefined }, ...["contractor", "contractor_admin", "technician", "report_only", "service_role", "invoice_controller"].map(role => ({ ...profile, role }))]) {
  test(`parts SMS denied identity ${JSON.stringify(candidate)} does not enable staff surface`, () => assert.equal(partsSmsOperator(candidate), null));
}
test("parts SMS browser projection strips phone/provider/customer values and bounds rows/cursor", () => {
  const safe = partsSmsDeliverySchema.parse({ ...delivery, phone: "+12025550101", providerSid: "synthetic reference", smsBody: "synthetic private content" });
  assert.deepEqual(safe, delivery);
  const page = parsePartsSmsPage({ items: [delivery], hasMore: true, nextCursor: { createdAt: delivery.createdAt, id: delivery.id, state: "unknown", boundary: delivery.createdAt } }, partsSmsDeliverySchema);
  assert.ok(page.nextCursor); assert.equal((parsePartsSmsCursor(page.nextCursor) as { id: string }).id, delivery.id);
  assert.throws(() => parsePartsSmsPage({ items: Array.from({ length: 26 }, () => delivery), hasMore: false, nextCursor: null }, partsSmsDeliverySchema));
  assert.throws(() => parsePartsSmsPage({ items: [], hasMore: true, nextCursor: null }, partsSmsDeliverySchema));
  for (const value of ["bad", "[]", "null", '{"nested":{}}', "x".repeat(2049)]) assert.throws(() => parsePartsSmsCursor(value));
});
test("parts SMS unavailable provider lookup keeps history readable without inventing a provider status", () => {
  const entry = { id: `status:${delivery.id}`, kind: "provider_status", state: "accepted", providerState: null,
    createdAt: delivery.createdAt, completedAt: delivery.createdAt, reason: null, sequence: 1, code: "TWILIO_STATUS_UNAVAILABLE" };
  const page = parsePartsSmsPage({ items: [entry], hasMore: false, nextCursor: null }, partsSmsHistorySchema);
  assert.equal(page.items[0].providerState, null); assert.equal(page.items[0].state, "accepted");
  assert.equal(partsSmsHistorySchema.safeParse({ ...entry, providerState: "unknown" }).success, false);
});
test("parts SMS bounded health counts never imply an exact total beyond the server cap", () => {
  assert.equal(partsSmsCount(0), "0"); assert.equal(partsSmsCount(999), "999");
  assert.equal(partsSmsCount(1000), "1000+"); assert.equal(partsSmsCount(1001), "1000+");
});
test("overdue pending and expired sending remain truthful review-only queue entries", () => {
  for (const state of ["pending", "claimed", "sending"] as const) {
    const view = partsSmsPresentation({ ...delivery, state, code: state === "pending" ? "PENDING_WORKER_DELAY" : "CLAIM_EXPIRED_REVIEW" });
    assert.equal(view.actionable, true); assert.equal(view.canResend, false); assert.equal(view.canResolve, false);
    if (state === "sending") assert.match(view.guidance, /may already have received/);
    if (state === "pending") assert.match(view.guidance, /operational warning, not a delivery SLA/);
  }
  const retry = partsSmsPresentation({ ...delivery, state: "failed", nextAttemptAt: delivery.createdAt, code: "PENDING_WORKER_DELAY" });
  assert.equal(retry.canResend, false); assert.equal(retry.canResolve, false); assert.match(retry.guidance, /demonstrably not accepted/);
});
test("recurring source quarantine remains visible without reopening a superseded SMS", () => {
  const view = partsSmsPresentation({ ...delivery, state: "superseded", code: "PARTS_SOURCE_RECURRENCE_REVIEW", current: false });
  assert.equal(view.actionable, true); assert.equal(view.canResend, false); assert.equal(view.canResolve, false);
  assert.match(view.guidance, /Automatic resend is blocked for review/);
  const { sourceRecurrenceCount: omitted, ...legacyHealth } = health;
  assert.equal(omitted, 0); assert.equal(partsSmsHealthSchema.parse(legacyHealth).sourceRecurrenceCount, 0);
  assert.equal(partsSmsHealthSchema.parse({ ...health, sourceRecurrenceCount: 1000 }).sourceRecurrenceCount, 1000);
});
test("parts SMS operation takes only event/request/reason and rejects forged provider/recipient state", () => {
  const operation = { deliveryId: delivery.id, operationId: "81000000-0000-4000-8000-000000000003", reason: "  Explicit phone review  " };
  assert.equal(partsSmsOperationSchema.parse(operation).reason, "Explicit phone review");
  for (const extra of [{ phone: "+12025550101" }, { sid: "synthetic" }, { actorId: profile.id }, { state: "delivered" }]) assert.equal(partsSmsOperationSchema.safeParse({ ...operation, ...extra }).success, false);
  for (const reason of ["", " ", "x".repeat(501)]) assert.equal(partsSmsOperationSchema.safeParse({ ...operation, reason }).success, false);
});
test("parts SMS error codes redact raw SQL/provider data and distinguish uncertain outcome", () => {
  assert.equal(safePartsSmsError({ code: "42501", message: "private" }).code, "FORBIDDEN");
  assert.equal(safePartsSmsError({ code: "PGRST301", message: "private" }).code, "AUTH_REQUIRED");
  for (const message of ["PARTS_ALERT_SUPERSEDED", "PARTS_ALERT_EVENT_STALE", "OPERATION_REUSED", "INVALID_CURSOR", "DELIVERY_NOT_FOUND", "DELIVERY_NOT_ACTIONABLE", "STALE_DIGEST"]) assert.equal(safePartsSmsError({ message }).uncertain, false);
  assert.equal(safePartsSmsError(new Error("private provider phone body")).uncertain, true);
  assert.doesNotMatch(safePartsSmsError(new Error("private provider phone body")).message, /private|phone|body/);
});
test("real parts SMS reason dialog has accessible warning, named reason, explicit confirmation and no silent Escape dismissal", () => {
  const h = featureModule("PartsSmsDialog.tsx", { "./api": {} }); const props = { delivery, action: "resend", onClose() {}, onCommitted() {}, onConflict() {} };
  let tree = h.render(props); assert.match(text(tree[0]), /SMS delivery could not be confirmed.*duplicate SMS/);
  assert.ok(find(tree, "shared-modal").props.title); assert.ok(find(tree, "shared-modal").props.initialFocusRef);
  assert.equal(find(tree, "textarea").props.required, true); assert.equal(find(tree, "textarea").props.maxLength, 500);
  assert.equal(button(tree, "Confirm resend").props.disabled, true);
  invoke(find(tree, "textarea"), "onChange", { target: { value: "Reviewed duplicate risk" } });
  invoke(find(h.render(props), "shared-modal"), "onRequestClose", "escape");
  assert.ok(find(h.render(props), "DiscardChangesDialog"));
  tree = h.render(props); invoke(find(tree, "input"), "onChange", { target: { checked: true } });
  assert.equal(button(h.render(props), "Confirm resend").props.disabled, false);
  invoke(find(h.render(props), "textarea"), "onChange", { target: { value: "New reason" } });
  assert.equal(button(h.render(props), "Confirm resend").props.disabled, true);
});
test("parts SMS uncertain response preserves operation payload and blocks double-click without false success", async () => {
  let finish: (value: unknown) => void = () => undefined; let request = new Promise<unknown>(done => { finish = done; });
  const calls: unknown[] = []; let commits = 0;
  const h = featureModule("PartsSmsDialog.tsx", { "./api": { reconcilePartsSms: async (_action: unknown, input: unknown) => { calls.push(input); const result = await request; if (result instanceof Error) throw result; return result; } } });
  const props = { delivery, action: "resend", onClose() {}, onCommitted() { commits++; }, onConflict() {} };
  invoke(find(h.render(props), "textarea"), "onChange", { target: { value: "  Confirmed request  " } });
  invoke(find(h.render(props), "input"), "onChange", { target: { checked: true } });
  const form = find(h.render(props), "form"); invoke(form, "onSubmit", { preventDefault() {} }); invoke(form, "onSubmit", { preventDefault() {} });
  assert.equal(calls.length, 1); assert.equal(button(h.render(props), "Saving…").props.disabled, true);
  finish(new PartsSmsError("RESULT_UNCONFIRMED")); await tick();
  assert.equal(find(h.render(props), "textarea").props.disabled, true); assert.equal(commits, 0);
  request = Promise.resolve({ status: "queued" }); invoke(find(h.render(props), "form"), "onSubmit", { preventDefault() {} }); await tick();
  assert.equal(calls[0], calls[1]); assert.equal(commits, 1);
});
test("parts SMS stale conflict refreshes without losing reason or relabeling manual contact as sent", async () => {
  let conflicts = 0; let commits = 0;
  const h = featureModule("PartsSmsDialog.tsx", { "./api": { reconcilePartsSms: async () => { throw new PartsSmsError("PARTS_ALERT_EVENT_STALE"); } } });
  const props = { delivery, action: "manual_resolution", onClose() {}, onCommitted() { commits++; }, onConflict() { conflicts++; } };
  invoke(find(h.render(props), "textarea"), "onChange", { target: { value: "Telephone contact recorded" } });
  invoke(find(h.render(props), "input"), "onChange", { target: { checked: true } });
  invoke(find(h.render(props), "form"), "onSubmit", { preventDefault() {} }); await tick();
  const tree = h.render(props); assert.equal(conflicts, 1); assert.equal(commits, 0); assert.equal(find(tree, "textarea").props.value, "Telephone contact recorded");
  assert.match(text(tree[0]), /does not mark the SMS as sent or delivered/); assert.equal(button(tree, "Confirm contact").props.disabled, true);
});
test("parts SMS request identity generation failure releases submission lock and produces no false success", async () => {
  let providerCalls = 0; let commits = 0; let generations = 0;
  const h = featureModule("PartsSmsDialog.tsx", { crypto: { randomUUID() { generations++; throw new Error("unavailable"); } },
    "./api": { reconcilePartsSms: async () => { providerCalls++; } } });
  const props = { delivery, action: "resend", onClose() {}, onCommitted() { commits++; }, onConflict() {} };
  invoke(find(h.render(props), "textarea"), "onChange", { target: { value: "Explicit request" } });
  invoke(find(h.render(props), "input"), "onChange", { target: { checked: true } });
  invoke(find(h.render(props), "form"), "onSubmit", { preventDefault() {} }); await tick();
  assert.equal(button(h.render(props), "Retry same request").props.disabled, false);
  invoke(find(h.render(props), "form"), "onSubmit", { preventDefault() {} }); await tick();
  assert.equal(generations, 2); assert.equal(providerCalls, 0); assert.equal(commits, 0);
});
test("parts dialog delegates resource ownership and guards dirty Cancel without losing the reason", async () => {
  const h = featureModule("PartsSmsDialog.tsx", { "./api": {} }); let closed = 0;
  const props = { delivery, action: "resend", onClose() { closed++; }, onCommitted() {}, onConflict() {} };
  invoke(find(h.render(props), "textarea"), "onChange", { target: { value: "Synthetic review reason" } });
  invoke(button(h.render(props), "Cancel"), "onClick"); assert.equal(closed, 0);
  invoke(find(h.render(props), "DiscardChangesDialog"), "onKeepEditing");
  assert.equal(find(h.render(props), "textarea").props.value, "Synthetic review reason");
  invoke(button(h.render(props), "Cancel"), "onClick");
  invoke(find(h.render(props), "DiscardChangesDialog"), "onDiscard"); await tick(); assert.equal(closed, 1);
  assert.equal(h.render(props).some(item => item.type === "dialog"), false);
});
test("parts SMS operations show missing heartbeat, bounded queue continuation, history filter and truthful durable success", () => {
  const cursors: unknown[] = []; const filters: unknown[] = []; const signatures: unknown[] = [];
  const h = featureModule("PartsSmsOperations.tsx", {
    "../../lib/useCursorPagination": { useCursorPagination: (signature: unknown) => { signatures.push(signature); return { position: { cursor: null, page: 1 }, previous() {}, next: (cursor: unknown) => cursors.push(cursor) }; } },
    "./queries": { usePartsSmsHealth: () => ({ data: { ...health, sourceRecurrenceCount: 1000 } }), usePartsSmsQueue: (_profile: unknown, filter: unknown, search: unknown) => { filters.push([filter, search]); return { data: { items: [delivery], hasMore: true, nextCursor: "opaque" } }; } },
    "./PartsSmsReview": { default: "sms-review" },
  });
  const props = { profile }; let tree = h.render(props);
  assert.match(text(tree[0]), /heartbeat is missing or older than two expected intervals/); assert.match(text(tree[0]), /not recorded completion/);
  assert.match(text(tree[0]), /Automatic source recurrence blocked for review:\s+1000\+/);
  assert.equal(find(tree, "input").props.maxLength, 100); invoke(button(tree, "More alerts"), "onClick"); assert.deepEqual(cursors, ["opaque"]);
  invoke(find(tree, "select"), "onChange", { target: { value: "history" } }); tree = h.render(props);
  assert.deepEqual(filters.at(-1), ["history", ""]); assert.match(String(signatures.at(-1)), /history/);
  invoke(find(tree, "sms-review"), "onCommitted", { status: "queued" }); assert.match(text(h.render(props)[0]), /Resend queued. SMS delivery has not yet been confirmed/);
  invoke(find(tree, "sms-review"), "onCommitted", { status: "manually_resolved" }); assert.match(text(h.render(props)[0]), /SMS delivery is not marked sent or delivered/);
  assert.deepEqual(h.render({ profile: { ...profile, active: false } }), []);
});
test("parts SMS first-page loading, safe read failures, empty/end and cursor restart are usable", () => {
  let outcome: Record<string, unknown> = { isPending: true }; const signatures: string[] = [];
  const h = featureModule("PartsSmsOperations.tsx", {
    "../../lib/useCursorPagination": { useCursorPagination: (signature: string) => { signatures.push(signature); return { position: { cursor: null, page: 1 }, previous() {}, next() {} }; } },
    "./queries": { usePartsSmsHealth: () => outcome, usePartsSmsQueue: () => outcome }, "./PartsSmsReview": { default: "sms-review" },
  });
  assert.match(text(h.render({ profile })[0]), /Loading worker health[\s\S]*Loading alerts/);
  outcome = { isError: true, refetch: async () => undefined };
  let tree = h.render({ profile }); assert.match(text(tree[0]), /health could not be confirmed/);
  const before = signatures.at(-1); invoke(button(tree, "Start at newest alerts"), "onClick"); h.render({ profile }); assert.notEqual(signatures.at(-1), before);
  outcome = { data: { ...health, items: [], hasMore: false, nextCursor: null } };
  tree = h.render({ profile }); assert.match(text(tree[0]), /No alerts match this view/); assert.match(text(tree[0]), /End of alerts/);
  assert.equal(button(tree, "More alerts").props.disabled, true);
});
test("parts SMS review shows historical immutable attempts and no action on accepted/sent/delivered/stale", () => {
  const h = featureModule("PartsSmsReview.tsx", {
    "@tanstack/react-query": { useQueryClient: () => ({}) },
    "../../lib/useCursorPagination": { useCursorPagination: () => ({ position: { cursor: null, page: 1 }, previous() {}, next() {} }) },
    "./queries": { usePartsSmsHistory: () => ({ data: { items: [], hasMore: false, nextCursor: null } }), invalidatePartsSms: async () => undefined },
    "./PartsSmsDialog": { default: "sms-dialog" },
  });
  for (const state of ["pending", "sending", "accepted", "sent", "delivered", "superseded"] as const) {
    assert.equal(h.render({ profile, delivery: { ...delivery, state }, onCommitted() {} }).some(item => item.type === "button" && text(item.props.children) === "Resend with reason"), false);
  }
  const historical = h.render({ profile, delivery: { ...delivery, current: false }, onCommitted() {} }); assert.match(text(historical[0]), /Historical alert — no resend/);
});
test("parts SMS dialog freezes reviewed page and pauses polling until explicit close", () => {
  let items: PartsSmsDelivery[] = [delivery]; const polls: boolean[] = [];
  const h = featureModule("PartsSmsOperations.tsx", {
    "../../lib/useCursorPagination": { useCursorPagination: () => ({ position: { cursor: null, page: 1 }, previous() {}, next() {} }) },
    "./queries": { usePartsSmsHealth: () => ({ data: { ...health, lastResultCode: "DATABASE_UNAVAILABLE" } }),
      usePartsSmsQueue: (_profile: unknown, _state: unknown, _search: unknown, _cursor: unknown, polling: boolean) => { polls.push(polling); return { data: { items, hasMore: false, nextCursor: null } }; } },
    "./PartsSmsReview": { default: "sms-review" },
  });
  let tree = h.render({ profile }); assert.match(text(tree[0]), /last run did not complete successfully/); assert.doesNotMatch(text(tree[0]), /DATABASE_UNAVAILABLE/);
  invoke(find(tree, "sms-review"), "onDialogChange", true); items = []; tree = h.render({ profile });
  assert.equal(polls.at(-1), false); assert.ok(find(tree, "sms-review")); assert.equal(find(tree, "select").props.disabled, true);
  invoke(find(tree, "sms-review"), "onDialogChange", false); tree = h.render({ profile }); assert.equal(polls.at(-1), true);
  assert.match(text(tree[0]), /No alerts match this view/);
});
test("parts SMS RPC reads pass cancellation and bounded filter/cursor/history contracts", async () => {
  const calls: { name: string; args: Record<string, unknown> }[] = []; const signals: unknown[] = [];
  const h = featureModule("api.ts", { "../../lib/supabase/client": { supabase: () => ({ rpc: (name: string, args: Record<string, unknown>) => { calls.push({ name, args }); return {
    abortSignal: async (signal: unknown) => { signals.push(signal); return { error: null, data: name.includes("health") ? health : { items: [], hasMore: false, nextCursor: null } }; },
  }; } }) } });
  const signal = new AbortController().signal; await h.call("readPartsSmsHealth", signal);
  await h.call("readPartsSmsQueue", "unknown", "Synthetic", null, signal); await h.call("readPartsSmsHistory", delivery.id, null, signal);
  assert.equal(signals.length, 3); assert.ok(signals.every(value => value === signal)); assert.equal(calls[1].args.p_limit, 25); assert.equal(calls[2].args.p_limit, 25);
  assert.equal(calls[1].args.p_state, "unknown"); assert.equal(calls[2].args.p_delivery_id, delivery.id);
  await assert.rejects(async () => h.call("readPartsSmsQueue", "all", "", "bad", signal)); assert.equal(calls.length, 3);
});
test("parts SMS first-page RPC safe failures reject malformed projections and redact database details", async () => {
  let response: unknown = { items: [delivery], hasMore: false, nextCursor: null }; let failure: unknown = null;
  const h = featureModule("api.ts", { "../../lib/supabase/client": { supabase: () => ({ rpc: () => ({ abortSignal: async () => ({ data: response, error: failure }) }) }) } });
  const signal = new AbortController().signal;
  const page = await h.call("readPartsSmsQueue", "all", "", null, signal) as { items: PartsSmsDelivery[] };
  assert.equal(page.items[0].id, delivery.id);
  response = { items: [{ ...delivery, state: "provider-secret" }], hasMore: false, nextCursor: null };
  await assert.rejects(async () => h.call("readPartsSmsQueue", "all", "", null, signal), /could not be confirmed/);
  failure = { message: "private SQL phone body" }; await assert.rejects(async () => h.call("readPartsSmsQueue", "all", "", null, signal), /could not be confirmed/);
  failure = { code: "42501", message: "private SQL phone body" }; await assert.rejects(async () => h.call("readPartsSmsHealth", signal), /Operational staff access/);
  failure = null; response = {}; await assert.rejects(async () => h.call("readPartsSmsHealth", signal), /could not be confirmed/);
});
test("parts SMS resend/manual RPC only sends command identity and never claims queued is sent", async () => {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const operation = { deliveryId: delivery.id, operationId: "81000000-0000-4000-8000-000000000003", reason: "  Confirmed request  " };
  let result: unknown = { status: "queued", deliveryId: delivery.id, operationId: operation.operationId, replayed: false };
  const h = featureModule("api.ts", { "../../lib/supabase/client": { supabase: () => ({ rpc: async (name: string, args: Record<string, unknown>) => { calls.push({ name, args }); return { data: result, error: null }; } }) } });
  await h.call("reconcilePartsSms", "resend", operation); assert.equal(calls[0].name, "request_parts_sms_resend_v1");
  assert.deepEqual(Object.keys(calls[0].args).sort(), ["p_delivery_id", "p_operation_id", "p_reason"]); assert.equal(calls[0].args.p_reason, "Confirmed request");
  result = { status: "sent", deliveryId: delivery.id, operationId: operation.operationId, replayed: false };
  await assert.rejects(async () => h.call("reconcilePartsSms", "resend", operation));
  result = { status: "manually_resolved", deliveryId: delivery.id, operationId: operation.operationId, replayed: true };
  await h.call("reconcilePartsSms", "manual_resolution", operation); assert.equal(calls.at(-1)?.name, "resolve_parts_sms_out_of_band_v1");
  const count = calls.length; await assert.rejects(async () => h.call("reconcilePartsSms", "resend", { ...operation, reason: "" })); assert.equal(calls.length, count);
});
test("parts SMS query keys isolate user permissions filters cursor and scope invalidation only", async () => {
  const configs: Record<string, unknown>[] = [];
  let visible = true;
  const h = featureModule("queries.ts", { "@tanstack/react-query": { useQuery: (config: Record<string, unknown>) => { configs.push(config); return config; } },
    "../../lib/realtime/browserVisibility": { usePortalVisibility: () => visible, isPortalVisible: () => visible },
    "./api": { readPartsSmsHealth: () => null, readPartsSmsQueue: () => null, readPartsSmsHistory: () => null } });
  h.call("usePartsSmsHealth", profile); const initial = configs[0]; assert.equal(initial.refetchInterval, 30000); assert.equal(initial.refetchIntervalInBackground, false); assert.equal(initial.retry, false);
  visible = false; h.call("usePartsSmsHealth", profile); assert.equal(configs.at(-1)?.enabled, false);
  visible = true; h.call("usePartsSmsHealth", profile); assert.equal(configs.at(-1)?.enabled, true);
  h.call("usePartsSmsHealth", { ...profile, id: "another-user" }); assert.notDeepEqual(initial.queryKey, configs.at(-1)?.queryKey);
  h.call("usePartsSmsHealth", { ...profile, active: false }); assert.equal(configs.at(-1)?.enabled, false);
  h.call("usePartsSmsQueue", profile, "unknown", "Synthetic", "cursor-1"); const first = configs.at(-1)?.queryKey;
  h.call("usePartsSmsQueue", profile, "history", "Synthetic", "cursor-2"); assert.notDeepEqual(first, configs.at(-1)?.queryKey);
  const invalidations: { queryKey: unknown[] }[] = []; const operator = partsSmsOperator(profile); assert.ok(operator);
  await h.call("invalidatePartsSms", { invalidateQueries: async (value: { queryKey: unknown[] }) => { invalidations.push(value); } }, operator);
  assert.equal(invalidations.length, 3); assert.ok(invalidations.every(value => value.queryKey[0] === "parts-sms" && value.queryKey[1] === profile.id));
});
test("actual parts health count observer sends no initial request while document is hidden", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity } } });
  let visible = false; let reads = 0; let observer: QueryObserver | undefined; let unsubscribe: (() => void) | undefined;
  const h = featureModule("queries.ts", {
    "../../lib/realtime/browserVisibility": { usePortalVisibility: () => visible, isPortalVisible: () => visible },
    "./api": { readPartsSmsHealth: async () => { reads += 1; return health; } },
    "@tanstack/react-query": { useQuery: (config: QueryObserverOptions) => {
      const options = { ...config, refetchInterval: false as const };
      if (!observer) { observer = new QueryObserver(client, options); unsubscribe = observer.subscribe(() => undefined); }
      else observer.setOptions(options);
      return observer.getCurrentResult();
    } },
  });
  try {
    h.call("usePartsSmsHealth", profile); await tick(); assert.equal(reads, 0);
    visible = true; h.call("usePartsSmsHealth", profile); await tick(); assert.equal(reads, 1);
    visible = false; h.call("usePartsSmsHealth", profile); await tick(); assert.equal(reads, 1);
  } finally { unsubscribe?.(); client.clear(); }
});
test("parts SMS client modules exclude server/provider imports and dashboard is the only feature-local owner", () => {
  for (const file of ["contracts.ts", "api.ts", "queries.ts", "PartsSmsOperations.tsx", "PartsSmsReview.tsx", "PartsSmsDialog.tsx", "settingsContract.ts"]) {
    const source = readFileSync(`src/features/parts-sms/${file}`, "utf8");
    assert.doesNotMatch(source, /from\s+["'][^"']*(?:server\/|graphClient|node:|twilioPartsSms)/);
    assert.doesNotMatch(source, /TWILIO_|service_role|invalidateQueries\(\)/);
  }
  assert.match(readFileSync("src/features/dashboard/Dashboard.tsx", "utf8"), /<PartsAlertSettings[^>]*\/>\s*<PartsSmsOperations profile=\{currentUser\}/);
});
