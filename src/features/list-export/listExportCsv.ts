import { escapeCsvCell } from "../../lib/csvSafety";
import { INV_STATE, STAFF_INV_STATE, PRIORITY, STATUS } from "../../lib/constants";
import { canonicalSevenElevenWorkOrderId } from "../../lib/workOrderIdentity";
import { LIST_EXPORT_BYTE_LIMIT, ListExportLimitError } from "./listExport";

function csv(headers: readonly string[], values: readonly (readonly unknown[])[]): string {
  const encoder = new TextEncoder();
  const lines: string[] = [];
  let size = 3; // UTF-8 BOM added by the download boundary.
  for (const row of [headers, ...values]) {
    const line = row.map(escapeCsvCell).join(",");
    size += encoder.encode(line).byteLength + 2;
    if (size > LIST_EXPORT_BYTE_LIMIT) throw new ListExportLimitError(
      "This CSV exceeds the 10 MB safe download limit. Narrow the filters and try again. No partial file was downloaded.");
    lines.push(line);
  }
  return lines.join("\r\n");
}
const record = (value: object): Record<string, unknown> => value as Record<string, unknown>;
const text = (value: unknown) => typeof value === "string" || typeof value === "number" ? String(value) : "";
const money = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value.toFixed(2) : "";
const label = (catalog: Readonly<Record<string, { label: string }>>, value: unknown) =>
  catalog[text(value)]?.label || text(value);

/** Allowlisted list columns only: no PDFs, storage paths, notes, provider IDs or profit data. */
export function workOrderListCsv(items: readonly object[]): string {
  return csv(["Portal work order", "7-Eleven work order", "Incident", "Store", "City", "State", "Summary",
    "Priority", "Portal status", "Functional status", "Technician", "Created", "Updated"], items.map(value => {
    const row = record(value); const id = text(row.id);
    return [id, canonicalSevenElevenWorkOrderId({ id, duplicateRootWorkOrderId: text(row.duplicateRootWorkOrderId) }),
      row.incidentId, row.store, row.city, row.storeState, row.summary,
      label(PRIORITY, row.priority), label(STATUS, row.status),
      row.functionalStatus, row.technicianOnJob, row.createdAt, row.updatedAt];
  }));
}

export function invoiceListCsv(items: readonly object[]): string {
  return csv(["Invoice number", "Portal work order", "7-Eleven work order", "Contractor", "Invoice type",
    "Document kind", "Status", "Invoice date", "Store", "Line count", "Subtotal", "Sales tax", "Total"], items.map(value => {
    const row = record(value); const id = text(row.workOrderId ?? row.wot);
    const type = text(row.invoiceType);
    return [row.num, id, row.externalWorkOrderId || id, row.contractorName, type, row.documentKind,
      label(type === "staff" ? STAFF_INV_STATE : INV_STATE, row.state),
      row.invoiceDate, row.storeNumber ?? row.store, row.lineCount, money(row.subtotal), money(row.salesTax), money(row.total)];
  }));
}
