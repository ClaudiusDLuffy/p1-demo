import { parseBillingCount, parseBillingRows, type BillingReadInput } from "../../features/billing/billingReadContracts";
import { loadCompactBillingRead, type CompactBillingReadPort } from "../../lib/server/billingCompactReads";
import type { CompactBillingRead } from "../../lib/server/billingCompactReadInput";

export type BillingReadRepository = {
  execute(input: Exclude<CompactBillingRead, { kind: "count" }>, signal: AbortSignal): Promise<unknown>;
  count(input: BillingReadInput, signal: AbortSignal): Promise<{ totalCount: number }>;
  legacyPage(input: BillingReadInput, signal: AbortSignal): Promise<unknown>;
  legacyRows(input: BillingReadInput, signal: AbortSignal): Promise<unknown>;
};

export function createBillingReadRepository(client: CompactBillingReadPort, controller: boolean): BillingReadRepository {
  return {
    execute: (input, signal) => loadCompactBillingRead(client, controller, input, signal),
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
  };
}
