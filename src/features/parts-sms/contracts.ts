import { z } from "zod";
import type { Json } from "../../lib/supabase/database.types";

export const PARTS_SMS_PAGE_SIZE = 25;
export const PARTS_SMS_REASON_LIMIT = 500;
export const PARTS_SMS_HEALTH_COUNT_CAP = 1000;
export const PARTS_SMS_UNKNOWN_WARNING = "SMS delivery could not be confirmed and the recipient may already have received this message. Resending can create a duplicate SMS. Enter a reason to continue.";
export const PARTS_SMS_RECURRENCE_QUEUED = "Parts request returned to an earlier unsent configuration. A new notification attempt was queued.";
export const PARTS_SMS_RECURRENCE_BLOCKED = "The parts request returned to a previous configuration, but an SMS may already have been sent or started. Automatic resend is blocked for review.";
export const PARTS_SMS_RECURRENCE_REASON = "Source signature became current again before any SMS send started.";
const identifier = z.string().uuid();
const timestamp = z.string().datetime({ offset: true });
const count = z.number().int().nonnegative().safe();
export const partsSmsStateSchema = z.enum(["pending", "claimed", "sending", "accepted", "sent", "delivered", "failed", "unknown", "not_deliverable", "superseded", "manually_resolved"]);
export type PartsSmsState = z.infer<typeof partsSmsStateSchema>;
export const partsSmsOriginSchema = z.enum(["initial", "explicit_resend", "source_recurrence"]);
export const partsSmsRecurrenceBlockSchema = z.enum(["send_started", "daily_outcome", "active_attempt", "proof_incomplete"]);
export const partsSmsDeliverySchema = z.object({
  id: identifier, rootId: identifier, recipientId: identifier, recipientName: z.string().max(200).nullable(),
  localDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), timezone: z.string().min(1).max(100),
  state: partsSmsStateSchema, providerState: z.enum(["accepted", "queued", "sending", "sent", "delivered", "undelivered", "failed", "canceled", "scheduled"]).nullable(),
  legacy: z.boolean(), current: z.boolean(), attemptCount: count, createdAt: timestamp,
  lastAttemptAt: timestamp.nullable(), completedAt: timestamp.nullable(), nextAttemptAt: timestamp.nullable(),
  code: z.string().max(80).nullable(), canResend: z.boolean(), canResolve: z.boolean(), statusCheckStale: z.boolean(),
  origin: partsSmsOriginSchema.optional(), recurrenceGeneration: count.nullable().optional(),
  recurrenceBlockCategory: partsSmsRecurrenceBlockSchema.nullable().optional(),
});
export type PartsSmsDelivery = z.infer<typeof partsSmsDeliverySchema>;
export const partsSmsHistorySchema = z.object({
  id: z.string().regex(/^(delivery|attempt|operation|status):[0-9a-f-]{36}$/i),
  kind: z.enum(["delivery", "attempt", "resend", "manual_resolution", "provider_status", "source_recurrence"]),
  state: partsSmsStateSchema, createdAt: timestamp, completedAt: timestamp.nullable(),
  providerState: z.enum(["accepted", "queued", "sending", "sent", "delivered", "undelivered", "failed"]).nullable(),
  reason: z.string().max(PARTS_SMS_REASON_LIMIT).nullable(), sequence: count, code: z.string().max(80).nullable(),
}).refine(item => item.kind !== "source_recurrence" || (
  item.reason === PARTS_SMS_RECURRENCE_REASON && item.state === "pending"
  && item.providerState === null && item.sequence === 0
));
export type PartsSmsHistory = z.infer<typeof partsSmsHistorySchema>;
export const partsSmsHealthSchema = z.object({
  enabled: z.boolean(), timezone: z.string().min(1).max(100), cutoffTime: z.string().nullable(),
  lastStartedAt: timestamp.nullable(), lastCompletedAt: timestamp.nullable(), lastSuccessfulAt: timestamp.nullable(),
  lastResultCode: z.string().max(80).nullable(), oldestPendingAt: timestamp.nullable(), unknownCount: count,
  notDeliverableCount: count, staleStatusCount: count, expiredClaimCount: count,
  sourceRecurrenceCount: count.default(0),
  lastRunRecurrenceQueued: count.optional(), lastRunRecurrenceBlocked: count.optional(),
  stale: z.boolean(), cadenceMinutes: z.number().int().min(1).max(60), currentRunIncomplete: z.boolean(),
});
export type PartsSmsHealth = z.infer<typeof partsSmsHealthSchema>;
export const partsSmsFilterSchema = z.enum(["all", "unknown", "not_deliverable", "failed", "history"]);
export type PartsSmsFilter = z.infer<typeof partsSmsFilterSchema>;
export type PartsSmsAction = "resend" | "manual_resolution";
export const partsSmsOperationSchema = z.object({ deliveryId: identifier, operationId: identifier,
  reason: z.string().trim().min(1).max(PARTS_SMS_REASON_LIMIT) }).strict();
