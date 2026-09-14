import assert from "node:assert/strict";
import test from "node:test";
import { parseInvoiceSummary, parseInvoiceSummaryDto, parseInvoiceLinePage, invoiceSummaryForLegacyUi,
  invoiceDocumentForLegacyUi, parseInvoiceSourceImportSummary, type InvoiceLinePage } from "./invoiceReadContracts";
import { readCompleteInvoiceDocument, rejectPartialInvoiceDocument } from "./invoiceDocumentRead";
import { matchesRealtimeTarget } from "../../lib/realtime/realtimeInvalidationPlan";
import { directoryActorScope } from "../../lib/counts/queryKeys";

const raw = { projection: "summary", id: "synthetic-invoice", num: "TEST-1", state: "draft", total: 110,
  subtotal: 100, sales_tax: 10, invoice_version: 7, line_count: 2, source_count: 0,
  work_order_id: "WOTTEST001", invoice_date: "2026-09-10", contractor_id: "synthetic-actor",
  description: "never copy", lines: [{ description: "never copy" }], private_field: "never copy" };
const summary = parseInvoiceSummary(raw);
const line = (position: number) => ({ id: `line-${String(position).padStart(4, "0")}`, invoiceId: summary.id,
  position, type: "Labor", description: `Synthetic ${position}`, qty: 1, rate: 50, amount: 50,
  isTaxable: false, sourceInvoiceLineId: null, sourceWorkOrderPartId: null, sourceUnitCost: null, markupPercent: null });
const page = (positions: number[], hasMore = false, cursor: string | null = null): InvoiceLinePage => ({
  projection: "line_page", invoiceVersion: 7, items: positions.map(line), pageSize: 50, hasMore, nextCursor: cursor });

test("summary is allowlisted, canonical, count-bearing and never masquerades as full lines", () => {
  assert.equal(summary.lineCount, 2);
  assert.equal(summary.workOrderId, "WOTTEST001");
  assert.equal(summary.invoiceDate, "2026-09-10");
  for (const key of ["lines", "wot", "desc", "description", "private_field", "invoiceDateRaw"]) assert.equal(key in summary, false);
  assert.deepEqual(parseInvoiceSummaryDto(summary), summary);
  assert.equal(invoiceSummaryForLegacyUi(summary).wot, summary.workOrderId);
  assert.throws(() => rejectPartialInvoiceDocument(summary));
  assert.doesNotThrow(() => rejectPartialInvoiceDocument({ projection: "complete_document", lines: [] }));
});

for (const change of [{ invoice_version: -1 }, { line_count: -1 }, { source_invoice_ids: Array(101).fill("source") },
  { line_type_summary: { categories: Array(7).fill({}) } }, { projection: "complete_document" }, { total: "NaN" }]) {
  test(`invalid compact invoice field is rejected: ${Object.keys(change)[0]}`, () => assert.throws(() => parseInvoiceSummary({ ...raw, ...change })));
}

test("line page maps only canonical fields and permits byte-limited fewer-than-pageSize continuation", () => {
  const mapped = parseInvoiceLinePage({ projection: "line_page", invoiceVersion: 7, pageSize: 50, hasMore: true, nextCursor: "cursor",
    items: [{ ...line(0), invoice_id: summary.id, description: "\u0001".repeat(4000), is_taxable: true,
      source_invoice_line_id: null, source_work_order_part_id: null, source_unit_cost: null, markup_percent: null, raw_secret: "discard" }] });
  assert.equal(mapped.items.length, 1);
  assert.equal(mapped.items[0].description?.length, 4000);
  assert.equal("desc" in mapped.items[0], false);
  assert.equal("raw_secret" in mapped.items[0], false);
  assert.equal(mapped.hasMore, true);
  assert.throws(() => parseInvoiceLinePage({ ...mapped, items: [], hasMore: true }, false));
  assert.throws(() => parseInvoiceLinePage({ ...mapped, nextCursor: null }, false));
});
test("historical version zero, nullable totals and descriptions, and signed positions remain readable", () => {
  const historical = parseInvoiceSummary({ ...raw, invoice_version: 0, subtotal: null, sales_tax: null, total: null });
  assert.equal(historical.invoiceVersion, 0); assert.equal(historical.total, 0);
  const nullable = parseInvoiceLinePage({ ...page([]), invoiceVersion: 0,
    items: [{ ...line(-3), description: null }] }, false);
  assert.equal(nullable.items[0].position, -3); assert.equal(nullable.items[0].description, null);
  const long = parseInvoiceLinePage({ ...page([]), items: [{ ...line(0), description: "x".repeat(80_000) }] }, false);
  assert.equal(long.items[0].description?.length, 80_000);
  assert.throws(() => parseInvoiceLinePage({ ...page([]), items: [{ ...line(0), description: "x".repeat(205_000) }] }, false));
});

