import assert from "node:assert/strict";
import test from "node:test";

import {
  billingInvoiceMatchesSearch,
  billingReadyWorkOrderMatchesSearch,
  buildBillingBuckets,
} from "./billingBuckets";

const staff = [
  { id: "draft", invoiceType: "staff", state: "draft", num: "P1-00120" },
  { id: "submit", invoiceType: "staff", state: "submitted", num: "P1-00121" },
  { id: "sent", invoiceType: "staff", state: "approved", num: "P1-00122" },
  { id: "quickbooks", invoiceType: "staff", state: "paid", num: "P1-00123" },
];
const contractor = [
  { id: "source", invoiceType: "contractor", state: "approved", num: "C-55" },
  { id: "pending", invoiceType: "contractor", state: "submitted", num: "C-56" },
];

test("All excludes sent invoices while Sent retains the completed history", () => {
  const buckets = buildBillingBuckets(staff, contractor);
  assert.deepEqual(
    buckets.find(bucket => bucket.id === "all")?.invoices.map(invoice => invoice.id),
    ["draft", "submit"],
  );
  assert.deepEqual(
    buckets.find(bucket => bucket.id === "sent")?.invoices.map(invoice => invoice.id),
    ["sent", "quickbooks"],
  );
  assert.deepEqual(
    buckets.find(bucket => bucket.id === "recently_approved")?.invoices.map(invoice => invoice.id),
    ["source"],
  );
});

test("billing search covers capital documents, source invoices, and Ready to Bill work orders", () => {
  assert.equal(
    billingInvoiceMatchesSearch({
      num: "P1-00124",
      documentKind: "capital_quote",
      sourceInvoices: [{ num: "CON-88" }],
    }, "capital quote"),
    true,
  );
  assert.equal(
    billingInvoiceMatchesSearch({
      num: "P1-00124",
      sourceInvoices: [{ num: "CON-88" }],
    }, "con-88"),
    true,
  );
  assert.equal(
    billingReadyWorkOrderMatchesSearch({
      id: "WOT1134236",
      store: "32914",
      summary: "Billing-only repair",
      status: "pending_invoice",
    }, "billing-only"),
    true,
  );
});
