import assert from "node:assert/strict";
import test from "node:test";
import { invoiceDetailRouteFromUrl } from "./invoiceDetailRoute";

const id = "00000000-0000-4000-8000-000000000001";
const url = `http://localhost/?portal=invoices&invoice=${id}`;
test("invoice-capable actors and staff restore only a valid invoice detail location", () => {
  for (const actor of [{ active: true, canInvoice: true }, { active: true, isManager: true }]) {
    assert.deepEqual(invoiceDetailRouteFromUrl(url, actor), { invoiceId: id });
    assert.equal(invoiceDetailRouteFromUrl(url.replace("invoices", "billing"), actor), null);
    assert.equal(invoiceDetailRouteFromUrl(url.replace(id, "not-a-uuid"), actor), null);
    assert.equal(invoiceDetailRouteFromUrl("not a URL", actor), null);
  }
});
test("anonymous inactive and report-only users cannot restore an invoice location", () => {
  for (const actor of [null, undefined, {}, { active: true, canInvoice: false },
    { active: false, canInvoice: true }, { active: false, isManager: true }]) {
    assert.equal(invoiceDetailRouteFromUrl(url, actor), null);
  }
});
