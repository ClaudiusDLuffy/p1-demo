import type { InvoicePdfExtraction, PositionedText } from "./invoicePdfTypes";
import { parseInvoicePdfPages } from "./invoicePdfTextParser";
import { InvoicePdfBudget, InvoicePdfError } from "./invoicePdfBudget";

// Only the text-loading capabilities we consume; both locked PDF.js builds
// satisfy this contract without casting their provider objects.
type PdfTextPage = {
  getTextContent?(): Promise<{ items: readonly unknown[] }>;
  streamTextContent?(): ReadableStream<{ items: readonly unknown[] }>;
  cleanup?(): boolean | void;
};
type PdfTextDocument = {
  numPages: number;
  getPage(pageNumber: number): Promise<PdfTextPage>;
};
type PdfJsLoader = () => Promise<{
  getDocument(options: {
    data: Uint8Array;
    disableFontFace: boolean;
    isEvalSupported: boolean;
    useSystemFonts: boolean;
  }): { promise: Promise<PdfTextDocument>; destroy(): Promise<void> };
}>;

export class InvoicePdfReadError extends InvoicePdfError {
  constructor(cause: unknown) {
    super(cause instanceof InvoicePdfError ? cause.code : "PDF_MALFORMED", cause);
    this.name = "InvoicePdfReadError";
    this.message = "The PDF text could not be read";
  }
}

export type InvoicePdfReadOptions = { budget?: InvoicePdfBudget; signal?: AbortSignal };
export const INVOICE_PDF_CLEANUP_TIMEOUT_MS = 1_000;

// A cooperative cleanup deadline prevents hanging promises from retaining the
// caller forever. The adapter owns physical worker/process termination.
async function cleanupWithinDeadline(action: () => unknown): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error("PDF cleanup did not complete")), INVOICE_PDF_CLEANUP_TIMEOUT_MS);
      Promise.resolve().then(action).then(value => {
        if (value === false) reject(new Error("PDF page cleanup did not complete"));
        else resolve();
      }, reject);
    });
  } finally { if (timer !== undefined) clearTimeout(timer); }
}

async function finishCleanup(failed: boolean, failure: unknown, actions: Array<() => unknown>, budget: InvoicePdfBudget): Promise<void> {
  const failures: unknown[] = [];
  for (const action of actions) {
    try { await cleanupWithinDeadline(action); }
    catch (error) { failures.push(error); }
  }
  if (failures.length === 0) return;
  budget.recordCleanupFailure();
  if (failed) {
    const aggregate = new AggregateError([failure, ...failures], "PDF loading and cleanup failed");
    if (failure instanceof InvoicePdfError) throw new InvoicePdfError(failure.code, aggregate);
    throw aggregate;
  }
  throw new InvoicePdfError("PDF_CLEANUP_FAILED", failures.length === 1 ? failures[0] : new AggregateError(failures));
}

// Provider values stay behind this boundary; PDF.js types its transform as an
// unchecked array. Validate coordinates before exposing platform-neutral text.
function positionedText(item: unknown): PositionedText | null {
  if (typeof item !== "object" || item === null || !("str" in item)) return null;
  if (typeof item.str !== "string") throw new Error("Invalid PDF text item");
  if (!item.str.trim()) return null;

  let x: unknown = 0;
  let y: unknown = 0;
  if ("transform" in item) {
    if (!Array.isArray(item.transform)) throw new Error("Invalid PDF text transform");
    x = item.transform[4];
    y = item.transform[5];
  }
  const width: unknown = "width" in item ? item.width : 0;
  if (typeof x !== "number" || !Number.isFinite(x)
    || typeof y !== "number" || !Number.isFinite(y)
    || typeof width !== "number" || !Number.isFinite(width)) {
    throw new Error("Invalid PDF text coordinates");
  }
  return { text: item.str, x, y, width };
}

