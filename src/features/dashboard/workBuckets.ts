export type DashboardWorkOrder = {
  id: string;
  status?: string | null;
  functionalStatus?: string | null;
  priority?: string | null;
  store?: string | null;
  summary?: string | null;
  description?: string | null;
  contractor?: string | null;
  hasUnreadNotes?: boolean | null;
  hasPendingSevenElevenSync?: boolean | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  isCapital?: boolean | null;
};

export type DashboardInvoice = {
  wot?: string | null;
  state?: string | null;
  invoiceType?: string | null;
};

export type DashboardPart = {
  workOrderId?: string | null;
  orderingResponsibility?: string | null;
  p1OrderStatus?: string | null;
};

export type DashboardBucketId =
  | "pending_submission"
  | "pending_approval"
  | "awaiting_parts"
  | "seven_eleven_updates"
  | "unassigned"
  | "p1_parts_to_order"
  | "pending_capital_completion";

export type DashboardBucket = {
  id: DashboardBucketId;
  label: string;
  description: string;
  workOrders: DashboardWorkOrder[];
};

const PRIORITY_ORDER: Record<string, number> = {
  p1: 0,
  p2: 1,
  p3: 2,
  p4: 3,
  p5: 4,
};

const time = (value: string | null | undefined) => {
  const parsed = value ? new Date(value).getTime() : 0;
  return Number.isFinite(parsed) ? parsed : 0;
};

const sortOperationalWork = (rows: DashboardWorkOrder[]) => [...rows].sort(
  (left, right) => {
    const priorityDifference = (PRIORITY_ORDER[left.priority || ""] ?? 99)
      - (PRIORITY_ORDER[right.priority || ""] ?? 99);
    if (priorityDifference) return priorityDifference;
    return time(right.updatedAt || right.createdAt)
      - time(left.updatedAt || left.createdAt);
  },
);

export function buildDashboardWorkBuckets({
  workOrders,
  invoices,
  parts,
}: {
  workOrders: DashboardWorkOrder[];
  invoices: DashboardInvoice[];
  parts: DashboardPart[];
}): DashboardBucket[] {
  const openWorkOrders = workOrders.filter(workOrder => workOrder.status !== "closed");
  const reviewWorkOrderIds = new Set(
    invoices
      .filter(invoice =>
        (invoice.invoiceType || "contractor") === "contractor"
        && ["submitted", "revised", "rejected"].includes(invoice.state || ""),
      )
      .map(invoice => invoice.wot)
      .filter((id): id is string => Boolean(id)),
  );
  const p1OrderWorkOrderIds = new Set(
    parts
      .filter(part =>
        part.orderingResponsibility === "p1"
        && part.p1OrderStatus === "requested",
      )
      .map(part => part.workOrderId)
      .filter((id): id is string => Boolean(id)),
  );

  const bucket = (
    id: DashboardBucketId,
    label: string,
    description: string,
    predicate: (workOrder: DashboardWorkOrder) => boolean,
  ): DashboardBucket => ({
    id,
    label,
    description,
    workOrders: sortOperationalWork(openWorkOrders.filter(predicate)),
  });

  return [
    bucket(
      "unassigned",
      "Unassigned",
      "New calls that still need a contractor assignment.",
      workOrder => workOrder.status === "unassigned",
    ),
    bucket(
      "pending_submission",
      "Pending 7-Eleven submission",
      "Contractor review is complete; P1 billing still needs to be prepared or submitted.",
      workOrder => ["pending_invoice", "pending_payment"].includes(workOrder.status || ""),
    ),
    bucket(
      "pending_approval",
      "Pending approvals",
      "Submitted, revised, or rejected contractor invoices still need a staff decision or correction.",
      workOrder => workOrder.status === "pending_approval"
        || reviewWorkOrderIds.has(workOrder.id),
    ),
    bucket(
      "awaiting_parts",
      "Awaiting parts",
      "Jobs paused for parts, kept separate from P1 procurement requests.",
      workOrder => workOrder.status === "parts"
        || workOrder.functionalStatus === "Awaiting Parts",
    ),
    bucket(
      "seven_eleven_updates",
      "Needing 7-Eleven updates",
      "Activity exists that has not yet been copied into the 7-Eleven portal.",
      workOrder => Boolean(workOrder.hasPendingSevenElevenSync),
    ),
    bucket(
      "p1_parts_to_order",
      "Parts P1 needs to order",
      "Contractor requests waiting for P1 purchasing action.",
      workOrder => p1OrderWorkOrderIds.has(workOrder.id)
        && !workOrder.isCapital
        && !["capital", "pending_capital_completion"].includes(workOrder.status || ""),
    ),
    bucket(
      "pending_capital_completion",
      "Pending capital completion",
      "Capital quotes sent to 7-Eleven with equipment work still in progress.",
      workOrder => workOrder.status === "pending_capital_completion",
    ),
  ];
}

export function dashboardWorkMatchesSearch(
  workOrder: DashboardWorkOrder,
  search: string,
): boolean {
  const query = search.trim().toLowerCase();
  if (!query) return true;
  return [
    workOrder.id,
    workOrder.store,
    workOrder.summary,
    workOrder.description,
    workOrder.functionalStatus,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase()
    .includes(query);
}
