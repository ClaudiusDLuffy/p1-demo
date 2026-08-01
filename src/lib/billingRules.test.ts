import assert from "node:assert/strict";
import test from "node:test";
import { stateCodeFromWorkOrder, taxRateFromPercent } from "./billingRules";

test("converts a manually entered tax percentage to a decimal rate", () => {
  assert.equal(taxRateFromPercent("6.125"), 0.06125);
  assert.equal(taxRateFromPercent(0), 0);
});

test("treats an empty manual tax percentage as no override", () => {
  assert.equal(taxRateFromPercent(""), null);
  assert.equal(taxRateFromPercent("  "), null);
  assert.equal(taxRateFromPercent(null), null);
});

test("rejects invalid manual tax percentages", () => {
  assert.throws(() => taxRateFromPercent("-0.01"), /between 0% and 100%/);
  assert.throws(() => taxRateFromPercent("100.01"), /between 0% and 100%/);
  assert.throws(() => taxRateFromPercent("not-a-rate"), /between 0% and 100%/);
});

test("resolves work-order states from canonical data and legacy addresses", () => {
  assert.equal(stateCodeFromWorkOrder({ storeState: "TX" }), "TX");
  assert.equal(
    stateCodeFromWorkOrder({ address: "100 Main St, Dallas, TX 75201" }),
    "TX",
  );
  assert.equal(
    stateCodeFromWorkOrder({ city: "Virginia Beach, VA" }),
    "VA",
  );
});
