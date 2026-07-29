import { normalizeStaffBillingLineType } from "./staffBilling";

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
  salesTax?: unknown;
  sales_tax?: unknown;
  lines?: StaffInvoiceCsvLine[];
};

export type StaffInvoiceCsvRow = {
  lineItem: string;
  description: string;
  qty: number;
  rate: number;
  amount: number;
  taxable: boolean;
  tax: number;
  total: number;
};

type LineItemNormalizer = (value: unknown) => string;

const roundMoney = (value: number) =>
  Math.round((value + Number.EPSILON) * 100) / 100;

const finiteNumber = (value: unknown) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const moneyCents = (value: unknown) =>
  Math.max(0, Math.round(finiteNumber(value) * 100));

const allocateTaxCents = (rows: StaffInvoiceCsvRow[], taxCents: number) => {
  const allocations = rows.map(() => 0);
  const taxableIndexes = rows
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => row.taxable && row.amount > 0)
    .map(({ index }) => index);
  const taxableCents = taxableIndexes.reduce(
    (sum, index) => sum + moneyCents(rows[index].amount),
    0,
  );

  if (taxCents <= 0 || taxableIndexes.length === 0 || taxableCents <= 0) {
    return allocations;
  }

  let allocated = 0;
  taxableIndexes.forEach((rowIndex, taxableIndex) => {
    const isLast = taxableIndex === taxableIndexes.length - 1;
    const cents = isLast
      ? taxCents - allocated
      : Math.floor(
          taxCents * moneyCents(rows[rowIndex].amount) / taxableCents,
        );
    allocations[rowIndex] = cents;
    allocated += cents;
  });

  return allocations;
};

const preserveInvoiceLineType = (value: unknown) =>
  String(value || "").trim() || "Other";

function buildInvoiceCsvRows(
  invoice: StaffInvoiceCsvInput,
  normalizeLineItem: LineItemNormalizer,
): StaffInvoiceCsvRow[] {
  const rows: StaffInvoiceCsvRow[] = (invoice.lines || []).map(line => {
    const qty = Math.max(0, finiteNumber(line.qty));
    const rate = Math.max(0, finiteNumber(line.rate));
    const calculatedAmount = qty * rate;
    const suppliedAmount = finiteNumber(line.amount);
    const amount = roundMoney(
      suppliedAmount > 0 ? suppliedAmount : calculatedAmount,
    );

    return {
      lineItem: normalizeLineItem(line.type),
      description: String(line.desc ?? line.description ?? "").trim(),
      qty,
      rate: roundMoney(rate),
      amount,
      taxable: Boolean(line.isTaxable ?? line.is_taxable),
      tax: 0,
      total: amount,
    };
  });

  if (rows.length === 0) {
    throw new Error("No invoice line items are available to export");
  }

  const taxCents = moneyCents(invoice.salesTax ?? invoice.sales_tax);
  const allocations = allocateTaxCents(rows, taxCents);
  const allocatedTaxCents = allocations.reduce((sum, cents) => sum + cents, 0);

  const rowsWithTax = rows.map((row, index) => {
    const tax = allocations[index] / 100;
    return {
      ...row,
      tax,
      total: roundMoney(row.amount + tax),
    };
  });

  if (taxCents > allocatedTaxCents) {
    const tax = (taxCents - allocatedTaxCents) / 100;
    rowsWithTax.push({
      lineItem: "Sales Tax",
      description: "Invoice-level sales tax",
      qty: 1,
      rate: 0,
      amount: 0,
      taxable: false,
      tax,
      total: tax,
    });
  }

  return rowsWithTax;
}

export function invoiceCsvRows(
  invoice: StaffInvoiceCsvInput,
): StaffInvoiceCsvRow[] {
  return buildInvoiceCsvRows(invoice, preserveInvoiceLineType);
}

export function staffInvoiceCsvRows(
  invoice: StaffInvoiceCsvInput,
): StaffInvoiceCsvRow[] {
  return buildInvoiceCsvRows(invoice, normalizeStaffBillingLineType);
}

const protectSpreadsheetText = (value: string) =>
  /^[=+\-@]/.test(value) ? `'${value}` : value;

const escapeCsvCell = (value: string) => {
  const escaped = value.replace(/"/g, "\"\"");
  return /[",\r\n]/.test(escaped) ? `"${escaped}"` : escaped;
};

const quantityText = (value: number) =>
  Number(value.toFixed(4)).toString();

const generateCsv = (rows: StaffInvoiceCsvRow[]) => {
  const header = [
    "line item",
    "description",
    "qty",
    "rate",
    "amount",
    "taxable",
    "tax",
    "total",
  ];
  const cells = rows.map(row => [
    protectSpreadsheetText(row.lineItem),
    protectSpreadsheetText(row.description),
    quantityText(row.qty),
    row.rate.toFixed(2),
    row.amount.toFixed(2),
    row.taxable ? "Yes" : "No",
    row.tax.toFixed(2),
    row.total.toFixed(2),
  ]);

  return [header, ...cells]
    .map(row => row.map(escapeCsvCell).join(","))
    .join("\r\n");
};

export function generateInvoiceCsv(invoice: StaffInvoiceCsvInput): string {
  return generateCsv(invoiceCsvRows(invoice));
}

export function generateStaffInvoiceCsv(invoice: StaffInvoiceCsvInput): string {
  return generateCsv(staffInvoiceCsvRows(invoice));
}

const filenameToken = (value: unknown, fallback: string) => {
  const token = String(value || "")
    .trim()
    .replace(/[^a-z0-9_-]+/gi, "-")
    .replace(/^-+|-+$/g, "");
  return token || fallback;
};

export function invoiceCsvFilename(invoice: StaffInvoiceCsvInput): string {
  const num = filenameToken(invoice.num, "Draft");
  const workOrder = filenameToken(
    invoice.wot || invoice.workOrderId,
    "Standalone",
  );
  return `Invoice-${num}-${workOrder}.csv`;
}

export function staffInvoiceCsvFilename(invoice: StaffInvoiceCsvInput): string {
  return invoiceCsvFilename(invoice);
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

export function downloadInvoiceCsv(invoice: StaffInvoiceCsvInput): void {
  triggerCsvDownload(
    generateInvoiceCsv(invoice),
    invoiceCsvFilename(invoice),
  );
}

export function downloadStaffInvoiceCsv(invoice: StaffInvoiceCsvInput): void {
  triggerCsvDownload(
    generateStaffInvoiceCsv(invoice),
    staffInvoiceCsvFilename(invoice),
  );
}
