import { runInvoicePdfProcess } from "./invoicePdfProcess";
import type { InvoicePdfExtraction, InvoiceTotalExtraction } from "./invoicePdfTypes";

// Node-only process dependency is a hard client-build boundary. Keep standalone
// Node callers compatible without the optional server-only marker package.
export async function extractInvoiceDataFromPdf(data: Uint8Array, options: {
  signal?: AbortSignal;
} = {}): Promise<InvoicePdfExtraction> {
  return (await runInvoicePdfProcess(data, options)).data;
}

export async function extractInvoiceTotalFromPdf(data: Uint8Array): Promise<InvoiceTotalExtraction> {
  const result = await extractInvoiceDataFromPdf(data);
  return { total: result.total, confidence: result.confidence, matchedLabel: result.matchedLabel };
}
