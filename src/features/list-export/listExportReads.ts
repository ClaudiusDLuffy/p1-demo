import { loadInvoicesPage, loadWorkOrderFamily, type InvoicePageParams } from "../../lib/db";
import { readBillingRows } from "../billing/billingReads";
import type { BillingInvoicePageParams } from "../billing/billingReadContracts";
import { loadWorkOrdersPage } from "../work-orders/data/workOrderReadRepository";
import type { WorkOrderPageParams } from "../work-orders/data/workOrderReadContracts";
import { collectListExport } from "./listExport";
import { AppError } from "../../lib/errors/AppError";

/** Use the same scoped, paginated read boundaries as the visible lists. */
export function exportWorkOrderRows(params: WorkOrderPageParams, signal: AbortSignal, progress: (count: number) => void,
  exactWorkOrderId?: string | null) {
  if (exactWorkOrderId) return collectListExport(async () => ({
    items: await loadWorkOrderFamily(exactWorkOrderId, signal), hasMore: false, nextCursor: null,
  }), signal, progress);
  return collectListExport(cursor => loadWorkOrdersPage({ ...params, cursor, limit: 100 }, signal), signal, progress);
}
export function exportContractorInvoiceRows(params: InvoicePageParams, signal: AbortSignal, progress: (count: number) => void) {
  return collectListExport(cursor => loadInvoicesPage({ ...params, cursor, limit: 100 }, signal), signal, progress);
}
export function exportBillingInvoiceRows(params: BillingInvoicePageParams, signal: AbortSignal, progress: (count: number) => void) {
  return collectListExport(cursor => readBillingRows({ ...params, cursor, limit: 100 }, signal), signal, progress);
}
export function exportBillingBucketRows(bucket: string, params: Omit<BillingInvoicePageParams, "queue">,
  signal: AbortSignal, progress: (count: number) => void) {
  switch (bucket) {
    case "all": case "draft": case "submitted": case "sent":
      return exportBillingInvoiceRows({ ...params, queue: bucket }, signal, progress);
    default: throw new AppError("INVALID_REQUEST");
  }
}
