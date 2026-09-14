import { DEFAULT_INVOICE_PDF_LIMITS, InvoicePdfError, type InvoicePdfErrorCode } from "./invoicePdfBudget";
import type { InvoiceLineExtraction, InvoicePdfExtraction } from "./invoicePdfTypes";

// Closed, bounded child/parent protocol. No provider message, path or raw page
// text can cross this boundary. Success retains the existing public fields.
export const PDF_PROCESS_OUTPUT_BYTES = 2 * 1024 * 1024;
export type InvoicePdfProcessMetrics = {
  pages: number; rawItems: number; rawCharacters: number; normalizedRows: number;
  candidates: number; outputLines: number; elapsedMs: number;
  peakRssKiB: number; heapUsedBytes: number; cleanup: "complete";
};
export type InvoicePdfProcessResult = { data: InvoicePdfExtraction; metrics: InvoicePdfProcessMetrics };

const codes: readonly InvoicePdfErrorCode[] = [
  "REQUEST_ABORTED", "PDF_PARSE_TIMEOUT", "PDF_TOO_LARGE", "PDF_PAGE_LIMIT", "PDF_ITEM_LIMIT",
  "PDF_TEXT_LIMIT", "PDF_OUTPUT_LIMIT", "PDF_INVALID_SIGNATURE", "PDF_ENCRYPTED_UNSUPPORTED",
  "PDF_MALFORMED", "PDF_PARSE_FAILED", "PDF_CLEANUP_FAILED", "PDF_PARSE_BUSY",
];
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const number = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 1e12;
const confidence = (value: unknown): value is "high" | "medium" | "none" => value === "high" || value === "medium" || value === "none";
const text = (value: unknown, length: number): value is string => typeof value === "string" && value.length <= length;
const optionalText = (value: unknown, length: number): value is string | null => value === null || text(value, length);
const lineTypes: readonly string[] = ["Truck Charge", "Labor", "Parts/Hardware", "Shipping", "Other"];

function parseLine(value: unknown): InvoiceLineExtraction {
  if (!record(value) || typeof value.type !== "string" || !lineTypes.includes(value.type)
    || !text(value.desc, DEFAULT_INVOICE_PDF_LIMITS.maxDescriptionChars)
    || !number(value.qty) || !number(value.rate) || !number(value.amount)
    || (value.confidence !== "high" && value.confidence !== "medium")) throw new InvoicePdfError("PDF_PARSE_FAILED");
  // The closed membership check above establishes the existing domain union.
  const type = value.type as InvoiceLineExtraction["type"];
  return { type, desc: value.desc, qty: value.qty, rate: value.rate, amount: value.amount, confidence: value.confidence };
}

export function parseInvoicePdfProcessResult(value: unknown): InvoicePdfProcessResult {
  if (!record(value)) throw new InvoicePdfError("PDF_PARSE_FAILED");
  if (value.ok === false) {
    const code = codes.find(code => code === value.code);
    throw new InvoicePdfError(code ?? "PDF_PARSE_FAILED");
  }
  const data = value.data;
  const metrics = value.metrics;
  if (value.ok !== true || !record(data) || !record(metrics)
    || !(data.total === null || number(data.total)) || !confidence(data.confidence)
    || !optionalText(data.matchedLabel, 128) || !optionalText(data.invoiceNumber, 256)
    || !confidence(data.invoiceNumberConfidence) || !optionalText(data.matchedNumberLabel, 128)
    || !confidence(data.lineConfidence) || !Array.isArray(data.lines)
    || data.lines.length > DEFAULT_INVOICE_PDF_LIMITS.maxLines
    || metrics.cleanup !== "complete") throw new InvoicePdfError("PDF_PARSE_FAILED");
  const count = (name: string, max: number): number => {
    const result = metrics[name];
    if (!number(result) || result < 0 || result > max) throw new InvoicePdfError("PDF_PARSE_FAILED");
    return result;
  };
  return {
    data: {
      total: number(data.total) ? data.total : null, confidence: data.confidence, matchedLabel: data.matchedLabel,
      invoiceNumber: data.invoiceNumber, invoiceNumberConfidence: data.invoiceNumberConfidence,
      matchedNumberLabel: data.matchedNumberLabel, lines: data.lines.map(parseLine), lineConfidence: data.lineConfidence,
    },
    metrics: {
      pages: count("pages", DEFAULT_INVOICE_PDF_LIMITS.maxPages), rawItems: count("rawItems", DEFAULT_INVOICE_PDF_LIMITS.maxItems),
      rawCharacters: count("rawCharacters", DEFAULT_INVOICE_PDF_LIMITS.maxChars),
      normalizedRows: count("normalizedRows", DEFAULT_INVOICE_PDF_LIMITS.maxRows), candidates: count("candidates", DEFAULT_INVOICE_PDF_LIMITS.maxCandidates),
      outputLines: count("outputLines", DEFAULT_INVOICE_PDF_LIMITS.maxLines), elapsedMs: count("elapsedMs", DEFAULT_INVOICE_PDF_LIMITS.timeoutMs),
      peakRssKiB: count("peakRssKiB", 10_000_000), heapUsedBytes: count("heapUsedBytes", 1_000_000_000), cleanup: "complete",
    },
  };
}
