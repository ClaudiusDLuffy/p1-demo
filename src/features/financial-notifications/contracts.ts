import { z } from "zod";
import type { Json } from "../../lib/supabase/database.types";

export const FINANCIAL_NOTICE_PAGE_SIZE = 25;
export const FINANCIAL_NOTICE_REASON_LIMIT = 500;
const uuid = z.string().uuid();
const timestamp = z.string().datetime({ offset: true });
export const noticeFamilySchema = z.enum(["invoice_rejected", "invoice_rejection_retracted", "payment_hold_placed", "payment_hold_released"]);
export type NoticeFamily = z.infer<typeof noticeFamilySchema>;
export const noticeStateSchema = z.enum(["pending", "claimed", "sending", "sent", "failed", "unknown", "not_deliverable", "superseded", "manually_resolved"]);
export type NoticeState = z.infer<typeof noticeStateSchema>;
export const noticeSchema = z.object({
  id: uuid, eventId: uuid, rootId: uuid, invoiceId: uuid, workOrderId: z.string().max(128).nullable(),
  family: noticeFamilySchema, sourceEventId: uuid, reviewRevision: z.number().int().nonnegative().safe().nullable(),
  recipientKind: z.enum(["contractor", "creator", "handoff", "missing"]), state: noticeStateSchema,
  attemptCount: z.number().int().nonnegative().safe(), createdAt: timestamp, lastAttemptAt: timestamp.nullable(),
  completedAt: timestamp.nullable(), code: z.string().max(80).nullable(), canResend: z.boolean(), canResolve: z.boolean(),
  current: z.boolean(), recipientLabel: z.string().max(200).nullable(),
  supersededBySourceEventId: uuid.nullable(), supersededAt: timestamp.nullable(), canAnnotateHistory: z.boolean(),
});
export type FinancialNotice = z.infer<typeof noticeSchema>;
export const noticeHistorySchema = z.object({
  id: z.string().regex(/^(delivery|attempt|operation|supersession):[0-9a-f-]{36}$/i),
  kind: z.enum(["delivery", "attempt", "resend", "manual_resolution", "historical_note", "system_no_longer_required", "supersession"]),
  state: noticeStateSchema, createdAt: timestamp, completedAt: timestamp.nullable(), reason: z.string().max(500).nullable(),
  sequence: z.number().int().nonnegative().safe(), code: z.string().max(80).nullable(),
});
export type NoticeHistory = z.infer<typeof noticeHistorySchema>;
export type NoticePage<T> = { items: T[]; hasMore: boolean; nextCursor: string | null };
export type NoticeStateFilter = "all" | "unknown" | "not_deliverable" | "failed";
export type NoticeFamilyFilter = "all" | NoticeFamily;
export const noticeActionSchema = z.enum(["resend", "manual_resolution", "history_note"]);
export type NoticeAction = z.infer<typeof noticeActionSchema>;
export function financialReviewSelection(value: unknown) {
  const parsed = z.array(z.object({ id: uuid, reviewRevision: z.number().int().positive().safe() })).min(1).max(100)
    .refine(rows => new Set(rows.map(row => row.id)).size === rows.length).safeParse(value);
  return parsed.success ? { invoiceIds: parsed.data.map(row => row.id),
    expectedRevisions: Object.fromEntries(parsed.data.map(row => [row.id, row.reviewRevision])) } : null;
}
export const noticeOperationSchema = z.object({ eventId: uuid, deliveryId: uuid, operationId: uuid,
  reason: z.string().trim().min(1).max(FINANCIAL_NOTICE_REASON_LIMIT) }).strict();
export type NoticeOperation = z.infer<typeof noticeOperationSchema>;
export const noticeActionResultSchema = z.object({ status: z.enum(["queued", "manually_resolved", "historical_note_recorded"]), deliveryId: uuid,
  eventId: uuid, operationId: uuid, replayed: z.boolean(), deliveryCount: z.number().int().nonnegative().safe() });
