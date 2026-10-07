import { z } from "zod";
import { lifecycleContextFor } from "../../lib/workOrderLifecycleCommands";
import { lifecycleRpcContext, lifecycleResultSchema } from "../../lib/workOrderLifecycleContracts";
import { supabase } from "../../lib/supabase/client";
import type { Json } from "../../lib/supabase/database.types";

export type CapitalSelfServiceAction = "capital_external_handoff" | "capital_confirmed_completion" | "capital_quote_revision";
const common = { note: z.string().trim().min(5).max(1000).refine(value => !/[\u0000-\u001f\u007f]/.test(value)), confirmed: z.literal(true) };
export const capitalFieldsSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("capital_external_handoff"), ...common, reference: z.string().trim().min(1).max(120).refine(value => !/[\u0000-\u001f\u007f]/.test(value)) }).strict(),
  z.object({ action: z.literal("capital_confirmed_completion"), ...common }).strict(),
  z.object({ action: z.literal("capital_quote_revision"), ...common, quoteId: z.uuid(), invoiceVersion: z.number().int().nonnegative() }).strict(),
]);
export type CapitalSelfServiceFunctions = {
  run_capital_self_service_v1: { Args: ReturnType<typeof lifecycleRpcContext> & { p_action: string; p_payload: Json }; Returns: Json };
};
const extra = z.object({ action: z.enum(["capital_external_handoff", "capital_confirmed_completion", "capital_quote_revision"]),
  externalQuoteId: z.uuid().nullable(), invoiceId: z.uuid().nullable(), invoiceVersion: z.number().int().nonnegative().nullable() });
export const capitalReceiptSchema = z.intersection(lifecycleResultSchema, extra);
export type CapitalReceipt = z.infer<typeof capitalReceiptSchema>;
type Transport = (name: "run_capital_self_service_v1", args: CapitalSelfServiceFunctions["run_capital_self_service_v1"]["Args"])
  => PromiseLike<{ data: unknown; error: unknown }>;

export class CapitalSelfServiceError extends Error {
  constructor(message: string, readonly uncertain = false) { super(message); }
}
const safeMessages = new Set([
  "Clock out the active visit before completing capital work",
  "Submit the pending capital quote or revision before completion",
  "An approved capital quote is required before completion",
  "Record the capital quote handoff before confirming installation",
  "Review existing portal documents before recording an external capital quote",
  "Only a sent capital quote awaiting installation can be revised. Refresh and review existing documents.",
]);
export function capitalError(cause: unknown): CapitalSelfServiceError {
  if (cause instanceof CapitalSelfServiceError) return cause;
  if (cause instanceof z.ZodError) return new CapitalSelfServiceError("Confirm the facts and complete the required reference and audit note (5–1,000 characters).");
  const provider = z.object({ code: z.string().optional(), message: z.string().optional() }).safeParse(cause);
  if (provider.success) {
    if (safeMessages.has(provider.data.message || "")) return new CapitalSelfServiceError(provider.data.message!);
    if (provider.data.code === "42501") return new CapitalSelfServiceError("Only active operational staff can use this action.");
    if (["PT409", "23505"].includes(provider.data.code || "")) return new CapitalSelfServiceError("The record changed or this action was already recorded. Close this form and review the latest history.");
    if (["22023", "23514", "P0002"].includes(provider.data.code || "")) return new CapitalSelfServiceError("The current stage or documents are not eligible. Review the work order and quote before retrying.");
  }
  return new CapitalSelfServiceError("The save could not be confirmed. Retry this unchanged request; do not create another quote.", true);
}
export function createCapitalAttempt(workOrder: unknown, input: unknown, operationId = crypto.randomUUID()) {
  const context = lifecycleContextFor(workOrder, operationId);
  const { action, ...payload } = capitalFieldsSchema.parse(input);
  const args = { ...lifecycleRpcContext(context), p_action: action, p_payload: payload };
  return async (transport: Transport): Promise<CapitalReceipt> => {
    try {
      const { data, error } = await transport("run_capital_self_service_v1", args);
      if (error) throw error;
      const parsed = capitalReceiptSchema.safeParse(data);
      if (!parsed.success) throw new CapitalSelfServiceError("The save response could not be verified. Retry this unchanged request.", true);
      const result = parsed.data;
      if (result.workOrderId !== context.workOrderId || result.operationId !== operationId || result.action !== action
        || result.assignmentVersion !== context.expectedAssignmentVersion || result.workflowCycle !== context.expectedWorkflowCycle
        || result.lifecycleVersion !== context.expectedLifecycleVersion + 1
        || result.workOrderStatus !== (action === "capital_confirmed_completion" ? "pending_invoice" : "pending_capital_completion")
        || (action === "capital_quote_revision" && (!result.invoiceId || result.invoiceVersion == null))) {
        throw new CapitalSelfServiceError("The save response could not be verified. Retry this unchanged request.", true);
      }
      return result;
    } catch (cause) { throw capitalError(cause); }
  };
}
export const runCapitalAttempt = (attempt: ReturnType<typeof createCapitalAttempt>) =>
  attempt((name, args) => supabase().rpc(name, args));
