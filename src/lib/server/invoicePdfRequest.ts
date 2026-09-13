import { hasInvoicePdfSignature, INVOICE_PDF_MAX_BYTES } from "../pdf/invoicePdfContent";

export const INVOICE_PDF_MULTIPART_LIMIT = INVOICE_PDF_MAX_BYTES + 64 * 1024;
export const INVOICE_PDF_AUTH_TIMEOUT_MS = 10_000;
export const INVOICE_PDF_BODY_TIMEOUT_MS = 10_000;
const MESSAGES = {
  AUTH_REQUIRED: [401, "Unauthorized"],
  AUTH_INVALID: [401, "Your session could not be verified. Sign in again."],
  ACCOUNT_INACTIVE: [403, "This account is inactive."],
  AUTH_TIMEOUT: [408, "Your session could not be verified in time. Try again."],
  FORBIDDEN: [403, "This account cannot parse invoice PDFs."],
  PDF_REQUEST_INVALID: [400, "Upload exactly one PDF file using the file field."],
  PDF_TOO_LARGE: [413, "PDF must be 5 MB or smaller"],
  PDF_INVALID_SIGNATURE: [415, "File must contain a supported PDF document."],
  REQUEST_ABORTED: [408, "The PDF request was cancelled."],
  PDF_REQUEST_TIMEOUT: [408, "The PDF request timed out. Try again."],
} as const;
export type InvoicePdfRequestCode = keyof typeof MESSAGES;
export class InvoicePdfRequestError extends Error {
  readonly status: number;
  constructor(readonly code: InvoicePdfRequestCode) {
    super(MESSAGES[code][1]);
    this.name = "InvoicePdfRequestError";
    this.status = MESSAGES[code][0];
  }
}

function abortError(signal: AbortSignal): InvoicePdfRequestError {
  return signal.reason instanceof InvoicePdfRequestError ? signal.reason : new InvoicePdfRequestError("REQUEST_ABORTED");
}

/** Own the timer and listener so successful operations release both immediately.
 * Parent-provided reasons are never forwarded to users. */
export function createInvoicePdfDeadline(parent: AbortSignal, timeoutMs: number,
  code: "AUTH_TIMEOUT" | "PDF_REQUEST_TIMEOUT"): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const onAbort = () => controller.abort(new InvoicePdfRequestError("REQUEST_ABORTED"));
  if (parent.aborted) onAbort();
  else parent.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(new InvoicePdfRequestError(code)), timeoutMs);
  return { signal: controller.signal, dispose: () => {
    clearTimeout(timer);
    parent.removeEventListener("abort", onAbort);
  } };
}

/** A deadline also settles callers whose underlying provider ignores abort.
 * The same signal must still be passed to that provider to stop its work. */
export async function awaitInvoicePdfRequest<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) { void work.catch(() => undefined); throw abortError(signal); }
  let onAbort: () => void = () => undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(abortError(signal));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try { return await Promise.race([work, aborted]); }
  finally { signal.removeEventListener("abort", onAbort); }
}

/** Fixed allocation, actual-byte accounting and cancellation, including streams
 * with absent/incorrect Content-Length or arbitrarily small chunks. */
export async function readInvoicePdfRequestBytes(stream: ReadableStream<Uint8Array> | null,
  maximum: number, signal: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
  if (!stream) throw new InvoicePdfRequestError("PDF_REQUEST_INVALID");
  const reader = stream.getReader();
  const buffer = new Uint8Array(maximum);
  let size = 0;
  let complete = false;
  const cancel = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    if (signal.aborted) throw abortError(signal);
    for (;;) {
      const { value, done } = await awaitInvoicePdfRequest(reader.read(), signal);
      if (signal.aborted) throw abortError(signal);
      if (done) { complete = true; break; }
      if (size + value.byteLength > maximum) throw new InvoicePdfRequestError("PDF_TOO_LARGE");
      buffer.set(value, size); size += value.byteLength;
    }
    return buffer.slice(0, size);
  } finally {
    signal.removeEventListener("abort", cancel);
    if (!complete) cancel();
    reader.releaseLock();
  }
}

