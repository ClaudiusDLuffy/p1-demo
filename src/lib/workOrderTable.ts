export const WORK_ORDER_TABLE_COLUMNS = [
  "work_order",
  "status",
  "priority",
  "incident",
  "store",
  "summary",
  "contractor",
  "created",
  "updated",
  "sla",
] as const;

export type WorkOrderTableColumn = typeof WORK_ORDER_TABLE_COLUMNS[number];
export type WorkOrderTableDirection = "asc" | "desc";

export type WorkOrderTableSort = {
  column: WorkOrderTableColumn;
  direction: WorkOrderTableDirection;
};

export type WorkOrderColumnFilters = Partial<Record<
  "workOrder" | "status" | "priority" | "incident" | "store" | "summary"
    | "contractor" | "createdDate" | "updatedDate" | "sla",
  string
>>;

export type WorkOrderTableRow = {
  // Some shared view helpers deliberately describe only the fields they use,
  // while the concrete portal row still carries `id`. Keep the fallback
  // contract structural so those safely narrowed rows remain compatible.
  id?: string | null;
  status?: string | null;
  priority?: string | null;
  incidentId?: string | null;
  store?: string | null;
  summary?: string | null;
  contractor?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  responseBreachAt?: string | null;
  resolutionBreachAt?: string | null;
};

export function nextWorkOrderTableSort(
  current: WorkOrderTableSort,
  column: WorkOrderTableColumn,
): WorkOrderTableSort {
  if (current.column !== column) {
    return {
      column,
      direction: ["created", "updated"].includes(column) ? "desc" : "asc",
    };
  }
  return { column, direction: current.direction === "asc" ? "desc" : "asc" };
}

const text = (value: unknown) => String(value || "").trim().toLowerCase();
const includes = (value: unknown, filter: unknown) =>
  !text(filter) || text(value).includes(text(filter));

const time = (value: unknown, fallback: number) => {
  const parsed = new Date(String(value || "")).getTime();
  return Number.isFinite(parsed) ? parsed : fallback;
};

const priorityRank = (value: unknown) => {
  const match = text(value).match(/^p([1-5])$/);
  return match ? Number(match[1]) : 99;
};

export function filterAndSortWorkOrderTable<T extends WorkOrderTableRow>(
  rows: T[],
  filters: WorkOrderColumnFilters,
  sort: WorkOrderTableSort,
  contractorName: (id: string | null | undefined) => string = () => "",
): T[] {
  const filtered = rows.filter(workOrder => {
    if (!includes(workOrder.id, filters.workOrder)) return false;
    if (filters.status && filters.status !== "all" && workOrder.status !== filters.status) return false;
    if (filters.priority && filters.priority !== "all" && workOrder.priority !== filters.priority) return false;
    if (!includes(workOrder.incidentId, filters.incident)) return false;
    if (!includes(workOrder.store, filters.store)) return false;
    if (!includes(workOrder.summary, filters.summary)) return false;
    if (!includes(contractorName(workOrder.contractor), filters.contractor)) return false;
    if (filters.createdDate && String(workOrder.createdAt || "").slice(0, 10) !== filters.createdDate) return false;
    if (filters.updatedDate && String(workOrder.updatedAt || "").slice(0, 10) !== filters.updatedDate) return false;
    if (filters.sla === "overdue" && time(workOrder.resolutionBreachAt || workOrder.responseBreachAt, Infinity) >= Date.now()) return false;
    return true;
  });

  const value = (workOrder: T): string | number => {
    switch (sort.column) {
      case "work_order": return text(workOrder.id);
      case "status": return text(workOrder.status);
      case "priority": return priorityRank(workOrder.priority);
      case "incident": return text(workOrder.incidentId);
      case "store": return text(workOrder.store);
      case "summary": return text(workOrder.summary);
      case "contractor": return text(contractorName(workOrder.contractor));
      case "updated": return time(workOrder.updatedAt, 0);
      case "sla": return time(workOrder.responseBreachAt || workOrder.resolutionBreachAt, Infinity);
      default: return time(workOrder.createdAt, 0);
    }
  };

  return [...filtered].sort((left, right) => {
    const leftValue = value(left);
    const rightValue = value(right);
    const compared = typeof leftValue === "number" && typeof rightValue === "number"
      ? leftValue - rightValue
      : String(leftValue).localeCompare(String(rightValue), undefined, { numeric: true });
    if (compared !== 0) return sort.direction === "asc" ? compared : -compared;
    return String(left.id).localeCompare(String(right.id)) * (sort.direction === "asc" ? 1 : -1);
  });
}

export function hasWorkOrderColumnFilters(filters: WorkOrderColumnFilters): boolean {
  return Object.values(filters).some(value => value && value !== "all");
}
