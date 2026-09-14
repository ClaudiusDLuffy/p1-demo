import { AppError } from "../../lib/errors/AppError";
import { STAFF_BILLING_LINE_TYPES } from "../../lib/staffBilling";
import type { InvoiceLineSubtotalSummary } from "../../lib/invoiceLineSubtotals";

const headerStrings = {
  workOrderId: "work_order_id", externalWorkOrderId: "external_work_order_id", storeNumber: "store_number", contractorId: "contractor_id",
  invoiceType: "invoice_type", documentKind: "document_kind", sourceCapitalQuoteId: "source_capital_quote_id",
  invoiceDate: "invoice_date", territory: "territory", qboInvoiceId: "qbo_invoice_id",
  qboSyncedAt: "qbo_synced_at", paidAt: "paid_at", createdAt: "created_at", updatedAt: "updated_at",
  sourceStaffInvoiceId: "source_staff_invoice_id", paymentHoldAt: "payment_hold_at",
  submissionKey: "submission_key", storeAddress: "store_address", cme: "cme", serviceDate: "service_date",
  dueDate: "due_date", terms: "terms", equipmentTag: "equipment_tag", taxState: "tax_state",
  taxRateSource: "tax_rate_source", taxRateReferenceId: "tax_rate_reference_id", taxRateVerifiedAt: "tax_rate_verified_at",
  pdfStoragePath: "pdf_storage_path", rejectionReason: "rejection_reason", rejectedAt: "rejected_at",
  rejectedBy: "rejected_by", resubmittedAt: "resubmitted_at", resubmittedBy: "resubmitted_by",
  paymentHoldBy: "payment_hold_by", paymentHoldReason: "payment_hold_reason", contractorName: "contractor_name",
  originalPdfName: "original_pdf_name",
} as const;
type HeaderStrings = { -readonly [Key in keyof typeof headerStrings]?: string | null };
export type InvoiceSourceSummary = {
  id: string; num: string; state: string; total: number; subtotal: number; salesTax: number;
  invoiceVersion: number; workOrderId: string | null;
};
export type InvoiceSourceImportSummary = InvoiceSourceSummary & { lineCount: number };
export type InvoiceSummary = HeaderStrings & {
  projection: "summary"; id: string; num: string; state: string; total: number;
  subtotal: number; salesTax: number; invoiceVersion: number; reviewRevision: number;
  lineCount: number; sourceCount: number; contractorAssignmentVersion: number | null;
  workflowCycle: number | null; taxRate?: number | null; pdfIsOriginal?: boolean;
  lineTypeSummary?: InvoiceLineSubtotalSummary; sourceInvoiceIds?: string[];
  sourceInvoices?: InvoiceSourceSummary[];
  contractorCost?: number | null; grossProfit?: number | null; marginPercent?: number | null;
};
export type InvoiceLine = {
  id: string; invoiceId: string; position: number; type: string; description: string | null;
  qty: number; rate: number; amount: number; isTaxable: boolean;
  sourceInvoiceLineId: string | null; sourceWorkOrderPartId: string | null;
  sourceUnitCost: number | null; markupPercent: number | null;
};
export type InvoiceLinePage = {
  projection: "line_page"; items: InvoiceLine[]; invoiceVersion: number;
  pageSize: number; hasMore: boolean; nextCursor: string | null;
};
export type CompleteInvoiceDocument = Omit<InvoiceSummary, "projection"> & {
  projection: "complete_document"; lines: InvoiceLine[];
};
const invalid = (): never => { throw new AppError("INTERNAL_ERROR"); };
export function invoiceReadRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
  return value as Record<string, unknown>;
}
const text = (value: unknown, max = 204800): string => {
  if (typeof value !== "string" || value.length > max) return invalid();
  return value;
};
const nullableText = (value: unknown): string | null => value == null ? null : text(value);
const numeric = (value: unknown): number => {
  if (typeof value === "string" && !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value)) return invalid();
  if ((typeof value !== "number" && typeof value !== "string") || !Number.isFinite(Number(value))) return invalid();
  return Number(value);
};
const integer = (value: unknown, min = 0): number => {
  const number = numeric(value);
  return Number.isSafeInteger(number) && number >= min ? number : invalid();
};
const nullableNumber = (value: unknown): number | null => value == null ? null : numeric(value);
// Historical stored totals can be SQL NULL. Missing wire fields are malformed,
// however, and must not be presented as an authoritative zero.
const storedAmount = (value: unknown): number => value === null ? 0 : numeric(value);
const id = (value: unknown): string => text(value, 200) || invalid();
function assertJsonBudget(value: unknown): void {
  try {
    if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 204800) throw new AppError("PAYLOAD_TOO_LARGE");
  } catch (error) { if (error instanceof AppError) throw error; return invalid(); }
}

