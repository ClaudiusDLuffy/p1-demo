import assert from "node:assert/strict";
import test from "node:test";
import {
  invoiceQuantityInputConstraints,
  isLaborInvoiceLineType,
  QUARTER_HOUR_QUANTITY,
} from "./invoiceQuantity";

test("recognizes regular and overtime labor line types", () => {
  assert.equal(isLaborInvoiceLineType("Labor"), true);
  assert.equal(isLaborInvoiceLineType("OT Labor"), true);
  assert.equal(isLaborInvoiceLineType("Parts/Hardware"), false);
});

test("uses quarter-hour quantities for labor without restricting other units", () => {
  assert.deepEqual(invoiceQuantityInputConstraints("Labor"), {
    min: QUARTER_HOUR_QUANTITY,
    step: QUARTER_HOUR_QUANTITY,
  });
  assert.deepEqual(invoiceQuantityInputConstraints("Parts/Hardware"), {
    min: 0.01,
    step: "any",
  });
});
