import { z } from "zod";

export const financialNotificationReceiptSchema = z.object({
  operationId: z.uuid(), replayed: z.boolean(),
  notificationStatus: z.enum(["not_required", "queued", "not_deliverable"]),
  notifications: z.array(z.object({ eventId: z.uuid(), sourceEventId: z.uuid(),
    family: z.enum(["invoice_rejected", "invoice_rejection_retracted", "payment_hold_placed", "payment_hold_released"]),
    status: z.enum(["queued", "not_deliverable"]),
  })).max(1),
});
export const financialReviewResultSchema = financialNotificationReceiptSchema.extend({
  invoiceId: z.uuid(), invoiceNum: z.string().max(256),
  invoiceState: z.enum(["submitted", "approved", "rejected", "revised", "paid"]),
  workOrderId: z.string().max(128),
  workOrderStatus: z.enum(["pending_invoice", "pending_approval", "closed"]).nullable(),
  reviewRevision: z.number().int().positive(), rejectionReason: z.string().nullable().optional(),
  total: z.number().finite().optional(), pdfStoragePath: z.string().max(1000).nullable().optional(),
});
export const financialBatchReviewResultSchema = z.object({
  action: z.enum(["approve", "reject"]), count: z.number().int().min(1).max(100),
  invoiceIds: z.array(z.uuid()).min(1).max(100), results: z.array(financialReviewResultSchema).min(1).max(100),
  operationId: z.uuid(), replayed: z.boolean(),
});
// Safe minimum hold result: existing hold details remain server-owned and are
// refreshed from their established query, not copied into notification caches.
export const financialHoldResultSchema = financialNotificationReceiptSchema.extend({
  invoiceId: z.uuid(), invoiceNum: z.string().max(256), applied: z.boolean(),
});
export type FinancialReviewResult = z.infer<typeof financialReviewResultSchema>;
export type FinancialBatchReviewResult = z.infer<typeof financialBatchReviewResultSchema>;
export type FinancialHoldResult = z.infer<typeof financialHoldResultSchema>;
export type FinancialNotificationReceipt = z.infer<typeof financialNotificationReceiptSchema>;
export function financialReceiptMatches(result: FinancialNotificationReceipt, family: FinancialNotificationReceipt["notifications"][number]["family"] | null) {
  return family === null ? result.notificationStatus === "not_required" && result.notifications.length === 0
    : result.notifications.length === 1 && result.notifications[0].family === family
      && result.notifications[0].status === result.notificationStatus;
}

export function financialNotificationFeedback(result: Pick<FinancialNotificationReceipt, "notificationStatus">): string {
  return result.notificationStatus === "queued" ? "notification queued"
    : result.notificationStatus === "not_deliverable" ? "notification needs attention — review invoice notification delivery"
    : "no notification required";
}

const errors = {
  AUTH_REQUIRED: "Your session expired. Sign in again before changing this invoice.",
  FORBIDDEN: "You no longer have permission for this invoice action. Refresh and review your access.",
  VALIDATION_FAILED: "Check the invoice selection and required reason. Payment-hold reasons must not exceed 500 characters.",
  STALE_REVIEW: "The invoice review changed. Refresh and review it before trying again.",
  STALE_HOLD: "The payment hold changed. Refresh and review it before trying again.",
  FINANCIAL_EVENT_STALE: "The invoice is no longer eligible for this action. Refresh and review its current state.",
  INVOICE_NOT_FOUND: "This invoice is no longer available. Refresh the invoice list.",
  OPERATION_REUSED: "An earlier invoice action is unconfirmed. Retry it unchanged before starting a different action.",
  REQUEST_CAPACITY: "There are too many unconfirmed invoice actions. Review them before starting another action.",
  RESULT_UNCONFIRMED: "The invoice action could not be confirmed. Retry the same unchanged action; it may already have been saved.",
} as const;
export class FinancialNotificationCommandError extends Error {
  constructor(public readonly code: keyof typeof errors) { super(errors[code]); this.name = "FinancialNotificationCommandError"; }
  get uncertain() { return this.code === "RESULT_UNCONFIRMED"; }
}
export function safeFinancialNotificationCommandError(cause: unknown): FinancialNotificationCommandError {
  if (cause instanceof FinancialNotificationCommandError) return cause;
  if (cause instanceof z.ZodError) return new FinancialNotificationCommandError("VALIDATION_FAILED");
  const parsed = z.object({ code: z.string().optional(), message: z.string().optional() }).safeParse(cause);
  if (parsed.success) {
    const { code, message } = parsed.data;
    for (const key of Object.keys(errors) as (keyof typeof errors)[]) {
      if (code === key || message === key) return new FinancialNotificationCommandError(key);
    }
    if (["42501", "PT403"].includes(code || "")) return new FinancialNotificationCommandError("FORBIDDEN");
    if (["PGRST301", "PGRST302", "PT401"].includes(code || "")) return new FinancialNotificationCommandError("AUTH_REQUIRED");
    if (["PT409", "40001"].includes(code || "")) return new FinancialNotificationCommandError("STALE_REVIEW");
    if (code === "55000") return new FinancialNotificationCommandError("FINANCIAL_EVENT_STALE");
    if (["PT422", "22023"].includes(code || "")) return new FinancialNotificationCommandError("VALIDATION_FAILED");
    if (["PT404", "P0002"].includes(code || "")) return new FinancialNotificationCommandError("INVOICE_NOT_FOUND");
  }
  return new FinancialNotificationCommandError("RESULT_UNCONFIRMED");
}
