export const CAPITAL_PROJECT_FILTERS = [
  { value: "all", label: "All capital statuses" },
  { value: "capital_waiting_quote", label: "Waiting for quote" },
  { value: "capital_quote_submitted", label: "Quote submitted — pending capital approval" },
  { value: "capital_work_authorized", label: "Approved — work authorized" },
  { value: "capital_equipment_ordered", label: "Equipment ordered — waiting for equipment" },
  { value: "capital_equipment_received", label: "Equipment received" },
  { value: "capital_installation_scheduled", label: "Installation scheduled" },
  { value: "capital_installed", label: "Installed" },
] as const;

export type CapitalProjectFilter = typeof CAPITAL_PROJECT_FILTERS[number]["value"];

type CapitalProjectLike = {
  status?: string | null;
  capitalStatus?: string | null;
};

export type CapitalProjectStage = {
  filter: Exclude<CapitalProjectFilter, "all">;
  label: string;
  tone: "waiting" | "submitted" | "authorized" | "ordered" | "received" | "scheduled" | "installed";
};

export function capitalProjectStage(workOrder: CapitalProjectLike): CapitalProjectStage {
  switch (workOrder.capitalStatus) {
    case "Approved - work authorized":
      return { filter: "capital_work_authorized", label: "Approved — work authorized", tone: "authorized" };
    case "Equipment ordered":
      return { filter: "capital_equipment_ordered", label: "Equipment ordered — waiting for equipment", tone: "ordered" };
    case "Equipment received":
      return { filter: "capital_equipment_received", label: "Equipment received", tone: "received" };
    case "Installation scheduled":
      return { filter: "capital_installation_scheduled", label: "Installation scheduled", tone: "scheduled" };
    case "Installed":
      return { filter: "capital_installed", label: "Installed", tone: "installed" };
    case "Pending approval":
      return { filter: "capital_quote_submitted", label: "Quote submitted — pending capital approval", tone: "submitted" };
    default:
      return workOrder.status === "pending_capital_completion"
        ? { filter: "capital_quote_submitted", label: "Quote submitted — pending capital approval", tone: "submitted" }
        : { filter: "capital_waiting_quote", label: "Waiting for quote", tone: "waiting" };
  }
}

