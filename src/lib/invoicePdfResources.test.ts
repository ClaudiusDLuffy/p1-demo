import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { readInvoicePdf } from "./pdf/invoicePdfDocument";
import { InvoicePdfBudget, InvoicePdfError, DEFAULT_INVOICE_PDF_LIMITS } from "./pdf/invoicePdfBudget";
import { findInvoiceNumber, findInvoiceTotal, parseInvoicePdfPages } from "./pdf/invoicePdfTextParser";
import type { PositionedText } from "./pdf/invoicePdfTypes";

type Item = { str: string; transform: number[]; width: number };
const item = (str: string, row = 1): Item => ({ str, transform: [1, 0, 0, 1, 20, row * 10], width: 10 });
function loader(pages: readonly (readonly Item[])[]) {
  let calls = 0;
  let destroyed = 0;
  return {
    calls: () => calls,
    destroyed: () => destroyed,
    load: async () => ({ getDocument: () => {
      calls += 1;
      return { promise: Promise.resolve({ numPages: pages.length,
        getPage: async (number: number) => ({ getTextContent: async () => ({ items: pages[number - 1] }) }),
      }), destroy: async () => { destroyed += 1; } };
    } }),
  };
}

test("PDF resource defaults are explicit and cannot be mutated", () => {
  assert.deepEqual(DEFAULT_INVOICE_PDF_LIMITS, {
    maxBytes: 5 * 1024 * 1024, maxPages: 25, maxItemsPerPage: 10_000, maxItems: 50_000,
    maxCharsPerItem: 64_000, maxCharsPerPage: 100_000, maxChars: 250_000,
    maxRowsPerPage: 2_000, maxRows: 10_000, maxCandidates: 2_000, maxLines: 1_000,
    maxDescriptionChars: 4_000, timeoutMs: 10_000,
  });
  assert.ok(Object.isFrozen(DEFAULT_INVOICE_PDF_LIMITS));
});

test("exact input, page, raw-item and text limits remain accepted", async () => {
  for (const pages of [
    Array.from({ length: 25 }, () => [item("Text")]),
    Array.from({ length: 5 }, () => Array.from({ length: 10_000 }, () => item(""))),
    [[item("x".repeat(64_000))]],
    [[item("x".repeat(50_000)), item("y".repeat(50_000))]],
    [[item("x".repeat(50_000)), item("y".repeat(50_000))],
      [item("x".repeat(50_000)), item("y".repeat(50_000))], [item("z".repeat(50_000))]],
  ]) {
    const fixture = loader(pages);
    const result = await readInvoicePdf(new Uint8Array([1]), fixture.load);
    assert.equal(result.total, null);
    assert.equal(fixture.destroyed(), 1);
  }
  await readInvoicePdf(new Uint8Array(5 * 1024 * 1024), loader([[item("Text")]]).load);
});

test("total raw-item limit counts empty items across pages", async () => {
  const pages = Array.from({ length: 5 }, () => Array.from({ length: 10_000 }, () => item("")));
  pages.push([item("")]);
  await assert.rejects(readInvoicePdf(new Uint8Array([1]), loader(pages).load), code("PDF_ITEM_LIMIT"));
});

test("bounded pure parsing enforces normalized page/document row limits exactly once", () => {
  const page = Array.from({ length: 2_000 }, (_, index) => ({ text: "Text", x: 20, y: index * 10, width: 10 }));
  const budget = new InvoicePdfBudget();
  const pages = Array.from({ length: 5 }, () => page);
  parseInvoicePdfPages(pages, budget);
  assert.equal(budget.snapshot().normalizedRows, 10_000);
  assert.throws(() => parseInvoicePdfPages([...pages, [page[0]]], new InvoicePdfBudget()), code("PDF_OUTPUT_LIMIT"));
});

test("money candidate limit rejects excess matches without changing accepted ranking", () => {
  const exactly = "Balance Due 1.00\n".repeat(2_000);
  const budget = new InvoicePdfBudget();
  assert.equal(findInvoiceTotal(exactly, budget).total, 1);
  assert.equal(budget.snapshot().candidates, 2_000);
  assert.throws(() => findInvoiceTotal(`${exactly}Balance Due 2.00`, new InvoicePdfBudget()), code("PDF_OUTPUT_LIMIT"));
});

