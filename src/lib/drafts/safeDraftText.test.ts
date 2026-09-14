import assert from "node:assert/strict";
import test from "node:test";
import { isSafeDraftText } from "./safeDraftText";
import { createBillingDraftPayload } from "../billingDraftPersistence";
import { createQuoteCalculatorDraft } from "../quoteCalculatorDraft";
test("ordinary descriptions, multiline financial notes and unsigned references remain valid", () => {
  for (const value of ["Pump service $2.50\n2 hours", "See https://example.invalid/manual.pdf", "Parts: A/B/C=2"]) assert.equal(isSafeDraftText(value), true);
});
test("allowed text fields cannot carry obvious binary or credential-bearing values", () => {
  const sensitive = ["data:image/png;base64,synthetic", "blob:https://synthetic.invalid/id", "%PDF-1.7", "https://synthetic.invalid/a?token=synthetic",
    "https://synthetic.invalid/a?X-Amz-Signature=synthetic", "Bearer abcdefghijklmnopqrstuvwxyz", "eyJabcdefghijklmno.abcdefghijklmnop.abcdefghijklmnop",
    "-----BEGIN PRIVATE KEY-----", "JVBERi0" + "A".repeat(80)];
  for (const desc of sensitive) {
    assert.equal(isSafeDraftText(desc), false);
    assert.throws(() => createBillingDraftPayload({ form: { lines: [{ desc }] } }));
    assert.throws(() => createQuoteCalculatorDraft({ workOrderId: "WOT100", selectedSourceId: "", pricing: {
      laborRate: "1", partsMarkupPercent: "2", overallMarginPercent: "3" }, lines: [{ id: "synthetic", type: "Other", desc, qty: 1, rate: 1, sourceRate: 1 }] }));
  }
});
