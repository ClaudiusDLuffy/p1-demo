import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createBillingDraftPayload, parseBillingDraft, writeBillingDraft } from "../../../scripts/draft-test-support/baselineBilling";
import { createQuoteCalculatorDraft, parseQuoteCalculatorDraft } from "../../../scripts/draft-test-support/baselineQuote";

// Frozen pre-7A sources, retained only as evidence; never imported by production.
test("baseline: 251 entered billing lines silently restore only 250", () => {
  const lines = Array.from({ length: 251 }, (_, id) => ({ type: "Labor", desc: `Synthetic ${id}`, qty: 1, rate: 1 }));
  const payload = createBillingDraftPayload({ form: { lines }, savedAt: "2026-09-11T00:00:00.000Z" });
  assert.equal((payload.form.lines as unknown[]).length, 250);
});

test("baseline: drafts carry no owner/environment/project proof and retain arbitrary source snapshots", () => {
  const payload = createBillingDraftPayload({ form: {}, sourceSnapshots: { synthetic: { unrelated: "synthetic-only" } } });
  assert.equal("ownerId" in payload, false);
  assert.equal("environment" in payload, false);
  assert.equal("project" in payload, false);
  assert.deepEqual(payload.sourceSnapshots, { synthetic: { unrelated: "synthetic-only" } });
  assert.ok(parseBillingDraft(JSON.stringify(payload)));
});

test("baseline: setItem success is treated as persistence without readback", () => {
  let reads = 0;
  const storage = { getItem: () => { reads++; return null; }, setItem: () => {}, removeItem: () => {} };
  writeBillingDraft(storage, "synthetic", createBillingDraftPayload({ form: {} }));
  assert.equal(reads, 0);
});

test("baseline: quote accepts arbitrary savedAt and has no TTL", () => {
  const payload = createQuoteCalculatorDraft({ workOrderId: "WOT-SYNTHETIC", selectedSourceId: "", lines: [
    { id: "synthetic", type: "Labor", desc: "Synthetic", qty: 1, rate: 1, sourceRate: 1, sourceInvoiceLineId: null },
  ], pricing: { laborRate: "1", partsMarkupPercent: "0", overallMarginPercent: "0" } }, "not-a-date");
  assert.ok(parseQuoteCalculatorDraft(JSON.stringify(payload), "WOT-SYNTHETIC"));
});

test("baseline: logout clears React/query state but has no browser-draft purge", () => {
  const auth = readFileSync(new URL("../../../scripts/draft-test-support/baselineAuth.txt", import.meta.url), "utf8");
  const logout = auth.slice(auth.indexOf("const logout = async"), auth.indexOf("// -- DATA LOADERS"));
  assert.match(logout, /qc\.clear\(\)/);
  assert.match(logout, /signOut\("local"\)/);
  assert.doesNotMatch(logout, /removeItem|draft|purge|storage/);
});