test("whitespace and delimiter rewrites preserve seeded legacy total/number matching", () => {
  // These two frozen expressions characterize the original matching language;
  // production retains its original ranking and candidate normalization.
  const oldTotal = /balance\s+due\s*(?:[:=\-]\s*)?(?:USD\s*)?\$?\s*(\(?-?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{2})\)?)/i;
  const oldBare = /^\s*invoice\s*[:=-]?\s+([A-Z0-9][A-Z0-9._/-]{0,63})\b/i;
  const spaces = ["", " ", "\t", "\n", "\r\n", "\u2003", " \t "];
  const delimiters = ["", ":", "=", "-", ";"];
  let seed = 1729;
  const pick = <T>(values: readonly T[]): T => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return values[seed % values.length];
  };
  for (let index = 0; index < 1_000; index += 1) {
    const totalText = `Balance Due${pick(spaces)}${pick(delimiters)}${pick(spaces)}${pick(["", "USD"])}${pick(spaces)}${pick(["", "$"])}${pick(spaces)}123.45`;
    const normalizedTotal = totalText.replace(/\u00a0/g, " ").replace(/[ \t]+/g, " ");
    const matched = oldTotal.test(normalizedTotal);
    const fallback = /\$\s*123\.45/.test(normalizedTotal);
    assert.deepEqual(findInvoiceTotal(totalText), {
      total: matched || fallback ? 123.45 : null,
      confidence: matched ? "high" : fallback ? "medium" : "none",
      matchedLabel: matched ? "balance due" : null,
    });
    const numberText = `Invoice${pick(spaces)}${pick(delimiters)}${pick(spaces)}SYNTH-123`;
    const oldNumber = numberText.replace(/\u00a0/g, " ").split(/\r?\n/)
      .map(line => line.replace(/[ \t]+/g, " ").trim())
      .find(line => oldBare.test(line));
    assert.deepEqual(findInvoiceNumber(numberText), {
      invoiceNumber: oldNumber ? "SYNTH-123" : null,
      invoiceNumberConfidence: oldNumber ? "medium" : "none",
      matchedNumberLabel: oldNumber ? "invoice" : null,
    });
  }
});

test("literal invoice-number lines are bounded before split allocation, including blank lines", () => {
  const exactly = `${"Synthetic\n".repeat(9_999)}Invoice SYNTH-123`;
  assert.equal(findInvoiceNumber(exactly, new InvoicePdfBudget()).invoiceNumber, "SYNTH-123");
  assert.throws(() => findInvoiceNumber(`${exactly}\nAnother line`, new InvoicePdfBudget()), code("PDF_OUTPUT_LIMIT"));
  assert.throws(() => findInvoiceNumber("\n".repeat(100_000), new InvoicePdfBudget()), code("PDF_OUTPUT_LIMIT"));
  // Unbudgeted pure characterization keeps its original matching behavior.
  assert.equal(findInvoiceNumber(`${exactly}\nAnother line`).invoiceNumber, "SYNTH-123");
});

for (const [helper, prefix] of [["findInvoiceTotal", "total"], ["findInvoiceNumber", "invoice"]]) {
  test(`${helper} bounds nonmatching whitespace work before the isolated test deadline`, () => {
    // The old ambiguous whitespace expressions exceed this external deadline
    // even with a 1-second cooperative budget. Bound the regression itself so
    // reintroducing synchronous backtracking cannot hang the test runner.
    const script = `const parserModule = await import('./src/lib/pdf/invoicePdfTextParser.ts');
      const budgetModule = await import('./src/lib/pdf/invoicePdfBudget.ts');
      const { ${helper} } = parserModule.default ?? parserModule;
      const { InvoicePdfBudget } = budgetModule.default ?? budgetModule;
      const result = ${helper}(${JSON.stringify(prefix)} + '\\u2003'.repeat(200000) + '!',
        new InvoicePdfBudget({ limits: { timeoutMs: 1000 } }));
      console.log(JSON.stringify(result));`;
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: process.cwd(), encoding: "utf8", timeout: 5_000, maxBuffer: 16_384,
    });
    assert.equal(result.error, undefined, "Synchronous matching exceeded the external regression deadline");
    assert.equal(result.status, 0, "Bounded matching must finish without timing out its cooperative budget");
    const parsed: unknown = JSON.parse(result.stdout);
    assert.deepEqual(parsed, helper === "findInvoiceTotal"
      ? { total: null, confidence: "none", matchedLabel: null }
      : { invoiceNumber: null, invoiceNumberConfidence: "none", matchedNumberLabel: null });
  });
}

function linePage(count: number, description = "Synthetic labor"): PositionedText[] {
  const text = (value: string, x: number, row: number): PositionedText => ({ text: value, x, y: 20_000 - row * 10, width: 10 });
  const result = [text("Description", 20, 0), text("Qty", 100, 0), text("Rate", 200, 0), text("Amount", 300, 0)];
  for (let index = 1; index <= count; index += 1) {
    result.push(text(description, 20, index), text("1", 100, index), text("1.00", 200, index), text("1.00", 300, index));
  }
  return result;
}

