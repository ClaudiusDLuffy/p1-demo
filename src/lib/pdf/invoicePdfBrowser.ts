import { readInvoicePdf } from "./invoicePdfDocument";
import { InvoicePdfBudget, InvoicePdfError } from "./invoicePdfBudget";
import { hasInvoicePdfSignature } from "./invoicePdfContent";
import type { InvoicePdfExtraction } from "./invoicePdfTypes";

/** One real worker belongs to one request: no global workerPort or fake-worker
 * fallback. Bounded text normalization still uses cooperative main-thread
 * checkpoints; terminating a worker cannot preempt that synchronous JS. */
export async function extractInvoiceDataFromPdf(data: Uint8Array,
  options: { signal?: AbortSignal; budget?: InvoicePdfBudget } = {}): Promise<InvoicePdfExtraction> {
  const budget = options.budget ?? new InvoicePdfBudget({ signal: options.signal });
  budget.checkBytes(data.byteLength);
  if (!hasInvoicePdfSignature(data)) throw new InvoicePdfError("PDF_INVALID_SIGNATURE");
  if (typeof Worker !== "function") throw new InvoicePdfError("PDF_PARSE_FAILED");
  const signal = options.signal ?? budget.signal;
  let worker: Worker | undefined;
  let pdfWorker: { destroy(): void } | undefined;
  let stopped: InvoicePdfError | undefined;
  let terminated = false;
  let succeeded = false;
  let fail: (error: InvoicePdfError) => void = () => undefined;
  const cancellation = new Promise<never>((_resolve, reject) => { fail = reject; });
  const terminate = () => {
    if (worker && !terminated) { terminated = true; worker.terminate(); }
  };
  const stop = (error: InvoicePdfError) => { stopped ??= error; terminate(); fail(stopped); };
  const abort = () => stop(new InvoicePdfError("REQUEST_ABORTED"));
  const workerFailed = () => stop(new InvoicePdfError("PDF_PARSE_FAILED"));
  const timer = setTimeout(() => stop(new InvoicePdfError("PDF_PARSE_TIMEOUT")), budget.remainingMs());
  signal?.addEventListener("abort", abort, { once: true });
  const run = async () => {
    const pdfjs = await budget.wait(import("pdfjs-dist/build/pdf.mjs"));
    if (stopped) throw stopped;
    budget.checkpoint();
    worker = new Worker(new URL("./invoicePdfBrowserWorker.ts", import.meta.url), { type: "module" });
    worker.addEventListener("error", workerFailed);
    worker.addEventListener("messageerror", workerFailed);
    // An explicit port uses PDF.js's supplied-port branch, which never chooses
    // its main-thread fake-worker implementation, even when worker startup fails.
    const ownedPdfWorker = new pdfjs.PDFWorker({ port: worker });
    pdfWorker = ownedPdfWorker;
    return readInvoicePdf(data, async () => ({ getDocument: parameters => pdfjs.getDocument({
      ...parameters, worker: ownedPdfWorker,
    }) }), { budget, signal });
  };
  try {
    // Attach rejection handlers before a pre-existing abort can reject; late
    // imports/provider settlement must not restart work or become unhandled.
    const outcome = Promise.race([run(), cancellation]);
    if (signal?.aborted) abort();
    const result = await outcome;
    budget.checkpoint();
    succeeded = true;
    return result;
  } catch (error: unknown) {
    throw error instanceof InvoicePdfError ? error : new InvoicePdfError("PDF_PARSE_FAILED", error);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
    worker?.removeEventListener("error", workerFailed);
    worker?.removeEventListener("messageerror", workerFailed);
    terminate();
    try { pdfWorker?.destroy(); }
    catch (error: unknown) {
      budget.recordCleanupFailure();
      if (succeeded) throw new InvoicePdfError("PDF_CLEANUP_FAILED", error);
    }
  }
}
