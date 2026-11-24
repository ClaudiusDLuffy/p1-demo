import assert from "node:assert/strict";
import test from "node:test";
import { collectListExport, ListExportLimitError } from "./listExport";
import { invoiceListCsv, workOrderListCsv } from "./listExportCsv";

test("collects every scoped page in order, preserves first-seen duplicates, and reports progress", async () => {
  const calls: (string | null)[] = []; const progress: number[] = [];
  const result = await collectListExport(async cursor => {
    calls.push(cursor);
    return cursor === null ? { items: [{ id: "A", amount: 1 }, { id: "B", amount: 2 }], hasMore: true, nextCursor: "next" }
      : { items: [{ id: "B", amount: 99 }, { id: "C", amount: 3 }], hasMore: false, nextCursor: null };
  }, new AbortController().signal, count => progress.push(count));
  assert.deepEqual(calls, [null, "next"]);
  assert.deepEqual(result, [{ id: "A", amount: 1 }, { id: "B", amount: 2 }, { id: "C", amount: 3 }]);
  assert.deepEqual(progress, [2, 3]);
});

test("empty lists produce no rows; an error after page one never returns a partial list", async () => {
  assert.deepEqual(await collectListExport(async () => ({ items: [], hasMore: false, nextCursor: null }),
    new AbortController().signal, () => undefined), []);
  await assert.rejects(collectListExport(async cursor => {
    if (cursor) throw new Error("Synthetic read failure");
    return { items: [{ id: "A" }], hasMore: true, nextCursor: "next" };
  }, new AbortController().signal, () => undefined), /Synthetic read failure/);
});

test("abort before or during a page prevents its result from being used", async () => {
  const before = new AbortController(); before.abort(); let reads = 0;
  await assert.rejects(collectListExport(async () => {
    reads++; return { items: [], hasMore: false, nextCursor: null };
  }, before.signal, () => undefined));
  assert.equal(reads, 0);
  const during = new AbortController(); let progress = 0;
  await assert.rejects(collectListExport(async () => {
    during.abort(); return { items: [{ id: "A" }], hasMore: false, nextCursor: null };
  }, during.signal, () => { progress++; }));
  assert.equal(progress, 0);
});

test("missing/repeated cursors and empty continuation pages fail closed", async () => {
  for (const kind of ["missing", "repeated", "empty"]) {
    let reads = 0;
    await assert.rejects(collectListExport(async () => {
      reads++;
      return { items: kind === "empty" ? [] : [{ id: String(reads) }],
        hasMore: true, nextCursor: kind === "missing" ? null : "same" };
    }, new AbortController().signal, () => undefined));
    assert.ok(reads <= 2);
  }
});

test("10,000 rows succeeds only at a terminal page; oversized lists reject without truncation", async () => {
  for (const [count, hasMore] of [[10_000, false], [10_000, true], [10_001, false]] as const) {
    const action = collectListExport(async () => ({ items: Array.from({ length: count }, (_, index) => ({ id: String(index) })),
      hasMore, nextCursor: hasMore ? "next" : null }), new AbortController().signal, () => undefined);
    if (count === 10_000 && !hasMore) assert.equal((await action).length, count);
    else await assert.rejects(action, ListExportLimitError);
  }
});

test("work-order CSV escapes formulas, quotes, commas, newlines and Unicode and excludes private fields", () => {
  const output = workOrderListCsv([{ id: "WOT-SYNTHETIC", store: "123", priority: "p1", status: "completed",
    city: "Café", summary: '=HYPERLINK("fixture"),\nsecond line',
    secret: "synthetic-secret", pdfStoragePath: "private-path", resolutionNotes: "private-note" }]);
  assert.match(output, /Café/);
  assert.ok(output.includes('"\'=HYPERLINK(""fixture""),\nsecond line"'));
  assert.doesNotMatch(output, /synthetic-secret|private-path|private-note/);
  assert.match(output, /P1 Critical,Completed/);
});

test("invoice CSV exports list amounts and status without inventing payments or exposing storage/operation data", () => {
  const output = invoiceListCsv([{ num: "=SYNTHETIC", wot: "WOT-ONE", invoiceType: "contractor", state: "paid",
    subtotal: 100, salesTax: 0, total: 100, lineCount: 2, pdfStoragePath: "private-path", submissionKey: "private-operation" },
  { num: "STAFF", invoiceType: "staff", state: "approved", total: 25.5 }]);
  assert.match(output, /'=SYNTHETIC/);
  assert.match(output, /Entered in QuickBooks/);
  assert.match(output, /Sent to 7-Eleven/);
  assert.match(output, /100\.00,0\.00,100\.00/);
  assert.doesNotMatch(output, /private-path|private-operation/);
});

test("large CSV content fails rather than downloading a partial or oversized file", () => {
  assert.throws(() => workOrderListCsv(Array.from({ length: 300 }, (_, index) => ({
    id: `SYNTHETIC-${index}`, summary: "x".repeat(40_000),
  }))), ListExportLimitError);
});
