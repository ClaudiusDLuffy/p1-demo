import { z } from "zod";
import type { StaffInvoiceSaveCommand } from "../../lib/staffInvoiceContracts";
import { FinancialRequestError } from "../../lib/financialHttpBoundary";
import { invalidBillingInputResult, readBillingInputData, type BillingInputRepositoryContext } from "./billingInputValidation";

export type BillingFinancialInputRequest = Pick<StaffInvoiceSaveCommand, "workOrderId" | "storeNumber" | "territory">;
export type BillingFinancialInputReadModel =
  | { kind: "standalone"; workOrderId: null }
  | {
    kind: "work_order"; workOrderId: string; duplicateRootWorkOrderId: string | null;
    assignmentVersion: number; workflowCycle: number; storeState: string | null;
  };
export interface BillingFinancialInputRepository {
  loadForSave(input: BillingFinancialInputRequest, context: BillingInputRepositoryContext): Promise<BillingFinancialInputReadModel>;
}

export const BILLING_FINANCIAL_INPUT_FIELDS = "id, duplicate_root_work_order_id, contractor_assignment_version, workflow_cycle, store_state";
const workOrderRow = z.object({
  id: z.string().min(1).max(120), duplicate_root_work_order_id: z.string().max(120).nullable(),
  contractor_assignment_version: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  workflow_cycle: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  store_state: z.string().max(200).nullable(),
});
type Read = PromiseLike<unknown>;
type Single = { maybeSingle(): Read };
type AbortableSingle = Single & { abortSignal(signal: AbortSignal): Single };
type Query = { eq(column: "id", value: string): AbortableSingle };
export type BillingFinancialInputDataSession = { from(table: "work_orders"): { select(fields: typeof BILLING_FINANCIAL_INPUT_FIELDS): Query } };

/** Tax, parts, numbering, final versions and financial policy remain SQL-owned. */
export function createBillingFinancialInputRepository(dataSession: BillingFinancialInputDataSession): BillingFinancialInputRepository {
  return {
    async loadForSave(input, context) {
      context.signal?.throwIfAborted();
      if (input.workOrderId === null) return { kind: "standalone", workOrderId: null };
      const query = dataSession.from("work_orders").select(BILLING_FINANCIAL_INPUT_FIELDS)
        .eq("id", input.workOrderId);
      // maybeSingle() narrows to PostgrestBuilder, whose supported public API
      // no longer exposes abortSignal. Bind cancellation before narrowing.
      const selected = context.signal ? query.abortSignal(context.signal) : query;
      const raw = await readBillingInputData(selected.maybeSingle(), context.signal);
      // SQL checks target existence before operation replay too. Preserve its
      // non-leaking P0002/404 semantics instead of inventing a standalone row.
      if (raw === null) throw new FinancialRequestError("FINANCIAL_NOT_FOUND", "The invoice or linked record was not found", 404);
      const parsed = workOrderRow.safeParse(raw);
      if (!parsed.success || parsed.data.id !== input.workOrderId) return invalidBillingInputResult();
      return {
        kind: "work_order", workOrderId: parsed.data.id,
        duplicateRootWorkOrderId: parsed.data.duplicate_root_work_order_id,
        assignmentVersion: parsed.data.contractor_assignment_version,
        workflowCycle: parsed.data.workflow_cycle, storeState: parsed.data.store_state,
      };
    },
  };
}
