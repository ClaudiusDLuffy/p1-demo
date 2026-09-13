import { z } from "zod";
import type { Json } from "../../lib/supabase/database.types";

export const DISPATCH_PAGE_SIZE = 25;
export const DISPATCH_REASON_LIMIT = 500;
const identifier = z.string().uuid();
const timestamp = z.string().datetime({ offset: true });
export const dispatchStateSchema = z.enum([
  "pending", "claimed", "sending", "sent", "failed", "unknown",
  "not_deliverable", "superseded", "cancelled", "manually_resolved",
]);
export type DispatchState = z.infer<typeof dispatchStateSchema>;

// Strip extra provider/recipient fields instead of retaining raw RPC objects.
export const deliverySchema = z.object({
  id: identifier, rootId: identifier, workOrderId: z.string().min(1).max(128),
  assignmentVersion: z.number().int().nonnegative().safe(), state: dispatchStateSchema,
  attemptCount: z.number().int().nonnegative().safe(), createdAt: timestamp,
  lastAttemptAt: timestamp.nullable(), completedAt: timestamp.nullable(),
  code: z.string().max(80).nullable(), canResend: z.boolean(), canResolve: z.boolean(),
});
export type DispatchDelivery = z.infer<typeof deliverySchema>;
export const currentSchema = z.object({
  kind: z.enum(["current", "legacy_untracked", "missing_intent", "unassigned"]),
  delivery: deliverySchema.nullable(),
}).refine(value => (value.kind === "current") === (value.delivery !== null));
export type DispatchCurrent = z.infer<typeof currentSchema>;
export const historyItemSchema = z.object({
  id: z.string().regex(/^(delivery|attempt|operation):[0-9a-f-]{36}$/i), kind: z.enum(["delivery", "attempt", "resend", "manual_resolution"]),
  state: dispatchStateSchema, createdAt: timestamp, completedAt: timestamp.nullable(),
  reason: z.string().max(DISPATCH_REASON_LIMIT).nullable(), code: z.string().max(80).nullable(), sequence: z.number().int().nonnegative().safe(),
});
export type DispatchHistoryItem = z.infer<typeof historyItemSchema>;
export type DispatchPage<T> = { items: T[]; hasMore: boolean; nextCursor: string | null };
export type DispatchFilter = "all" | "unknown" | "not_deliverable" | "failed";
export type DispatchAction = "resend" | "manual_resolution";
export type DispatchOperation = {
  deliveryId: string; assignmentVersion: number; operationId: string; reason: string;
};
export const operationSchema = z.object({
  deliveryId: identifier, assignmentVersion: z.number().int().nonnegative().safe(),
  operationId: identifier, reason: z.string().trim().min(1).max(DISPATCH_REASON_LIMIT),
}).strict();
export const actionResultSchema = z.object({
  status: z.enum(["queued", "manually_resolved"]), deliveryId: identifier,
  operationId: identifier, replayed: z.boolean(),
});
export type DispatchActionResult = z.infer<typeof actionResultSchema>;

const cursorSchema = z.record(z.string().max(60), z.union([
  z.string().max(256), z.number().finite(), z.boolean(), z.null(),
])).refine(value => Object.keys(value).length <= 12);
export function parseDispatchCursor(value: string | null): Json | null {
  if (!value) return null;
  try {
    if (value.length > 2048) throw new Error("cursor");
    return cursorSchema.parse(JSON.parse(value));
  } catch { throw new DispatchOperatorError("VALIDATION_FAILED"); }
}
export function parseDispatchPage<T>(value: unknown, item: z.ZodType<T>): DispatchPage<T> {
  const result = z.object({
    items: z.array(item).max(DISPATCH_PAGE_SIZE), hasMore: z.boolean(),
    nextCursor: cursorSchema.nullable(),
  }).safeParse(value);
  if (!result.success || result.data.hasMore !== (result.data.nextCursor !== null)) {
    throw new DispatchOperatorError("DELIVERY_UNCONFIRMED");
  }
  return { ...result.data, nextCursor: result.data.nextCursor ? JSON.stringify(result.data.nextCursor) : null };
}

export type DispatchOperator = { id: string; role: string; active: true; staffPermissions: string[] };
export function dispatchOperator(profile: unknown): DispatchOperator | null {
  const parsed = z.object({ id: z.string().min(1).max(128), role: z.enum(["manager", "dispatcher", "back_office"]),
    active: z.literal(true), staffPermissions: z.array(z.string()).max(50).default([]) }).safeParse(profile);
  if (!parsed.success || parsed.data.staffPermissions.includes("invoice_controller")) return null;
  return parsed.data;
}
export function operatorScope(operator: DispatchOperator) {
  return [operator.id, operator.role, ...operator.staffPermissions.slice().sort()];
}

