import assert from "node:assert/strict";
import test from "node:test";
import { hasInvoicePdfSignature, INVOICE_PDF_MAX_BYTES } from "./pdf/invoicePdfContent";
import { createInvoicePdfDeadline, INVOICE_PDF_MULTIPART_LIMIT, InvoicePdfRequestError, readUploadedInvoicePdf } from "./server/invoicePdfRequest";

const encoded = (text: string) => new TextEncoder().encode(text);
const validHeader = encoded("%PDF-1.7\nsynthetic admission fixture; extraction is tested separately");
const file = (bytes: Uint8Array<ArrayBuffer> = validHeader, name = "synthetic.pdf", type = "application/pdf") => new File([bytes], name, { type });
const multipart = (parts: readonly [string, FormDataEntryValue][] = [["file", file()]]) => {
  const form = new FormData();
  for (const [name, value] of parts) form.append(name, value);
  return new Request("https://portal.invalid/api/invoice-pdf/parse-total", { method: "POST", body: form });
};
function streamed(stream: ReadableStream<Uint8Array>, headers: HeadersInit,
  signal?: AbortSignal): Request {
  const init: RequestInit & { duplex: "half" } = { method: "POST", body: stream, headers, signal, duplex: "half" };
  return new Request("https://portal.invalid/api/invoice-pdf/parse-total", init);
}
const rejected = (status: number, code?: string) => (error: unknown) => {
  assert.ok(error instanceof InvoicePdfRequestError); assert.equal(error.status, status);
  if (code) assert.equal(error.code, code);
  assert.doesNotMatch(error.message, /\/private\/|native|synthetic-secret/);
  return true;
};

test("PDF signature admits only byte-zero supported versions followed by CR or LF", () => {
  for (const version of ["1.0", "1.1", "1.2", "1.3", "1.4", "1.5", "1.6", "1.7", "2.0"]) {
    for (const end of ["\n", "\r", "\r\n"]) assert.equal(hasInvoicePdfSignature(encoded(`%PDF-${version}${end}`)), true);
  }
  for (const value of ["", "%PDF-1.7", "%PDF-1.7x\n", "%PDF-1.8\n", "%PDF-2.1\n", "%PDF-0.9\n",
    " %PDF-1.7\n", "\n%PDF-1.7\n", "\ufeff%PDF-1.7\n", "<html>%PDF-1.7\n", "%pdf-1.7\n"]) {
    assert.equal(hasInvoicePdfSignature(encoded(value)), false, JSON.stringify(value));
  }
});

test("genuine PDF headers are authoritative despite bounded advisory extension or MIME mismatch", async () => {
  for (const [name, type] of [["synthetic.pdf", "application/pdf"], ["synthetic.bin", "application/octet-stream"],
    ["synthetic.txt", "text/plain"], ["synthetic", ""]]) {
    assert.deepEqual(await readUploadedInvoicePdf(multipart([["file", file(validHeader, name, type)]])), validHeader);
  }
});

test("a claimed PDF filename or MIME never admits invalid bytes", async () => {
  for (const input of [encoded("not a PDF"), encoded("\ufeff%PDF-1.7\n"), encoded("%PDF-1.7-without-newline")]) {
    await assert.rejects(readUploadedInvoicePdf(multipart([["file", file(input)]])), rejected(415, "PDF_INVALID_SIGNATURE"));
  }
});

test("multipart accepts exactly one file field and rejects duplicates, unrelated fields and string substitutes", async () => {
  const cases: [string, FormDataEntryValue][][] = [[], [["file", "synthetic string"]], [["document", file()]],
    [["file", file()], ["file", file()]], [["file", file()], ["workOrderId", "WOT-FORGED"]],
    [["file", file()], ["role", "manager"]], [["file", file()], ["extra-file", file()]]];
  for (const parts of cases) await assert.rejects(readUploadedInvoicePdf(multipart(parts)), rejected(400));
});

