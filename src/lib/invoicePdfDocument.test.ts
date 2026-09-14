import assert from "node:assert/strict";
import test from "node:test";
import {
  InvoicePdfReadError, loadInvoicePdfPages, readInvoicePdf,
} from "./pdf/invoicePdfDocument";

type Loader = Parameters<typeof loadInvoicePdfPages>[1];

function documentLoader(items: readonly unknown[], options: { failPage?: Error; failCleanup?: Error } = {}) {
  let destroyed = 0;
  const pagesRead: number[] = [];
  const loader: Loader = async () => ({
    getDocument: settings => {
      assert.equal(settings.disableFontFace, true);
      assert.equal(settings.isEvalSupported, false);
      assert.equal(settings.useSystemFonts, true);
      return {
        promise: Promise.resolve({
          numPages: 25,
          getPage: async pageNumber => {
            pagesRead.push(pageNumber);
            if (options.failPage) throw options.failPage;
            return { getTextContent: async () => ({ items }) };
          },
        }),
        destroy: async () => {
          destroyed += 1;
          if (options.failCleanup) throw options.failCleanup;
        },
      };
    },
  });
  return { loader, pagesRead, destroyed: () => destroyed };
}

test("PDF loading normalizes text, ignores markers, accepts 25 pages, and releases its task", async () => {
  const fixture = documentLoader([
    { type: "beginMarkedContent", id: "synthetic" },
    { str: " " },
    { str: "Total Due 10.00", transform: [1, 0, 0, 1, 20, 30], width: 100 },
  ]);
  const pages = await loadInvoicePdfPages(new Uint8Array([1]), fixture.loader);
  assert.equal(pages.length, 25);
  assert.deepEqual(pages[0], [{ text: "Total Due 10.00", x: 20, y: 30, width: 100 }]);
  assert.deepEqual(fixture.pagesRead, Array.from({ length: 25 }, (_, index) => index + 1));
  assert.equal(fixture.destroyed(), 1);
});

test("invalid provider coordinates are rejected safely and the PDF task is released", async () => {
  const fixture = documentLoader([{ str: "Total Due 10.00", transform: [1, 0, 0, 1, "invalid", 0] }]);
  await assert.rejects(readInvoicePdf(new Uint8Array([1]), fixture.loader), error => {
    assert.ok(error instanceof InvoicePdfReadError);
    assert.equal(error.message, "The PDF text could not be read");
    assert.ok(error.cause instanceof Error);
    return true;
  });
  assert.equal(fixture.destroyed(), 1);
});

test("page failure preserves internal cause, hides details, and releases the task", async () => {
  const cause = new Error("synthetic provider implementation detail");
  const fixture = documentLoader([], { failPage: cause });
  await assert.rejects(readInvoicePdf(new Uint8Array([1]), fixture.loader), error => {
    assert.ok(error instanceof InvoicePdfReadError);
    assert.equal(error.message, "The PDF text could not be read");
    assert.equal(error.cause, cause);
    return true;
  });
  assert.equal(fixture.destroyed(), 1);
});

test("a failed loading promise is also released without exposing provider details", async () => {
  const cause = new Error("synthetic invalid PDF");
  let destroyed = 0;
  const loader: Loader = async () => ({
    getDocument: () => ({
      promise: Promise.reject(cause),
      destroy: async () => { destroyed += 1; },
    }),
  });
  await assert.rejects(readInvoicePdf(new Uint8Array([1]), loader), error => {
    assert.ok(error instanceof InvoicePdfReadError);
    assert.equal(error.message, "The PDF text could not be read");
    assert.equal(error.cause, cause);
    return true;
  });
  assert.equal(destroyed, 1);
});

test("loader initialization failure uses the same safe error and retains its cause", async () => {
  const cause = new Error("synthetic native loader detail");
  await assert.rejects(readInvoicePdf(new Uint8Array([1]), async () => { throw cause; }), error => {
    assert.ok(error instanceof InvoicePdfReadError);
    assert.equal(error.message, "The PDF text could not be read");
    assert.equal(error.cause, cause);
    return true;
  });
});

test("cleanup failure cannot return a successful parser result or leak its message", async () => {
  const cause = new Error("synthetic worker cleanup failure");
  const fixture = documentLoader([], { failCleanup: cause });
  await assert.rejects(readInvoicePdf(new Uint8Array([1]), fixture.loader), error => {
    assert.ok(error instanceof Error && "code" in error && error.code === "PDF_CLEANUP_FAILED");
    assert.equal(error.message, "PDF parsing could not finish safely. Try again shortly.");
    assert.ok("cause" in error);
    assert.equal(error.cause, cause);
    return true;
  });
  assert.equal(fixture.destroyed(), 1);
});

test("a cleanup failure does not discard the original PDF loading failure", async () => {
  const failure = new Error("synthetic page failure");
  const cleanupFailure = new Error("synthetic worker cleanup failure");
  const fixture = documentLoader([], { failPage: failure, failCleanup: cleanupFailure });
  await assert.rejects(readInvoicePdf(new Uint8Array([1]), fixture.loader), error => {
    assert.ok(error instanceof InvoicePdfReadError);
    assert.equal(error.message, "The PDF text could not be read");
    assert.ok(error.cause instanceof AggregateError);
    assert.deepEqual(error.cause.errors, [failure, cleanupFailure]);
    return true;
  });
  assert.equal(fixture.destroyed(), 1);
});
