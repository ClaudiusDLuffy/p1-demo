import assert from "node:assert/strict";
import test from "node:test";
import {
  PARTS_SMS_RECURRENCE_BLOCKED, PARTS_SMS_RECURRENCE_QUEUED, PARTS_SMS_RECURRENCE_REASON,
  PARTS_SMS_UNKNOWN_WARNING, parsePartsSmsPage, partsSmsDeliverySchema, partsSmsHealthSchema,
  partsSmsHistorySchema, partsSmsOperationSchema, partsSmsOriginSchema, partsSmsPresentation,
  partsSmsRecurrenceBlockSchema, partsSmsRecurrenceRun, type PartsSmsDelivery, type PartsSmsHealth,
} from "../features/parts-sms/contracts";
import { partsButton, partsInvoke, partsModuleHarness, partsVisibleText } from "./partsSmsOperatorTestHarness";

const profile = { id: "83000000-0000-4000-8000-000000000001", active: true, role: "manager", staffPermissions: [] };
const delivery: PartsSmsDelivery = {
  id: "83000000-0000-4000-8000-000000000002", rootId: "83000000-0000-4000-8000-000000000003",
  recipientId: profile.id, recipientName: "Synthetic operational recipient", localDate: "2026-09-10", timezone: "America/New_York",
  state: "pending", providerState: null, legacy: false, current: true, attemptCount: 0, createdAt: "2026-09-10T20:00:00Z",
  lastAttemptAt: null, completedAt: null, nextAttemptAt: "2026-09-10T20:00:00Z", code: null,
  canResend: false, canResolve: false, statusCheckStale: false,
};
const health: PartsSmsHealth = {
  enabled: true, timezone: "America/New_York", cutoffTime: "17:00", lastStartedAt: delivery.createdAt,
  lastCompletedAt: delivery.createdAt, lastSuccessfulAt: delivery.createdAt, lastResultCode: "RUN_COMPLETE",
  oldestPendingAt: null, unknownCount: 0, notDeliverableCount: 0, staleStatusCount: 0, expiredClaimCount: 0,
  sourceRecurrenceCount: 0, stale: false, cadenceMinutes: 3, currentRunIncomplete: false,
};
const recurrence = { ...delivery, origin: "source_recurrence" as const, recurrenceGeneration: 3, recurrenceBlockCategory: null };
const historyEntry = {
  id: `attempt:${delivery.id}`, kind: "source_recurrence", state: "pending", providerState: null,
  createdAt: delivery.createdAt, completedAt: delivery.createdAt, reason: PARTS_SMS_RECURRENCE_REASON, sequence: 0, code: null,
};
const cursor = { version: 1, deliveryId: delivery.id, createdAt: delivery.createdAt,
  id: historyEntry.id, snapshotAt: delivery.createdAt };

test("3C.1 recurrence projections remain additive to valid 0138 browser contracts", () => {
  assert.deepEqual(partsSmsDeliverySchema.parse(delivery), delivery);
  assert.deepEqual(partsSmsHealthSchema.parse(health), health);
  assert.equal(partsSmsRecurrenceRun(undefined, undefined), null);
  assert.deepEqual(partsSmsDeliverySchema.parse(recurrence), recurrence);
});

test("3C.1 source origins and recurrence block categories are closed safe vocabularies", () => {
  assert.deepEqual(partsSmsOriginSchema.options, ["initial", "explicit_resend", "source_recurrence"]);
  assert.deepEqual(partsSmsRecurrenceBlockSchema.options, ["send_started", "daily_outcome", "active_attempt", "proof_incomplete"]);
  for (const origin of partsSmsOriginSchema.options) assert.equal(partsSmsDeliverySchema.parse({ ...delivery, origin }).origin, origin);
  for (const extra of [{ origin: "provider-retry" }, { recurrenceGeneration: -1 }, { recurrenceGeneration: 0.5 },
    { recurrenceGeneration: Number.MAX_SAFE_INTEGER + 1 }, { recurrenceBlockCategory: "raw-provider-error" }]) {
    assert.equal(partsSmsDeliverySchema.safeParse({ ...delivery, ...extra }).success, false);
  }
});

test("3C.1 recurrence browser projection excludes source content, phone and provider identity", () => {
  const parsed = partsSmsDeliverySchema.parse({ ...recurrence, phone: "+12025550101", providerSid: "synthetic-sid",
    smsBody: "synthetic private message", sourceSignature: "private signature", sourceParts: [{ description: "private" }] });
  assert.deepEqual(parsed, recurrence);
});

