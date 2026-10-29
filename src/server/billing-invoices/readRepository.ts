import { parseBillingCount, parseBillingRows, type BillingReadInput } from "../../features/billing/billingReadContracts";
import { loadCompactBillingRead, type CompactBillingReadPort } from "../../lib/server/billingCompactReads";
import type { CompactBillingRead } from "../../lib/server/billingCompactReadInput";
import { attachApplicableStaffInvoiceNteWaitFlags, loadStaffInvoiceNteWaitFlags, type NteApprovalWaitReadClient } from "./nteApprovalWaitFlags";
import { AppError } from "../../lib/errors/AppError";

export type BillingReadRepository = {
  execute(input: Exclude<CompactBillingRead, { kind: "count" }>, signal: AbortSignal): Promise<unknown>;
  count(input: BillingReadInput, signal: AbortSignal): Promise<{ totalCount: number }>;
  legacyPage(input: BillingReadInput, signal: AbortSignal): Promise<unknown>;
  legacyRows(input: BillingReadInput, signal: AbortSignal): Promise<unknown>;
  nteWaitFlags(invoiceIds: readonly string[], signal: AbortSignal): Promise<Map<string, boolean>>;
};

export function createBillingReadRepository(client: CompactBillingReadPort, controller: boolean): BillingReadRepository {
  return {
    execute: async (input, signal) => {
      const result = await loadCompactBillingRead(client, controller, input, signal);
      if (input.kind === "page") {
        if (!result || typeof result !== "object" || Array.isArray(result)
          || !Array.isArray((result as Record<string, unknown>).items)) throw new AppError("INTERNAL_ERROR");
        const page = result as Record<string, unknown> & { items: { id: string; invoiceType?: string | null }[] };
        const items = await attachApplicableStaffInvoiceNteWaitFlags(page.items,
          (invoiceIds, readSignal) => loadStaffInvoiceNteWaitFlags(
            client as unknown as NteApprovalWaitReadClient, invoiceIds, readSignal), signal);
        return { ...page, items };
      }
      if (input.kind === "summary") {
        if (!result || typeof result !== "object" || Array.isArray(result)
          || !("invoice" in result) || !result.invoice || typeof result.invoice !== "object" || Array.isArray(result.invoice)) {
          throw new AppError("INTERNAL_ERROR");
        }
        const invoice = (result as { invoice: { id: string; invoiceType?: string | null } }).invoice;
        const [annotated] = await attachApplicableStaffInvoiceNteWaitFlags([invoice],
          (invoiceIds, readSignal) => loadStaffInvoiceNteWaitFlags(
            client as unknown as NteApprovalWaitReadClient, invoiceIds, readSignal), signal);
        return { ...result, invoice: annotated };
      }
      return result;
    },
    count: async (input, signal) => {
      signal.throwIfAborted();
      const result = await client.rpc("count_staff_invoices_v1", {
        p_queue: input.queue, p_search: input.search, p_work_order_id: input.workOrderId,
      }).abortSignal(signal);
      signal.throwIfAborted();
      if (result.error) throw result.error;
      return parseBillingCount(result.data);
    },
    legacyPage: async (input, signal) => {
      signal.throwIfAborted();
      const result = await client.rpc("list_staff_invoices_page", {
        p_queue: input.queue, p_search: input.search, p_sort: input.sort, p_direction: input.direction,
        p_limit: input.limit, p_cursor: input.cursor, p_work_order_id: input.workOrderId,
      }).abortSignal(signal);
      signal.throwIfAborted();
      if (result.error) throw result.error;
      return parseBillingRows(result.data);
    },
    legacyRows: async (input, signal) => {
      signal.throwIfAborted();
      const result = await client.rpc("list_staff_invoices_rows_v1", {
        p_queue: input.queue, p_search: input.search, p_sort: input.sort, p_direction: input.direction,
        p_limit: input.limit, p_cursor: input.cursor, p_work_order_id: input.workOrderId,
      }).abortSignal(signal);
      signal.throwIfAborted();
      if (result.error) throw result.error;
      return parseBillingRows(result.data);
    },
    nteWaitFlags: (invoiceIds, signal) => loadStaffInvoiceNteWaitFlags(
      client as unknown as NteApprovalWaitReadClient, invoiceIds, signal),
  };
}
