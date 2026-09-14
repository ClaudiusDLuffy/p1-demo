import { z } from "zod";
import { matchesFinancialUuid, parseStaffFinancialRpcResponse, type StaffFinancialCommandClient } from "../../lib/staffFinancialCommands";
import { FinancialRequestError } from "../../lib/financialHttpBoundary";
import type { StaffInvoiceSaveCommand } from "../../lib/staffInvoiceContracts";
import { executeBillingSaveCommand, type BillingSaveCommandResult } from "./billingSaveCommandRepository";
import { executeBillingAction } from "./billingCommandReconciliation";

export type BillingUpdateCommandContext = {
  actor: { userId: string }; dataSession: StaffFinancialCommandClient; signal: AbortSignal | null;
};
export type BillingUpdateCommandResult = BillingSaveCommandResult;
const readyResult = z.object({ invoiceId: z.string().uuid(), state: z.literal("submitted"), transitioned: z.boolean() });
const billedResult = z.object({
  applied: z.boolean(), reason: z.enum(["submitted", "billed", "already_submitted", "already_billed"]),
  invoiceId: z.string().uuid(), documentKind: z.enum(["invoice", "capital_quote"]),
  workOrderId: z.string().nullable(), transitioned: z.boolean(),
  // A legacy replay on a standalone invoice has SQL NULL comparisons here.
  workOrderClosed: z.boolean().nullable(), pendingCapitalCompletion: z.boolean().nullable(),
  workOrderStatus: z.enum(["unassigned", "assigned", "wip", "parts", "capital", "pending_capital_completion",
    "completed", "pending_invoice", "pending_approval", "pending_payment", "closed"]).nullable(),
  visitsClosed: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
}).superRefine((result, context) => {
  const replay = result.reason === "already_submitted" || result.reason === "already_billed";
  const quote = result.reason === "submitted" || result.reason === "already_submitted";
  if (result.applied === replay || quote !== (result.documentKind === "capital_quote")
    || (replay && (result.transitioned || result.visitsClosed !== 0))
    || (result.workOrderClosed === true && result.pendingCapitalCompletion === true)) {
    context.addIssue({ code: "custom", message: "Inconsistent billing action receipt" });
  }
});
export type BillingReadyResult = z.infer<typeof readyResult>;
export type BillingBilledResult = z.infer<typeof billedResult>;
export type BillingUpdateActionResult = BillingReadyResult | BillingBilledResult;
export interface BillingUpdateCommandRepository {
  save(command: StaffInvoiceSaveCommand, invoiceId: string, context: BillingUpdateCommandContext): Promise<BillingUpdateCommandResult>;
  action(action: "mark_ready" | "mark_billed", invoiceId: string,
    context: BillingUpdateCommandContext): Promise<BillingUpdateActionResult>;
}

export function createBillingUpdateCommandRepository(): BillingUpdateCommandRepository {
  return {
    save: (command, invoiceId, context) => executeBillingSaveCommand(context.dataSession, context.actor.userId,
      invoiceId, command, context.signal),
    action: (action, invoiceId, context) => executeBillingAction(async signal => {
      signal?.throwIfAborted();
      const query = context.dataSession.rpc(action === "mark_ready" ? "mark_staff_invoice_ready" : "mark_staff_invoice_billed",
        { p_invoice_id: invoiceId, p_actor_id: context.actor.userId });
      const result = parseStaffFinancialRpcResponse(await (signal ? query.abortSignal(signal) : query));
      if (result.error) throw result.error;
      const parsed = (action === "mark_ready" ? readyResult : billedResult).safeParse(result.data);
      if (!parsed.success || !matchesFinancialUuid(parsed.data.invoiceId, invoiceId)) {
        throw new FinancialRequestError("FINANCIAL_RESULT_INVALID",
          "The billing action result could not be verified. Check the invoice before retrying", 500);
      }
      return parsed.data;
    }, context.signal),
  };
}
