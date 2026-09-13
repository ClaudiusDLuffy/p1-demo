import assert from "node:assert/strict";
import test from "node:test";
import { performance } from "node:perf_hooks";
import { billingRouteHarness } from "./billingFinancialRouteTestHarness";
import { parseInvoiceSummary, parseInvoiceSummaryDto } from "../features/invoices/invoiceReadContracts";

const uuid = (index: number) => `76100000-0000-4000-8000-${String(index).padStart(12, "0")}`;
const invoice = (index: number, contractor: boolean) => ({
  id: uuid(index), num: `SYNTHETIC-${index}`, invoice_type: contractor ? "contractor" : "staff",
  work_order_id: `WOT-SYNTHETIC-${index % 100}`, state: contractor ? "approved" : "submitted",
  invoice_version: 2, document_kind: "invoice", deleted_at: null, store_number: "00000",
  store_address: "Synthetic fixture address", contractor_id: uuid(999), cme: "Synthetic fixture",
  invoice_date: "2026-09-10", service_date: "2026-09-09", due_date: "2026-10-10",
  terms: "Net 30", subtotal: contractor ? 200 : 500, sales_tax: 0, total: contractor ? 200 : 500,
  tax_state: "TX", tax_rate: 0, territory: "Synthetic territory", created_at: "2026-09-10T00:00:00Z",
  updated_at: "2026-09-10T00:00:00Z",
});
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");
type Breakdown = Record<"header" | "legacyAliases" | "lines" | "lineDescriptions" | "sources" | "workOrderContext" | "other", number>;
/** Exact JSON-token partition, including property names and punctuation. */
function breakdown(value: unknown): Breakdown {
  const totals: Breakdown = { header: 0, legacyAliases: 0, lines: 0, lineDescriptions: 0, sources: 0, workOrderContext: 0, other: 0 };
  function visit(value: unknown, path: string[], inherited: keyof Breakdown): void {
    if (Array.isArray(value)) {
      totals[inherited] += 2 + Math.max(0, value.length - 1);
      value.forEach((item, index) => visit(item, [...path, String(index)], inherited));
    } else if (value && typeof value === "object") {
      const entries = Object.entries(value);
      totals[inherited] += 2 + Math.max(0, entries.length - 1);
      for (const [key, child] of entries) {
        const alias = key === "invoices" || ["wot", "desc", "invoiceDateRaw", "serviceDateRaw", "dueDateRaw"].includes(key);
        const category: keyof Breakdown = alias ? "legacyAliases"
          : key === "description" && path.includes("lines") ? "lineDescriptions"
          : path.includes("lines") || key === "lines" ? "lines"
          : key === "sourceInvoices" || path.includes("sourceInvoices") || key === "sourceInvoiceIds" ? "sources"
          : ["workOrderId", "externalWorkOrderId", "assignmentVersion", "workflowCycle"].includes(key) ? "workOrderContext"
          : path.includes("items") || path.includes("invoice") ? "header" : inherited;
        totals[category] += bytes(key) + 1;
        if (alias) totals[category] += bytes(child);
        else visit(child, [...path, key], category);
      }
    } else totals[inherited] += bytes(value);
  }
  visit(value, [], "other");
  assert.equal(Object.values(totals).reduce((sum, amount) => sum + amount, 0), bytes(value));
  return totals;
}

