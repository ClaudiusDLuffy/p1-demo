import { AppError } from "../../lib/errors/AppError";
import type { CompleteInvoiceDocument, InvoiceLinePage, InvoiceSummary } from "./invoiceReadContracts";

export type InvoiceDocumentPurpose = "edit" | "source_import" | "pdf" | "csv";
export const MAX_COMPLETE_INVOICE_LINES = 1000;
export const MAX_COMPLETE_INVOICE_BYTES = 32 * 1024 * 1024;
/** Explicit editor/export boundary only. Ordinary detail and list reads must
 * never use this collector. A partial or mixed-version document never escapes. */
export async function readCompleteInvoiceDocument(input: {
  purpose: InvoiceDocumentPurpose; signal: AbortSignal;
  summary: () => Promise<InvoiceSummary | null>;
  page: (version: number, cursor: string | null) => Promise<InvoiceLinePage>;
  maxLines?: number;
}): Promise<CompleteInvoiceDocument | null> {
  input.signal.throwIfAborted();
  const summary = await input.summary();
  input.signal.throwIfAborted();
  if (!summary) return null;
  const maxLines = Math.min(MAX_COMPLETE_INVOICE_LINES, input.maxLines ?? MAX_COMPLETE_INVOICE_LINES);
  if (!Number.isSafeInteger(maxLines) || maxLines < 0 || summary.lineCount > maxLines) throw new AppError("PAYLOAD_TOO_LARGE");
  const lines: CompleteInvoiceDocument["lines"] = [];
  const seen = new Set<string>();
  const cursors = new Set<string>();
  let bytes = new TextEncoder().encode(JSON.stringify(summary)).byteLength;
  let cursor: string | null = null;
  // Even an empty document needs one version check; the header may change
  // between the summary and lines request.
  do {
    const page = await input.page(summary.invoiceVersion, cursor);
    input.signal.throwIfAborted();
    if (page.invoiceVersion !== summary.invoiceVersion) throw new AppError("STALE_VERSION");
    bytes += new TextEncoder().encode(JSON.stringify(page)).byteLength;
    if (bytes > MAX_COMPLETE_INVOICE_BYTES || lines.length + page.items.length > maxLines) throw new AppError("PAYLOAD_TOO_LARGE");
    for (const line of page.items) {
      if (line.invoiceId !== summary.id || seen.has(line.id)) throw new AppError("INTERNAL_ERROR");
      const previous = lines.at(-1);
      if (previous && (line.position < previous.position || (line.position === previous.position && line.id <= previous.id))) throw new AppError("INTERNAL_ERROR");
      seen.add(line.id); lines.push(line);
    }
    cursor = page.hasMore ? page.nextCursor : null;
    if (page.hasMore && (!cursor || cursors.has(cursor) || page.items.length === 0)) throw new AppError("INTERNAL_ERROR");
    if (cursor) cursors.add(cursor);
  } while (cursor);
  if (lines.length !== summary.lineCount) throw new AppError("STALE_VERSION");
  return { ...summary, projection: "complete_document", lines };
}

export function rejectPartialInvoiceDocument(value: unknown): void {
  if (value && typeof value === "object" && "projection" in value
    && value.projection !== "complete_document") throw new AppError("STALE_VERSION");
}
