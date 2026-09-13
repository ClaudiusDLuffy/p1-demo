import { boundedReadRpc } from "../../lib/counts/readRpc";
import { parseInvoiceSummary, parseInvoiceLinePage } from "./invoiceReadContracts";
import { readCompleteInvoiceDocument, type InvoiceDocumentPurpose } from "./invoiceDocumentRead";

export async function readInvoiceSummary(id: string, signal?: AbortSignal) {
  const result = await boundedReadRpc("get_invoice_summary_v1", { p_invoice_id: id }, signal);
  return result === null ? null : parseInvoiceSummary(result);
}
export async function readInvoiceLines(id: string, version: number, cursor: string | null, signal: AbortSignal) {
  return parseInvoiceLinePage(await boundedReadRpc("list_invoice_lines_page_v1", {
    p_invoice_id: id, p_limit: 50, p_cursor: cursor, p_expected_version: version,
  }, signal));
}
export function readInvoiceDocument(id: string, purpose: InvoiceDocumentPurpose, signal: AbortSignal) {
  return readCompleteInvoiceDocument({ purpose, signal, summary: () => readInvoiceSummary(id, signal),
    page: (version, cursor) => readInvoiceLines(id, version, cursor, signal) });
}
