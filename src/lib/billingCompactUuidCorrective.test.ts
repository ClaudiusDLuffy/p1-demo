import assert from "node:assert/strict";
import test from "node:test";
import { canonicalBillingReadUuid } from "../features/billing/billingReadUuid";
import { billingInvoiceByIdKey } from "../features/billing/billingQueryKeys";
import { parseCompactBillingRead } from "./server/billingCompactReadInput";
import { billingRouteHarness } from "./billingFinancialRouteTestHarness";

globalThis.fetch = async () => { throw new Error("Synthetic billing UUID tests forbid network access"); };

const id = "b7300000-abcd-4000-8abc-000000000001";
const otherId = "b7300000-abcd-4000-8abc-000000000002";
const lineId = "b730000a-abcd-4000-8abc-000000000003";
const nextLineId = "b730000b-abcd-4000-8abc-000000000004";
const spellings = [id, id.toUpperCase(), "b7300000-AbCd-4000-8aBC-000000000001"];
type Mode = "summary" | "sources" | "lines";
const summary = (invoiceId: string, mode: Mode) => ({
  projection: "summary", id: invoiceId, num: "P1-SYNTHETIC", state: mode === "sources" ? "approved" : "draft",
  invoice_type: mode === "sources" ? "contractor" : "staff", work_order_id: "WOT-CaseSensitive-SYNTHETIC",
  invoice_version: 2, subtotal: 10, sales_tax: 0, total: 10, line_count: 1, source_count: 0,
});
const line = (invoiceId = id, ownId = lineId, position = 1) => ({ id: ownId, invoice_id: invoiceId,
  position, type: "Labor", description: "Synthetic service", qty: 1, rate: 10, amount: 10, is_taxable: false });
const linePage = (items = [line()]) => ({ projection: "line_page", invoiceVersion: 2, pageSize: 50,
  items, hasMore: false, nextCursor: null });
function query(mode: Mode, invoiceId: string, cursor?: string) {
  const params = new URLSearchParams({ contract: "compact-v1" });
  params.set(mode === "sources" ? "sourceInvoiceIds" : "invoiceId", invoiceId);
  if (mode === "lines") { params.set("lines", "1"); params.set("expectedVersion", "2"); }
  if (cursor !== undefined) params.set("cursor", cursor);
  return `?${params}`;
}
function harness(mode: Mode, returnedId = id, items = [line(returnedId)]) {
  return billingRouteHarness({
    tableRows: { invoices: [{ id: returnedId, invoice_type: "staff", state: "draft", invoice_version: 2, deleted_at: null }] },
    compactRpc: name => {
      if (name === "get_invoice_summary_v1") return { data: summary(returnedId, mode), error: null };
      if (name === "get_invoice_source_summaries_v1") return { data: { invoices: [summary(returnedId, mode)] }, error: null };
      if (name === "list_invoice_lines_page_v1") return { data: linePage(items), error: null };
      return undefined;
    },
  });
}

test("R3 UUID canonicalizer preserves exact legacy hex/version/variant acceptance without coercion", () => {
  for (const value of spellings) assert.equal(canonicalBillingReadUuid(value), id);
  for (const value of ["00000000-0000-0000-0000-000000000000", "ffffffff-ffff-ffff-ffff-ffffffffffff"]) {
    assert.equal(canonicalBillingReadUuid(value.toUpperCase()), value, "No new version or variant restriction");
  }
  for (const value of [undefined, null, 1, {}, "", ` ${id}`, `${id} `, `${id}\n`, `${id}\r`, `${id}\r\n`, `{${id}}`,
    `urn:uuid:${id}`, id.replaceAll("-", ""), `${id}0`, id.slice(1), id.replace("b", "g")]) {
    assert.equal(canonicalBillingReadUuid(value), null, `Strict rejection: ${String(value)}`);
  }
});

