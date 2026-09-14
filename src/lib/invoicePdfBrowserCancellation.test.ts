import assert from "node:assert/strict";
import test from "node:test";
import { InvoicePdfBudget, InvoicePdfError } from "./pdf/invoicePdfBudget";
import { browserPdfHarness, clientPdfHarness } from "./pdf/test-fixtures/browserPdfHarness";
import type { InvoicePdfExtraction } from "./pdf/invoicePdfTypes";

const bytes = new TextEncoder().encode("%PDF-1.7\nsynthetic provider fixture");
const result: InvoicePdfExtraction = { total: 12, confidence: "high", matchedLabel: "total", invoiceNumber: "SYNTH-1",
  invoiceNumberConfidence: "high", matchedNumberLabel: "invoice", lines: [], lineConfidence: "none" };
function deferred<T>() { let resolve: (value: T) => void = () => undefined; let reject: (error: unknown) => void = () => undefined;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const code = (expected: string) => (error: unknown) => {
  assert.ok(error instanceof InvoicePdfError); assert.equal(error.code, expected);
  assert.doesNotMatch(error.message, /provider detail|node_modules|\/private\/|native|canvas/); return true;
};

test("browser PDF request owns a distinct real-port branch and terminates on successful completion", async () => {
  const h = browserPdfHarness({ loadPdfJs: async () => ({}), readPdf: async () => result });
  assert.deepEqual(await h.parse(bytes), result); assert.deepEqual(await h.parse(bytes), result);
  assert.equal(h.workers.length, 2); assert.notEqual(h.workers[0], h.workers[1]);
  assert.equal(h.wrappersDestroyed(), 2);
  for (const worker of h.workers) { assert.equal(worker.terminated, 1); assert.equal(worker.options.type, "module");
    assert.ok(worker.url.href.endsWith("/invoicePdfBrowserWorker.ts")); }
});

test("browser abort stops its worker immediately and consumes late provider settlement", async () => {
  const pending = deferred<InvoicePdfExtraction>();
  const h = browserPdfHarness({ loadPdfJs: async () => ({}), readPdf: () => pending.promise });
  const controller = new AbortController(); const promise = h.parse(bytes, { signal: controller.signal });
  await tick(); controller.abort(); await assert.rejects(promise, code("REQUEST_ABORTED"));
  assert.equal(h.workers[0]?.terminated, 1); assert.equal(h.wrappersDestroyed(), 1);
  pending.reject(new Error("Synthetic late provider detail")); await tick();
});

test("browser deadline terminates a hanging worker and does not start a fake worker", async () => {
  const h = browserPdfHarness({ loadPdfJs: async () => ({}), readPdf: () => new Promise(() => undefined) });
  await assert.rejects(h.parse(bytes, { budget: new InvoicePdfBudget({ limits: { timeoutMs: 15 } }) }), code("PDF_PARSE_TIMEOUT"));
  assert.equal(h.workers.length, 1); assert.equal(h.workers[0].terminated, 1);
});

test("abort and deadline during lazy loading prevent late worker creation", async () => {
  for (const abort of [false, true]) {
    const providerModule = deferred<Record<string, unknown>>(); const controller = new AbortController();
    const h = browserPdfHarness({ loadPdfJs: () => providerModule.promise, readPdf: async () => result });
    const promise = h.parse(bytes, { signal: controller.signal, budget: new InvoicePdfBudget({ signal: controller.signal,
      limits: { timeoutMs: abort ? 1000 : 15 } }) });
    if (abort) controller.abort();
    await assert.rejects(promise, code(abort ? "REQUEST_ABORTED" : "PDF_PARSE_TIMEOUT"));
    providerModule.resolve({}); await tick(); assert.equal(h.workers.length, 0);
  }
});

test("invalid signatures and pre-aborted requests do not import PDF.js", async () => {
  const h = browserPdfHarness({ loadPdfJs: async () => ({}), readPdf: async () => result });
  await assert.rejects(h.parse(new TextEncoder().encode("not a PDF")), code("PDF_INVALID_SIGNATURE"));
  const controller = new AbortController(); controller.abort();
  await assert.rejects(h.parse(bytes, { signal: controller.signal }), code("REQUEST_ABORTED"));
  assert.equal(h.imports(), 0); assert.equal(h.workers.length, 0);
});

test("worker construction and runtime errors fail safely without a fake-worker fallback", async () => {
  const failed = browserPdfHarness({ loadPdfJs: async () => ({}), workerFailure: true, readPdf: async () => result });
  await assert.rejects(failed.parse(bytes), code("PDF_PARSE_FAILED")); assert.equal(failed.workers.length, 0);
  const h = browserPdfHarness({ loadPdfJs: async () => ({}), readPdf: () => new Promise(() => undefined) });
  const promise = h.parse(bytes); await tick(); h.workers[0].dispatchEvent(new Event("error"));
  await assert.rejects(promise, code("PDF_PARSE_FAILED")); assert.equal(h.workers[0].terminated, 1);
});

test("worker-wrapper cleanup failure is observable without replacing a primary parse failure", async () => {
  for (const failed of [false, true]) {
    const budget = new InvoicePdfBudget();
    const h = browserPdfHarness({ loadPdfJs: async () => ({}),
      createPdfWorker: () => ({ destroy() { throw new Error("Synthetic cleanup provider detail"); } }),
      readPdf: async () => { if (failed) throw new InvoicePdfError("PDF_TEXT_LIMIT"); return result; },
    });
    await assert.rejects(h.parse(bytes, { budget }), code(failed ? "PDF_TEXT_LIMIT" : "PDF_CLEANUP_FAILED"));
    assert.equal(budget.cleanupFailed, true); assert.equal(h.workers[0].terminated, 1);
  }
});

test("browser File facade validates bytes before loading and shares one request budget", async () => {
  let calls = 0; const controller = new AbortController();
  const h = clientPdfHarness(async (data, options) => {
    calls += 1; assert.deepEqual(data, bytes); assert.equal(options?.signal, controller.signal);
    assert.ok(options?.budget instanceof InvoicePdfBudget); return result;
  });
  await assert.rejects(h.parse(new File(["not PDF"], "fake.pdf", { type: "application/pdf" })), code("PDF_INVALID_SIGNATURE"));
  assert.equal(h.imports(), 0);
  assert.deepEqual(await h.parse(new File([bytes], "synthetic.pdf"), { signal: controller.signal }), result);
  assert.equal(calls, 1);
});

test("browser PDF content identity ignores advisory filename and MIME while bounding their display lengths", async () => {
  const h = clientPdfHarness(async data => { assert.deepEqual(data, bytes); return result; });
  for (const [name, type] of [["synthetic.txt", "text/plain"], ["synthetic.bin", "application/octet-stream"],
    ["synthetic", ""]]) {
    assert.deepEqual(await h.parse(new File([bytes], name, { type })), result);
  }
  for (const [name, type] of [["", ""], ["x".repeat(256), "application/pdf"], ["synthetic.pdf", "x".repeat(129)]]) {
    await assert.rejects(h.parse(new File([bytes], name, { type })), code("PDF_PARSE_FAILED"));
  }
  assert.equal(h.imports(), 3);
});

test("one-byte stream chunks are copied into one bounded buffer rather than retaining provider-owned chunks", async () => {
  // Reusing the same provider chunk also proves that earlier bytes are copied
  // immediately; retaining a chunks[] array would silently corrupt the input.
  class TinyChunksFile extends File {
    stream(): ReadableStream<Uint8Array<ArrayBuffer>> {
      let offset = 0; const chunk = new Uint8Array(1);
      return new ReadableStream({ pull(sink) {
        if (offset === bytes.length) { sink.close(); return; }
        chunk[0] = bytes[offset++]; sink.enqueue(chunk);
      } }, { highWaterMark: 0 });
    }
  }
  const h = clientPdfHarness(async data => { assert.deepEqual(data, bytes); return result; });
  assert.deepEqual(await h.parse(new TinyChunksFile([bytes], "synthetic.pdf")), result);
});

test("cancelling a File stream prevents parser loading and safely releases the reader", async () => {
  let cancelled = 0;
  class PendingFile extends File {
    stream(): ReadableStream<Uint8Array<ArrayBuffer>> {
      return new ReadableStream({ pull() {}, cancel() { cancelled += 1; } });
    }
  }
  const h = clientPdfHarness(async () => result); const controller = new AbortController();
  const pending = h.parse(new PendingFile([bytes], "pending.pdf"), { signal: controller.signal });
  await tick(); controller.abort(); await assert.rejects(pending, code("REQUEST_ABORTED"));
  assert.equal(cancelled, 1); assert.equal(h.imports(), 0);
});

test("browser stored-PDF read is bounded, cancellable and hides provider errors", async () => {
  let cancelled = 0; const controller = new AbortController(); let passedSignal: AbortSignal | undefined;
  const stream = new ReadableStream<Uint8Array>({ pull() {}, cancel() { cancelled += 1; } });
  const h = clientPdfHarness(async () => result, { from: bucket => {
    assert.equal(bucket, "invoice-pdfs"); return { download: (_path: string, _options: unknown, request: { signal: AbortSignal }) => {
      passedSignal = request.signal; return { asStream: async () => ({ data: stream, error: null }) };
    } };
  } });
  const promise = h.parseStored("synthetic/private.pdf", { signal: controller.signal }); await tick(); controller.abort();
  await assert.rejects(promise, code("REQUEST_ABORTED")); assert.equal(cancelled, 1); assert.equal(passedSignal?.aborted, true);
  const oversized = clientPdfHarness(async () => result, { from: () => ({ download: () => ({ asStream: async () => ({
    data: new ReadableStream({ start(sink) { sink.enqueue(new Uint8Array(5 * 1024 * 1024 + 1)); } }), error: null,
  }) }) }) });
  await assert.rejects(oversized.parseStored("synthetic/private.pdf"), code("PDF_TOO_LARGE")); assert.equal(oversized.imports(), 0);
  const failed = clientPdfHarness(async () => result, { from: () => ({ download: () => ({ asStream: async () => ({
    data: null, error: { message: "Synthetic secret provider detail" },
  }) }) }) });
  await assert.rejects(failed.parseStored("synthetic/private.pdf"), code("PDF_PARSE_FAILED"));
});

test("stored-PDF success and failure dispose their owned deadline and parent abort listener", async () => {
  for (const failed of [false, true]) {
    const parent = new AbortController(); let passedSignal: AbortSignal | undefined;
    const h = clientPdfHarness(async (_data, options) => {
      assert.equal(options?.signal, passedSignal); return result;
    }, { from: () => ({ download: (_path: string, _options: unknown, request: { signal: AbortSignal }) => {
      passedSignal = request.signal;
      return { asStream: async () => failed ? { data: null, error: { message: "Synthetic provider detail" } }
        : { data: new ReadableStream({ start(sink) { sink.enqueue(bytes); sink.close(); } }), error: null } };
    } }) });
    const promise = h.parseStored("synthetic/private.pdf", { signal: parent.signal });
    if (failed) await assert.rejects(promise, code("PDF_PARSE_FAILED"));
    else assert.deepEqual(await promise, result);
    assert.equal(h.activeTimers(), 0); assert.equal(passedSignal?.aborted, false);
    parent.abort(); h.fireTimers(); await tick();
    assert.equal(passedSignal?.aborted, false, "Completed request must not be aborted by a late caller or timer");
  }
});

test("stored-PDF owned deadline cancels the actual download and reports timeout rather than caller abort", async () => {
  let passedSignal: AbortSignal | undefined;
  const h = clientPdfHarness(async () => result, { from: () => ({ download: (_path: string, _options: unknown,
    request: { signal: AbortSignal }) => {
    passedSignal = request.signal; return { asStream: () => new Promise(() => undefined) };
  } }) });
  const pending = h.parseStored("synthetic/private.pdf"); await tick();
  assert.equal(h.activeTimers(), 1); h.fireTimers();
  await assert.rejects(pending, code("PDF_PARSE_TIMEOUT"));
  assert.equal(passedSignal?.aborted, true); assert.equal(h.activeTimers(), 0); assert.equal(h.imports(), 0);
});
