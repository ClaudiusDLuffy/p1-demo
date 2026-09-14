import type { InvoicePageParams, WorkOrderPageParams } from "../db";

export function workOrderCountFilters(params: WorkOrderPageParams): WorkOrderPageParams {
  // Presentation order/page position never creates a new count query. Any
  // table-only filters and scopes remain in the object and select table mode;
  // an otherwise equivalent preset sort can use the lighter generic count.
  return Object.fromEntries(Object.entries(params).filter(([key]) => ![
    "limit", "cursor", "sort", "pendingFirst", "tableSortColumn", "tableSortDirection",
  ].includes(key)));
}
export function invoiceCountFilters(params: InvoicePageParams): InvoicePageParams {
  return { state: params.state || "all", search: params.search?.trim() || "", workOrderId: params.workOrderId || null };
}