function parseSubtotal(value: unknown): InvoiceLineSubtotalSummary {
  const row = invoiceReadRecord(value);
  if (!Array.isArray(row.categories) || row.categories.length > 6) return invalid();
  const categories = row.categories.map(value => {
    const category = invoiceReadRecord(value);
    const kind = STAFF_BILLING_LINE_TYPES.find(type => type === category.category);
    if (!kind) return invalid();
    return { category: kind, label: text(category.label, 80), amount: numeric(category.amount), lineCount: integer(category.lineCount) };
  });
  if (new Set(categories.map(value => value.category)).size !== categories.length) return invalid();
  return { categories, subtotal: numeric(row.subtotal), salesTax: numeric(row.salesTax), grandTotal: numeric(row.grandTotal) };
}
function parseSource(value: unknown, raw: boolean): InvoiceSourceSummary {
  const row = invoiceReadRecord(value);
  return { id: id(row.id), num: text(row.num), state: text(row.state), total: storedAmount(row.total),
    subtotal: storedAmount(row.subtotal), salesTax: storedAmount(row[raw ? "sales_tax" : "salesTax"]),
    invoiceVersion: integer(row[raw ? "invoice_version" : "invoiceVersion"]),
    workOrderId: nullableText(row[raw ? "work_order_id" : "workOrderId"]) };
}
export function parseInvoiceSourceImportSummary(value: unknown): InvoiceSourceImportSummary {
  const row = invoiceReadRecord(value);
  return { ...parseSource(row, false), lineCount: integer(row.lineCount) };
}
function parseSummary(value: unknown, raw: boolean): InvoiceSummary {
  assertJsonBudget(value);
  const row = invoiceReadRecord(value);
  if (row.projection !== "summary") return invalid();
  const field = (camel: string, snake: string): unknown => row[raw ? snake : camel];
  const result: InvoiceSummary = {
    projection: "summary", id: id(row.id), num: text(row.num), state: text(row.state),
    total: storedAmount(row.total), subtotal: storedAmount(row.subtotal), salesTax: storedAmount(field("salesTax", "sales_tax")),
    invoiceVersion: integer(field("invoiceVersion", "invoice_version")),
    reviewRevision: integer(field("reviewRevision", "review_revision") ?? 1, 1),
    lineCount: integer(field("lineCount", "line_count")), sourceCount: integer(field("sourceCount", "source_count") ?? 0),
    contractorAssignmentVersion: nullableNumber(field("contractorAssignmentVersion", "contractor_assignment_version")),
    workflowCycle: nullableNumber(field("workflowCycle", "workflow_cycle")),
  };
  for (const key of Object.keys(headerStrings) as (keyof typeof headerStrings)[]) {
    const property = raw ? headerStrings[key] : key;
    if (Object.hasOwn(row, property)) result[key] = nullableText(row[property]);
  }
  const taxRate = field("taxRate", "tax_rate");
  if (taxRate !== undefined) result.taxRate = nullableNumber(taxRate);
  for (const [camel, snake] of [["contractorCost", "contractor_cost"], ["grossProfit", "gross_profit"], ["marginPercent", "margin_percent"]] as const) {
    const amount = field(camel, snake);
    if (amount !== undefined) result[camel] = nullableNumber(amount);
  }
  const original = field("pdfIsOriginal", "pdf_is_original");
  if (original !== undefined) {
    if (typeof original !== "boolean") return invalid();
    result.pdfIsOriginal = original;
  }
  const subtotal = field("lineTypeSummary", "line_type_summary");
  if (subtotal != null) result.lineTypeSummary = parseSubtotal(subtotal);
  const sourceIds = field("sourceInvoiceIds", "source_invoice_ids");
  if (sourceIds !== undefined) {
    if (!Array.isArray(sourceIds) || sourceIds.length > 100) return invalid();
    result.sourceInvoiceIds = sourceIds.map(id);
    if (new Set(result.sourceInvoiceIds).size !== result.sourceInvoiceIds.length) return invalid();
  }
  const sources = field("sourceInvoices", "source_invoices");
  if (sources !== undefined) {
    if (!Array.isArray(sources) || sources.length > 100) return invalid();
    result.sourceInvoices = sources.map(source => parseSource(source, raw));
  }
  return result;
}
/** SQL snake_case to the sole canonical, allowlisted wire projection. */
export const parseInvoiceSummary = (value: unknown): InvoiceSummary => parseSummary(value, true);
/** Browser/API validation does not preserve unknown fields or duplicate aliases. */
export const parseInvoiceSummaryDto = (value: unknown): InvoiceSummary => parseSummary(value, false);