export type NoticeActionResult = z.infer<typeof noticeActionResultSchema>;
const cursorSchema = z.record(z.string().max(60), z.union([z.string().max(256), z.number().finite(), z.boolean(), z.null()]))
  .refine(value => Object.keys(value).length <= 12);
export function parseNoticeCursor(value: string | null): Json | null {
  if (!value) return null;
  try { if (value.length > 2048) throw new Error("cursor"); return cursorSchema.parse(JSON.parse(value)); }
  catch { throw new FinancialNoticeError("INVALID_CURSOR"); }
}
export function parseNoticePage<T>(value: unknown, item: z.ZodType<T>): NoticePage<T> {
  const result = z.object({ items: z.array(item).max(FINANCIAL_NOTICE_PAGE_SIZE), hasMore: z.boolean(), nextCursor: cursorSchema.nullable() }).safeParse(value);
  if (!result.success || result.data.hasMore !== (result.data.nextCursor !== null)) throw new FinancialNoticeError("RESULT_UNCONFIRMED");
  return { ...result.data, nextCursor: result.data.nextCursor ? JSON.stringify(result.data.nextCursor) : null };
}
export function parseNoticeStatus(value: unknown) {
  const extra = z.object({ latestHoldSourceEventId: uuid.nullable() }).safeParse(value);
  if (!extra.success) throw new FinancialNoticeError("RESULT_UNCONFIRMED");
  return { ...parseNoticePage(value, noticeSchema), ...extra.data };
}
export type NoticeOperator = { id: string; role: "manager" | "dispatcher" | "back_office"; active: true; staffPermissions: string[] };
export function noticeOperator(profile: unknown): NoticeOperator | null {
  const result = z.object({ id: z.string().min(1).max(128), role: z.enum(["manager", "dispatcher", "back_office"]), active: z.literal(true),
    staffPermissions: z.array(z.string()).max(50).default([]) }).safeParse(profile);
  return result.success ? result.data : null;
}
export function canReviewNotices(operator: NoticeOperator) { return !operator.staffPermissions.includes("invoice_controller"); }
export function canActOnNotice(operator: NoticeOperator, family: NoticeFamily) {
  return family.startsWith("invoice_") ? canReviewNotices(operator)
    : family !== "payment_hold_released" || operator.staffPermissions.includes("quickbooks_handoff");
}
export function noticeScope(operator: NoticeOperator) { return [operator.id, operator.role, ...operator.staffPermissions.slice().sort()]; }
export const noticeFamilyLabel: Record<NoticeFamily, string> = {
  invoice_rejected: "Invoice rejection", invoice_rejection_retracted: "Rejection withdrawn",
  payment_hold_placed: "Payment hold placed", payment_hold_released: "Payment hold released",
};
export const noticeRecipientLabel: Record<FinancialNotice["recipientKind"], string> = {
  contractor: "Contractor account", creator: "Invoice submitter", handoff: "Payables recipient", missing: "Recipient unavailable",
};
const errorMessages = {
  AUTH_REQUIRED: "Sign in again to review invoice notification delivery.",
  ACCOUNT_INACTIVE: "Your account is inactive. Contact an administrator.",
  FORBIDDEN: "You do not have permission for this notification action.",
  DELIVERY_NOT_FOUND: "This notification record is unavailable. Refresh the invoice.",
  EVENT_NOT_CURRENT: "This notification no longer matches the applicable invoice event. Refresh before taking action.",
  DELIVERY_NOT_CURRENT: "This notification no longer matches the current recipient or event. Refresh before taking action.",
  DELIVERY_ALREADY_SENT: "This email is already confirmed sent. It cannot be resent here.",
  DELIVERY_NOT_ACTIONABLE: "This notification is no longer available for that action. Refresh its status.",
  DELIVERY_SUPERSEDED: "A later invoice event superseded this notification. It cannot be resent.",
  DELIVERY_INTEGRITY_REVIEW: "The notification records need operational integrity review before any action.",
  RECIPIENT_NOT_DELIVERABLE: "The intended recipient needs an active eligible account and a deliverable address before resending.",
  STALE_REVIEW: "The invoice review has changed. Refresh before taking action.",
  STALE_HOLD: "The payment hold event has changed. Refresh before taking action.",
  HOLD_NOTIFICATION_SUPERSEDED: "A later hold change superseded this notification. It cannot be resent. Review its history or record a historical review note.",
  OPERATION_REUSED: "This request differs from its original details. Refresh and review the recorded outcome.",
  REASON_REQUIRED: "Enter a reason to continue.",
  VALIDATION_FAILED: "Check the reason and request details, then try again.",
  INVALID_CURSOR: "This page is no longer valid. Start at the newest results.",
  RESULT_UNCONFIRMED: "The result could not be confirmed. Review the status or retry this same request; its original details are preserved.",
} as const;
export type NoticeErrorCode = keyof typeof errorMessages;
export class FinancialNoticeError extends Error {
  constructor(readonly code: NoticeErrorCode) { super(errorMessages[code]); this.name = "FinancialNoticeError"; }
  get uncertain() { return this.code === "RESULT_UNCONFIRMED"; }
}
export function safeNoticeError(cause: unknown): FinancialNoticeError {
  if (cause instanceof FinancialNoticeError) return cause;
  const parsed = z.object({ code: z.unknown().optional(), message: z.unknown().optional(), details: z.unknown().optional() }).safeParse(cause);
  if (parsed.success) {
    if (["42501", "PT403"].includes(String(parsed.data.code))) return new FinancialNoticeError("FORBIDDEN");
    if (["PGRST301", "PGRST302", "PT401"].includes(String(parsed.data.code))) return new FinancialNoticeError("AUTH_REQUIRED");
    for (const value of [parsed.data.code, parsed.data.message, parsed.data.details]) {
      if (typeof value === "string" && Object.hasOwn(errorMessages, value)) return new FinancialNoticeError(value as NoticeErrorCode);
    }
  }
  return new FinancialNoticeError("RESULT_UNCONFIRMED");
}
export function noticePresentation(notice: Pick<FinancialNotice, "state" | "attemptCount" | "code" | "canResend" | "canResolve">) {
  const retrying = notice.state === "failed" && notice.attemptCount < 3
    && ["GRAPH_RATE_LIMITED", "GRAPH_AUTH_RETRYABLE"].includes(notice.code || "");
  const states: Record<NoticeState, { label: string; guidance: string }> = {
    pending: { label: "Queued", guidance: "The invoice action was saved. This email is waiting for the delivery worker." },
    claimed: { label: "Sending", guidance: "Email delivery is in progress." },
    sending: { label: "Sending", guidance: "Email delivery is in progress." },
    sent: { label: "Sent", guidance: "The provider confirmed acceptance. This does not prove that the recipient read it." },
    failed: retrying ? { label: "Retry scheduled", guidance: "The provider did not accept the email. The worker owns its scheduled retry." }
      : { label: "Delivery failed", guidance: "Automatic attempts have stopped. Review this notification." },
    unknown: { label: "Delivery unresolved", guidance: "Delivery could not be confirmed. The recipient may already have received the email. Review before authorizing another message." },
    not_deliverable: { label: "Email unavailable", guidance: "No eligible deliverable recipient was available. Correct the intended contact or record contact another way." },
    superseded: { label: "Superseded", guidance: "A later invoice event made this notice inapplicable. This is historical delivery state." },
    manually_resolved: { label: "Contacted another way", guidance: "Staff recorded contact outside email. The email is not marked sent." },
  };
  const actionable = notice.state === "unknown" || notice.state === "not_deliverable" || (notice.state === "failed" && !retrying);
  return { ...states[notice.state], actionable, canResend: actionable && notice.canResend, canResolve: actionable && notice.canResolve };
}

