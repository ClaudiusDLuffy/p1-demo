import { createRequire } from "node:module";
import { DEFAULT_INVOICE_PDF_LIMITS, InvoicePdfBudget, InvoicePdfError } from "./invoicePdfBudget";
import { hasInvoicePdfSignature } from "./invoicePdfContent";
import { readInvoicePdf } from "./invoicePdfDocument";
import { PDF_PROCESS_OUTPUT_BYTES } from "./invoicePdfProcessProtocol";

// Executed only as a disposable Node child. It receives at most one bounded PDF
// on stdin, no authentication environment, object path, URL or extraction code.
async function input(): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    if (!Buffer.isBuffer(chunk)) throw new InvoicePdfError("PDF_PARSE_FAILED");
    bytes += chunk.byteLength;
    if (bytes > DEFAULT_INVOICE_PDF_LIMITS.maxBytes) throw new InvoicePdfError("PDF_TOO_LARGE");
    chunks.push(chunk);
  }
  return new Uint8Array(Buffer.concat(chunks, bytes));
}

async function loadServerPdfJs() {
  const requireNative = createRequire(import.meta.url);
  const canvas: typeof import("@napi-rs/canvas") = requireNative("@napi-rs/canvas");
  Object.assign(globalThis, {
    DOMMatrix: globalThis.DOMMatrix ?? canvas.DOMMatrix,
    ImageData: globalThis.ImageData ?? canvas.ImageData,
    Path2D: globalThis.Path2D ?? canvas.Path2D,
  });
  await import("pdfjs-dist/legacy/build/pdf.worker.mjs");
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  return {
    getDocument: (options: { data: Uint8Array; disableFontFace: boolean; isEvalSupported: boolean; useSystemFonts: boolean }) => pdfjs.getDocument({
      ...options, verbosity: 0, isEvalSupported: false, useWasm: false,
      disableFontFace: true, isOffscreenCanvasSupported: false,
    }),
  };
}

async function main(): Promise<void> {
  let response: unknown;
  try {
    const data = await input();
    if (!hasInvoicePdfSignature(data)) throw new InvoicePdfError("PDF_INVALID_SIGNATURE");
    const budget = new InvoicePdfBudget();
    const result = await readInvoicePdf(data, loadServerPdfJs, { budget });
    budget.checkpoint();
    response = { ok: true, data: result, metrics: {
      ...budget.snapshot(), peakRssKiB: process.resourceUsage().maxRSS,
      heapUsedBytes: process.memoryUsage().heapUsed, cleanup: "complete",
    } };
  } catch (error) {
    response = { ok: false, code: error instanceof InvoicePdfError ? error.code : "PDF_PARSE_FAILED" };
  }
  let encoded = JSON.stringify(response);
  if (Buffer.byteLength(encoded) > PDF_PROCESS_OUTPUT_BYTES) encoded = JSON.stringify({ ok: false, code: "PDF_OUTPUT_LIMIT" });
  // Only the bounded result is written, after readInvoicePdf's finally. Explicit
  // exit releases any provider-global fake-worker state even on handled failure.
  process.stdout.write(encoded, () => process.exit(0));
}

void main().catch(() => process.exit(1));