test("3C.1 queued recurrence identifies its origin without claiming provider acceptance", () => {
  const view = partsSmsPresentation(recurrence);
  assert.equal(view.label, "Queued"); assert.equal(view.originNote, PARTS_SMS_RECURRENCE_QUEUED);
  assert.match(view.guidance, /Delivery has not been confirmed/);
  assert.equal(view.canResend, false); assert.equal(view.canResolve, false);
});

test("3C.1 recurrence origin does not broaden or remove the existing reasoned current-unknown action guard", () => {
  const unknown = { ...recurrence, state: "unknown" as const, nextAttemptAt: null, code: "TWILIO_UNKNOWN", canResend: true, canResolve: true };
  assert.equal(partsSmsPresentation(unknown).canResend, true);
  assert.equal(partsSmsPresentation({ ...unknown, current: false }).canResend, false);
  assert.equal(partsSmsPresentation({ ...unknown, canResend: false }).canResend, false);
  const blocked = partsSmsPresentation({ ...unknown, code: "PARTS_SOURCE_RECURRENCE_REVIEW", recurrenceBlockCategory: "send_started" });
  assert.equal(blocked.canResend, false); assert.equal(blocked.canResolve, true);
});

test("3C.1 historical recurrence review preserves only server-authorized out-of-band resolution", () => {
  const blocked = { ...recurrence, current: false, nextAttemptAt: null, code: "PARTS_SOURCE_RECURRENCE_REVIEW",
    recurrenceBlockCategory: "daily_outcome" as const, canResend: true, canResolve: true };
  for (const state of ["unknown", "accepted", "sent"] as const) {
    const view = partsSmsPresentation({ ...blocked, state, statusCheckStale: state !== "unknown" });
    assert.equal(view.canResend, false); assert.equal(view.canResolve, true);
    assert.ok(view.guidance.startsWith(PARTS_SMS_RECURRENCE_BLOCKED));
    assert.equal(partsSmsPresentation({ ...blocked, state, statusCheckStale: true, canResolve: false }).canResolve, false);
  }
  for (const state of ["pending", "claimed", "sending", "delivered", "superseded", "manually_resolved"] as const) {
    assert.equal(partsSmsPresentation({ ...blocked, state, statusCheckStale: false }).canResolve, false);
  }
  assert.equal(partsSmsPresentation({ ...blocked, state: "accepted", statusCheckStale: false }).canResolve, false);
});

for (const state of ["unknown", "accepted", "sent", "delivered", "superseded"] as const) {
  test(`3C.1 recurrence origin never overwrites its later ${state} outcome`, () => {
    const view = partsSmsPresentation({ ...recurrence, state });
    assert.equal(view.originNote, PARTS_SMS_RECURRENCE_QUEUED);
    if (state === "unknown") assert.equal(view.guidance, PARTS_SMS_UNKNOWN_WARNING);
    if (state === "accepted") assert.match(view.guidance, /not confirmation of handset delivery/);
    if (state === "sent") assert.match(view.guidance, /Handset delivery has not been confirmed/);
    if (state === "delivered") assert.equal(view.label, "Delivered");
    assert.equal(view.canResend, false); assert.equal(view.canResolve, false);
  });
}

for (const category of partsSmsRecurrenceBlockSchema.options) {
  test(`3C.1 ${category} block remains accountable without a force or resend action`, () => {
    const parsed = partsSmsDeliverySchema.parse({ ...delivery, state: "superseded", current: false,
      code: "PARTS_SOURCE_RECURRENCE_REVIEW", recurrenceBlockCategory: category });
    const view = partsSmsPresentation({ ...parsed, canResend: true, canResolve: true });
    assert.equal(view.label, "Superseded"); assert.equal(view.actionable, true);
    assert.ok(view.guidance.startsWith(PARTS_SMS_RECURRENCE_BLOCKED));
    assert.equal(view.canResend, false); assert.equal(view.canResolve, false);
    assert.doesNotMatch(view.guidance, /pending an approved|owner policy decision/);
  });
}

test("3C.1 immutable system recurrence history has a fixed reason distinct from staff resend", () => {
  const parsed = partsSmsHistorySchema.parse({ ...historyEntry, phone: "+12025550101", providerSid: "synthetic-sid" });
  assert.deepEqual(parsed, historyEntry);
  assert.equal(partsSmsHistorySchema.safeParse({ ...historyEntry, reason: "arbitrary system override" }).success, false);
  for (const change of [{ state: "sent" }, { providerState: "accepted" }, { sequence: 1 }]) {
    assert.equal(partsSmsHistorySchema.safeParse({ ...historyEntry, ...change }).success, false);
  }
  assert.equal(partsSmsHistorySchema.safeParse({ ...historyEntry, kind: "source_generation" }).success, false);
  assert.equal(partsSmsHistorySchema.safeParse({ ...historyEntry, id: `generation:${delivery.id}` }).success, false);
});

