import assert from "node:assert/strict";
import test from "node:test";

import {
  assertStaffInvoiceIntegrity,
  inspectStaffInvoiceIntegrity,
} from "./staffInvoiceIntegrity";

test("accepts a staff invoice whose persisted lines reconcile to its totals", () => {
  const result = inspectStaffInvoiceIntegrity({
    num: "P1-TEST",
    subtotal: 124.5,
    salesTax: 1.25,
    total: 125.75,
    lines: [
      { qty: 1, rate: 110 },
      { qty: 2, rate: 7.25 },
    ],
  });

  assert.deepEqual(result, {
    ok: true,
    lineCount: 2,
    calculatedSubtotal: 124.5,
    calculatedTotal: 125.75,
    reason: null,
  });
});

test("blocks a header-only invoice from producing an external document", () => {
  assert.throws(
    () => assertStaffInvoiceIntegrity({
      num: "P1-GHOST",
      subtotal: 330,
      salesTax: 0,
      total: 330,
      lines: [],
    }),
    /cannot be exported because no persisted line items were returned/i,
  );
});

test("blocks an invoice when a displayed total outlives a missing part line", () => {
  const result = inspectStaffInvoiceIntegrity({
    num: "P1-MISMATCH",
    subtotal: 124.5,
    salesTax: 0,
    total: 124.5,
    lines: [{ qty: 1, rate: 110 }],
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "the stored subtotal does not match the line items");
});

test("allows ordinary floating-point rounding within one cent", () => {
  const result = inspectStaffInvoiceIntegrity({
    num: "P1-ROUND",
    subtotal: 0.3,
    salesTax: 0,
    total: 0.3,
    lines: [{ qty: 3, rate: 0.1 }],
  });

  assert.equal(result.ok, true);
});

test("allows a historical informational line with a zero rate", () => {
  const result = inspectStaffInvoiceIntegrity({
    num: "P1-NO-CHARGE",
    subtotal: 110,
    salesTax: 0,
    total: 110,
    lines: [
      { qty: 1, rate: 110 },
      { qty: 1, rate: 0 },
    ],
  });

  assert.equal(result.ok, true);
});
