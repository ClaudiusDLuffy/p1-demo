import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { resolve } from "node:path";
import { DEFAULT_INVOICE_PDF_LIMITS, InvoicePdfError, type InvoicePdfErrorCode } from "./invoicePdfBudget";
import { hasInvoicePdfSignature } from "./invoicePdfContent";
import { PDF_PROCESS_OUTPUT_BYTES, parseInvoicePdfProcessResult, type InvoicePdfProcessResult } from "./invoicePdfProcessProtocol";

export const INVOICE_PDF_PROCESS_CONCURRENCY = 1;
export const INVOICE_PDF_PROCESS_HEAP_MIB = 256;
let active = 0;
let started = 0;
let closed = 0;

/** Counts only, for deterministic local resource verification. */
export const invoicePdfProcessState = () => ({ active, started, closed });

function startProcess(): ChildProcessWithoutNullStreams {
  // Fixed build-generated entry; no path, environment or Node argument comes
  // from the request. Do not pass application credentials or NODE_OPTIONS.
  return spawn(process.execPath, [`--max-old-space-size=${INVOICE_PDF_PROCESS_HEAP_MIB}`,
    resolve(process.cwd(), "node_modules/.cache/p1-invoice-pdf-runtime/invoicePdfProcessWorker.mjs")], {
    stdio: ["pipe", "pipe", "pipe"], env: { NODE_ENV: "production" }, windowsHide: true,
  });
}

/**
 * The injected process factory is test-only dependency injection, not a route
 * input or a production debug flag. Timeouts may only LOWER the fixed ceiling.
 * Resolve/reject only after 'close': timeout never abandons a running parser.
 */
export async function runInvoicePdfProcess(data: Uint8Array, options: {
  signal?: AbortSignal; timeoutMs?: number; spawnChild?: () => ChildProcessWithoutNullStreams;
} = {}): Promise<InvoicePdfProcessResult> {
  if (options.signal?.aborted) throw new InvoicePdfError("REQUEST_ABORTED");
  if (!data.byteLength) throw new InvoicePdfError("PDF_MALFORMED");
  if (data.byteLength > DEFAULT_INVOICE_PDF_LIMITS.maxBytes) throw new InvoicePdfError("PDF_TOO_LARGE");
  if (!hasInvoicePdfSignature(data)) throw new InvoicePdfError("PDF_INVALID_SIGNATURE");
  const timeoutMs = options.timeoutMs ?? DEFAULT_INVOICE_PDF_LIMITS.timeoutMs;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > DEFAULT_INVOICE_PDF_LIMITS.timeoutMs) {
    throw new InvoicePdfError("PDF_PARSE_FAILED");
  }
  if (active >= INVOICE_PDF_PROCESS_CONCURRENCY) throw new InvoicePdfError("PDF_PARSE_BUSY");
  active += 1;
  try {
    return await new Promise<InvoicePdfProcessResult>((resolveResult, reject) => {
      let child: ChildProcessWithoutNullStreams;
      try { child = (options.spawnChild ?? startProcess)(); }
      catch { reject(new InvoicePdfError("PDF_PARSE_FAILED")); return; }
      started += 1;
      let failure: InvoicePdfErrorCode | undefined;
      let outputBytes = 0;
      const chunks: Buffer[] = [];
      const stop = (code: InvoicePdfErrorCode) => {
        if (failure) return;
        failure = code;
        // This kills synchronous PDF.js, regex, native decode and stuck cleanup
        // in the child. OS process death releases its buffers/worker resources.
        child.kill("SIGKILL");
      };
      const onAbort = () => stop("REQUEST_ABORTED");
      const timer = setTimeout(() => stop("PDF_PARSE_TIMEOUT"), timeoutMs);
      options.signal?.addEventListener("abort", onAbort, { once: true });
      child.on("error", () => stop("PDF_PARSE_FAILED"));
      child.stdin.on("error", () => { if (!failure) stop("PDF_PARSE_FAILED"); });
      child.stdout.on("data", (chunk: Buffer) => {
        if (failure) return;
        outputBytes += chunk.byteLength;
        if (outputBytes > PDF_PROCESS_OUTPUT_BYTES) stop("PDF_OUTPUT_LIMIT");
        else chunks.push(chunk);
      });
      // Drain without retaining/logging provider stderr (it may contain paths).
      child.stderr.on("data", () => undefined);
      child.once("close", code => {
        closed += 1;
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", onAbort);
        child.removeAllListeners();
        child.stdin.removeAllListeners();
        child.stdout.removeAllListeners();
        child.stderr.removeAllListeners();
        try {
          if (options.signal?.aborted) throw new InvoicePdfError("REQUEST_ABORTED");
          if (failure) throw new InvoicePdfError(failure);
          if (code !== 0) throw new InvoicePdfError("PDF_PARSE_FAILED");
          const message: unknown = JSON.parse(Buffer.concat(chunks, outputBytes).toString("utf8"));
          resolveResult(parseInvoicePdfProcessResult(message));
        } catch (error) {
          reject(error instanceof InvoicePdfError ? error : new InvoicePdfError("PDF_PARSE_FAILED"));
        } finally { chunks.length = 0; }
      });
      if (options.signal?.aborted) onAbort();
      if (!failure) child.stdin.end(data);
      else child.stdin.destroy();
    });
  } finally { active -= 1; }
}
