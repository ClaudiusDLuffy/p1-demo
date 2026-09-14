import { supabase } from "./supabase/client";
import { InvoicePdfBudget, InvoicePdfError } from "./pdf/invoicePdfBudget";
import { hasInvoicePdfSignature } from "./pdf/invoicePdfContent";
import type { InvoiceLineExtraction, InvoicePdfExtraction } from "./pdf/invoicePdfTypes";

export type ParsedInvoiceLine = InvoiceLineExtraction;
export type ParsedInvoicePdf = InvoicePdfExtraction;

export type InvoicePdfClientOptions = { signal?: AbortSignal };

async function readPdfBytes(stream: ReadableStream<unknown>, budget: InvoicePdfBudget): Promise<Uint8Array> {
  const reader = stream.getReader();
  // One fixed allocation bounds retained memory even if a stream emits millions
  // of tiny chunks. Never retain provider-owned chunk objects between reads.
  const buffer = new Uint8Array(budget.limits.maxBytes);
  let length = 0;
  const cancel = () => { void reader.cancel().catch(() => undefined); };
  budget.signal?.addEventListener("abort", cancel, { once: true });
  try {
    for (;;) {
      const next = await budget.wait(reader.read());
      if (next.done) break;
      if (!(next.value instanceof Uint8Array)) throw new InvoicePdfError("PDF_MALFORMED");
      if (next.value.byteLength === 0) continue;
      length += next.value.byteLength;
      budget.checkBytes(length);
      buffer.set(next.value, length - next.value.byteLength);
    }
    budget.checkBytes(length);
    const data = buffer.slice(0, length);
    if (!hasInvoicePdfSignature(data)) throw new InvoicePdfError("PDF_INVALID_SIGNATURE");
    return data;
  } finally {
    cancel();
    budget.signal?.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}

async function parseBytes(data: Uint8Array, budget: InvoicePdfBudget): Promise<ParsedInvoicePdf> {
  const { extractInvoiceDataFromPdf } = await budget.wait(import("./pdf/invoicePdfBrowser"));
  budget.checkpoint();
  return extractInvoiceDataFromPdf(data, { signal: budget.signal, budget });
}

export async function parseInvoicePdf(file: File, options: InvoicePdfClientOptions = {}): Promise<ParsedInvoicePdf> {
  const budget = new InvoicePdfBudget(options);
  budget.checkpoint();
  if (file.size === 0) throw new Error("PDF file is empty");
  if (file.size > 5 * 1024 * 1024) throw new Error("PDF must be 5 MB or smaller");
  if (!file.name || file.name.length > 255 || file.type.length > 128) {
    throw new InvoicePdfError("PDF_PARSE_FAILED");
  }

  try { return await parseBytes(await readPdfBytes(file.stream(), budget), budget); }
  catch (error: unknown) { throw error instanceof InvoicePdfError ? error : new InvoicePdfError("PDF_PARSE_FAILED", error); }
}

export async function parseStoredInvoicePdf(storagePath: string, options: InvoicePdfClientOptions = {}): Promise<ParsedInvoicePdf> {
  const controller = new AbortController();
  const budget = new InvoicePdfBudget({ signal: controller.signal });
  let timedOut = false;
  const abort = () => controller.abort();
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, budget.remainingMs());
  try {
    budget.checkpoint();
    // The installed SDK forwards the signal and exposes the response stream;
    // do not materialize an unbounded legacy object with download().blob().
    const { data, error } = await budget.wait(supabase().storage.from("invoice-pdfs")
      .download(storagePath, {}, { signal: controller.signal }).asStream());
    if (error || !data) throw new InvoicePdfError("PDF_PARSE_FAILED");
    return await parseBytes(await readPdfBytes(data, budget), budget);
  } catch (error: unknown) {
    if (timedOut || error instanceof InvoicePdfError && error.code === "PDF_PARSE_TIMEOUT") {
      controller.abort();
      throw new InvoicePdfError("PDF_PARSE_TIMEOUT");
    }
    if (options.signal?.aborted) throw new InvoicePdfError("REQUEST_ABORTED");
    throw error instanceof InvoicePdfError ? error : new InvoicePdfError("PDF_PARSE_FAILED", error);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
  }
}

export const parseInvoicePdfTotal = parseInvoicePdf;