function addContent(content: unknown, items: PositionedText[], budget: InvoicePdfBudget): void {
  if (typeof content !== "object" || content === null || !("items" in content) || !Array.isArray(content.items)) {
    throw new Error("Invalid PDF text content");
  }
  const rawItems: readonly unknown[] = content.items;
  for (const raw of rawItems) {
    // Count markers/empty items and all raw string characters before trimming,
    // filtering or allocating normalized copies.
    const length = typeof raw === "object" && raw !== null && "str" in raw && typeof raw.str === "string" ? raw.str.length : 0;
    budget.addItem(length);
    const normalized = positionedText(raw);
    if (normalized) items.push(normalized);
  }
}

async function loadPage(page: PdfTextPage, budget: InvoicePdfBudget): Promise<PositionedText[]> {
  const items: PositionedText[] = [];
  let reader: ReadableStreamDefaultReader<{ items: readonly unknown[] }> | undefined;
  let failed = false;
  let failure: unknown;
  try {
    if (page.streamTextContent) {
      reader = page.streamTextContent().getReader();
      while (true) {
        const next = await budget.wait(reader.read());
        if (next.done) break;
        addContent(next.value, items, budget);
      }
    } else if (page.getTextContent) {
      // Compatibility for existing test/provider adapters. Production PDF.js
      // supplies streamTextContent so pages are not accumulated beforehand.
      addContent(await budget.wait(page.getTextContent()), items, budget);
    } else { throw new Error("PDF text loading is unavailable"); }
    return items;
  } catch (error) {
    failed = true;
    failure = error;
    throw error;
  } finally {
    const actions: Array<() => unknown> = [];
    if (reader) {
      const activeReader = reader;
      // PDF.js requires an Error before it marks its internal stream closed.
      // Cancelling without one closes the native stream but leaves PDF.js's
      // state open, allowing a queued CLOSE to reject after this task ends.
      if (failed) actions.push(() => activeReader.cancel(new Error("PDF text reading stopped")));
      actions.push(() => activeReader.releaseLock());
    }
    if (page.cleanup) actions.push(() => page.cleanup?.());
    await finishCleanup(failed, failure, actions, budget);
  }
}

/** PDF.js orchestration only; the platform adapter supplies its permitted loader. */
export async function loadInvoicePdfPages(
  data: Uint8Array,
  loadPdfJs: PdfJsLoader,
  options: InvoicePdfReadOptions = {},
): Promise<PositionedText[][]> {
  const budget = options.budget ?? new InvoicePdfBudget({ signal: options.signal });
  budget.checkBytes(data.byteLength);
  const { getDocument } = await budget.wait(loadPdfJs());
  budget.checkpoint();
  const loadingTask = getDocument({
    data,
    disableFontFace: true,
    isEvalSupported: false,
    useSystemFonts: true,
  });
  let failed = false;
  let failure: unknown;
  try {
    const pdf = await budget.wait(loadingTask.promise);
    budget.checkPages(pdf.numPages);
    const pages: PositionedText[][] = [];
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      budget.beginPage();
      const page = await budget.wait(pdf.getPage(pageNumber));
      pages.push(await loadPage(page, budget));
    }
    return pages;
  } catch (cause) {
    failed = true;
    failure = cause;
    throw cause;
  } finally {
    // Also release a loading task whose promise rejected before a document existed.
    await finishCleanup(failed, failure, [() => loadingTask.destroy()], budget);
  }
}

export async function readInvoicePdf(
  data: Uint8Array,
  loadPdfJs: PdfJsLoader,
  options: InvoicePdfReadOptions = {},
): Promise<InvoicePdfExtraction> {
  const budget = options.budget ?? new InvoicePdfBudget({ signal: options.signal });
  try {
    return parseInvoicePdfPages(await loadInvoicePdfPages(data, loadPdfJs, { budget }), budget);
  } catch (cause) {
    if (cause instanceof InvoicePdfError) throw cause;
    let primary: unknown = cause;
    for (let depth = 0; depth < 4 && primary instanceof AggregateError; depth += 1) primary = primary.errors[0];
    if (primary instanceof Error && primary.name === "PasswordException") {
      throw new InvoicePdfError("PDF_ENCRYPTED_UNSUPPORTED", cause);
    }
    throw new InvoicePdfReadError(cause);
  }
}
