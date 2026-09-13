import assert from "node:assert/strict";
import test from "node:test";
import { billingRouteHarness, financialTestIds, validBillingRequest } from "./billingFinancialRouteTestHarness";

for (const method of ["POST", "PATCH"] as const) {
  test(`${method} confirmed commit survives detail refresh failure with one command and a safe warning`, async () => {
    const tableRows: Record<string, readonly Record<string, unknown>[]> = {};
    Object.defineProperty(tableRows, "invoices", { get() { throw new Error("synthetic-private-refresh-canary"); } });
    const h = billingRouteHarness({ tableRows, compactRpc(name) {
      if (name === "get_invoice_summary_v1") throw new Error("synthetic-private-refresh-canary");
      return undefined;
    } });
    const response = await h.handlers[method](h.request(method,
      { ...validBillingRequest(), expectedInvoiceVersion: method === "PATCH" ? 1 : null },
      method === "PATCH" ? `?id=${financialTestIds.invoice}` : ""));
    assert.equal(response.status, 200, await response.clone().text());
    const body = await response.json();
    assert.equal(body.command.invoiceId, financialTestIds.invoice);
    assert.equal(body.invoice.id, financialTestIds.invoice);
    assert.equal(body.invoice.num, "P1-SYNTHETIC");
    assert.equal(body.invoice.wot, "WOTSYNTHETIC");
    assert.equal(body.refresh.status, "unavailable");
    assert.equal(body.refresh.warning, "BILLING_REFRESH_UNAVAILABLE");
    assert.equal(h.calls.filter(call => call.name === "rpc:save_staff_billing_invoice_v4").length, 1);
    assert.doesNotMatch(JSON.stringify(body), /synthetic-private-refresh-canary|stack|hint/);
    assert.ok(response.headers.get("x-request-id"));
  });

  test(`${method} mutation refresh uses one compact summary and no invoice-line collector`, async () => {
    const h = billingRouteHarness();
    const response = await h.handlers[method](h.request(method,
      { ...validBillingRequest(), expectedInvoiceVersion: method === "PATCH" ? 1 : null },
      method === "PATCH" ? `?id=${financialTestIds.invoice}` : ""));
    assert.equal(response.status, 200, await response.clone().text());
    const body = await response.json();
    assert.equal(body.invoice.projection, "summary");
    assert.equal(body.invoice.id, financialTestIds.invoice);
    assert.equal(body.invoice.num, "P1-SYNTHETIC");
    assert.equal(body.invoice.wot, "WOTSYNTHETIC");
    assert.equal(body.refresh.status, "available");
    assert.equal(h.calls.filter(call => call.name === "rpc:get_invoice_summary_v1").length, 1);
    assert.equal(h.calls.filter(call => /from:(invoice_lines|staff_invoice_sources)/.test(call.name)).length, 0);
    assert.equal("lines" in body.invoice, false);
    assert.ok(Buffer.byteLength(JSON.stringify(body), "utf8") < 8_192);
  });

  test(`${method} malformed compact refresh is secondary to the committed receipt`, async () => {
    const h = billingRouteHarness({ compactRpc(name) {
      return name === "get_invoice_summary_v1"
        ? { data: { projection: "summary", id: financialTestIds.invoice, state: "impossible", internal_sql_detail: "synthetic-private-canary" }, error: null }
        : undefined;
    } });
    const response = await h.handlers[method](h.request(method,
      { ...validBillingRequest(), expectedInvoiceVersion: method === "PATCH" ? 1 : null },
      method === "PATCH" ? `?id=${financialTestIds.invoice}` : ""));
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.command.invoiceId, financialTestIds.invoice);
    assert.equal(body.refresh.status, "unavailable");
    assert.doesNotMatch(JSON.stringify(body), /internal_sql_detail|synthetic-private-canary|impossible/);
    assert.equal(h.calls.filter(call => call.name === "rpc:save_staff_billing_invoice_v4").length, 1);
  });
}