export type PartsSmsOperation = z.infer<typeof partsSmsOperationSchema>;
export const partsSmsActionResultSchema = z.object({ status: z.enum(["queued", "manually_resolved"]),
  deliveryId: identifier, operationId: identifier, replayed: z.boolean() });
export type PartsSmsActionResult = z.infer<typeof partsSmsActionResultSchema>;
export type PartsSmsPage<T> = { items: T[]; hasMore: boolean; nextCursor: string | null };
const cursorSchema = z.record(z.string().max(60), z.union([z.string().max(256), z.number().finite(), z.boolean(), z.null()]))
  .refine(value => Object.keys(value).length <= 12);
export function parsePartsSmsCursor(value: string | null): Json | null {
  if (!value) return null;
  try { if (value.length > 2048) throw new Error("cursor"); return cursorSchema.parse(JSON.parse(value)); }
  catch { throw new PartsSmsError("INVALID_CURSOR"); }
}
export function parsePartsSmsPage<T>(value: unknown, item: z.ZodType<T>): PartsSmsPage<T> {
  const parsed = z.object({ items: z.array(item).max(PARTS_SMS_PAGE_SIZE), hasMore: z.boolean(), nextCursor: cursorSchema.nullable() }).safeParse(value);
  if (!parsed.success || parsed.data.hasMore !== (parsed.data.nextCursor !== null)) throw new PartsSmsError("RESULT_UNCONFIRMED");
  return { ...parsed.data, nextCursor: parsed.data.nextCursor ? JSON.stringify(parsed.data.nextCursor) : null };
}
const operatorSchema = z.object({ id: z.string().min(1).max(128), active: z.literal(true), role: z.enum(["manager", "dispatcher", "back_office"]), staffPermissions: z.array(z.string().max(80)).max(50).default([]) });
export type PartsSmsOperator = z.infer<typeof operatorSchema>;
export function partsSmsOperator(value: unknown): PartsSmsOperator | null {
  const parsed = operatorSchema.safeParse(value);
  return parsed.success && !parsed.data.staffPermissions.includes("invoice_controller") ? parsed.data : null;
}
export function partsSmsScope(operator: PartsSmsOperator) { return [operator.id, operator.role, ...operator.staffPermissions.slice().sort()]; }