for (const mode of ["summary", "sources", "lines"] as const) {
  test(`R3 compact ${mode} binds lowercase/uppercase/mixed input and returned UUIDs canonically`, async () => {
    for (const requestedId of spellings) for (const returnedId of spellings) {
      const h = harness(mode, returnedId);
      const response = await h.handlers.GET(h.request("GET", undefined, query(mode, requestedId)));
      assert.equal(response.status, 200, `${requestedId} -> ${returnedId}`);
      const body = await response.json();
      assert.equal(mode === "summary" ? body.invoice.id : mode === "sources" ? body.invoices[0].id : body.items[0].invoiceId, id);
      if (mode !== "lines") assert.equal(mode === "summary" ? body.invoice.workOrderId : body.invoices[0].workOrderId, "WOT-CaseSensitive-SYNTHETIC");
      const rpc = h.calls.find(call => call.name.startsWith("rpc:"));
      assert.ok(rpc);
      assert.deepEqual(rpc.payload, mode === "sources" ? { p_invoice_ids: [id] }
        : mode === "summary" ? { p_invoice_id: id }
        : { p_invoice_id: id, p_limit: 50, p_cursor: null, p_expected_version: 2 });
      assert.equal(h.calls.filter(call => call.name.startsWith("rpc:")).length, 1);
      assert.equal(h.calls.filter(call => call.name === "from:invoices").length, mode === "lines" ? 1 : 0);
    }
  });

  test(`R3 compact ${mode} malformed UUIDs are rejected before authorization/query calls`, async () => {
    for (const invalid of ["", ` ${id}`, `${id} `, `${id}\n`, `${id}\r`, `${id}\r\n`, `{${id}}`, `urn:uuid:${id}`, id.replaceAll("-", ""), `${id}0`, id.replace("b", "g")]) {
      const h = harness(mode);
      const response = await h.handlers.GET(h.request("GET", undefined, query(mode, invalid)));
      assert.equal(response.status, 400);
      const body = await response.json();
      assert.equal(body.code, "INVALID_REQUEST");
      assert.equal(body.correlationId, response.headers.get("x-request-id"));
      assert.equal(h.calls.length, 0);
    }
  });

  test(`R3 compact ${mode} genuinely different UUID remains a non-leaking not-found`, async () => {
    const h = harness(mode, otherId);
    const response = await h.handlers.GET(h.request("GET", undefined, query(mode, id.toUpperCase())));
    assert.equal(response.status, 404);
    const text = await response.text();
    assert.equal(JSON.parse(text).code, "NOT_FOUND");
    assert.doesNotMatch(text, /P1-SYNTHETIC|WOT-CaseSensitive/);
  });
}

test("R3 case-equivalent duplicate sources reject before query and distinct sources keep selection order", async () => {
  const h = harness("sources");
  const response = await h.handlers.GET(h.request("GET", undefined, query("sources", `${id},${id.toUpperCase()}`)));
  assert.equal(response.status, 400); assert.equal(h.calls.length, 0);
  assert.deepEqual(parseCompactBillingRead(new URLSearchParams(query("sources", `${otherId.toUpperCase()},${id}`).slice(1))),
    { kind: "sources", invoiceIds: [otherId, id] });
  const duplicate = billingRouteHarness({ compactRpc: () => ({ data: { invoices: [summary(id, "sources"), summary(id.toUpperCase(), "sources")] }, error: null }) });
  const denied = await duplicate.handlers.GET(duplicate.request("GET", undefined, query("sources", `${id},${otherId}`)));
  assert.equal(denied.status, 404, "Case cannot disguise duplicate returned sources");
});

