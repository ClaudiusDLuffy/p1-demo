import { z } from "zod";
import { AppError } from "../../../lib/errors/AppError";
import { normalizeUnknownError } from "../../../lib/errors/normalizeUnknown";

const MAX_WORK_ORDERS = 100;
const PAGE_SIZE = 500;
const MAX_FLAG_ROWS = 5_000;

const workOrderIdSchema = z.string().min(1).max(128);
const flagRowsSchema = z.array(z.strictObject({
  invoices: z.strictObject({ work_order_id: workOrderIdSchema }),
})).max(PAGE_SIZE);

type ReadResult = { data: unknown; error: unknown };
type NteFlagSelect = {
  eq(column: "waiting_on_nte_approval", value: true): NteFlagSelect;
  in(column: "invoices.work_order_id", values: string[]): NteFlagSelect;
  order(column: "invoice_id", options: { ascending: true }): NteFlagSelect;
  range(from: number, to: number): NteFlagSelect;
  abortSignal(signal: AbortSignal): PromiseLike<ReadResult>;
};
export type WorkOrderNteWaitIndicatorClient = {
  from(table: "staff_invoice_nte_wait_flags"): {
    select(columns: "invoices!inner(work_order_id)"): NteFlagSelect;
  };
};

/** Read only the flagged work-order IDs needed by the visible list page. RLS
 * on the existing NTE flag table limits this query to active P1 staff. */
export async function loadWorkOrderNteWaitIndicatorIds(
  client: WorkOrderNteWaitIndicatorClient,
  requestedIds: readonly string[],
  signal: AbortSignal,
): Promise<string[]> {
  if (requestedIds.length > MAX_WORK_ORDERS
    || requestedIds.some(id => !workOrderIdSchema.safeParse(id).success)
    || new Set(requestedIds).size !== requestedIds.length) {
    throw new AppError("INVALID_REQUEST");
  }
  if (requestedIds.length === 0) return [];

  signal.throwIfAborted();
  const requested = new Set(requestedIds);
  const waitingWorkOrders = new Set<string>();

  for (let offset = 0; offset < MAX_FLAG_ROWS; offset += PAGE_SIZE) {
    const { data, error } = await client.from("staff_invoice_nte_wait_flags")
      .select("invoices!inner(work_order_id)")
      .eq("waiting_on_nte_approval", true)
      .in("invoices.work_order_id", [...requested])
      .order("invoice_id", { ascending: true })
      .range(offset, offset + PAGE_SIZE - 1)
      .abortSignal(signal);
    signal.throwIfAborted();
    if (error) throw normalizeUnknownError(error);

    const parsed = flagRowsSchema.safeParse(data);
    if (!parsed.success) throw new AppError("INTERNAL_ERROR");
    for (const row of parsed.data) {
      const workOrderId = row.invoices.work_order_id;
      if (!requested.has(workOrderId)) throw new AppError("INTERNAL_ERROR");
      waitingWorkOrders.add(workOrderId);
    }
    if (parsed.data.length < PAGE_SIZE) return [...waitingWorkOrders].sort();
  }

  // Fail closed rather than silently omit indicators if a pathological page
  // exceeds the bounded marker scan.
  throw new AppError("INTERNAL_ERROR");
}
