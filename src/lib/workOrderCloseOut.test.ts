import assert from "node:assert/strict";
import test from "node:test";
import { closeOutAuditNote, isCapitalCloseOutWork, noInvoiceCloseSnapshotMatches, workOrderCloseOutOptions, type CloseOutWorkOrder } from "./workOrderCloseOut";

const workOrder: CloseOutWorkOrder = { id: "SYNTHETIC-WO", status: "pending_invoice", functionalStatus: "Completed", workflowCycle: 1, visits: [] };
const base = { workOrder, hasCompleteEvidence: true, hasCurrentInvoice: false, hasStaffDocuments: false,
  hasAnyDocuments: false, hasUnresolvedContractorInvoices: false, canCloseFollowUp: false };
const options = (changes: Partial<typeof base> = {}) => workOrderCloseOutOptions({ ...base, ...changes });

test("capital detection safely handles the initial empty work-order selection", () => {
  assert.equal(isCapitalCloseOutWork(null), false);
  assert.equal(isCapitalCloseOutWork(undefined), false);
  assert.equal(isCapitalCloseOutWork(workOrder), false);
  assert.equal(isCapitalCloseOutWork({ ...workOrder, status: "capital" }), true);
  assert.equal(isCapitalCloseOutWork({ ...workOrder, isCapital: true }), true);
  assert.equal(isCapitalCloseOutWork({ ...workOrder, isCapital: true, billingOnly: true }), false);
});

test("capital closeout has exactly the billed or still-open billing outcomes", () => {
  const capital = options({ workOrder: { ...workOrder, status: "capital", functionalStatus: "Work in Progress" } });
  assert.deepEqual(capital.map(option => option.label), ["Completed and billed", "Completed, send to billing"]);
  assert.equal(options({ workOrder: { ...workOrder, status: "capital" }, hasStaffDocuments: true }).find(option => option.action === "capital_billed")?.blocked, undefined);
  const waiting = options({ workOrder: { ...workOrder, status: "pending_capital_completion", visits: [{ checkOutAt: null }] } });
  assert.match(waiting.find(option => option.action === "capital_to_billing")?.blocked ?? "", /actual checkout/);
  assert.match(waiting.find(option => option.action === "capital_billed")?.blocked ?? "", /actual checkout/);
  const ready = options({ workOrder: { ...workOrder, status: "pending_capital_completion" } });
  assert.equal(ready.find(option => option.action === "capital_billed")?.blocked, undefined);
  assert.equal(ready.some(option => ["external_billing", "linked_billing", "no_invoice"].includes(option.action)), false);
});

test("installed and operational capitals retain the same two choices while regular WOs do not", () => {
  for (const status of ["pending_invoice", "parts", "wip"]) {
    assert.deepEqual(options({ workOrder: { ...workOrder, status, isCapital: true } }).map(option => option.action), ["capital_billed", "capital_to_billing"]);
  }
  const unresolved = options({ workOrder: { ...workOrder, isCapital: true }, hasUnresolvedContractorInvoices: true });
  assert.ok(unresolved.find(option => option.action === "capital_billed")?.blocked);
  assert.equal(unresolved.find(option => option.action === "capital_to_billing")?.blocked, undefined);
});

test("final billing, linked billing, external billing and unbilled closure are separate choices", () => {
  assert.deepEqual(options().map(option => option.action), ["review_billing", "linked_billing", "external_billing", "no_invoice"]);
  const billed = options({ hasCurrentInvoice: true, hasStaffDocuments: true, hasAnyDocuments: true });
  assert.match(billed[0].label, /finish P1 billing/);
  assert.equal(billed.some(option => option.action === "no_invoice"), false);
  for (const option of billed.filter(option => ["external_billing", "linked_billing"].includes(option.action))) assert.match(option.blocked ?? "", /P1 invoice already exists/);
  assert.equal(options({ canCloseFollowUp: true }).some(option => option.action === "follow_up"), true);
});

for (const status of ["assigned", "unassigned", "wip", "parts", "pending_approval"]) test(`unfinished stage ${status} has no ordinary billing closure shortcut`, () => {
  const result = options({ workOrder: { ...workOrder, status, functionalStatus: "Work in Progress" } });
  assert.deepEqual(result.map(option => option.action), ["review_billing"]);
  assert.ok(result[0].blocked);
});

