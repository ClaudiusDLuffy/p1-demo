import { escapeCsvCell } from "../../lib/csvSafety";
import { PRIORITY, STATUS } from "../../lib/constants";
import type { WorkOrderReadModel } from "../work-orders/data/workOrderReadContracts";
import { nextActionLabel } from "./simplifiedWorkModel";
import { capitalProjectStage } from "../work-orders/capitalProjectStage";

const CSV_COLUMNS = [
  "Work order",
  "Store",
  "City",
  "Priority",
  "Portal status",
  "Functional status",
  "Capital status",
  "Technician",
  "ETA",
  "Next action",
] as const;

export function simplifiedWorkOrdersCsv(rows: readonly WorkOrderReadModel[]): string {
  const values = rows.map(workOrder => [
    workOrder.id,
    workOrder.store || "",
    workOrder.city || "",
    PRIORITY[workOrder.priority]?.label || workOrder.priority,
    STATUS[workOrder.status]?.label || workOrder.status,
    workOrder.functionalStatus || "",
    workOrder.isCapital || ["capital", "pending_capital_completion"].includes(workOrder.status)
      ? capitalProjectStage(workOrder).label : "",
    workOrder.technicianOnJob || "",
    workOrder.eta || "",
    nextActionLabel(workOrder),
  ]);

  return [CSV_COLUMNS, ...values]
    .map(row => row.map(escapeCsvCell).join(","))
    .join("\r\n");
}

export function downloadSimplifiedWorkOrders(rows: readonly WorkOrderReadModel[]): void {
  const url = URL.createObjectURL(new Blob([simplifiedWorkOrdersCsv(rows)], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = "p1-simplified-work-orders.csv";
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}
