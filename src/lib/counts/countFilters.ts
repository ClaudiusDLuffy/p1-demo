import type { InvoicePageParams, WorkOrderPageParams } from "../db";

export function workOrderCountFilters(params: WorkOrderPageParams): WorkOrderPageParams {
  // Preserve table mode, but presentation order/page position never creates a
  // new count query. Table and legacy history aggregates are distinct contracts.
  return Object.fromEntries(Object.entries(params).filter(([key]) => ![
    "limit", "cursor", "sort", "pendingFirst", "tableSortColumn", "tableSortDirection",
  ].includes(key)).concat(params.tableSortColumn ? [["tableSortColumn", "created"]] : []));
}
export function invoiceCountFilters(params: InvoicePageParams): InvoicePageParams {
  return { state: params.state || "all", search: params.search?.trim() || "", workOrderId: params.workOrderId || null };
}
