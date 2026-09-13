import assert from "node:assert/strict";
import test from "node:test";
import { billingRouteHarness, financialTestIds } from "./billingFinancialRouteTestHarness";

const id = financialTestIds.invoice;
const lineId = financialTestIds.operation;
const summary = (extra: Record<string, unknown> = {}) => ({
  projection: "summary", id, num: "P1-SYNTHETIC", state: "submitted", invoice_type: "staff",
  work_order_id: "WOT-SYNTHETIC", invoice_version: 2, subtotal: 500, sales_tax: 25, total: 525,
  line_count: 1_000, source_count: 1, contractor_assignment_version: 2, workflow_cycle: 1,
  internal_secret: "SYNTHETIC_PRIVATE_FIELD", ...extra,
});
const linePage = (extra: Record<string, unknown> = {}) => ({
  projection: "line_page", invoiceVersion: 2, pageSize: 50, hasMore: true, nextCursor: "synthetic-next",
  items: [{ id: lineId, invoice_id: id, position: 1, type: "Labor", description: "Synthetic service",
    qty: 2, rate: 50, amount: 100, is_taxable: false }], ...extra,
});

test("current compact billing list is one rows RPC, no line/detail fanout or duplicate aliases", async () => {
  const h = billingRouteHarness({ compactRpc: name => name === "list_staff_invoices_rows_v2"
    ? { data: { items: [summary()], hasMore: true, nextCursor: "synthetic-next" }, error: null } : undefined });
  const response = await h.handlers.GET(h.request("GET", undefined, "?contract=compact-v1&response=rows"));
  assert.equal(response.status, 200);
  const text = await response.text();
  const body = JSON.parse(text);
  assert.ok(Buffer.byteLength(text) <= 204800);
  assert.deepEqual(Object.keys(body).sort(), ["hasMore", "items", "nextCursor", "pageSize", "projection"]);
  assert.equal(body.items[0].lineCount, 1000);
  assert.equal(body.items[0].total, 525);
  assert.equal(body.items[0].workOrderId, "WOT-SYNTHETIC");
  assert.ok(!("lines" in body.items[0]));
  assert.ok(!("wot" in body.items[0]));
  assert.doesNotMatch(text, /SYNTHETIC_PRIVATE_FIELD|invoice_date_raw|sourceInvoices/);
  assert.deepEqual(h.calls.filter(call => call.name.startsWith("rpc:")).map(call => call.name), ["rpc:list_staff_invoices_rows_v2"]);
  assert.ok(!h.calls.some(call => ["from:invoice_lines", "from:staff_invoice_sources", "from:invoices", "from:work_orders"].includes(call.name)));
});

test("current compact exact billing summary returns authoritative header without full lines", async () => {
  const h = billingRouteHarness({ compactRpc: name => name === "get_invoice_summary_v1" ? { data: summary(), error: null } : undefined });
  const response = await h.handlers.GET(h.request("GET", undefined, `?contract=compact-v1&invoiceId=${id}`));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.invoice.projection, "summary");
  assert.equal(body.invoice.lineCount, 1000);
  assert.equal(body.invoice.total, 525);
  assert.ok(!("lines" in body.invoice));
  assert.equal(h.calls.filter(call => call.name.startsWith("rpc:")).length, 1);
});

for (const cursor of ["", "&cursor=synthetic-previous"]) test(`line page uses one header gate and one bounded RPC, never a count: ${cursor || "first"}`, async () => {
  const h = billingRouteHarness({ tableRows: { invoices: [{ id, invoice_type: "staff", state: "submitted", invoice_version: 2, deleted_at: null }] },
    compactRpc: name => name === "list_invoice_lines_page_v1" ? { data: linePage(), error: null } : undefined });
  const response = await h.handlers.GET(h.request("GET", undefined, `?contract=compact-v1&invoiceId=${id}&lines=1&expectedVersion=2${cursor}`));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.items[0].description, "Synthetic service");
  assert.equal(body.items[0].invoiceId, id);
  assert.ok(!("desc" in body.items[0]));
  assert.ok(!("invoice_id" in body.items[0]));
  assert.equal(body.invoiceVersion, 2);
  assert.equal(h.calls.filter(call => call.name === "from:invoices").length, 1);
  assert.deepEqual(h.calls.filter(call => call.name.startsWith("rpc:")).map(call => call.name), ["rpc:list_invoice_lines_page_v1"]);
  assert.ok(!h.calls.some(call => call.name.includes("count") || call.name.includes("summary") || call.name === "from:invoice_lines"));
});

