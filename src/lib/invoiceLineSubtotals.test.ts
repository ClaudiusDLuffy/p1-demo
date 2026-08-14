import assert from "node:assert/strict";
import test from "node:test";

import { summarizeInvoiceLineTypes } from "./invoiceLineSubtotals";

test("invoice line subtotals use P1 sell prices and the requested category order", () => {
  const summary = summarizeInvoiceLineTypes([
    { type: "Parts/Hardware", qty: 2, rate: 125, amount: 1 },
    { type: "Travel", qty: 1, rate: 110 },
    { type: "Labor", qty: 1.25, rate: 110 },
    { type: "Overtime Labor", qty: 0.5, rate: 165 },
    { type: "Shipping", qty: 1, rate: 20 },
    { type: "Permit", qty: 1, rate: 35 },
  ], 38.4);

  assert.deepEqual(
    summary.categories.map(category => [category.label, category.amount]),
    [
      ["Labor", 137.5],
      ["OT labor", 82.5],
      ["Travel", 110],
      ["Parts", 250],
      ["Shipping", 20],
      ["Other", 35],
    ],
  );
  assert.equal(summary.subtotal, 635);
  assert.equal(summary.salesTax, 38.4);
  assert.equal(summary.grandTotal, 673.4);
});

test("invoice line subtotals omit categories the invoice does not contain", () => {
  const summary = summarizeInvoiceLineTypes([
    { type: "Labor", quantity: "2", unitPrice: "110" },
  ], -5);

  assert.deepEqual(summary.categories.map(category => category.category), ["Labor"]);
  assert.equal(summary.categories[0]?.lineCount, 1);
  assert.equal(summary.subtotal, 220);
  assert.equal(summary.salesTax, 0);
  assert.equal(summary.grandTotal, 220);
});