test("empty files and overlong advisory metadata are rejected before parsing", async () => {
  for (const input of [file(new Uint8Array()), file(validHeader, "a".repeat(256)), file(validHeader, "synthetic.pdf", "a".repeat(129))]) {
    await assert.rejects(readUploadedInvoicePdf(multipart([["file", input]])), rejected(400));
  }
});

test("a PDF at five MiB is admitted while one byte beyond is rejected despite available multipart envelope", async () => {
  const maximum = new Uint8Array(INVOICE_PDF_MAX_BYTES); maximum.set(validHeader);
  assert.equal((await readUploadedInvoicePdf(multipart([["file", file(maximum)]]))).byteLength, INVOICE_PDF_MAX_BYTES);
  const oversized = new Uint8Array(INVOICE_PDF_MAX_BYTES + 1); oversized.set(validHeader);
  await assert.rejects(readUploadedInvoicePdf(multipart([["file", file(oversized)]])), rejected(413));
});

test("wrong Content-Type, malformed multipart and invalid Content-Length fail with safe400", async () => {
  const cases: HeadersInit[] = [{ "Content-Type": "application/json" }, { "Content-Type": "text/multipart/form-data" },
    { "Content-Type": "multipart/form-data" }, { "Content-Type": "multipart/form-data; boundary=missing", "Content-Length": "-1" },
    { "Content-Type": "multipart/form-data; boundary=missing", "Content-Length": "unknown" }];
  for (const headers of cases) {
    await assert.rejects(readUploadedInvoicePdf(new Request("https://portal.invalid", { method: "POST", body: "invalid multipart", headers })), rejected(400));
  }
});

test("oversized declared body is only an early rejection hint and never starts reading", async () => {
  let reads = 0, cancelled = false;
  const stream = new ReadableStream<Uint8Array>({ pull() { reads++; }, cancel() { cancelled = true; } }, { highWaterMark: 0 });
  await assert.rejects(readUploadedInvoicePdf(streamed(stream, {
    "Content-Type": "multipart/form-data; boundary=synthetic", "Content-Length": String(INVOICE_PDF_MULTIPART_LIMIT + 1),
  })), rejected(413));
  assert.equal(reads, 0); assert.equal(cancelled, true);
});

test("actual multipart bytes remain bounded with absent or deceptively small Content-Length", async () => {
  for (const contentLength of [undefined, "1"]) {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(INVOICE_PDF_MULTIPART_LIMIT + 1)); },
      cancel() { cancelled = true; },
    });
    const headers = new Headers({ "Content-Type": "multipart/form-data; boundary=synthetic" });
    if (contentLength) headers.set("Content-Length", contentLength);
    await assert.rejects(readUploadedInvoicePdf(streamed(stream, headers)), rejected(413));
    assert.equal(cancelled, true);
  }
});

test("chunked multipart is consumed exactly without requiring Content-Length", async () => {
  const original = multipart();
  const bytes = new Uint8Array(await original.arrayBuffer());
  let index = 0;
  const stream = new ReadableStream<Uint8Array>({ pull(controller) {
    if (index === bytes.length) { controller.close(); return; }
    controller.enqueue(bytes.slice(index, ++index));
  } });
  assert.deepEqual(await readUploadedInvoicePdf(streamed(stream, original.headers)), validHeader);
});

test("stalled multipart body is cancelled by its actual deadline instead of awaiting another chunk", async () => {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
  const keepAlive = setTimeout(() => undefined, 100);
  try {
    await assert.rejects(readUploadedInvoicePdf(streamed(stream, { "Content-Type": "multipart/form-data; boundary=synthetic" }), { timeoutMs: 5 }),
      rejected(408, "PDF_REQUEST_TIMEOUT"));
  } finally { clearTimeout(keepAlive); }
  assert.equal(cancelled, true);
});

test("caller cancellation stops multipart consumption without exposing its arbitrary reason", async () => {
  const controller = new AbortController();
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
  const pending = readUploadedInvoicePdf(streamed(stream, { "Content-Type": "multipart/form-data; boundary=synthetic" }, controller.signal));
  controller.abort(new Error("/private/synthetic-secret"));
  await assert.rejects(pending, rejected(408, "REQUEST_ABORTED"));
  assert.equal(cancelled, true);
});

