export type InvoicePdfErrorCode =
  | "REQUEST_ABORTED" | "PDF_PARSE_TIMEOUT" | "PDF_TOO_LARGE" | "PDF_PAGE_LIMIT"
  | "PDF_ITEM_LIMIT" | "PDF_TEXT_LIMIT" | "PDF_OUTPUT_LIMIT" | "PDF_INVALID_SIGNATURE"
  | "PDF_ENCRYPTED_UNSUPPORTED" | "PDF_MALFORMED" | "PDF_PARSE_FAILED" | "PDF_PARSE_BUSY" | "PDF_CLEANUP_FAILED";

const messages: Record<InvoicePdfErrorCode, string> = {
  REQUEST_ABORTED: "PDF parsing was cancelled.",
  PDF_PARSE_TIMEOUT: "The PDF took too long to read. Try a simpler PDF or enter the invoice details manually.",
  PDF_TOO_LARGE: "PDF must be 5 MB or smaller",
  PDF_PAGE_LIMIT: "The PDF must contain 25 pages or fewer.",
  PDF_ITEM_LIMIT: "The PDF contains too many text items. Try a simpler PDF or enter the invoice details manually.",
  PDF_TEXT_LIMIT: "The PDF contains too much text. Try a simpler PDF or enter the invoice details manually.",
  PDF_OUTPUT_LIMIT: "The PDF contains too many or excessively long invoice entries.",
  PDF_INVALID_SIGNATURE: "The file does not contain a supported PDF signature.",
  PDF_ENCRYPTED_UNSUPPORTED: "Password-protected PDFs are not supported. Upload an unencrypted copy.",
  PDF_MALFORMED: "The PDF text could not be read",
  PDF_PARSE_FAILED: "PDF parsing is temporarily unavailable. Try again shortly.",
  PDF_PARSE_BUSY: "PDF parsing is busy. Try again shortly.",
  PDF_CLEANUP_FAILED: "PDF parsing could not finish safely. Try again shortly.",
};

export class InvoicePdfError extends Error {
  readonly code: InvoicePdfErrorCode;
  readonly cause: unknown;

  constructor(code: InvoicePdfErrorCode, cause?: unknown) {
    super(messages[code]);
    this.name = "InvoicePdfError";
    this.code = code;
    this.cause = cause;
  }
}

export type InvoicePdfLimits = {
  maxBytes: number;
  maxPages: number;
  maxItemsPerPage: number;
  maxItems: number;
  maxCharsPerItem: number;
  maxCharsPerPage: number;
  maxChars: number;
  maxRowsPerPage: number;
  maxRows: number;
  maxCandidates: number;
  maxLines: number;
  maxDescriptionChars: number;
  timeoutMs: number;
};

export const DEFAULT_INVOICE_PDF_LIMITS: Readonly<InvoicePdfLimits> = Object.freeze({
  maxBytes: 5 * 1024 * 1024,
  maxPages: 25,
  maxItemsPerPage: 10_000,
  maxItems: 50_000,
  maxCharsPerItem: 64_000,
  maxCharsPerPage: 100_000,
  maxChars: 250_000,
  maxRowsPerPage: 2_000,
  maxRows: 10_000,
  maxCandidates: 2_000,
  maxLines: 1_000,
  maxDescriptionChars: 4_000,
  timeoutMs: 10_000,
});

type TextCounters = { pageItems: number; items: number; pageChars: number; chars: number };
const counters = (): TextCounters => ({ pageItems: 0, items: 0, pageChars: 0, chars: 0 });

/**
 * Platform-neutral cooperative accounting. The Node process/browser worker
 * owner must separately terminate execution on a deadline: promises and timer
 * callbacks cannot preempt synchronous provider or extraction work.
 */
export class InvoicePdfBudget {
  readonly signal: AbortSignal | undefined;
  readonly limits: Readonly<InvoicePdfLimits>;
  private readonly now: () => number;
  private readonly startedAt: number;
  private readonly deadline: number;
  private readonly loaded = counters();
  private readonly parsed = counters();
  private pageRows = 0;
  private rows = 0;
  private candidates = 0;
  private lines = 0;
  private pages = 0;
  private cleanupFailure = false;

  constructor(options: { signal?: AbortSignal; limits?: Partial<InvoicePdfLimits>; now?: () => number } = {}) {
    const limits = { ...DEFAULT_INVOICE_PDF_LIMITS, ...options.limits };
    if (Object.values(limits).some(value => !Number.isSafeInteger(value) || value <= 0)) {
      throw new InvoicePdfError("PDF_PARSE_FAILED");
    }
    this.signal = options.signal;
    this.limits = Object.freeze(limits);
    this.now = options.now ?? (() => performance.now());
    this.startedAt = this.now();
    this.deadline = this.startedAt + limits.timeoutMs;
  }

  remainingMs(): number {
    return Math.max(0, this.deadline - this.now());
  }

  get cleanupFailed(): boolean { return this.cleanupFailure; }
  recordCleanupFailure(): void { this.cleanupFailure = true; }

