import { escapeCsvCell } from "../../lib/csvSafety";
import type { ControllerExportHistoryPage } from "./historyRepository";

export function mapControllerExportHistory(page: ControllerExportHistoryPage) {
  const profiles = new Map(page.profiles.map(profile => [profile.id.toLowerCase(), profile]));
  const staffName = (id: string | null): string => {
    if (id === null) return "";
    const profile = profiles.get(id.toLowerCase());
    return profile?.name || profile?.company || "Unknown staff member";
  };
  const history = page.batches.map(batch => ({ ...batch,
    createdByName: staffName(batch.createdBy), confirmedByName: staffName(batch.confirmedBy),
    cancelledByName: staffName(batch.cancelledBy), items: page.items
      .filter(item => item.batchId.toLowerCase() === batch.id.toLowerCase())
      .map(item => {
        const profile = item.contractorId ? profiles.get(item.contractorId.toLowerCase()) : undefined;
        return { invoiceId: item.invoiceId, invoiceNumber: item.invoiceNumber, workOrderId: item.workOrderId,
          contractorId: item.contractorId, contractorName: profile?.company || profile?.name || "Unknown contractor", total: item.total };
      }) }));
  const actors = [...new Map(history.map(batch => [batch.createdBy, { id: batch.createdBy, name: batch.createdByName }])).values()];
  return { history, actors };
}
export type ControllerExportHistoryBody = ReturnType<typeof mapControllerExportHistory>;
export const CONTROLLER_EXPORT_CSV_HEADER = "\uFEFF" + ["Batch ID", "Status", "Created By", "Created At", "Confirmed By", "Confirmed At",
  "Cancelled By", "Cancelled At", "Invoice Number", "Work Order", "Contractor", "Invoice Amount", "Batch Total", "Cancellation Reason"]
  .map(escapeCsvCell).join(",") + "\r\n";

export function* controllerExportHistoryCsvRows(page: ControllerExportHistoryPage): Generator<string> {
  for (const batch of mapControllerExportHistory(page).history) {
    for (const item of batch.items) {
      yield [batch.id, batch.status, batch.createdByName, batch.createdAt, batch.confirmedByName, batch.confirmedAt || "",
        batch.cancelledByName, batch.cancelledAt || "", item.invoiceNumber, item.workOrderId || "", item.contractorName,
        item.total.toFixed(2), batch.total.toFixed(2), batch.cancellationReason || ""].map(escapeCsvCell).join(",") + "\r\n";
    }
  }
}