const messages = {
  AUTH_REQUIRED: "Sign in again to review dispatch delivery.",
  ACCOUNT_INACTIVE: "Your account is inactive. Contact an administrator.",
  FORBIDDEN: "You do not have permission to review dispatch delivery.",
  DELIVERY_NOT_FOUND: "This dispatch record is unavailable. Refresh the work order.",
  DELIVERY_NOT_CURRENT: "The assignment has changed. Refresh before taking action.",
  DELIVERY_ALREADY_SENT: "This email is already confirmed sent. Refresh its status.",
  DELIVERY_NOT_ACTIONABLE: "Delivery is no longer available for this action. Refresh its status.",
  DELIVERY_SUPERSEDED: "The assignment has changed. This delivery cannot be resent.",
  DELIVERY_INTEGRITY_REVIEW: "The dispatch records need operational integrity review. No action can be taken until they are checked.",
  RECIPIENT_NOT_DELIVERABLE: "The current contractor needs an active account and a deliverable email before resending.",
  STALE_ASSIGNMENT: "The assignment has changed. Refresh before taking action.",
  OPERATION_REUSED: "This request no longer matches its original details. Refresh and review the recorded outcome.",
  REASON_REQUIRED: "Enter a reason to continue.",
  VALIDATION_FAILED: "Check the reason and request details, then try again.",
  INVALID_CURSOR: "This page is no longer valid. Start at the newest results and review the list again.",
  DELIVERY_UNCONFIRMED: "The result could not be confirmed. Refresh the status or retry this same request; its original details are preserved.",
} as const;
export type DispatchErrorCode = keyof typeof messages;
export class DispatchOperatorError extends Error {
  constructor(readonly code: DispatchErrorCode) { super(messages[code]); this.name = "DispatchOperatorError"; }
  get uncertain() { return this.code === "DELIVERY_UNCONFIRMED"; }
}
export function safeDispatchError(error: unknown): DispatchOperatorError {
  if (error instanceof DispatchOperatorError) return error;
  const fields = z.object({ code: z.unknown().optional(), details: z.unknown().optional(), message: z.unknown().optional() }).safeParse(error);
  if (fields.success) {
    if (fields.data.code === "42501" || fields.data.code === "PT403") return new DispatchOperatorError("FORBIDDEN");
    if (fields.data.code === "PGRST301" || fields.data.code === "PGRST302" || fields.data.code === "PT401") return new DispatchOperatorError("AUTH_REQUIRED");
    for (const key of ["code", "details", "message"] as const) {
      const value = fields.data[key];
      if (typeof value === "string" && Object.hasOwn(messages, value)) {
        return new DispatchOperatorError(value as DispatchErrorCode);
      }
    }
  }
  return new DispatchOperatorError("DELIVERY_UNCONFIRMED");
}

export function dispatchPresentation(delivery: Pick<DispatchDelivery, "state" | "attemptCount" | "code" | "canResend" | "canResolve">) {
  const retrying = delivery.state === "failed" && delivery.attemptCount < 3
    && (delivery.code === "GRAPH_RATE_LIMITED" || delivery.code === "GRAPH_AUTH_RETRYABLE");
  const states: Record<DispatchState, { label: string; guidance: string }> = {
    pending: { label: "Queued", guidance: "The assignment succeeded. Its email is waiting for the delivery worker." },
    claimed: { label: "Sending", guidance: "Email delivery is in progress." },
    sending: { label: "Sending", guidance: "Email delivery is in progress." },
    sent: { label: "Sent", guidance: "The email provider confirmed acceptance. This does not confirm that the contractor has read it." },
    failed: retrying
      ? { label: "Retry scheduled", guidance: "The email was not accepted. The delivery worker will retry." }
      : { label: "Delivery failed", guidance: "Automatic attempts have ended. Review the dispatch and choose how to contact the contractor." },
    unknown: { label: "Delivery unresolved", guidance: "Delivery could not be confirmed. The contractor may already have received the email. Review before authorizing another message." },
    not_deliverable: { label: "Email unavailable", guidance: "No deliverable recipient was available. Check the current contractor account and email, or contact the contractor another way." },
    superseded: { label: "Superseded", guidance: "This delivery belongs to an earlier assignment and cannot be resent." },
    cancelled: { label: "Cancelled", guidance: "This dispatch is no longer queued for delivery." },
    manually_resolved: { label: "Contacted another way", guidance: "Staff recorded contact outside email. This does not confirm email delivery." },
  };
  const actionable = delivery.state === "unknown" || delivery.state === "not_deliverable" || (delivery.state === "failed" && !retrying);
  return { ...states[delivery.state], actionable, canResend: actionable && delivery.canResend,
    canResolve: actionable && delivery.canResolve };
}

export function dispatchOutcomeGuidance(code: string | null): string | null {
  const categories: Record<string, string> = {
    RECIPIENT_INACTIVE: "The contractor account is unavailable or inactive.",
    RECIPIENT_EMAIL_MISSING: "The contractor needs a deliverable email address.",
    RECIPIENT_NOT_DELIVERABLE: "The current contractor contact needs review.",
    ASSIGNMENT_SUPERSEDED: "The assignment changed before delivery.",
    GRAPH_RATE_LIMITED: "The provider temporarily limited requests; only known-unsent attempts may retry.",
    GRAPH_AUTH_RETRYABLE: "Provider authorization was temporarily unavailable before sending.",
    GRAPH_SEND_REJECTED: "The provider rejected the email without accepting it.",
    GRAPH_CONFIG_UNAVAILABLE: "The email service configuration needs operational review.",
    GRAPH_OUTCOME_UNKNOWN: "Acceptance could not be confirmed; the email may already have been delivered.",
    GRAPH_SEND_FAILED: "Email delivery needs operational review.",
    WORK_ORDER_NOT_FOUND: "The work order is unavailable for delivery.",
    CLAIM_EXPIRED_BEFORE_SEND: "The worker lease expired before sending began.",
    SEND_OUTCOME_UNKNOWN: "The worker stopped after sending may have begun; the email may already have been delivered.",
    DELIVERY_FAILED: "Delivery needs operational review.",
  };
  return code && Object.hasOwn(categories, code) ? categories[code] : null;
}