for (const [name, change] of Object.entries({
  openVisit: { workOrder: { ...workOrder, visits: [{ checkOutAt: null }] } },
  unfinishedWork: { workOrder: { ...workOrder, functionalStatus: "Work in Progress" } },
  pendingCustomerUpdate: { workOrder: { ...workOrder, hasPendingSevenElevenSync: true } },
  pendingContractorAttention: { workOrder: { ...workOrder, hasPendingContractorAttention: true } },
  unresolvedInvoice: { hasUnresolvedContractorInvoices: true },
  incompleteHistory: { hasCompleteEvidence: false },
})) test(`${name} blocks guided ordinary closure, not review of an existing invoice`, () => {
  const result = options({ ...change, hasCurrentInvoice: true });
  assert.equal(result.find(option => option.action === "review_billing")?.blocked, undefined);
  for (const option of result.filter(option => ["external_billing", "linked_billing", "no_invoice"].includes(option.action))) assert.ok(option.blocked);
});

test("closed work has no repeat-close choices; billing-only work retains existing eligibility", () => {
  assert.deepEqual(options({ workOrder: { ...workOrder, status: "closed" } }), []);
  assert.equal(options({ workOrder: { ...workOrder, billingOnly: true, functionalStatus: "Work in Progress" } }).find(option => option.action === "linked_billing")?.blocked, undefined);
});

test("a proven reopened field follow-up retains its existing staff-confirmed resolution path", () => {
  const result = options({ workOrder: { ...workOrder, status: "wip", functionalStatus: "Work in Progress" }, canCloseFollowUp: true,
    hasAnyDocuments: true, hasStaffDocuments: true });
  assert.equal(result.find(option => option.action === "follow_up")?.blocked, undefined);
  assert.equal(result.some(option => ["external_billing", "linked_billing", "no_invoice"].includes(option.action)), false);
  assert.ok(result.find(option => option.action === "review_billing")?.blocked);
});

for (const outcome of ["capital_complete", "external_quote", "external_billing", "linked_billing", "follow_up"] as const) test(`${outcome} generates a bounded, cycle-specific audit note without free text`, () => {
  const note = closeOutAuditNote(workOrder, outcome, "", "SYNTHETIC-REF");
  assert.match(note, /SYNTHETIC-WO, cycle 1/);
  assert.match(note, /Staff confirmed/);
  assert.ok(note.length >= 5 && note.length <= 1000);
  assert.match(closeOutAuditNote(workOrder, outcome, "  Extra context  ", "SYNTHETIC-REF"), /Additional details: Extra context$/);
});

test("automatic notes reject oversized details and control characters instead of dropping audit data", () => {
  assert.throws(() => closeOutAuditNote(workOrder, "follow_up", "x".repeat(351)));
  assert.throws(() => closeOutAuditNote(workOrder, "capital_complete", "bad\u0000text"));
  assert.throws(() => closeOutAuditNote(workOrder, "external_quote", "", "x".repeat(1000)));
  assert.match(closeOutAuditNote(workOrder, "capital_complete", "Line one\nLine two"), /Line one Line two/);
});

test("no-invoice preflight rejects stale, missing, incomplete or newly billed state without promoting the snapshot", () => {
  const snapshot = { id: workOrder.id, workflowCycle: 1, contractorAssignmentVersion: 2, updatedAt: "2026-10-01T12:00:00.123456+00:00" };
  const current = { ...workOrder, ...snapshot, historyInvoiceCount: 0, billingInvoiceId: null };
  assert.equal(noInvoiceCloseSnapshotMatches(current, snapshot), true);
  for (const patch of [{ id: "OTHER" }, { updatedAt: "2026-10-01T12:00:00.123457+00:00" }, { workflowCycle: 2 },
    { contractorAssignmentVersion: 3 }, { status: "parts" }, { functionalStatus: "Work in Progress" },
    { hasPendingSevenElevenSync: true }, { hasPendingContractorAttention: true }, { historyInvoiceCount: 1 },
    { historyInvoiceCount: undefined }, { billingInvoiceId: "NEW-P1-INVOICE" }]) assert.equal(noInvoiceCloseSnapshotMatches({ ...current, ...patch }, snapshot), false);
  assert.equal(noInvoiceCloseSnapshotMatches(null, snapshot), false);
  assert.equal(noInvoiceCloseSnapshotMatches(current, { ...snapshot, updatedAt: null }), false);
});
