import assert from "node:assert/strict";
import test from "node:test";
import {
  importedStaffBillingRate,
  normalizeStaffBillingLineType,
} from "./staffBilling";

test("normalizes overtime labor before generic labor", () => {
  assert.equal(normalizeStaffBillingLineType("OT Labor"), "OT Labor");
  assert.equal(normalizeStaffBillingLineType("overtime labor"), "OT Labor");
});

test("imports fixed labor and travel rates without markup", () => {
  assert.equal(importedStaffBillingRate("Labor", 80), 110);
  assert.equal(importedStaffBillingRate("Travel", 45), 110);
  assert.equal(importedStaffBillingRate("OT Labor", 120), 165);
});

test("applies the adjustable markup only to imported parts", () => {
  assert.equal(importedStaffBillingRate("Parts/Hardware", 200, 25), 250);
  assert.equal(importedStaffBillingRate("Other", 200, 25), 200);
});