/** Effective financial state is separate from the original provider outcome.
 * In particular a later hold change never relabels an original sent/unknown
 * email as unsent or manually resolved. Review/retraction policy is unchanged. */
export function noticeEventPresentation(notice: FinancialNotice, latestHoldSourceEventId: string | null) {
  const original = noticePresentation(notice);
  const supersededHold = notice.family.startsWith("payment_hold_") && (notice.supersededBySourceEventId !== null
    || (latestHoldSourceEventId !== null && notice.sourceEventId !== latestHoldSourceEventId));
  const current = notice.current && !supersededHold;
  return {
    ...original, current, supersededHold,
    label: supersededHold ? "Superseded by a later hold change" : original.label,
    guidance: supersededHold ? "This earlier financial notice is historical and cannot be sent or resent. The latest hold change owns the current notification."
      : original.guidance,
    originalLabel: original.label, originalGuidance: original.guidance,
    canResend: current && original.canResend, canResolve: current && original.canResolve,
    canAnnotateHistory: supersededHold && notice.canAnnotateHistory
      && (notice.state === "unknown" || notice.state === "superseded"),
  };
}

export function noticeHistoryLabel(item: Pick<NoticeHistory, "kind" | "state" | "sequence" | "code">) {
  if (item.kind === "resend") return "Explicit resend queued";
  if (item.kind === "manual_resolution") return "Contacted another way";
  if (item.kind === "system_no_longer_required") return "Notification no longer required — system classification";
  if (item.kind === "supersession") return "Superseded by a later hold change — original outcome preserved";
  if (item.kind === "historical_note") return item.state === "superseded"
    ? "Notification no longer required — staff review note" : "Historical review note — original outcome preserved";
  return noticePresentation({ state: item.state, attemptCount: item.sequence, code: item.code, canResend: false, canResolve: false }).label;
}

