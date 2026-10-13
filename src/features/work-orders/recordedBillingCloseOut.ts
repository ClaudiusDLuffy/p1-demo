import { z } from "zod";
import { lifecycleRpcContext, lifecycleResultSchema } from "../../lib/workOrderLifecycleContracts";
import { supabase } from "../../lib/supabase/client";
import type { Json } from "../../lib/supabase/database.types";

const version = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const recordedBillingEvidenceSchema = z.object({
  workOrderId: z.string().min(1).max(128), assignmentVersion: version,
  workflowCycle: z.literal(0), lifecycleVersion: version,
  invoiceId: z.uuid(), invoiceVersion: version, invoiceNumber: z.string().min(1),
  billingActivityId: z.uuid(), billedAt: z.iso.datetime({ offset: true }),
});
export type RecordedBillingEvidence = z.infer<typeof recordedBillingEvidenceSchema>;
export const recordedBillingReceiptSchema = z.intersection(lifecycleResultSchema, recordedBillingEvidenceSchema.extend({
  workOrderStatus: z.literal("closed"), functionalStatus: z.literal("Completed"),
  closedAt: z.iso.datetime({ offset: true }), invoiceCreated: z.literal(false),
  billingRecorded: z.literal(false), paymentRecorded: z.literal(false), csvExported: z.literal(false),
}));
export type RecordedBillingReceipt = z.infer<typeof recordedBillingReceiptSchema>;
export type RecordedBillingCloseOutFunctions = {
  get_recorded_billing_closeout_v1: { Args: { p_work_order_id: string }; Returns: Json };
  reconcile_recorded_billing_closeout_v1: { Args: ReturnType<typeof lifecycleRpcContext> & {
    p_invoice_id: string; p_expected_invoice_version: number; p_billing_activity_id: string; p_confirmed: boolean;
  }; Returns: Json };
};
const messages: Record<string, string> = {
  RECORDED_BILLING_INVALID_INPUT: "Confirm the finished work and existing billing before closing.",
  RECORDED_BILLING_NOT_FOUND: "This work order is no longer available. Refresh and review its history.",
  RECORDED_BILLING_NOT_ELIGIBLE: "This closeout is only for finished regular work with existing billing, not capitals or reopened work.",
  RECORDED_BILLING_REOPENED: "This job was reopened. Review the current follow-up instead of closing against earlier billing.",
  RECORDED_BILLING_OPEN_VISIT: "Record the active visit's actual checkout before closing.",
  RECORDED_BILLING_PENDING_UPDATES: "Resolve pending 7-Eleven updates and contractor attention items first.",
  RECORDED_BILLING_UNRESOLVED_INVOICES: "Resolve outstanding contractor invoice reviews before closing.",
  RECORDED_BILLING_DOCUMENT_CONFLICT: "Conflicting billing documents exist. Review the invoice history before closing.",
  RECORDED_BILLING_NO_EVIDENCE: "A matching recorded 7-Eleven billing handoff is required. An approved invoice alone is not enough.",
  RECORDED_BILLING_LATER_WORK: "Later visits or contractor invoices exist. Review whether additional billing is needed.",
};
export class RecordedBillingCloseOutError extends Error {
  constructor(message: string, readonly uncertain = false) { super(message); }
}
export function recordedBillingCloseOutError(cause: unknown): RecordedBillingCloseOutError {
  if (cause instanceof RecordedBillingCloseOutError) return cause;
  if (cause instanceof z.ZodError) return new RecordedBillingCloseOutError(messages.RECORDED_BILLING_INVALID_INPUT);
  const parsed = z.object({ code: z.string().optional(), message: z.string().optional() }).safeParse(cause);
  if (parsed.success) {
    if (messages[parsed.data.message || ""]) return new RecordedBillingCloseOutError(messages[parsed.data.message!]);
    if (parsed.data.code === "42501") return new RecordedBillingCloseOutError("Only active operational P1 staff can reconcile already billed work.");
    if (["PT409", "40001", "23505"].includes(parsed.data.code || "")) return new RecordedBillingCloseOutError("This record changed. Close the form, refresh, and review it before trying again.");
    if (parsed.data.code === "PGRST202") return new RecordedBillingCloseOutError("The already-billed closeout database update is not installed in this environment yet.");
    if (["23514", "22023", "P0002"].includes(parsed.data.code || "")) return new RecordedBillingCloseOutError("The current work and billing evidence are not eligible. Review the records before closing.");
  }
  return new RecordedBillingCloseOutError("The closeout could not be confirmed. Retry this unchanged request; do not create another invoice or bill again.", true);
}
export async function loadRecordedBillingEvidence(workOrderId: string, signal?: AbortSignal) {
  const request = supabase().rpc("get_recorded_billing_closeout_v1", { p_work_order_id: workOrderId });
  const { data, error } = await (signal ? request.abortSignal(signal) : request);
  if (error) throw recordedBillingCloseOutError(error);
  if (data === null) return null;
  const evidence = recordedBillingEvidenceSchema.parse(data);
  if (evidence.workOrderId !== workOrderId) throw new RecordedBillingCloseOutError("The billing evidence did not match this work order.");
  return evidence;
}
type Transport = (name: "reconcile_recorded_billing_closeout_v1", args: RecordedBillingCloseOutFunctions["reconcile_recorded_billing_closeout_v1"]["Args"])
  => PromiseLike<{ data: unknown; error: unknown }>;
export function createRecordedBillingCloseOutAttempt(input: unknown, confirmed: boolean, operationId = crypto.randomUUID()) {
  const evidence = recordedBillingEvidenceSchema.parse(input);
  if (!confirmed) throw new RecordedBillingCloseOutError(messages.RECORDED_BILLING_INVALID_INPUT);
  const args = Object.freeze({ ...lifecycleRpcContext({ workOrderId: evidence.workOrderId,
    expectedAssignmentVersion: evidence.assignmentVersion, expectedWorkflowCycle: evidence.workflowCycle,
    expectedLifecycleVersion: evidence.lifecycleVersion, operationId }), p_invoice_id: evidence.invoiceId,
    p_expected_invoice_version: evidence.invoiceVersion, p_billing_activity_id: evidence.billingActivityId, p_confirmed: true });
  return async (transport: Transport): Promise<RecordedBillingReceipt> => {
    try {
      const { data, error } = await transport("reconcile_recorded_billing_closeout_v1", args);
      if (error) throw error;
      const parsed = recordedBillingReceiptSchema.safeParse(data);
      if (!parsed.success) throw new RecordedBillingCloseOutError("The closeout response could not be verified. Retry this unchanged request.", true);
      const result = parsed.data;
      if (result.workOrderId !== evidence.workOrderId || result.operationId !== operationId
        || result.assignmentVersion !== evidence.assignmentVersion || result.workflowCycle !== evidence.workflowCycle
        || result.lifecycleVersion !== evidence.lifecycleVersion + 1 || result.invoiceId !== evidence.invoiceId
        || result.invoiceVersion !== evidence.invoiceVersion || result.invoiceNumber !== evidence.invoiceNumber
        || result.billingActivityId !== evidence.billingActivityId || result.billedAt !== evidence.billedAt) {
        throw new RecordedBillingCloseOutError("The closeout response could not be verified. Retry this unchanged request.", true);
      }
      return result;
    } catch (cause) { throw recordedBillingCloseOutError(cause); }
  };
}
export const runRecordedBillingCloseOutAttempt = (attempt: ReturnType<typeof createRecordedBillingCloseOutAttempt>) =>
  attempt((name, args) => supabase().rpc(name, args));
