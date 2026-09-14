import assert from "node:assert/strict";
import test from "node:test";
import { performance } from "node:perf_hooks";
import { billingRouteHarness } from "./billingFinancialRouteTestHarness";

const uuid = (index: number) => `76100000-0000-4000-8000-${String(index).padStart(12, "0")}`;
const syntheticInvoice = (index: number, contractor: boolean) => ({
  id: uuid(index), num: `SYNTHETIC-${index}`, invoice_type: contractor ? "contractor" : "staff",
  work_order_id: `WOT-SYNTHETIC-${index % 100}`, state: contractor ? "approved" : "submitted",
  invoice_version: 2, document_kind: "invoice", deleted_at: null, store_number: "00000",
  store_address: "Synthetic fixture address", contractor_id: uuid(999), cme: "Synthetic fixture",
  invoice_date: "2026-09-10", service_date: "2026-09-09", due_date: "2026-10-10",
  terms: "Net 30", subtotal: contractor ? 200 : 500, sales_tax: 0, total: contractor ? 200 : 500,
  tax_state: "TX", tax_rate: 0, territory: "Synthetic territory", created_at: "2026-09-10T00:00:00Z",
  updated_at: "2026-09-10T00:00:00Z", internal_private_canary: "SYNTHETIC_PRIVATE_EXTRA_FIELD",
});
function fixture(staffLines = 4, sourceLines = 3, pageSize = 25) {
  const staff = Array.from({ length: pageSize }, (_, index) => syntheticInvoice(index + 1, false));
  const sources = Array.from({ length: pageSize }, (_, index) => syntheticInvoice(index + 101, true));
  const lineRows = [...staff, ...sources].flatMap((invoice, invoiceIndex) => Array.from({
    length: invoice.invoice_type === "staff" ? staffLines : sourceLines,
  }, (_, lineIndex) => ({
    id: uuid(10_000 + invoiceIndex * 100 + lineIndex), invoice_id: invoice.id, position: lineIndex + 1,
    type: lineIndex % 2 ? "Parts" : "Labor", description: `Synthetic line ${lineIndex + 1}: inspect and service test equipment.`,
    qty: 1, rate: 50, amount: 50, is_taxable: false, source_invoice_line_id: null,
    source_work_order_part_id: null, source_unit_cost: invoice.invoice_type === "staff" ? 25 : null,
    markup_percent: invoice.invoice_type === "staff" ? 100 : null,
  })));
  return { staff, sourceLineCount: sourceLines, tableRows: {
    invoices: sources, invoice_lines: lineRows,
    staff_invoice_sources: staff.map((invoice, index) => ({ id: uuid(2000 + index),
      staff_invoice_id: invoice.id, contractor_invoice_id: sources[index].id })),
    work_orders: staff.map(invoice => ({ id: invoice.work_order_id, duplicate_root_work_order_id: null,
      contractor_assignment_version: 2, workflow_cycle: 1 })),
  } };
}
const stats = (values: number[]) => {
  const sorted = values.toSorted((a, b) => a - b);
  return { p50Ms: sorted[Math.ceil(sorted.length * 0.5) - 1],
    p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1], maxMs: sorted.at(-1) };
};

