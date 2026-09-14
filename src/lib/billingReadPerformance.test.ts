import assert from "node:assert/strict";
import test from "node:test";
import { billingRouteHarness } from "./billingFinancialRouteTestHarness";

test("billing old first-page response is unchanged, new and legacy continuation never call full-count RPC", async () => {
  for (const [query, expected] of [
    ["?queue=all", "list_staff_invoices_page"],
    ["?queue=all&response=rows", "list_staff_invoices_rows_v1"],
    ["?queue=all&cursor=synthetic", "list_staff_invoices_rows_v1"],
    ["?queue=all&cursor=synthetic&response=rows", "list_staff_invoices_rows_v1"],
  ]) {
    const h = billingRouteHarness();
    const response = await h.handlers.GET(h.request("GET", undefined, query));
    assert.equal(response.status, 200);
    assert.match(response.headers.get("x-request-id") || "", /\S+/);
    assert.deepEqual(h.calls.filter(call => call.name.startsWith("rpc:")).map(call => call.name), [`rpc:${expected}`]);
    assert.deepEqual(await response.json(), { ...(query.includes("response=rows") ? {} : { invoices: [] }), items: [], hasMore: false, nextCursor: null,
      totalCount: expected === "list_staff_invoices_page" ? 0 : null });
  }
});
test("billing visible count is one focused request with no row enrichment", async () => {
  const h = billingRouteHarness({ controller: true });
  const response = await h.handlers.GET(h.request("GET", undefined, "?response=count&queue=submitted&search=SYNTHETIC"));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { totalCount: 12 });
  assert.deepEqual(JSON.parse(JSON.stringify(h.calls.filter(call => call.name.startsWith("rpc:")))), [{ name: "rpc:count_staff_invoices_v1",
    payload: { p_queue: "submitted", p_search: "SYNTHETIC", p_work_order_id: null } }]);
  assert.ok(!h.calls.some(call => ["from:invoices", "from:invoice_lines", "from:staff_invoice_sources", "from:work_orders"].includes(call.name)));
});
for (const options of [{ authFailure: true }, { active: false }, { role: "contractor" }, { role: "technician" }]) {
  test(`billing rows and count recheck current authority ${JSON.stringify(options)}`, async () => {
    for (const mode of ["rows", "count"]) {
      const h = billingRouteHarness(options);
      const response = await h.handlers.GET(h.request("GET", undefined, `?response=${mode}`));
      assert.ok([401, 403].includes(response.status));
      assert.ok(!h.calls.some(call => call.name.startsWith("rpc:")));
    }
  });
}
for (const query of ["response=count&cursor=opaque", "response=rows&limit=101", "response=rows&queue=other", "response=count&search=%00"]) {
  test(`invalid billing count/read scope fails before page/count DB access: ${query}`, async () => {
    const h = billingRouteHarness();
    const response = await h.handlers.GET(h.request("GET", undefined, `?${query}`));
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(body.code, "INVALID_REQUEST");
    assert.equal(body.correlationId, response.headers.get("x-request-id"));
    assert.ok(!h.calls.some(call => call.name.startsWith("rpc:")));
  });
}
test("count mapper and query failure retain safe errors, never synthetic private detail or false zero", async () => {
  for (const options of [{ countResult: { totalCount: "12" } }, { readError: { code: "XX000", message: "PRIVATE_SYNTHETIC_SQL_DETAIL" } }]) {
    const h = billingRouteHarness(options);
    const response = await h.handlers.GET(h.request("GET", undefined, "?response=count"));
    assert.equal(response.status, 500);
    const text = await response.text();
    assert.doesNotMatch(text, /PRIVATE_SYNTHETIC_SQL_DETAIL|totalCount/);
    assert.match(text, /correlationId/);
  }
});
