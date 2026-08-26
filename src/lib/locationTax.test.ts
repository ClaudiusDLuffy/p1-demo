import assert from "node:assert/strict";
import test from "node:test";

import { mapVerifiedLocationTaxRate, postalCodeFromAddress } from "./locationTax";

test("extracts a five-digit postal code without treating it as a tax boundary", () => {
  assert.equal(postalCodeFromAddress("100 Main St, Dallas, TX 75201-1234"), "75201");
  assert.equal(postalCodeFromAddress("Dallas, TX"), "");
});

test("accepts only bounded, identified verified location rates", () => {
  assert.deepEqual(mapVerifiedLocationTaxRate({
    id: "rate-1",
    rate: 0.0825,
    effectiveFrom: "2026-07-01",
    sourceName: "Texas Comptroller",
    sourceVersion: "2026 Q3",
    sourceUrl: "https://comptroller.texas.gov/",
    jurisdictions: [{ type: "city", code: "2000000" }],
  }), {
    id: "rate-1",
    rate: 0.0825,
    effectiveFrom: "2026-07-01",
    effectiveTo: null,
    sourceName: "Texas Comptroller",
    sourceVersion: "2026 Q3",
    sourceUrl: "https://comptroller.texas.gov/",
    jurisdictions: [{ type: "city", code: "2000000" }],
  });
  assert.equal(mapVerifiedLocationTaxRate({ id: "", rate: 0.0825 }), null);
  assert.equal(mapVerifiedLocationTaxRate({ id: "x", rate: 1.1 }), null);
});
