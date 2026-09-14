import { generateContractorBillManifestCsv, contractorBillPdfPath, type ContractorBillManifestItem } from "../../lib/contractorBillManifest";
import { canonicalSevenElevenWorkOrderId } from "../../lib/workOrderIdentity";
import { resolveQuickBooksEquipmentTag } from "../../lib/quickBooksEquipmentTags";
import type { ControllerExportDocumentInput } from "./exportDocumentRepository";

export type ControllerExportArchiveFormat = "reference_manifest_v2" | "legacy_saas_ant_v1";
export type ControllerExportSnapshot = {
  sources: readonly { invoiceId: string; updatedAt: string }[];
  pdfEntries: readonly { invoiceId: string; name: string }[];
  manifest: Uint8Array;
};
export const CONTROLLER_EXPORT_MANIFEST_NAME = "Contractor-bills-reference-manifest.csv";

/** Explicit date input: no hidden clock, operation identity, DB, or provider. */
export function archiveFilename(batchId: string, format: ControllerExportArchiveFormat, createdAt: string | Date): string {
  const date = createdAt instanceof Date ? createdAt : new Date(createdAt);
  const day = date.toISOString().slice(0, 10);
  return `${format === "reference_manifest_v2" ? "Contractor-Bills" : "Legacy-QuickBooks-Handoff"}-${day}-${batchId.slice(0, 12)}.zip`;
}
export function controllerExportObjectPath(batchId: string, createdAt: Date): string {
  return `${createdAt.toISOString().slice(0, 10)}/${batchId}.zip`;
}

/** Persisted source bindings remain SQL-owned; this is the exact package input. */
export function createExportSnapshot(inputs: readonly ControllerExportDocumentInput[]): ControllerExportSnapshot {
  const items: ContractorBillManifestItem[] = inputs.map(({ invoice, contractor, workOrder }) => {
    const externalWorkOrderId = invoice.workOrderId
      ? canonicalSevenElevenWorkOrderId(workOrder ?? invoice.workOrderId) : "";
    const sourcePdf = contractorBillPdfPath({ portalInvoiceId: invoice.id, contractorInvoiceNumber: invoice.num, externalWorkOrderId });
    return { portalInvoiceId: invoice.id, contractorInvoiceNumber: invoice.num,
      contractorName: contractor?.company || contractor?.name || "Unknown contractor", contractorEmail: contractor?.email ?? "",
      externalWorkOrderId, portalWorkOrderId: invoice.workOrderId ?? "", storeNumber: invoice.storeNumber ?? "",
      equipmentTag: resolveQuickBooksEquipmentTag(workOrder), invoiceDate: invoice.invoiceDate,
      serviceDate: invoice.serviceDate, dueDate: invoice.dueDate, subtotal: invoice.subtotal ?? 0,
      salesTax: invoice.salesTax ?? 0, total: invoice.total ?? 0, sourcePdf };
  });
  return {
    sources: inputs.map(({ invoice }) => ({ invoiceId: invoice.id, updatedAt: invoice.updatedAt })),
    pdfEntries: items.map(item => ({ invoiceId: item.portalInvoiceId, name: item.sourcePdf })),
    manifest: new TextEncoder().encode(`\uFEFF${generateContractorBillManifestCsv(items)}`),
  };
}
