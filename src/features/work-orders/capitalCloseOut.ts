import { z } from "zod";
import { lifecycleContextFor } from "../../lib/workOrderLifecycleCommands";
import { lifecycleRpcContext, lifecycleResultSchema } from "../../lib/workOrderLifecycleContracts";
import { supabase } from "../../lib/supabase/client";
import type { Json } from "../../lib/supabase/database.types";

const version = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const reference = z.string().trim().max(100).refine(value => !/[\u0000-\u001f\u007f]/u.test(value));
export const capitalCloseOutFieldsSchema = z.object({
  outcome: z.enum(["billed", "send_to_billing"]), confirmed: z.literal(true),
  documentId: z.uuid().nullable(), invoiceVersion: version.nullable(), markQuoteSubmitted: z.boolean(),
  quoteReference: reference, invoiceReference: reference, billedOn: z.iso.date().nullable(),
}).strict().superRefine((value, context) => {
  if ((value.documentId === null) !== (value.invoiceVersion === null)
    || (value.outcome === "billed" && (!value.invoiceReference || !value.billedOn))
    || (value.outcome === "send_to_billing" && (value.invoiceReference || value.billedOn))) {
    context.addIssue({ code: "custom", message: "Confirm the outcome and its current document and billing evidence." });
  }
});
export type CapitalCloseOutOutcome = z.infer<typeof capitalCloseOutFieldsSchema>["outcome"];
export type CapitalCloseOutFunctions = {
  close_out_capital_v1: { Args: ReturnType<typeof lifecycleRpcContext> & { p_payload: Json }; Returns: Json };
};
export const capitalCloseOutReceiptSchema = z.intersection(lifecycleResultSchema, z.object({
  outcome: z.enum(["billed", "send_to_billing"]), documentId: z.uuid().nullable(), invoiceVersion: version.nullable(),
  invoiceCreated: z.literal(false), csvExported: z.literal(false),
}));
export type CapitalCloseOutReceipt = z.infer<typeof capitalCloseOutReceiptSchema>;
type Transport = (name: "close_out_capital_v1", args: CapitalCloseOutFunctions["close_out_capital_v1"]["Args"])
  => PromiseLike<{ data: unknown; error: unknown }>;

const messages: Record<string, string> = {
  CAPITAL_CLOSE_INVALID_INPUT: "Review the selected outcome, quote, and references before confirming.",
  CAPITAL_CLOSE_BILLING_REQUIRED: "Enter the existing invoice reference and actual billing date, no later than today (Miami time). Unbilled capitals must go to billing, not History.",
  CAPITAL_CLOSE_CAPITAL_ONLY: "This simplified closeout is only for capital jobs, not regular or billing-only work orders.",
  CAPITAL_CLOSE_OPEN_VISIT: "Record the active visit’s actual checkout before confirming completion.",
  CAPITAL_CLOSE_PENDING_UPDATES: "Resolve pending 7-Eleven updates and contractor attention items before closing as billed.",
  CAPITAL_CLOSE_UNRESOLVED_INVOICES: "Resolve outstanding contractor invoice reviews before closing as billed. You can still send completed work to billing.",
  CAPITAL_CLOSE_PENDING_REVISION: "Another unsubmitted capital quote or revision exists. Review it before confirming completion.",
  CAPITAL_CLOSE_SUBMISSION_REQUIRED: "Mark the actual quote submission in this form before confirming completion.",
  CAPITAL_CLOSE_PRIOR_CYCLE: "This document belongs to an earlier cycle or has conflicting submission history. Review the current quote; do not bill an older document again.",
  CAPITAL_CLOSE_REVIEW_DOCUMENTS: "A different P1 billing document exists. Select and review the correct document to avoid duplicate billing.",
  EXTERNAL_BILLING_PORTAL_INVOICE_EXISTS: "A final P1 invoice exists. Select that invoice instead of recording a second bill against the quote.",
};
export class CapitalCloseOutError extends Error {
  constructor(message: string, readonly uncertain = false) { super(message); }
}
export function capitalCloseOutError(cause: unknown): CapitalCloseOutError {
  if (cause instanceof CapitalCloseOutError) return cause;
  if (cause instanceof z.ZodError) return new CapitalCloseOutError(messages.CAPITAL_CLOSE_INVALID_INPUT);
  const provider = z.object({ message: z.string().optional(), code: z.string().optional() }).safeParse(cause);
  if (provider.success) {
    const known = messages[provider.data.message || ""];
    if (known) return new CapitalCloseOutError(known);
    if (provider.data.code === "42501") return new CapitalCloseOutError("Only active operational staff can close out capitals.");
    if (["PT409", "40001", "23505"].includes(provider.data.code || "")) return new CapitalCloseOutError("This record changed. Close the form, refresh, and review it before trying again.");
    if (["22023", "23514", "P0002"].includes(provider.data.code || "")) return new CapitalCloseOutError("The current documents are not eligible. Review the quote or invoice before trying again.");
    if (provider.data.code === "PGRST202") return new CapitalCloseOutError("The capital closeout database update is not installed in this environment yet.");
  }
  return new CapitalCloseOutError("The result could not be confirmed. Retry this unchanged request; do not create another invoice or import another CSV.", true);
}
export function createCapitalCloseOutAttempt(workOrder: unknown, input: unknown, operationId = crypto.randomUUID()) {
  const context = lifecycleContextFor(workOrder, operationId);
  const payload = capitalCloseOutFieldsSchema.parse(input);
  const args = { ...lifecycleRpcContext(context), p_payload: payload };
  return async (transport: Transport): Promise<CapitalCloseOutReceipt> => {
    try {
      const { data, error } = await transport("close_out_capital_v1", args);
      if (error) throw error;
      const receipt = capitalCloseOutReceiptSchema.safeParse(data);
      if (!receipt.success) throw new CapitalCloseOutError("The save response could not be verified. Retry this unchanged request.", true);
      const result = receipt.data;
      if (result.workOrderId !== context.workOrderId || result.operationId !== context.operationId
        || result.workflowCycle !== context.expectedWorkflowCycle || result.assignmentVersion !== context.expectedAssignmentVersion
        || result.lifecycleVersion <= context.expectedLifecycleVersion || result.outcome !== payload.outcome
        || result.documentId !== payload.documentId || (result.documentId === null) !== (result.invoiceVersion === null)
        || (payload.invoiceVersion !== null && (result.invoiceVersion === null || result.invoiceVersion < payload.invoiceVersion))
        || result.functionalStatus !== "Completed"
        || result.workOrderStatus !== (payload.outcome === "billed" ? "closed" : "pending_invoice")) {
        throw new CapitalCloseOutError("The save response could not be verified. Retry this unchanged request.", true);
      }
      return result;
    } catch (cause) { throw capitalCloseOutError(cause); }
  };
}
export const runCapitalCloseOutAttempt = (attempt: ReturnType<typeof createCapitalCloseOutAttempt>) =>
  attempt((name, args) => supabase().rpc(name, args));