test("output line and description limits preserve accepted inference and reject excess entries", () => {
  const budget = new InvoicePdfBudget();
  assert.equal(parseInvoicePdfPages([linePage(1_000)], budget).lines.length, 1_000);
  assert.equal(budget.snapshot().outputLines, 1_000);
  assert.throws(() => parseInvoicePdfPages([linePage(1_001)], new InvoicePdfBudget()), code("PDF_OUTPUT_LIMIT"));
  assert.equal(parseInvoicePdfPages([linePage(1, "x".repeat(4_000))], new InvoicePdfBudget()).lines[0].desc.length, 4_000);
  assert.throws(() => parseInvoicePdfPages([linePage(1, "x".repeat(4_001))], new InvoicePdfBudget()), code("PDF_OUTPUT_LIMIT"));
});

test("continued description overflow is rejected before concatenating another output description", () => {
  const page = linePage(1, "x".repeat(2_000));
  page.push({ text: "y".repeat(1_999), x: 20, y: 19_980, width: 10 });
  assert.equal(parseInvoicePdfPages([page], new InvoicePdfBudget()).lines[0].desc.length, 4_000);
  const last = page[page.length - 1];
  last.text += "y";
  assert.throws(() => parseInvoicePdfPages([page], new InvoicePdfBudget()), code("PDF_OUTPUT_LIMIT"));
});

test("pure historical characterization remains available while bounded adapters reject oversized items", () => {
  const pages = [[{ text: "x".repeat(250_010), x: 20, y: 100, width: 10 },
    { text: "Total Due 999.00", x: 20, y: 90, width: 10 }]];
  assert.equal(parseInvoicePdfPages(pages).total, null);
  assert.throws(() => parseInvoicePdfPages(pages, new InvoicePdfBudget()), code("PDF_TEXT_LIMIT"));
});

test("deadline checkpoints and explicit cancellation retain distinct safe outcomes", async () => {
  let clock = 0;
  const budget = new InvoicePdfBudget({ now: () => clock, limits: { timeoutMs: 10 } });
  clock = 10;
  assert.throws(() => budget.checkpoint(), code("PDF_PARSE_TIMEOUT"));
  const controller = new AbortController();
  controller.abort(new Error("Synthetic internal request detail"));
  await assert.rejects(readInvoicePdf(new Uint8Array([1]), loader([[item("Text")]]).load,
    { signal: controller.signal }), error => error instanceof InvoicePdfError && error.code === "REQUEST_ABORTED"
      && !error.message.includes("Synthetic"));
});

test("a pending loading promise times out and its task is destroyed exactly once", async () => {
  let destroyed = 0;
  await assert.rejects(readInvoicePdf(new Uint8Array([1]), async () => ({ getDocument: () => ({
    promise: new Promise<never>(() => undefined), destroy: async () => { destroyed += 1; },
  }) }), { budget: new InvoicePdfBudget({ limits: { timeoutMs: 15 } }) }), code("PDF_PARSE_TIMEOUT"));
  assert.equal(destroyed, 1);
});

test("streamed text is bounded before further reads and releases reader, page and document", async () => {
  let cancelled = 0;
  let cleaned = 0;
  let destroyed = 0;
  let getTextCalls = 0;
  let pulls = 0;
  const stream = new ReadableStream<{ items: Item[] }>({
    pull(controller) {
      pulls += 1;
      controller.enqueue({ items: [item("x".repeat(64_001))] });
    },
    cancel(reason) { assert.ok(reason instanceof Error, "PDF.js cancellation requires an Error reason"); cancelled += 1; },
  }, { highWaterMark: 0 });
  await assert.rejects(readInvoicePdf(new Uint8Array([1]), async () => ({ getDocument: () => ({
    promise: Promise.resolve({ numPages: 1, getPage: async () => ({
      streamTextContent: () => stream,
      getTextContent: async () => { getTextCalls += 1; return { items: [] }; },
      cleanup: () => { cleaned += 1; return true; },
    }) }), destroy: async () => { destroyed += 1; },
  }) })), code("PDF_TEXT_LIMIT"));
  assert.deepEqual({ cancelled, cleaned, destroyed, getTextCalls, pulls, locked: stream.locked },
    { cancelled: 1, cleaned: 1, destroyed: 1, getTextCalls: 0, pulls: 1, locked: false });
});

test("abort during a pending streamed read cancels that reader and releases owned resources", async () => {
  const controller = new AbortController();
  let cancelled = 0;
  let cleaned = 0;
  let destroyed = 0;
  const stream = new ReadableStream<{ items: Item[] }>({
    pull() { queueMicrotask(() => controller.abort()); return new Promise<void>(() => undefined); },
    cancel() { cancelled += 1; },
  }, { highWaterMark: 0 });
  await assert.rejects(readInvoicePdf(new Uint8Array([1]), async () => ({ getDocument: () => ({
    promise: Promise.resolve({ numPages: 1, getPage: async () => ({ streamTextContent: () => stream,
      cleanup: () => { cleaned += 1; return true; } }) }), destroy: async () => { destroyed += 1; },
  }) }), { signal: controller.signal }), code("REQUEST_ABORTED"));
  assert.deepEqual({ cancelled, cleaned, destroyed, locked: stream.locked }, { cancelled: 1, cleaned: 1, destroyed: 1, locked: false });
});

