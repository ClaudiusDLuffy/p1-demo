import { normalizeStaffBillingLineType } from "./staffBilling";
import { canonicalSevenElevenWorkOrderId } from "./workOrderIdentity";
import { escapeCsvCell } from "./csvSafety";

export type StaffInvoiceCsvLine = {
  type?: unknown;
  desc?: unknown;
  description?: unknown;
  qty?: unknown;
  rate?: unknown;
  amount?: unknown;
  isTaxable?: unknown;
  is_taxable?: unknown;
};

export type StaffInvoiceCsvInput = {
  num?: unknown;
  wot?: unknown;
  workOrderId?: unknown;
  externalWorkOrderId?: unknown;
  store?: unknown;
  storeNumber?: unknown;
  invoiceDate?: unknown;
  invoiceDateRaw?: unknown;
  serviceDate?: unknown;
  serviceDateRaw?: unknown;
  dueDate?: unknown;
  dueDateRaw?: unknown;
  terms?: unknown;
  taxRate?: unknown;
  tax_rate?: unknown;
  taxState?: unknown;
  tax_state?: unknown;
  territory?: unknown;
  equipmentTag?: unknown;
  equipment_tag?: unknown;
  lines?: StaffInvoiceCsvLine[];
};

export type StaffInvoiceCsvRow = {
  invoiceNumber: string;
  customer: string;
  subCustomer: string;
  terms: string;
  invoiceDate: string;
  serviceDate: string;
  dueDate: string;
  location: string;
  shippingTo: string;
  storeNumber: string;
  memo: string;
  messageOnInvoice: string;
  workOrderNumber: string;
  productService: string;
  description: string;
  quantity: number;
  rate: number;
  amount: number;
  taxRate: string;
  equipmentTag: string;
  className: string;
};

const HEADERS = [
  "Invoice Number",
  "*Customer",
  "Sub Customer",
  "Terms",
  "*Invoice Date",
  "*Service Date",
  "Due Date",
  "Location",
  "Shipping To",
  "Store Number",
  "Memo",
  "Message on Invoice",
  "Work Order #",
  "*Product/Service",
  "Description",
  "Quantity",
  "Rate",
  "*Amount",
  "Tax Rate",
  "Equipment Tag",
  "Class",
] as const;

const roundMoney = (value: number) =>
  Math.round((value + Number.EPSILON) * 100) / 100;

const finiteNumber = (value: unknown) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const formatDate = (value: unknown) => {
  const raw = String(value || "").trim();
  if (!raw) return "";

  const iso = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (iso) return `${iso[2].padStart(2, "0")}/${iso[3].padStart(2, "0")}/${iso[1]}`;

  const us = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (us) return `${us[1].padStart(2, "0")}/${us[2].padStart(2, "0")}/${us[3]}`;

  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return raw;
  return `${String(date.getMonth() + 1).padStart(2, "0")}/${String(date.getDate()).padStart(2, "0")}/${date.getFullYear()}`;
};

const territoryFromState = (value: unknown) => {
  const state = String(value || "").trim().toUpperCase();
  if (state === "VA") return "Virginia";
  if (state === "TX") return "Texas";
  if (state === "FL") return "Florida";
  return "";
};

const taxRateText = (invoice: StaffInvoiceCsvInput, taxable: boolean) => {
  if (!taxable) return "";
  const raw = invoice.taxRate ?? invoice.tax_rate;
  if (raw === "" || raw == null) return "";
  const rate = finiteNumber(raw);
  if (rate <= 0) return "";
  const percent = rate <= 1 ? rate * 100 : rate;
  return `${Number(percent.toFixed(4))}%`;
};

const storeNumber = (invoice: StaffInvoiceCsvInput) =>
  String(invoice.store ?? invoice.storeNumber ?? "").trim();