export async function readUploadedInvoicePdf(request: Request,
  options: { timeoutMs?: number } = {}): Promise<Uint8Array<ArrayBuffer>> {
  const deadline = createInvoicePdfDeadline(request.signal, options.timeoutMs ?? INVOICE_PDF_BODY_TIMEOUT_MS, "PDF_REQUEST_TIMEOUT");
  const { signal } = deadline;
  const contentType = request.headers.get("content-type") || "";
  const declaredLength = request.headers.get("content-length");
  try {
    const boundaryMatch = contentType.match(/^multipart\/form-data\s*;\s*boundary=(?:"([0-9A-Za-z'()+_,\-./:=? ]{1,70})"|([0-9A-Za-z'()+_,\-./:=?]{1,70}))\s*$/i);
    const boundary = boundaryMatch?.[1] ?? boundaryMatch?.[2];
    if (contentType.length > 256 || !boundary || boundary.endsWith(" ")) {
      throw new InvoicePdfRequestError("PDF_REQUEST_INVALID");
    }
    if (declaredLength !== null) {
      if (!/^\d+$/.test(declaredLength) || !Number.isSafeInteger(Number(declaredLength))) {
        throw new InvoicePdfRequestError("PDF_REQUEST_INVALID");
      }
      if (Number(declaredLength) > INVOICE_PDF_MULTIPART_LIMIT) throw new InvoicePdfRequestError("PDF_TOO_LARGE");
    }
    const bytes = await readInvoicePdfRequestBytes(request.body, INVOICE_PDF_MULTIPART_LIMIT, signal);
    await assertSingleMultipartPart(bytes, boundary, signal);
    // The native parser is not preemptible while synchronously executing. The
    // byte, boundary, header and single-part limits above bound its input first.
    const form = await awaitInvoicePdfRequest(new Response(bytes, { headers: { "Content-Type": contentType } }).formData(), signal);
    const entries = [...form.entries()];
    const file = form.get("file");
    if (entries.length !== 1 || entries[0]?.[0] !== "file" || !(file instanceof File)
      || file.size === 0 || file.name.length === 0 || file.name.length > 255 || file.type.length > 128) {
      throw new InvoicePdfRequestError("PDF_REQUEST_INVALID");
    }
    if (file.size > INVOICE_PDF_MAX_BYTES) throw new InvoicePdfRequestError("PDF_TOO_LARGE");
    const signature = new Uint8Array(await awaitInvoicePdfRequest(file.slice(0, 9).arrayBuffer(), signal));
    if (!hasInvoicePdfSignature(signature)) throw new InvoicePdfRequestError("PDF_INVALID_SIGNATURE");
    return new Uint8Array(await awaitInvoicePdfRequest(file.arrayBuffer(), signal));
  } catch (error: unknown) {
    // Early header rejection still releases an unconsumed request body.
    if (!request.bodyUsed) void request.body?.cancel().catch(() => undefined);
    if (error instanceof InvoicePdfRequestError) throw error;
    if (signal.aborted) throw abortError(signal);
    throw new InvoicePdfRequestError("PDF_REQUEST_INVALID");
  } finally { deadline.dispose(); }
}

/** Reject multipart amplification before native FormData allocates part objects.
 * A valid request has one opening boundary and one closing boundary. Header
 * bytes are capped independently of the document, and scanning yields so abort
 * and deadline signals can run even when a malicious PDF contains many lines. */
async function assertSingleMultipartPart(bytes: Uint8Array, boundary: string, signal: AbortSignal): Promise<void> {
  const marker = new TextEncoder().encode(`--${boundary}`);
  let opened = false;
  let closed = false;
  let headerEnd = -1;
  for (let i = 0; i < bytes.length; i += 1) {
    if (i % 65_536 === 0) {
      if (signal.aborted) throw abortError(signal);
      if (i > 0) await awaitInvoicePdfRequest(new Promise<void>((resolve) => setTimeout(resolve, 0)), signal);
    }
    if (headerEnd < 0 && i >= marker.length + 2 && bytes[i] === 13 && bytes[i + 1] === 10 && bytes[i + 2] === 13 && bytes[i + 3] === 10) headerEnd = i + 4;
    if (headerEnd < 0 && i > marker.length + 8192) throw new InvoicePdfRequestError("PDF_REQUEST_INVALID");
    if (bytes[i] !== 45 || (i !== 0 && (bytes[i - 2] !== 13 || bytes[i - 1] !== 10))) continue;
    if (!marker.every((value, index) => bytes[i + index] === value)) continue;
    const end = i + marker.length;
    if (bytes[end] === 13 && bytes[end + 1] === 10) {
      if (opened || i !== 0 || closed) throw new InvoicePdfRequestError("PDF_REQUEST_INVALID");
      opened = true;
    } else if (bytes[end] === 45 && bytes[end + 1] === 45) {
      if (!opened || closed || headerEnd < 0) throw new InvoicePdfRequestError("PDF_REQUEST_INVALID");
      if (end + 2 !== bytes.length && !(end + 4 === bytes.length && bytes[end + 2] === 13 && bytes[end + 3] === 10)) {
        throw new InvoicePdfRequestError("PDF_REQUEST_INVALID");
      }
      closed = true;
    }
  }
  if (!opened || !closed || headerEnd < 0) throw new InvoicePdfRequestError("PDF_REQUEST_INVALID");
}