export function parseInvoiceLinePage(value: unknown, raw = true): InvoiceLinePage {
  assertJsonBudget(value);
  const page = invoiceReadRecord(value);
  if (page.projection !== "line_page" || !Array.isArray(page.items) || page.items.length > 100
    || typeof page.hasMore !== "boolean" || (page.nextCursor !== null && typeof page.nextCursor !== "string")) return invalid();
  const items = page.items.map(value => {
    const row = invoiceReadRecord(value);
    const field = (camel: string, snake: string): unknown => row[raw ? snake : camel];
    if (typeof field("isTaxable", "is_taxable") !== "boolean") return invalid();
    const position = integer(row.position, -2147483648);
    if (position > 2147483647) return invalid();
    return { id: id(row.id), invoiceId: id(field("invoiceId", "invoice_id")), position,
      type: text(row.type), description: row.description == null ? null : text(row.description), qty: numeric(row.qty), rate: numeric(row.rate),
      amount: numeric(row.amount), isTaxable: field("isTaxable", "is_taxable") === true,
      sourceInvoiceLineId: nullableText(field("sourceInvoiceLineId", "source_invoice_line_id")),
      sourceWorkOrderPartId: nullableText(field("sourceWorkOrderPartId", "source_work_order_part_id")),
      sourceUnitCost: nullableNumber(field("sourceUnitCost", "source_unit_cost")),
      markupPercent: nullableNumber(field("markupPercent", "markup_percent")) };
  });
  const nextCursor = page.nextCursor == null ? null : text(page.nextCursor, 8192);
  const pageSize = integer(page.pageSize, 1);
  if (pageSize > 100 || items.length > pageSize || new Set(items.map(item => item.id)).size !== items.length
    || (page.hasMore ? !items.length || !nextCursor : nextCursor !== null)) return invalid();
  for (let index = 1; index < items.length; index++) {
    const before = items[index - 1]; const after = items[index];
    if (after.invoiceId !== before.invoiceId || after.position < before.position
      || (after.position === before.position && after.id <= before.id)) return invalid();
  }
  return { projection: "line_page", items, invoiceVersion: integer(page.invoiceVersion), pageSize,
    hasMore: page.hasMore, nextCursor };
}

/** Aliases exist only at legacy component boundaries, never in normal JSON. */
export function invoiceSummaryForLegacyUi(summary: InvoiceSummary) {
  const displayDate = (value: string | null | undefined) => {
    if (!value) return null;
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    return match ? `${match[2]}/${match[3]}/${match[1]}` : value;
  };
  const shortDate = summary.invoiceDate && /^(\d{4})-(\d{2})-(\d{2})$/.exec(summary.invoiceDate);
  const month = shortDate ? ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][Number(shortDate[2]) - 1] : null;
  return { ...summary, wot: summary.workOrderId ?? null, store: summary.storeNumber ?? null,
    storeAddr: summary.storeAddress ?? null, contractor: summary.contractorId ?? null,
    invoiceDateRaw: summary.invoiceDate ?? null, serviceDateRaw: summary.serviceDate ?? null,
    invoiceDate: displayDate(summary.invoiceDate), serviceDate: displayDate(summary.serviceDate), dueDate: displayDate(summary.dueDate),
    date: month && shortDate ? `${month} ${Number(shortDate[3])}` : summary.invoiceDate ?? "", reason: summary.rejectionReason ?? null,
    assignmentVersion: summary.contractorAssignmentVersion,
    documentKind: summary.documentKind === "capital_quote" ? "capital_quote" as const : "invoice" as const,
    sourceInvoices: summary.sourceInvoices?.map(source => ({ ...source, wot: source.workOrderId })) };
}
export function invoiceLineForLegacyUi(line: InvoiceLine) { return { ...line, desc: line.description ?? "" }; }
export function invoiceDocumentForLegacyUi(document: CompleteInvoiceDocument) {
  return { ...invoiceSummaryForLegacyUi({ ...document, projection: "summary" }),
    projection: "complete_document" as const, lines: document.lines.map(invoiceLineForLegacyUi) };
}