for (const state of ["draft", "submitted", "rejected"]) test(`controller cannot use new contract to read unauthorized contractor source: ${state}`, async () => {
  const h = billingRouteHarness({ controller: true, compactRpc: name => name === "get_invoice_source_summaries_v1"
    ? { data: { invoices: [summary({ invoice_type: "contractor", state })] }, error: null } : undefined });
  const response = await h.handlers.GET(h.request("GET", undefined, `?contract=compact-v1&sourceInvoiceIds=${id}`));
  assert.equal(response.status, 403);
  assert.doesNotMatch(await response.text(), /P1-SYNTHETIC|SYNTHETIC_PRIVATE_FIELD/);
});
for (const options of [{ authFailure: true }, { active: false }, { role: "contractor" }]) test("compact reads retain current active staff authorization", async () => {
  const h = billingRouteHarness(options);
  const response = await h.handlers.GET(h.request("GET", undefined, "?contract=compact-v1&response=rows"));
  assert.ok([401, 403].includes(response.status));
  assert.ok(!h.calls.some(call => call.name.startsWith("rpc:")));
});

test("missing compact RPC fails safely with correlation and no legacy fallback", async () => {
  const h = billingRouteHarness({ compactRpc: () => ({ data: null, error: { code: "PGRST202", message: "SYNTHETIC_PRIVATE_SQL" } }) });
  const response = await h.handlers.GET(h.request("GET", undefined, "?contract=compact-v1"));
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.equal(body.correlationId, response.headers.get("x-request-id"));
  assert.equal(body.code, "PROVIDER_UNAVAILABLE");
  assert.doesNotMatch(JSON.stringify(body), /SYNTHETIC_PRIVATE_SQL/);
  assert.deepEqual(h.calls.filter(call => call.name.startsWith("rpc:")).map(call => call.name), ["rpc:list_staff_invoices_rows_v2"]);
});
test("revised document rejects continuation before line read; never merges revisions", async () => {
  const h = billingRouteHarness({ tableRows: { invoices: [{ id, invoice_type: "staff", state: "submitted", invoice_version: 3, deleted_at: null }] } });
  const response = await h.handlers.GET(h.request("GET", undefined, `?contract=compact-v1&invoiceId=${id}&lines=1&cursor=synthetic&expectedVersion=2`));
  assert.equal(response.status, 409);
  assert.equal((await response.json()).code, "STALE_VERSION");
  assert.ok(!h.calls.some(call => call.name.startsWith("rpc:")));
});
test("compact count stays independent and does not invoke compact page or summary RPC", async () => {
  const h = billingRouteHarness();
  const response = await h.handlers.GET(h.request("GET", undefined, "?contract=compact-v1&response=count"));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { totalCount: 12 });
  assert.deepEqual(h.calls.filter(call => call.name.startsWith("rpc:")).map(call => call.name), ["rpc:count_staff_invoices_v1"]);
});

test("source import preflight is one compact batch query for 100 headers, not N header requests", async () => {
  const ids = Array.from({ length: 100 }, (_, n) => `76300000-0000-4000-8000-${String(n).padStart(12, "0")}`);
  const h = billingRouteHarness({ compactRpc: name => name === "get_invoice_source_summaries_v1"
    ? { data: { invoices: ids.map(id => summary({ id, invoice_type: "contractor", invoice_version: 0,
      line_count: 10, rejection_reason: "SYNTHETIC_DISCARDED_REASON", source_invoices: [] })) }, error: null } : undefined });
  const response = await h.handlers.GET(h.request("GET", undefined, `?contract=compact-v1&sourceInvoiceIds=${ids.join(",")}`));
  assert.equal(response.status, 200);
  const text = await response.text(); const body = JSON.parse(text);
  assert.ok(Buffer.byteLength(text) <= 204800);
  assert.equal(body.invoices.length, 100);
  assert.deepEqual(Object.keys(body.invoices[0]).sort(), ["id", "invoiceVersion", "lineCount", "num", "salesTax", "state", "subtotal", "total", "workOrderId"].sort());
  assert.doesNotMatch(text, /SYNTHETIC_DISCARDED_REASON|sourceInvoices|source_invoices|lines|internal_secret|rejectionReason/);
  assert.deepEqual(h.calls.filter(call => call.name.startsWith("rpc:")).map(call => call.name), ["rpc:get_invoice_source_summaries_v1"]);
});
for (const returned of [[], [summary({ id: lineId, invoice_type: "contractor" })], [summary(), summary()]]) {
  test("source preflight fails closed on missing/other/duplicated invoice identity", async () => {
    const h = billingRouteHarness({ compactRpc: () => ({ data: { invoices: returned }, error: null }) });
    const response = await h.handlers.GET(h.request("GET", undefined, `?contract=compact-v1&sourceInvoiceIds=${id}`));
    assert.equal(response.status, 404);
    assert.doesNotMatch(await response.text(), /P1-SYNTHETIC/);
  });
}
test("historical version zero remains a valid first line-page version", async () => {
  const h = billingRouteHarness({ tableRows: { invoices: [{ id, invoice_type: "staff", state: "submitted", invoice_version: 0, deleted_at: null }] },
    compactRpc: () => ({ data: linePage({ invoiceVersion: 0 }), error: null }) });
  const response = await h.handlers.GET(h.request("GET", undefined, `?contract=compact-v1&invoiceId=${id}&lines=1&expectedVersion=0`));
  assert.equal(response.status, 200); assert.equal((await response.json()).invoiceVersion, 0);
});
