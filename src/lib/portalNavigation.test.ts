import assert from "node:assert/strict";
import test from "node:test";
import {
  PORTAL_HISTORY_KEY,
  portalUrlForView,
  portalViewFromHistoryState,
  portalViewKey,
} from "./portalNavigation";

const view = {
  page: "invoices",
  selectedWorkOrderId: null,
  selectedInvoiceId: "invoice-1",
  selectedBillingInvoiceId: null,
  returnWorkOrderId: "WOT123",
  returnWorkOrderPage: "work_orders",
};

test("portal history state round-trips nullable view fields", () => {
  assert.deepEqual(
    portalViewFromHistoryState({ [PORTAL_HISTORY_KEY]: view }),
    view,
  );
  assert.equal(portalViewFromHistoryState({}), null);
});

test("portal URL keeps unrelated query parameters", () => {
  assert.equal(
    portalUrlForView("https://portal.test/?demo=true", view),
    "/?demo=true&portal=invoices&invoice=invoice-1&returnWo=WOT123&returnPage=work_orders",
  );
});

test("portal view keys change when return context changes", () => {
  assert.notEqual(
    portalViewKey(view),
    portalViewKey({ ...view, returnWorkOrderId: null }),
  );
});
