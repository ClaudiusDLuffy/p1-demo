import assert from "node:assert/strict";
import test from "node:test";
import { BILLING_DRAFT_MAX_AGE_MS, createBillingDraftPayload, parseBillingDraft, validateBillingDraft } from "./billingDraftPersistence";
const sourceId = "00000000-0000-4000-8000-000000000001";
test("partial billing data round trips without accepting an invalid financial command", () => {
  const value = createBillingDraftPayload({ savedAt: "2026-08-06T01:00:00.000Z", form: { num: "synthetic", workOrderId: "WOT100",
    lines: [{ type: "Labor", desc: "Incomplete", qty: 1, rate: "" }] }, selectedSourceIds: [sourceId], numberEdited: true });
  const read = parseBillingDraft(JSON.stringify(value), Date.parse("2026-08-06T01:05:00.000Z"));
  assert.equal(read?.form.lines[0].rate, ""); assert.deepEqual(read?.selectedSourceIds, [sourceId]);
});
test("billing keeps existing 30 day expiry and rejects future malformed and old schemas", () => {
  const at = "2026-01-01T00:00:00.000Z"; const value = createBillingDraftPayload({ savedAt: at, form: {} });
  assert.equal(parseBillingDraft(JSON.stringify(value), Date.parse(at) + BILLING_DRAFT_MAX_AGE_MS + 1), null);
  assert.equal(parseBillingDraft(JSON.stringify(value), Date.parse(at) - 1), null);
  assert.equal(parseBillingDraft("not-json"), null); assert.equal(validateBillingDraft({ ...value, version: 1 }), null);
});
test("all 1000 intended lines survive; 1001 and oversized drafts fail instead of truncating", () => {
  const lines = Array.from({ length: 1000 }, (_, index) => ({ type: "Other", desc: `synthetic ${index}`, qty: 1, rate: "" }));
  const value = createBillingDraftPayload({ form: { lines } }); assert.equal(value.form.lines.length, 1000);
  assert.throws(() => createBillingDraftPayload({ form: { lines: [...lines, lines[0]] } }));
  assert.throws(() => createBillingDraftPayload({ form: { lines: lines.map(line => ({ ...line, desc: "x".repeat(4000) })) } }));
});
test("only source summary is retained; PDF/provider/full lines and profile fields cannot enter payload", () => {
  const value = createBillingDraftPayload({ form: {}, sourceSnapshots: { [sourceId]: { id: sourceId, num: "synthetic", subtotal: 1,
    total: 2, invoiceVersion: 3, lines: [{ secret: true }], pdfStoragePath: "synthetic", providerResponse: {} } } });
  assert.deepEqual(Object.keys(value.sourceSnapshots[sourceId]).sort(), ["id", "invoiceVersion", "num", "subtotal", "total"]);
  assert.throws(() => createBillingDraftPayload({ form: { profile: {} } }));
  assert.equal(validateBillingDraft({ ...value, token: "synthetic" }), null);
});
test("captured versions stay with original financial draft", () => {
  const snapshot = { key: "invoice:synthetic", value: { workOrderId: "WOT100", expectedInvoiceVersion: 0, expectedAssignmentVersion: 2, expectedWorkflowCycle: 4 } };
  const value = createBillingDraftPayload({ form: {}, financialSnapshot: snapshot }); assert.deepEqual(value.financialSnapshot, snapshot);
});
