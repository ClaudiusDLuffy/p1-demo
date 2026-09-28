import type { WorkOrderPageParams, WorkOrderReadModel } from "../work-orders/data/workOrderReadContracts";

export type SimplifiedView = "unassigned" | "open" | "breached" | "capital" | "closed";

/** Filter at the existing read boundary, before pagination—not just the first 50 rows. */
export function simplifiedWorkQuery(
  view: SimplifiedView, status: string, search: string, contractorId: string | null,
): Omit<WorkOrderPageParams, "cursor" | "limit"> {
  const scopes = { unassigned: "dashboard_unassigned", open: "active", breached: "active", capital: "capital", closed: "history" } as const;
  return {
    scope: scopes[view], contractorId, search, status: view === "unassigned" ? "all" : status,
    sort: view === "breached" ? "sla_due" : "newest",
    ...(view === "breached" ? { slaFilter: "overdue" as const } : {}),
  };
}

const NEXT_ACTION_RULES: ReadonlyArray<{
  matches: (workOrder: WorkOrderReadModel) => boolean;
  label: string;
}> = [
  { matches: workOrder => workOrder.status === "unassigned", label: "Assign a contractor" },
  { matches: workOrder => Boolean(workOrder.hasPendingSevenElevenSync), label: "Send the latest update to 7-Eleven" },
  { matches: workOrder => Boolean(workOrder.hasPendingContractorAttention), label: "Review the contractor update" },
  { matches: workOrder => workOrder.status === "assigned" && !workOrder.eta, label: "Set an ETA" },
  { matches: workOrder => workOrder.status === "assigned", label: "Start field work" },
  { matches: workOrder => workOrder.status === "wip", label: "Continue field work" },
  { matches: workOrder => workOrder.status === "parts", label: "Track parts and return visit" },
  { matches: workOrder => workOrder.status === "capital", label: "Prepare or review the capital quote" },
  { matches: workOrder => workOrder.status === "pending_capital_completion", label: "Track approved capital work" },
  { matches: workOrder => workOrder.status === "completed", label: "Prepare invoice" },
  { matches: workOrder => workOrder.status === "pending_invoice", label: "Review invoicing status" },
  { matches: workOrder => workOrder.status === "pending_payment", label: "Track payment" },
  { matches: workOrder => workOrder.status === "pending_approval", label: "Review contractor bill" },
];

export function isResolutionBreached(workOrder: WorkOrderReadModel, now = Date.now()): boolean {
  if (!workOrder.resolutionBreachAt || ["completed", "closed"].includes(workOrder.status)) return false;
  const deadline = new Date(workOrder.resolutionBreachAt).getTime();
  return Number.isFinite(deadline) && deadline <= now;
}

export function nextActionLabel(workOrder: WorkOrderReadModel): string {
  return NEXT_ACTION_RULES.find(rule => rule.matches(workOrder))?.label || "Open work order";
}