export function noticePriorOutcomeLabel(state: NoticeState) {
  // A supersession snapshot does not carry an attempt count. Do not infer a
  // scheduled retry from a zero sequence or claim that a pre-send claim sent.
  if (state === "failed") return "Failed attempt";
  if (state === "claimed") return "Claimed before sending started";
  return noticePresentation({ state, attemptCount: 0, code: null, canResend: false, canResolve: false }).label;
}

export function noticeOutcomeGuidance(code: string | null) {
  const categories: Record<string, string> = {
    RECIPIENT_INACTIVE: "The intended recipient account is unavailable or inactive.",
    RECIPIENT_EMAIL_MISSING: "The intended recipient needs a deliverable address.",
    RECIPIENT_NOT_DELIVERABLE: "The intended recipient's contact or eligibility needs review.",
    GRAPH_RATE_LIMITED: "The provider temporarily limited requests; only known-unsent attempts may retry.",
    GRAPH_AUTH_RETRYABLE: "Provider authorization was temporarily unavailable before sending.",
    GRAPH_SEND_REJECTED: "The provider rejected the email without accepting it.",
    GRAPH_CONFIG_UNAVAILABLE: "The email service configuration needs operational review.",
    GRAPH_OUTCOME_UNKNOWN: "Acceptance could not be confirmed; the email may already have been delivered.",
    SEND_OUTCOME_UNKNOWN: "Sending may have begun before the worker stopped; the email may already have been delivered.",
    CLAIM_EXPIRED_BEFORE_SEND: "The worker lease expired before sending began.",
    EVENT_NOT_CURRENT: "The source event no longer matches the applicable invoice state.",
    STALE_REVIEW: "A later review revision made this notice inapplicable.",
    STALE_HOLD: "A later payment-hold event changed the applicable state.",
    HOLD_NOTIFICATION_SUPERSEDED: "A later hold change superseded this notification. Its original delivery history is preserved; no older notice may be resent.",
    DELIVERY_FAILED: "Delivery needs operational review.",
  };
  return code && Object.hasOwn(categories, code) ? categories[code] : null;
}