test("underlying multipart stream errors are normalized without leaking internal messages", async () => {
  const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.error(new Error("/private/synthetic-secret")); } });
  await assert.rejects(readUploadedInvoicePdf(streamed(stream, { "Content-Type": "multipart/form-data; boundary=synthetic" })), rejected(400));
});

test("multipart preflight rejects excess part count, oversized boundaries and headers before native parsing", async () => {
  const original = Response.prototype.formData;
  let nativeCalls = 0;
  Response.prototype.formData = function () { nativeCalls++; return original.call(this); };
  try {
    const extra = multipart([["file", file()], ["extra", "untrusted"]]);
    await assert.rejects(readUploadedInvoicePdf(extra), rejected(400));
    const many = new FormData();
    for (let index = 0; index < 5000; index++) many.append(`f${index}`, "x");
    await assert.rejects(readUploadedInvoicePdf(new Request("https://portal.invalid", { method: "POST", body: many })), rejected(400));
    await assert.rejects(readUploadedInvoicePdf(new Request("https://portal.invalid", { method: "POST", body: "bounded",
      headers: { "Content-Type": `multipart/form-data; boundary=${"a".repeat(71)}` } })), rejected(400));
    const body = `--synthetic\r\nContent-Disposition: form-data; name="file"; filename="synthetic.pdf"\r\nX-Excess: ${"a".repeat(8192)}\r\n\r\n%PDF-1.7\n\r\n--synthetic--`;
    await assert.rejects(readUploadedInvoicePdf(new Request("https://portal.invalid", { method: "POST", body,
      headers: { "Content-Type": "multipart/form-data; boundary=synthetic" } })), rejected(400));
    assert.equal(nativeCalls, 0);
  } finally { Response.prototype.formData = original; }
});

test("successful admission deadlines explicitly release timers and parent abort listeners", async () => {
  const parent = new AbortController();
  const deadline = createInvoicePdfDeadline(parent.signal, 5, "PDF_REQUEST_TIMEOUT");
  deadline.dispose();
  parent.abort(new Error("unrelated later action"));
  await new Promise<void>(resolve => setTimeout(resolve, 10));
  assert.equal(deadline.signal.aborted, false);
});

test("signature validation reads only the first nine file bytes before allocating the complete PDF buffer", async () => {
  const validRequest = multipart();
  const invalidRequest = multipart([["file", file(encoded("not a PDF despite a synthetic extension"))]]);
  const original = Blob.prototype.arrayBuffer;
  const sizes: number[] = [];
  Blob.prototype.arrayBuffer = function () { sizes.push(this.size); return original.call(this); };
  try {
    await assert.rejects(readUploadedInvoicePdf(invalidRequest), rejected(415));
    assert.deepEqual(sizes, [9]);
    sizes.length = 0;
    await readUploadedInvoicePdf(validRequest);
    assert.deepEqual(sizes, [9, validHeader.byteLength]);
  } finally { Blob.prototype.arrayBuffer = original; }
});

test("multipart preflight yields to cancellation before starting native FormData", async () => {
  const bytes = new Uint8Array(INVOICE_PDF_MAX_BYTES); bytes.set(validHeader);
  const controller = new AbortController();
  const base = multipart([["file", file(bytes)]]);
  const req = new Request(base, { signal: controller.signal });
  const original = Response.prototype.formData;
  let nativeCalls = 0;
  Response.prototype.formData = function () { nativeCalls++; return original.call(this); };
  const timer = setTimeout(() => controller.abort(), 0);
  try {
    await assert.rejects(readUploadedInvoicePdf(req), rejected(408, "REQUEST_ABORTED"));
    assert.equal(nativeCalls, 0);
  } finally { clearTimeout(timer); Response.prototype.formData = original; }
});