test("real billing GET bounds modern enriched 20/25-row payloads and exposes legacy duplicate-alias overhead", async context => {
  const measurements = [];
  for (const pageSize of [20, 25]) for (const mode of ["rows", "count", "legacy"] as const) {
    const data = fixture(4, 3, pageSize);
    const h = billingRouteHarness({ tableRows: data.tableRows, countResult: { totalCount: 50_000 },
      pageResult: { items: data.staff, hasMore: true, nextCursor: "synthetic-next",
        ...(mode === "legacy" ? { totalCount: 50_000 } : {}) } });
    const query = `?queue=all&limit=${pageSize}${mode === "legacy" ? "" : `&response=${mode}`}`;
    const durations: number[] = []; let bytes = 0;
    for (let iteration = 0; iteration < 17; iteration++) {
      const start = performance.now();
      const response = await h.handlers.GET(h.request("GET", undefined, query));
      assert.equal(response.status, 200); assert.ok(response.headers.get("x-request-id"));
      const buffer = await response.arrayBuffer(); bytes = buffer.byteLength;
      if (iteration >= 2) durations.push(performance.now() - start);
      const serialized = new TextDecoder().decode(buffer);
      assert.ok(!serialized.includes("SYNTHETIC_PRIVATE_EXTRA_FIELD"));
      const body: unknown = JSON.parse(serialized);
      assert.ok(body && typeof body === "object" && "totalCount" in body);
      if (mode === "count") {
        assert.deepEqual(body, { totalCount: 50_000 });
      } else {
        assert.ok("items" in body && Array.isArray(body.items));
        assert.equal(body.items.length, pageSize);
        if (mode === "legacy") { assert.ok("invoices" in body); assert.deepEqual(body.items, body.invoices); }
        else assert.ok(!("invoices" in body), "explicit modern rows serialize the enriched payload only once");
        for (const invoice of body.items as Record<string, unknown>[]) {
          assert.ok(Array.isArray(invoice.lines)); assert.equal(invoice.lines.length, 4);
          assert.ok(Array.isArray(invoice.sourceInvoices)); assert.equal(invoice.sourceInvoices.length, 1);
          assert.equal(invoice.sourceInvoices[0].lines.length, data.sourceLineCount);
          assert.equal(invoice.contractorCost, 200); assert.equal(invoice.grossProfit, 300);
        }
        assert.equal(body.totalCount, mode === "legacy" ? 50_000 : null);
      }
      // Modern rows omit only the duplicate compatibility alias, not invoice
      // content. Legacy 25-row pages remain above the proposed JSON budget;
      // retain that evidence instead of silently shrinking the fixture.
      if (pageSize === 20 || mode !== "legacy") assert.ok(bytes <= 200 * 1024,
        `Current billing ${mode} Response exceeds local 200 KiB fixture budget: ${bytes}`);
      else assert.ok(bytes > 200 * 1024, "25-row fixture must retain the known enriched-payload limitation");
    }
    if (mode === "count") assert.ok(!h.calls.some(call =>
      ["from:invoice_lines", "from:staff_invoice_sources", "from:invoices", "from:work_orders"].includes(call.name)));
    measurements.push({ pageSize, mode, bytes, budget: bytes <= 200 * 1024 ? "PASS" : "EXCEEDS_PROPOSED_PAGE_TARGET", ...stats(durations) });
  }
  context.diagnostic(JSON.stringify({ evidence: "LOCAL_MEASURED_SYNTHETIC_ROUTE", staffInvoices: [20, 25],
    staffLinesPerInvoice: 4, sourceInvoicesPerStaff: 1, sourceLinesPerInvoice: 3,
    measuredIterations: 15, warmupIterations: 2, measurements,
    limitation: "Actual uncompressed Response JSON; legacy retains invoices/items duplication, explicit modern rows serialize items once. No gateway, RLS or browser timing. Per-invoice line/source fanout has no universal response cap." }));
});

test("existing high-fanout billing documents disclose why a bounded invoice page is not a universal byte cap", async context => {
  const data = fixture(20, 10);
  const h = billingRouteHarness({ tableRows: data.tableRows,
    pageResult: { items: data.staff, hasMore: false, nextCursor: null } });
  const response = await h.handlers.GET(h.request("GET", undefined, "?queue=all&limit=25&response=rows"));
  assert.equal(response.status, 200);
  const bytes = (await response.arrayBuffer()).byteLength;
  assert.ok(bytes > 200 * 1024, "Disclosure fixture must expose the inherited enrichment payload limitation");
  context.diagnostic(JSON.stringify({ evidence: "LOCAL_MEASURED_SYNTHETIC_ROUTE", staffInvoices: 25,
    staffLinesPerInvoice: 20, sourceInvoicesPerStaff: 1, sourceLinesPerInvoice: 10, bytes,
    budget: "UNVERIFIED_FOR_UNBOUNDED_DOCUMENT_FANOUT", optimization: "Deferred invoice workspace/read projection design; no business data or response fields removed." }));
});
