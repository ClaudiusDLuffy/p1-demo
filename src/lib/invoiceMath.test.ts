import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeInvoiceLineNumbers,
  roundInvoiceNumber,
} from "./invoiceMath";

test("rounds rates with more than two decimals instead of rejecting them", () => {
  assert.equal(roundInvoiceNumber(4.286), 4.29);
  assert.equal(roundInvoiceNumber("4.284"), 4.28);
});

test("normalizes invoice quantities and rates to database precision", () => {
  assert.deepEqual(
    normalizeInvoiceLineNumbers({ type: "Labor", qty: 1.005, rate: 110.127 }),
    { type: "Labor", qty: 1.01, rate: 110.13 },
  );
});

