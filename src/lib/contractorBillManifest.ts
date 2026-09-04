import { escapeCsvCell } from "./csvSafety";

export type ContractorBillManifestItem = {
  portalInvoiceId: string;
  contractorInvoiceNumber: string;
  contractorName: string;
  contractorEmail?: string | null;
  externalWorkOrderId?: string | null;
  portalWorkOrderId?: string | null;
  storeNumber?: string | null;
  equipmentTag?: string | null;
  invoiceDate?: string | null;
  serviceDate?: string | null;
  dueDate?: string | null;
  subtotal: number;
  salesTax: number;
  total: number;
  sourcePdf: string;
};

const HEADERS = [
  "Reference Only",
  "Portal Invoice ID",
  "Contractor Invoice Number",
  "Contractor",
  "Contractor Email",
  "7-Eleven Work Order",
  "P1 Portal Work Order",
  "Store",
  "Equipment Tag",
  "Invoice Date",
  "Service Date",
  "Due Date",
  "Subtotal",
  "Sales Tax",
  "Total",
  "Source PDF",
] as const;

const REFERENCE_ONLY_NOTICE = "Not a QuickBooks import file";

const money = (value: number) => Number(value || 0).toFixed(2);

const MAX_FILENAME_TOKEN_LENGTH = 64;

const filenameToken = (value: unknown, fallback: string) => {
  const token = String(value || "")
    .trim()
    .replace(/[^a-z0-9_-]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_FILENAME_TOKEN_LENGTH)
    .replace(/-+$/g, "");
  return token || fallback;
};

export function contractorBillPdfPath({
  portalInvoiceId,
  contractorInvoiceNumber,
  externalWorkOrderId,
}: Pick<
  ContractorBillManifestItem,
  "portalInvoiceId" | "contractorInvoiceNumber" | "externalWorkOrderId"
>): string {
  return [
    "Contractor-Bill-PDFs/Invoice",
    filenameToken(contractorInvoiceNumber, "Invoice"),
    filenameToken(externalWorkOrderId, "Standalone"),
    filenameToken(portalInvoiceId, "Portal-record"),
  ].join("-") + ".pdf";
}

export function generateContractorBillManifestCsv(
  items: ContractorBillManifestItem[],
): string {
  if (items.length === 0) {
    throw new Error("No contractor bills are available for the manifest");
  }

  const rows = items.map(item => [
    REFERENCE_ONLY_NOTICE,
    item.portalInvoiceId,
    item.contractorInvoiceNumber,
    item.contractorName,
    item.contractorEmail || "",
    item.externalWorkOrderId || "",
    item.portalWorkOrderId || "",
    item.storeNumber || "",
    item.equipmentTag || "",
    item.invoiceDate || "",
    item.serviceDate || "",
    item.dueDate || "",
    money(item.subtotal),
    money(item.salesTax),
    money(item.total),
    item.sourcePdf,
  ]);

  return [HEADERS, ...rows]
    .map(row => row.map(escapeCsvCell).join(","))
    .join("\r\n");
}