test("cleanup failure remains observable without replacing a timeout as the primary safe result", async () => {
  const budget = new InvoicePdfBudget({ limits: { timeoutMs: 15 } });
  await assert.rejects(readInvoicePdf(new Uint8Array([1]), async () => ({ getDocument: () => ({
    promise: new Promise<never>(() => undefined), destroy: async () => { throw new Error("Synthetic cleanup detail"); },
  }) }), { budget }), error => error instanceof InvoicePdfError && error.code === "PDF_PARSE_TIMEOUT"
    && error.cause instanceof AggregateError && !error.message.includes("Synthetic"));
  assert.equal(budget.cleanupFailed, true);
});

test("hung cleanup has a bounded cooperative wait and cannot report successful extraction", async () => {
  const budget = new InvoicePdfBudget();
  const started = performance.now();
  await assert.rejects(readInvoicePdf(new Uint8Array([1]), async () => ({ getDocument: () => ({
    promise: Promise.resolve({ numPages: 1, getPage: async () => ({ getTextContent: async () => ({ items: [] }) }) }),
    destroy: () => new Promise<void>(() => undefined),
  }) }), { budget }), code("PDF_CLEANUP_FAILED"));
  assert.equal(budget.cleanupFailed, true);
  assert.ok(performance.now() - started < 2_500);
});

test("encrypted input retains its safe category when task cleanup also fails", async () => {
  const password = new Error("Synthetic provider password detail");
  password.name = "PasswordException";
  const budget = new InvoicePdfBudget();
  await assert.rejects(readInvoicePdf(new Uint8Array([1]), async () => ({ getDocument: () => ({
    promise: Promise.reject(password), destroy: async () => { throw new Error("Synthetic cleanup detail"); },
  }) }), { budget }), error => error instanceof InvoicePdfError && error.code === "PDF_ENCRYPTED_UNSUPPORTED"
    && error.cause instanceof AggregateError && !error.message.includes("Synthetic"));
  assert.equal(budget.cleanupFailed, true);
});

test("cooperative deadline and pre-aborted waits observe late provider rejections", async () => {
  let rejectProvider: (error: Error) => void = () => undefined;
  const provider = new Promise<never>((_resolve, reject) => { rejectProvider = reject; });
  await assert.rejects(new InvoicePdfBudget({ limits: { timeoutMs: 10 } }).wait(provider), code("PDF_PARSE_TIMEOUT"));
  rejectProvider(new Error("Synthetic late provider failure"));
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(new InvoicePdfBudget({ signal: controller.signal }).wait(Promise.reject(new Error("Synthetic aborted provider failure"))),
    code("REQUEST_ABORTED"));
  // Node's test runner reports any unhandled rejection from either promise.
  await new Promise<void>(resolve => setImmediate(resolve));
});
const code = (expected: string) => (error: unknown) =>
  error instanceof Error && "code" in error && error.code === expected;

test("PDF resource boundary rejects oversized bytes before calling the provider", async () => {
  const fixture = loader([[item("Total Due 1.00")]]);
  await assert.rejects(readInvoicePdf(new Uint8Array(5 * 1024 * 1024 + 1), fixture.load), code("PDF_TOO_LARGE"));
  assert.equal(fixture.calls(), 0);
});

for (const [name, pages, expected] of [
  ["26 pages rather than silently returning the first 25", Array.from({ length: 26 }, () => [item("Text")]), "PDF_PAGE_LIMIT"],
  ["10,001 raw empty items", [Array.from({ length: 10_001 }, () => item(""))], "PDF_ITEM_LIMIT"],
  ["a 64,001-character item", [[item("x".repeat(64_001))]], "PDF_TEXT_LIMIT"],
  ["100,001 page characters", [[item("x".repeat(50_000)), item("y".repeat(50_001))]], "PDF_TEXT_LIMIT"],
  ["more than 250,000 document characters", Array.from({ length: 3 }, () => [item("x".repeat(45_000)), item("y".repeat(45_000))]), "PDF_TEXT_LIMIT"],
  ["2,001 normalized rows", [Array.from({ length: 2_001 }, (_, index) => item("Text", index))], "PDF_OUTPUT_LIMIT"],
] as const) {
  test(`PDF resource boundary rejects ${name} and destroys the task`, async () => {
    const fixture = loader(pages);
    await assert.rejects(readInvoicePdf(new Uint8Array([1]), fixture.load), code(expected));
    assert.equal(fixture.destroyed(), 1);
  });
}