  snapshot(): { pages: number; rawItems: number; rawCharacters: number; normalizedRows: number;
    candidates: number; outputLines: number; elapsedMs: number } {
    return { pages: this.pages, rawItems: this.loaded.items, rawCharacters: this.loaded.chars,
      normalizedRows: this.rows, candidates: this.candidates, outputLines: this.lines,
      elapsedMs: Math.max(0, this.now() - this.startedAt) };
  }

  checkpoint(): void {
    if (this.signal?.aborted) throw new InvoicePdfError("REQUEST_ABORTED");
    if (this.remainingMs() <= 0) throw new InvoicePdfError("PDF_PARSE_TIMEOUT");
  }

  async wait<T>(promise: PromiseLike<T>): Promise<T> {
    const operation = Promise.resolve(promise);
    try { this.checkpoint(); }
    catch (error) {
      // A provider may have started immediately before cancellation. Observe
      // its eventual rejection even though this caller cannot await it.
      void operation.catch(() => undefined);
      throw error;
    }
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const finish = (failure?: InvoicePdfError) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.signal?.removeEventListener("abort", onAbort);
        if (failure) reject(failure);
      };
      const onAbort = () => finish(new InvoicePdfError("REQUEST_ABORTED"));
      const timer = setTimeout(() => finish(new InvoicePdfError("PDF_PARSE_TIMEOUT")), this.remainingMs());
      this.signal?.addEventListener("abort", onAbort, { once: true });
      // Attach both handlers even when cancellation wins, so late provider
      // rejection is observed rather than becoming an unhandled rejection.
      operation.then(value => {
        if (settled) return;
        try { this.checkpoint(); }
        catch (error) { finish(); reject(error); return; }
        finish(); resolve(value);
      }, error => {
        if (settled) return;
        finish(); reject(error);
      });
      if (this.signal?.aborted) onAbort();
    });
  }

  checkBytes(length: number): void {
    this.checkpoint();
    if (!Number.isSafeInteger(length) || length <= 0) throw new InvoicePdfError("PDF_MALFORMED");
    if (length > this.limits.maxBytes) throw new InvoicePdfError("PDF_TOO_LARGE");
  }

  checkPages(count: number): void {
    this.checkpoint();
    if (!Number.isSafeInteger(count) || count < 1) throw new InvoicePdfError("PDF_MALFORMED");
    if (count > this.limits.maxPages) throw new InvoicePdfError("PDF_PAGE_LIMIT");
    this.pages = count;
  }

  checkText(characters: number): void {
    this.checkpoint();
    if (characters > this.limits.maxChars) throw new InvoicePdfError("PDF_TEXT_LIMIT");
  }

  checkTextLines(lines: number): void {
    this.checkpoint();
    // Invoice-number matching preserves both positioned row text and the
    // original flattened page text. Allow its one synthetic extra line per
    // page without weakening the independent positioned-row limit. Direct
    // pure-helper budgets have zero pages: their logical-line cap is 10,000.
    if (lines > this.limits.maxRows + this.pages) throw new InvoicePdfError("PDF_OUTPUT_LIMIT");
  }

  beginPage(): void {
    this.checkpoint();
    this.loaded.pageItems = 0;
    this.loaded.pageChars = 0;
  }

  beginParsedPage(): void {
    this.checkpoint();
    this.parsed.pageItems = 0;
    this.parsed.pageChars = 0;
    this.pageRows = 0;
  }

  private accountText(count: TextCounters, characters: number): void {
    this.checkpoint();
    if (!Number.isSafeInteger(characters) || characters < 0) throw new InvoicePdfError("PDF_MALFORMED");
    count.pageItems += 1;
    count.items += 1;
    if (count.pageItems > this.limits.maxItemsPerPage || count.items > this.limits.maxItems) {
      throw new InvoicePdfError("PDF_ITEM_LIMIT");
    }
    if (characters > this.limits.maxCharsPerItem) throw new InvoicePdfError("PDF_TEXT_LIMIT");
    count.pageChars += characters;
    count.chars += characters;
    if (count.pageChars > this.limits.maxCharsPerPage || count.chars > this.limits.maxChars) {
      throw new InvoicePdfError("PDF_TEXT_LIMIT");
    }
  }

  addItem(characters: number): void { this.accountText(this.loaded, characters); }
  addParsedItem(characters: number): void { this.accountText(this.parsed, characters); }

  addRow(): void {
    this.checkpoint();
    this.pageRows += 1;
    this.rows += 1;
    if (this.pageRows > this.limits.maxRowsPerPage || this.rows > this.limits.maxRows) {
      throw new InvoicePdfError("PDF_OUTPUT_LIMIT");
    }
  }

  addCandidate(): void {
    this.checkpoint();
    this.candidates += 1;
    if (this.candidates > this.limits.maxCandidates) throw new InvoicePdfError("PDF_OUTPUT_LIMIT");
  }

  checkDescription(characters: number): void {
    this.checkpoint();
    if (characters > this.limits.maxDescriptionChars) throw new InvoicePdfError("PDF_OUTPUT_LIMIT");
  }

  addLine(descriptionCharacters: number): void {
    this.checkDescription(descriptionCharacters);
    this.lines += 1;
    if (this.lines > this.limits.maxLines) throw new InvoicePdfError("PDF_OUTPUT_LIMIT");
  }
}
