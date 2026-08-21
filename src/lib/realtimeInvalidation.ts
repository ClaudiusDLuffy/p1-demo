export const REALTIME_INVALIDATION_BATCH_MS = 250;

export const PORTAL_REALTIME_TABLES = [
  "work_orders",
  "activities",
  "invoices",
  "contractor_estimates",
  "photos",
  "wo_parts",
  "work_order_visits",
  "work_order_technician_assignments",
  "staff_work_order_todos",
  "staff_work_order_notification_reads",
] as const;

export type PortalRealtimeTable = (typeof PORTAL_REALTIME_TABLES)[number];

export type PortalRealtimeChange = {
  table: PortalRealtimeTable;
  eventType: "INSERT" | "UPDATE" | "DELETE" | string;
  new: Record<string, unknown>;
  old: Record<string, unknown>;
};

export type PortalRealtimeDataset =
  | "workOrders"
  | "workOrderDetails"
  | "invoices"
  | "billingInvoices"
  | "contractorEstimates"
  | "woParts"
  | "staffWorkTodos"
  | "staffNotificationReads";

const DATASETS_BY_TABLE: Record<PortalRealtimeTable, readonly PortalRealtimeDataset[]> = {
  work_orders: ["workOrders", "workOrderDetails"],
  activities: ["workOrders", "workOrderDetails"],
  invoices: ["invoices", "billingInvoices"],
  contractor_estimates: ["contractorEstimates"],
  photos: ["workOrderDetails"],
  wo_parts: ["woParts"],
  work_order_visits: ["workOrderDetails"],
  work_order_technician_assignments: ["workOrders", "workOrderDetails"],
  staff_work_order_todos: ["staffWorkTodos"],
  staff_work_order_notification_reads: ["staffNotificationReads"],
};

export function datasetsForRealtimeTables(
  tables: Iterable<PortalRealtimeTable>,
): PortalRealtimeDataset[] {
  const datasets = new Set<PortalRealtimeDataset>();
  for (const table of tables) {
    for (const dataset of DATASETS_BY_TABLE[table]) datasets.add(dataset);
  }
  return [...datasets];
}

export function workOrderIdFromRealtimeChange(
  change: PortalRealtimeChange,
): string | null {
  const nextRow = change.new || {};
  const previousRow = change.old || {};
  const value = change.table === "work_orders"
    ? nextRow.id ?? previousRow.id
    : nextRow.work_order_id ?? previousRow.work_order_id;
  return typeof value === "string" && value.length > 0 ? value : null;
}