const errors = {
  AUTH_REQUIRED: "Sign in again to review parts SMS delivery.", ACCOUNT_INACTIVE: "Your account is inactive. Contact an administrator.",
  FORBIDDEN: "Operational staff access is required.", PARTS_ALERT_EVENT_NOT_FOUND: "This parts alert is unavailable. Refresh the list.",
  PARTS_ALERT_EVENT_STALE: "The parts, date or recipient changed. Refresh before taking action.",
  PARTS_ALERT_SUPERSEDED: "This parts alert is no longer current and cannot be resent.",
  PARTS_ALERT_NOT_ACTIONABLE: "This alert is not available for that action. Refresh its status.",
  PARTS_ALERT_ALREADY_DELIVERED: "Provider delivery evidence already exists. This alert cannot be resent.",
  PARTS_ALERT_DISABLED: "Parts alerts are disabled. Review the current settings.",
  RECIPIENT_NOT_DELIVERABLE: "Check the active staff recipient and configured phone before resending.",
  OPERATION_REUSED: "The request differs from its original details. Review the recorded result before taking another action.",
  REASON_REQUIRED: "Enter a reason to continue.", VALIDATION_FAILED: "Check the reason and request details.",
  INVALID_CURSOR: "This page is invalid. Start at the newest results again.",
  RESULT_UNCONFIRMED: "The result could not be confirmed. Refresh the status or retry this same request; its original details are preserved.",
} as const;
export type PartsSmsErrorCode = keyof typeof errors;
export class PartsSmsError extends Error {
  constructor(readonly code: PartsSmsErrorCode) { super(errors[code]); this.name = "PartsSmsError"; }
  get uncertain() { return this.code === "RESULT_UNCONFIRMED"; }
}
export function safePartsSmsError(error: unknown): PartsSmsError {
  if (error instanceof PartsSmsError) return error;
  const parsed = z.object({ code: z.unknown().optional(), message: z.unknown().optional(), details: z.unknown().optional() }).safeParse(error);
  if (parsed.success) {
    if (["42501", "PT403"].includes(String(parsed.data.code))) return new PartsSmsError("FORBIDDEN");
    if (["PGRST301", "PGRST302", "PT401"].includes(String(parsed.data.code))) return new PartsSmsError("AUTH_REQUIRED");
    const aliases: Record<string, PartsSmsErrorCode> = { DELIVERY_NOT_FOUND: "PARTS_ALERT_EVENT_NOT_FOUND",
      DELIVERY_NOT_ACTIONABLE: "PARTS_ALERT_NOT_ACTIONABLE", STALE_DIGEST: "PARTS_ALERT_EVENT_STALE" };
    for (const value of [parsed.data.code, parsed.data.message, parsed.data.details]) {
      if (typeof value === "string" && Object.hasOwn(aliases, value)) return new PartsSmsError(aliases[value]);
      if (typeof value === "string" && Object.hasOwn(errors, value)) return new PartsSmsError(value as PartsSmsErrorCode);
    }
  }
  return new PartsSmsError("RESULT_UNCONFIRMED");
}
export function partsSmsPresentation(delivery: Pick<PartsSmsDelivery, "state" | "providerState" | "nextAttemptAt" | "current" | "canResend" | "canResolve" | "statusCheckStale" | "legacy" | "code" | "origin" | "recurrenceBlockCategory">) {
  const retrying = delivery.state === "failed" && delivery.nextAttemptAt !== null;
  const views: Record<PartsSmsState, { label: string; guidance: string }> = {
    pending: { label: "Queued", guidance: "Waiting for the scheduled SMS worker. Delivery has not been confirmed." },
    claimed: { label: "Sending", guidance: "A worker owns this attempt." }, sending: { label: "Sending", guidance: "The SMS provider request is in progress." },
    accepted: { label: "Accepted by SMS provider", guidance: "The provider accepted the message. This is not confirmation of handset delivery." },
    sent: delivery.legacy ? { label: "Sent (legacy record)", guidance: "Sending was recorded before durable SMS tracking. Handset delivery was not verified." }
      : { label: "Sent by provider", guidance: "The provider reports sent. Handset delivery has not been confirmed." },
    delivered: { label: "Delivered", guidance: "The SMS provider confirmed delivery." },
    failed: retrying ? { label: "Retry scheduled", guidance: "The message was demonstrably not accepted. A bounded automatic retry is scheduled." }
      : { label: delivery.providerState === "undelivered" ? "Undelivered" : "Delivery failed", guidance: "Automatic sending has ended. Review the outcome before contacting the recipient." },
    unknown: { label: "Delivery unresolved", guidance: PARTS_SMS_UNKNOWN_WARNING },
    not_deliverable: { label: "Phone unavailable", guidance: "No deliverable recipient or SMS configuration was available. Correct the settings before requesting a resend." },
    superseded: { label: "Superseded", guidance: "The source parts, settings or notification date changed. This historical alert cannot be resent." },
    manually_resolved: { label: "Contacted another way", guidance: "Staff recorded an out-of-band resolution. This does not mark SMS delivery as sent or delivered." },
  };
  const actionable = ["unknown", "not_deliverable", "failed"].includes(delivery.state) && !retrying;
  const staleProviderContact = delivery.statusCheckStale && ["accepted", "sent"].includes(delivery.state);
  let guidance = views[delivery.state].guidance;
  if (delivery.code === "PENDING_WORKER_DELAY") guidance += " The worker is more than two expected schedule intervals behind. Operations should review the schedule; this is an operational warning, not a delivery SLA.";
  if (delivery.code === "CLAIM_EXPIRED_REVIEW") guidance = delivery.state === "sending"
    ? "The worker lease expired after sending began. SMS delivery could not be confirmed and the recipient may already have received this message. Wait for guarded recovery before any further action."
    : "The worker claim expired before recorded send start. Wait for guarded recovery; this does not authorize another SMS.";
  const recurrenceBlocked = delivery.code === "PARTS_SOURCE_RECURRENCE_REVIEW";
  const blockReasons: Record<z.infer<typeof partsSmsRecurrenceBlockSchema>, string> = {
    send_started: "A previous attempt recorded send start.",
    daily_outcome: "A provider or manual outcome already exists for this recipient and local date.",
    active_attempt: "Another attempt is active. Wait for its recorded outcome.",
    proof_incomplete: "Available history does not prove that all earlier attempts were unsent.",
  };
  if (recurrenceBlocked) guidance = `${PARTS_SMS_RECURRENCE_BLOCKED}${delivery.recurrenceBlockCategory ? ` ${blockReasons[delivery.recurrenceBlockCategory]}` : ""}`;
  return { ...views[delivery.state], guidance, actionable: actionable || delivery.statusCheckStale || ["PENDING_WORKER_DELAY", "CLAIM_EXPIRED_REVIEW", "PARTS_SOURCE_RECURRENCE_REVIEW"].includes(delivery.code || ""),
    originNote: delivery.origin === "source_recurrence" ? PARTS_SMS_RECURRENCE_QUEUED : null,
    canResend: !recurrenceBlocked && actionable && delivery.current && delivery.canResend,
    canResolve: (actionable || staleProviderContact) && delivery.canResolve };
}
export function partsSmsTime(value: string | null) { return value ? new Date(value).toLocaleString() : "Not recorded"; }
export function partsSmsCount(value: number) { return value >= PARTS_SMS_HEALTH_COUNT_CAP ? `${PARTS_SMS_HEALTH_COUNT_CAP}+` : String(value); }
export function partsSmsRecurrenceRun(queued: number | undefined, blocked: number | undefined) {
  if (queued === undefined || blocked === undefined) return null;
  if (queued === 0 && blocked === 0) return "No source recurrence in the last recorded run.";
  return `Last run source recurrence: ${partsSmsCount(queued)} queued; ${partsSmsCount(blocked)} blocked for safety review.`;
}