function buildInvoiceCsvRows(
  invoice: StaffInvoiceCsvInput,
): StaffInvoiceCsvRow[] {
  const lines = invoice.lines || [];
  if (lines.length === 0) {
    throw new Error("No invoice line items are available to export");
  }

  const store = storeNumber(invoice);
  const shippingTo = store ? `7-ELEVEN STORE - ${store}` : "";
  const equipmentTag = String(
    invoice.equipmentTag ?? invoice.equipment_tag ?? "",
  ).trim();
  const invoiceNumber = String(invoice.num || "").trim();
  const workOrderNumber = String(
    canonicalSevenElevenWorkOrderId(
      String(
        invoice.externalWorkOrderId
          ?? invoice.wot
          ?? invoice.workOrderId
          ?? "",
      ),
    ),
  ).trim();
  const territory = String(invoice.territory || "").trim()
    || territoryFromState(invoice.taxState ?? invoice.tax_state);

  return lines.map((line, index) => {
    const quantity = Math.max(0, finiteNumber(line.qty));
    const rate = Math.max(0, finiteNumber(line.rate));
    const suppliedAmount = finiteNumber(line.amount);
    const lineAmount = roundMoney(
      suppliedAmount > 0 ? suppliedAmount : quantity * rate,
    );
    const taxable = Boolean(line.isTaxable ?? line.is_taxable);
    const first = index === 0;

    return {
      invoiceNumber,
      customer: first ? "7-Eleven Inc" : "",
      subCustomer: first ? shippingTo : "",
      terms: first ? String(invoice.terms || "Net 30").trim() : "",
      invoiceDate: first
        ? formatDate(invoice.invoiceDateRaw ?? invoice.invoiceDate)
        : "",
      serviceDate: first
        ? formatDate(invoice.serviceDateRaw ?? invoice.serviceDate)
        : "",
      dueDate: first
        ? formatDate(invoice.dueDateRaw ?? invoice.dueDate)
        : "",
      location: first ? territory : "",
      // SaasAnt uses Sub Customer for the store. Keep Shipping To blank so
      // QuickBooks cannot interpret a location string as a shipping charge.
      shippingTo: "",
      storeNumber: first ? store : "",
      memo: "",
      messageOnInvoice: "",
      workOrderNumber: first ? workOrderNumber : "",
      productService: normalizeStaffBillingLineType(line.type),
      description: String(line.desc ?? line.description ?? "").trim(),
      quantity,
      rate: roundMoney(rate),
      amount: lineAmount,
      taxRate: taxRateText(invoice, taxable),
      equipmentTag: first ? equipmentTag : "",
      className: "",
    };
  });
}

export function staffInvoiceCsvRows(
  invoice: StaffInvoiceCsvInput,
): StaffInvoiceCsvRow[] {
  return buildInvoiceCsvRows(invoice);
}

const numberText = (value: number) =>
  Number(value.toFixed(4)).toString();

const rowCells = (row: StaffInvoiceCsvRow) => [
  row.invoiceNumber,
  row.customer,
  row.subCustomer,
  row.terms,
  row.invoiceDate,
  row.serviceDate,
  row.dueDate,
  row.location,
  row.shippingTo,
  row.storeNumber,
  row.memo,
  row.messageOnInvoice,
  row.workOrderNumber,
  row.productService,
  row.description,
  numberText(row.quantity),
  numberText(row.rate),
  numberText(row.amount),
  row.taxRate,
  row.equipmentTag,
  row.className,
];

const generateCsv = (rows: StaffInvoiceCsvRow[]) =>
  [HEADERS, ...rows.map(rowCells)]
    .map(row => row
      .map(escapeCsvCell)
      .join(","))
    .join("\r\n");

export function generateStaffInvoiceCsv(invoice: StaffInvoiceCsvInput): string {
  return generateCsv(staffInvoiceCsvRows(invoice));
}

export function generateStaffInvoiceBatchCsv(
  invoices: StaffInvoiceCsvInput[],
): string {
  if (invoices.length === 0) {
    throw new Error("No invoices are available to export");
  }
  return generateCsv(invoices.flatMap(staffInvoiceCsvRows));
}

const filenameToken = (value: unknown, fallback: string) => {
  const token = String(value || "")
    .trim()
    .replace(/[^a-z0-9_-]+/gi, "-")
    .replace(/^-+|-+$/g, "");
  return token || fallback;
};

export function staffInvoiceCsvFilename(invoice: StaffInvoiceCsvInput): string {
  const num = filenameToken(invoice.num, "Draft");
  const workOrder = filenameToken(
    canonicalSevenElevenWorkOrderId(
      String(
        invoice.externalWorkOrderId
          || invoice.wot
          || invoice.workOrderId
          || "",
      ),
    ),
    "Standalone",
  );
  return `Invoice-${num}-${workOrder}.csv`;
}

const triggerCsvDownload = (csv: string, filename: string) => {
  const blob = new Blob(["\uFEFF", csv], {
    type: "text/csv;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
};

export function downloadStaffInvoiceCsv(invoice: StaffInvoiceCsvInput): void {
  triggerCsvDownload(
    generateStaffInvoiceCsv(invoice),
    staffInvoiceCsvFilename(invoice),
  );
}