test("R3 line UUID normalization precedes same-parent ordering and duplicate validation", async () => {
  const h = harness("lines", id.toUpperCase(), [line(id.toUpperCase(), lineId, 1), line(id, nextLineId.toUpperCase(), 1)]);
  const response = await h.handlers.GET(h.request("GET", undefined, query("lines", spellings[2])));
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).items.map((item: { id: string; invoiceId: string }) => [item.id, item.invoiceId]),
    [[lineId, id], [nextLineId, id]]);
  for (const items of [[line(), line(id.toUpperCase(), lineId.toUpperCase(), 1)], [line(id, "not-a-uuid")]]) {
    const invalid = harness("lines", id, items);
    const result = await invalid.handlers.GET(invalid.request("GET", undefined, query("lines", id)));
    assert.equal(result.status, 500); assert.equal((await result.json()).code, "INTERNAL_ERROR");
  }
  const foreign = harness("lines", id, [line(otherId)]);
  const result = await foreign.handlers.GET(foreign.request("GET", undefined, query("lines", id)));
  assert.equal(result.status, 409); assert.equal((await result.json()).code, "STALE_VERSION");
});

test("R3 uppercase line continuation preserves opaque cursor and authoritative version binding", async () => {
  const cursor = "opaque-SYNTHETIC+/==";
  const h = harness("lines");
  const response = await h.handlers.GET(h.request("GET", undefined, query("lines", id.toUpperCase(), cursor)));
  assert.equal(response.status, 200);
  assert.deepEqual(h.calls.find(call => call.name === "rpc:list_invoice_lines_page_v1")?.payload,
    { p_invoice_id: id, p_limit: 50, p_cursor: cursor, p_expected_version: 2 });
  const stale = billingRouteHarness({ tableRows: { invoices: [{ id, invoice_type: "staff", state: "draft", invoice_version: 3, deleted_at: null }] } });
  const staleResponse = await stale.handlers.GET(stale.request("GET", undefined, query("lines", id.toUpperCase(), cursor)));
  assert.equal(staleResponse.status, 409); assert.equal((await staleResponse.json()).code, "STALE_VERSION");
  assert.equal(stale.calls.filter(call => call.name.startsWith("rpc:")).length, 0);
  const invalid = harness("lines");
  const invalidResponse = await invalid.handlers.GET(invalid.request("GET", undefined, query("lines", id.toUpperCase(), " ")));
  assert.equal(invalidResponse.status, 400); assert.equal((await invalidResponse.json()).code, "INVALID_CURSOR");
  assert.equal(invalid.calls.length, 0);
});

test("R3 canonical UUIDs do not widen active staff/controller source permissions", async () => {
  for (const mode of ["summary", "sources", "lines"] as const) {
    for (const options of [{ active: false }, { role: "contractor" }, { authFailure: true }]) {
      const h = billingRouteHarness(options);
      const response = await h.handlers.GET(h.request("GET", undefined, query(mode, id.toUpperCase())));
      assert.ok([401, 403].includes(response.status));
      assert.equal(h.calls.filter(call => call.name.startsWith("rpc:")).length, 0);
    }
    const h = billingRouteHarness({ controller: true,
      tableRows: { invoices: [{ id, invoice_type: "contractor", state: "draft", invoice_version: 2, deleted_at: null }] },
      compactRpc: () => ({ data: mode === "sources" ? { invoices: [{ ...summary(id, mode), state: "draft" }] }
        : { ...summary(id, mode), invoice_type: "contractor", state: "draft" }, error: null }) });
    const response = await h.handlers.GET(h.request("GET", undefined, query(mode, id.toUpperCase())));
    assert.equal(response.status, 403);
  }
});

test("R3 exact billing cache identity canonicalizes UUID spelling without changing scope or prefixes", () => {
  for (const spelling of spellings) assert.deepEqual(billingInvoiceByIdKey(spelling, "actor-scope"),
    ["billing-invoice-by-id", id, "actor-scope"]);
  assert.notDeepEqual(billingInvoiceByIdKey(id, "actor-scope"), billingInvoiceByIdKey(id, "other-scope"));
  assert.deepEqual(billingInvoiceByIdKey("", "actor-scope"), ["billing-invoice-by-id", "", "actor-scope"]);
});
