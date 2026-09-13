import { z } from "zod";
import { FINANCIAL_MAX_SOURCES, type StaffInvoiceSaveCommand } from "../../lib/staffInvoiceContracts";
import { FinancialRequestError } from "../../lib/financialHttpBoundary";
import { invalidBillingInputResult, readBillingInputData, type BillingInputRepositoryContext } from "./billingInputValidation";

export type BillingSourceLoadRequest = Pick<StaffInvoiceSaveCommand, "workOrderId" | "sourceInvoiceIds">;
export type BillingSourceReadModel = { sourceInvoiceIds: readonly string[] };
export interface BillingSourceRepository {
  loadForSave(input: BillingSourceLoadRequest, context: BillingInputRepositoryContext): Promise<BillingSourceReadModel>;
}

export const BILLING_SOURCE_QUERY_LIMIT = FINANCIAL_MAX_SOURCES;
export const BILLING_SOURCE_FIELDS = "id, work_order_id, invoice_type, state, deleted_at";
const requestedIds = z.array(z.string().uuid()).max(BILLING_SOURCE_QUERY_LIMIT)
  .refine(ids => new Set(ids).size === ids.length);
const sourceRows = z.array(z.object({
  id: z.string().uuid(), work_order_id: z.string().min(1).max(120).nullable(),
  invoice_type: z.literal("contractor"),
  state: z.enum(["draft", "submitted", "approved", "rejected", "revised", "paid"]),
  deleted_at: z.null(),
})).max(BILLING_SOURCE_QUERY_LIMIT);

type Read = PromiseLike<unknown> & { abortSignal(signal: AbortSignal): PromiseLike<unknown> };
type Ordered = { order(column: "id", options: { ascending: boolean }): Read };
type Live = { is(column: "deleted_at", value: null): Ordered };
type Family = { eq(column: "invoice_type", value: "contractor"): Live };
type Selected = { in(column: "id", values: readonly string[]): Family };
export type BillingSourceDataSession = { from(table: "invoices"): { select(fields: typeof BILLING_SOURCE_FIELDS): Selected } };

/** One primary-key-bounded query for at most 100 sources; zero for an empty set.
 * SQL owns live eligibility and resolves operation replay before eligibility.
 * A valid missing source therefore must not become an application-level 500.
 */
export function createBillingSourceRepository(dataSession: BillingSourceDataSession): BillingSourceRepository {
  return {
    async loadForSave(input, context) {
      context.signal?.throwIfAborted();
      const request = requestedIds.safeParse(input.sourceInvoiceIds);
      if (!request.success) throw new FinancialRequestError("FINANCIAL_VALIDATION_FAILED", "Financial source selection is invalid", 422);
      if (!request.data.length) return { sourceInvoiceIds: [] };
      const query = dataSession.from("invoices").select(BILLING_SOURCE_FIELDS)
        .in("id", request.data).eq("invoice_type", "contractor").is("deleted_at", null)
        .order("id", { ascending: true });
      const raw = await readBillingInputData(context.signal ? query.abortSignal(context.signal) : query, context.signal);
      const parsed = sourceRows.safeParse(raw);
      if (!parsed.success) return invalidBillingInputResult();
      const ids = parsed.data.map(row => row.id);
      const requested = new Set(request.data.map(id => id.toLowerCase()));
      if (new Set(ids.map(id => id.toLowerCase())).size !== ids.length
        || ids.some(id => !requested.has(id.toLowerCase()))) return invalidBillingInputResult();
      // The wire order is not trusted even when an ORDER BY was requested.
      return { sourceInvoiceIds: ids.sort() };
    },
  };
}