test("3C.1 actual review keeps superseded originals and the queued system journal visible", () => {
  const entries = [
    { ...historyEntry, id: `delivery:${delivery.rootId}`, kind: "delivery", state: "superseded", reason: null },
    { ...historyEntry, id: "delivery:83000000-0000-4000-8000-000000000004", kind: "delivery", state: "superseded", reason: null }, historyEntry,
  ];
  const h = partsModuleHarness("src/features/parts-sms/PartsSmsReview.tsx", {
    "@tanstack/react-query": { useQueryClient: () => ({}) },
    "../../lib/useCursorPagination": { useCursorPagination: () => ({ position: { cursor: null, page: 1 } }) },
    "./queries": { usePartsSmsHistory: () => ({ data: parsePartsSmsPage({ items: entries, hasMore: false, nextCursor: null }, partsSmsHistorySchema) }) },
    "./PartsSmsDialog": { default: "sms-dialog" },
  });
  const props = { profile, delivery: recurrence, onCommitted() {} };
  let tree = h.render(props); assert.match(partsVisibleText(tree[0]), /Parts request returned to an earlier unsent configuration/);
  assert.match(partsVisibleText(tree[0]), /Source generation\s+3/);
  partsInvoke(partsButton(tree, "View history"), "onClick"); tree = h.render(props);
  assert.equal(tree.filter(item => item.type === "li").length, 3);
  assert.match(partsVisibleText(tree[0]), /System queued source recurrence/);
  assert.match(partsVisibleText(tree[0]), /System reason/); assert.doesNotMatch(partsVisibleText(tree[0]), /Staff reason/);
  assert.equal(tree.some(item => item.type === "sms-dialog"), false);
});

test("3C.1 successful safety blocking is not displayed as worker failure or an outstanding policy decision", () => {
  const h = partsModuleHarness("src/features/parts-sms/PartsSmsOperations.tsx", {
    "../../lib/useCursorPagination": { useCursorPagination: () => ({ position: { cursor: null, page: 1 } }) },
    "./queries": { usePartsSmsHealth: () => ({ data: { ...health, sourceRecurrenceCount: 1, lastRunRecurrenceQueued: 2, lastRunRecurrenceBlocked: 1 } }),
      usePartsSmsQueue: () => ({ data: { items: [], hasMore: false, nextCursor: null } }) }, "./PartsSmsReview": { default: "sms-review" },
  });
  const rendered = partsVisibleText(h.render({ profile })[0]);
  assert.match(rendered, /2 queued; 1 blocked for safety review/);
  assert.match(rendered, /Safety checks prevented a new SMS/);
  assert.doesNotMatch(rendered, /did not complete successfully|owner policy decision/);
  assert.equal(partsSmsRecurrenceRun(0, 0), "No source recurrence in the last recorded run.");
  assert.match(String(partsSmsRecurrenceRun(1000, 1000)), /1000\+ queued; 1000\+ blocked/);
});

test("3C.1 recurrence history keeps cancellation and the existing bounded cursor RPC contract", async () => {
  const calls: { name: string; args: Record<string, unknown>; signal: unknown }[] = [];
  const h = partsModuleHarness("src/features/parts-sms/api.ts", {
    "../../lib/supabase/client": { supabase: () => ({ rpc: (name: string, args: Record<string, unknown>) => ({
      abortSignal: async (signal: unknown) => { calls.push({ name, args, signal });
        return { error: null, data: { items: [historyEntry], hasMore: true, nextCursor: cursor } }; },
    }) }) },
  });
  const signal = new AbortController().signal;
  const page = await h.call("readPartsSmsHistory", delivery.id, JSON.stringify(cursor), signal) as { hasMore: boolean; nextCursor: string };
  assert.equal(page.hasMore, true); assert.equal(JSON.parse(page.nextCursor).id, historyEntry.id);
  assert.equal(calls[0].name, "get_parts_sms_history_v1"); assert.equal(calls[0].args.p_limit, 25); assert.equal(calls[0].signal, signal);
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0].args.p_cursor)), cursor);
});

test("3C.1 recurrence cannot be requested through an expanded browser operation payload", () => {
  const operation = { deliveryId: delivery.id, operationId: "83000000-0000-4000-8000-000000000005", reason: "Explicit reviewed contact" };
  assert.ok(partsSmsOperationSchema.safeParse(operation).success);
  for (const extra of [{ origin: "source_recurrence" }, { recurrenceGeneration: 3 }, { force: true }, { signature: "chosen" }]) {
    assert.equal(partsSmsOperationSchema.safeParse({ ...operation, ...extra }).success, false);
  }
});