test("missing authoritative totals reject rather than masquerading as financial zero", () => {
  for (const field of ["subtotal", "sales_tax", "total"] as const) {
    const incomplete: Record<string, unknown> = { ...raw };
    delete incomplete[field];
    assert.throws(() => parseInvoiceSummary(incomplete));
  }
  for (const field of ["subtotal", "salesTax", "total"] as const) {
    const incomplete: Record<string, unknown> = { ...summary };
    delete incomplete[field];
    assert.throws(() => parseInvoiceSummaryDto(incomplete));
    assert.throws(() => parseInvoiceSourceImportSummary(incomplete));
  }
  const legacyNullSource = parseInvoiceSourceImportSummary({ ...summary, subtotal: null, salesTax: null, total: null });
  assert.equal(legacyNullSource.subtotal, 0);
  assert.equal(legacyNullSource.salesTax, 0);
  assert.equal(legacyNullSource.total, 0);
});

test("financial numeric strings accept decimal/exponent syntax but never JavaScript coercion", () => {
  for (const value of ["", " ", "\t", " 1", "1 ", "0x10", "0b10", "0o10", "1_000", "Infinity", "NaN", "1e309", "--1", "+"]) {
    assert.throws(() => parseInvoiceSummary({ ...raw, total: value }));
    assert.throws(() => parseInvoiceSourceImportSummary({ ...summary, subtotal: value }));
    assert.throws(() => parseInvoiceLinePage({ ...page([]), items: [{ ...line(0), qty: value }] }, false));
  }
  for (const value of ["0", "-0", "-12.50", "+12.50", ".5", "1.", "1.25e2", "-5E-2"]) {
    assert.equal(parseInvoiceSummary({ ...raw, total: value }).total, Number(value));
  }
});

test("complete document explicitly collects all version-bound pages and preserves stored totals", async () => {
  const cursors: (string | null)[] = [];
  const result = await readCompleteInvoiceDocument({ purpose: "edit", signal: new AbortController().signal,
    summary: async () => summary, page: async (version, cursor) => {
      assert.equal(version, 7); cursors.push(cursor);
      return cursor === null ? page([0], true, "next") : page([1]);
    } });
  assert.ok(result);
  assert.deepEqual(cursors, [null, "next"]);
  assert.equal(result.lines.length, 2);
  assert.equal(result.total, 110);
  assert.equal(result.projection, "complete_document");
  assert.equal(invoiceDocumentForLegacyUi(result).lines[1].desc, "Synthetic 1");
});

const failurePages: [string, InvoiceLinePage][] = [
  ["version changes", { ...page([0, 1]), invoiceVersion: 8 }],
  ["missing final row", page([0])], ["duplicate row", page([0, 0])], ["reversed order", page([1, 0])],
  ["wrong invoice", { ...page([0, 1]), items: [{ ...line(0), invoiceId: "other" }, line(1)] }],
];
for (const [name, changed] of failurePages) {
  test(`full-document failure never returns partial data: ${name}`, async () => {
    await assert.rejects(readCompleteInvoiceDocument({ purpose: "pdf", signal: new AbortController().signal,
      summary: async () => summary, page: async () => changed }));
  });
}
test("replayed cursors and over-1000-line documents are rejected without an unbounded collector", async () => {
  let calls = 0;
  await assert.rejects(readCompleteInvoiceDocument({ purpose: "edit", signal: new AbortController().signal,
    summary: async () => ({ ...summary, lineCount: 1001 }), page: async () => { calls++; return page([]); } }));
  assert.equal(calls, 0);
  await assert.rejects(readCompleteInvoiceDocument({ purpose: "edit", signal: new AbortController().signal,
    summary: async () => summary, page: async () => page([calls++], true, "repeat") }));
  assert.equal(calls, 2);
});
test("aborted full-document response is discarded before any partial result", async () => {
  const controller = new AbortController();
  await assert.rejects(readCompleteInvoiceDocument({ purpose: "source_import", signal: controller.signal,
    summary: async () => summary, page: async () => { controller.abort(); return page([0, 1]); } }));
});
test("empty document still checks its version once", async () => {
  let calls = 0;
  const result = await readCompleteInvoiceDocument({ purpose: "csv", signal: new AbortController().signal,
    summary: async () => ({ ...summary, lineCount: 0 }), page: async () => { calls++; return page([]); } });
  assert.equal(calls, 1); assert.equal(result?.lines.length, 0);
});
test("exact line-page keys remain in one actor-scoped Realtime invoice family", () => {
  const actor = { id: "actor", role: "manager", active: true };
  const key = ["invoice-by-id", "invoice", directoryActorScope(actor), "lines-v1", 7, "cursor"];
  assert.equal(matchesRealtimeTarget(key, { family: "invoice_detail", id: "invoice" }, actor), true);
  assert.equal(matchesRealtimeTarget(key, { family: "invoice_detail", id: "other" }, actor), false);
  assert.equal(matchesRealtimeTarget(key, { family: "invoice_detail", id: "invoice" }, { ...actor, id: "other-actor" }), false);
  assert.equal(matchesRealtimeTarget(key, { family: "financial" }, actor), false);
});
