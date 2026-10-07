import assert from "node:assert/strict";
import test from "node:test";
import { belongsToCurrentBillingWork } from "./currentBillingDocument";
const reopenedAt = Date.parse("2026-09-28T15:00:00Z");
test("earlier finalized customer invoices do not become the current follow-up document", () => {
  assert.equal(belongsToCurrentBillingWork({documentKind:"invoice",state:"approved",createdAt:"2026-09-25T00:00:00Z"},reopenedAt),false);
  assert.equal(belongsToCurrentBillingWork({documentKind:"invoice",state:"paid"},reopenedAt),false);
  assert.equal(belongsToCurrentBillingWork({documentKind:"invoice",state:"submitted",createdAt:"2026-09-29T00:00:00Z"},reopenedAt),true);
});
test("capital authorization cycles retain the submitted quote as an accessible document", () => {
  assert.equal(belongsToCurrentBillingWork({documentKind:"capital_quote",state:"approved",createdAt:"2026-09-25T00:00:00Z"},reopenedAt),true);
  assert.equal(belongsToCurrentBillingWork({documentKind:"invoice",state:"approved",createdAt:"2026-09-25T00:00:00Z"},0),true);
});