test("same high-fanout billing fixture has a compact bounded page without dropping invoices or lines", async context => {
  const staff = Array.from({ length: 25 }, (_, index) => invoice(index + 1, false));
  const sources = Array.from({ length: 25 }, (_, index) => invoice(index + 101, true));
  const lines = [...staff, ...sources].flatMap((row, invoiceIndex) => Array.from({ length: row.invoice_type === "staff" ? 20 : 10 }, (_, lineIndex) => ({
    id: uuid(10_000 + invoiceIndex * 100 + lineIndex), invoice_id: row.id, position: lineIndex + 1,
    type: lineIndex % 2 ? "Parts" : "Labor", description: `Synthetic line ${lineIndex + 1}: inspect and service test equipment.`,
    qty: 1, rate: 50, amount: 50, is_taxable: false, source_invoice_line_id: null,
    source_work_order_part_id: null, source_unit_cost: row.invoice_type === "staff" ? 25 : null,
    markup_percent: row.invoice_type === "staff" ? 100 : null,
  })));
  const original = billingRouteHarness({ tableRows: {
    invoices: sources, invoice_lines: lines,
    staff_invoice_sources: staff.map((row, index) => ({ id: uuid(2000 + index), staff_invoice_id: row.id, contractor_invoice_id: sources[index].id })),
    work_orders: staff.map(row => ({ id: row.work_order_id, duplicate_root_work_order_id: null, contractor_assignment_version: 2, workflow_cycle: 1 })),
  }, compactRpc: name => name === "list_staff_invoices_rows_v1"
    ? { data: { items: staff, hasMore: false, nextCursor: null }, error: null } : undefined });
  const legacyResponse = await original.handlers.GET(original.request("GET", undefined, "?queue=all&limit=25&response=rows"));
  assert.equal(legacyResponse.status, 200);
  const legacyText = await legacyResponse.text();
  const legacyBytes = Buffer.byteLength(legacyText, "utf8");
  const legacyValue = JSON.parse(legacyText) as { items: Record<string, unknown>[] };
  const withoutSourceIds = structuredClone(legacyValue);
  withoutSourceIds.items.forEach(row => delete row.sourceInvoiceIds);
  const withoutMargin = structuredClone(legacyValue);
  withoutMargin.items.forEach(row => delete row.marginPercent);
  context.diagnostic(JSON.stringify({ legacyBytes,
    sourceInvoiceIdsBytes: legacyBytes - Buffer.byteLength(JSON.stringify(withoutSourceIds), "utf8"),
    marginPercentBytes: legacyBytes - Buffer.byteLength(JSON.stringify(withoutMargin), "utf8"),
  }));
  // Preserved Phase7A loadStaffInvoicesPage produces these exact bytes. The
  // earlier 308775 expectation concealed 50 pairs of null versions instead
  // of the verified work-order assignmentVersion:2/workflowCycle:1 facts.
  assert.equal(legacyBytes, 308475, "Verified Phase7A legacy high-fanout serialization");
  for (const row of legacyValue.items) {
    assert.equal(row.assignmentVersion, 2);
    assert.equal(row.workflowCycle, 1);
    assert.ok(Array.isArray(row.lines));
    assert.equal(row.lines.length, 20);
    assert.ok(Array.isArray(row.sourceInvoices));
    assert.equal(row.sourceInvoices.length, 1);
    const source: unknown = row.sourceInvoices[0];
    assert.ok(source && typeof source === "object" && "assignmentVersion" in source && "workflowCycle" in source && "lines" in source);
    assert.equal(source.assignmentVersion, 2);
    assert.equal(source.workflowCycle, 1);
    assert.ok(Array.isArray(source.lines));
    assert.equal(source.lines.length, 10);
  }
  const legacy = legacyValue;
  const rawHeaders = staff.map(row => ({ ...row, projection: "summary", line_count: 20, source_count: 1 }));
  const compact = billingRouteHarness({ compactRpc: name => name === "list_staff_invoices_rows_v2"
    ? { data: { items: rawHeaders, hasMore: false, nextCursor: null }, error: null } : undefined });
  const times: number[] = [];
  let current: { items: { id: string; lineCount: number; total: number }[] } = { items: [] };
  for (let iteration = 0; iteration < 32; iteration++) {
    const started = performance.now();
    const response = await compact.handlers.GET(compact.request("GET", undefined, "?contract=compact-v1&response=rows&queue=all&limit=25"));
    assert.equal(response.status, 200);
    current = await response.json();
    if (iteration >= 2) times.push(performance.now() - started);
  }
  assert.deepEqual(current.items.map(row => row.id), staff.map(row => row.id));
  assert.ok(current.items.every(row => row.lineCount === 20 && row.total === 500 && !("lines" in row)));
  assert.ok(bytes(current) <= 204800);
  assert.equal(lines.length, 750, "Fixture financial records are unchanged; line reachability is verified by SQL pagination tests");
  const componentTimes = { simulatedRpcJsonParse: [] as number[], actualHeaderMapping: [] as number[],
    canonicalJsonSerialization: [] as number[], currentClientValidation: [] as number[] };
  const rawJson = JSON.stringify(rawHeaders);
  for (let iteration = 0; iteration < 32; iteration++) {
    let started = performance.now();
    const decoded: unknown = JSON.parse(rawJson);
    const parseMs = performance.now() - started;
    assert.ok(Array.isArray(decoded));
    started = performance.now();
    const mapped = decoded.map(parseInvoiceSummary);
    const mapMs = performance.now() - started;
    started = performance.now();
    const encoded = JSON.stringify({ projection: "summary", items: mapped, pageSize: 25, nextCursor: null, hasMore: false });
    const serializationMs = performance.now() - started;
    started = performance.now();
    const parsed: { items: unknown[] } = JSON.parse(encoded);
    const validated = parsed.items.map(parseInvoiceSummaryDto);
    const clientMs = performance.now() - started;
    assert.deepEqual(validated, current.items);
    if (iteration >= 2) {
      componentTimes.simulatedRpcJsonParse.push(parseMs);
      componentTimes.actualHeaderMapping.push(mapMs);
      componentTimes.canonicalJsonSerialization.push(serializationMs);
      componentTimes.currentClientValidation.push(clientMs);
    }
  }
  const components = Object.fromEntries(Object.entries(componentTimes).map(([name, values]) => {
    values.sort((a, b) => a - b);
    return [name, { p50Ms: values[14], p95Ms: values[28], maxMs: values[29] }];
  }));
  times.sort((a, b) => a - b);
  context.diagnostic(JSON.stringify({ evidence: "LOCAL_SYNTHETIC_ROUTE", fixture: { invoices: 25, staffLinesEach: 20, sourcesEach: 1, sourceLinesEach: 10 },
    beforeBytes: bytes(legacy), afterBytes: bytes(current), beforeComponents: breakdown(legacy), afterComponents: breakdown(current),
    mapperRouteAndSerialization: { warmups: 2, iterations: 30, p50Ms: times[14], p95Ms: times[28], maxMs: times[29] },
    separateComponents: { warmups: 2, iterations: 30, ...components },
    limitations: "Actual Response JSON with synthetic RPC ports, not database/PostgREST/browser time. SQL harness proves every line remains reachable." }));
});
