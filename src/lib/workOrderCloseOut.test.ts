import assert from "node:assert/strict";
import test from "node:test";
import { closeOutAuditNote, isCapitalCloseOutWork, noInvoiceCloseSnapshotMatches, workOrderCloseOutOptions, workOrderCloseOutReviewSteps, type CloseOutWorkOrder } from "./workOrderCloseOut";

const workOrder: CloseOutWorkOrder = { id: "SYNTHETIC-WO", status: "pending_invoice", functionalStatus: "Completed", workflowCycle: 1, visits: [] };
const base = { workOrder, hasCompleteEvidence: true, hasCurrentInvoice: false, hasStaffDocuments: false,
  hasAnyDocuments: false, hasUnresolvedContractorInvoices: false, canCloseFollowUp: false };
const options = (changes: Partial<typeof base> = {}) => workOrderCloseOutOptions({ ...base, ...changes });
const reviewSteps = (changes: Partial<typeof base> = {}) => workOrderCloseOutReviewSteps({ ...base, ...changes });

test("ordinary closeout review links appear only for existing documents or unmet prerequisites", () => {
  assert.deepEqual(reviewSteps(), []);
  const before = options();
  const cases: [Partial<typeof base>, string][] = [
    [{ hasCompleteEvidence: false }, "history"],
    [{ hasCurrentInvoice: true }, "billing"],
    [{ workOrder: { ...workOrder, visits: [{ checkOutAt: null }] } }, "visits"],
    [{ workOrder: { ...workOrder, hasPendingSevenElevenSync: true } }, "updates"],
    [{ workOrder: { ...workOrder, hasPendingContractorAttention: true } }, "updates"],
    [{ hasUnresolvedContractorInvoices: true }, "documents"],
    [{ workOrder: { ...workOrder, functionalStatus: "Work in Progress" } }, "progress"],
  ];
  for (const [change, target] of cases) {
    assert.deepEqual(reviewSteps(change).map(step => step.target), [target]);
  }
  assert.deepEqual(options(), before, "Read-only guidance cannot change closure eligibility");
});

test("review links report all relevant prerequisites once, including pending updates with two flags", () => {
  const steps = reviewSteps({ hasCompleteEvidence: false, hasCurrentInvoice: true, hasUnresolvedContractorInvoices: true,
    workOrder: { ...workOrder, visits: [{ checkOutAt: null }], hasPendingSevenElevenSync: true, hasPendingContractorAttention: true } });
  assert.deepEqual(steps.map(step => step.target), ["history", "billing", "visits", "updates", "documents"]);
  assert.equal(steps.filter(step => step.target === "updates").length, 1);
});

test("each regular closeout choice receives only its own short review links without changing eligibility", () => {
  const input = { ...base, hasCompleteEvidence: false, hasCurrentInvoice: true, hasUnresolvedContractorInvoices: true,
    workOrder: { ...workOrder, functionalStatus: "Work in Progress", visits: [{ checkOutAt: null }], hasPendingSevenElevenSync: true } };
  const before = workOrderCloseOutOptions(input);
  assert.deepEqual(workOrderCloseOutReviewSteps({ ...input, action: "review_billing" }).map(step => step.target), ["billing"]);
  for (const action of ["linked_billing", "external_billing"] as const) {
    assert.deepEqual(workOrderCloseOutReviewSteps({ ...input, action }).map(step => step.target), ["history", "billing", "visits", "updates", "documents", "progress"]);
  }
  assert.deepEqual(workOrderCloseOutReviewSteps({ ...input, action: "follow_up" }).map(step => step.target), ["history", "visits", "updates", "documents"]);
  assert.deepEqual(workOrderCloseOutReviewSteps({ ...input, action: "no_invoice" }).map(step => step.target), ["history", "visits", "updates", "documents", "progress"]);
  assert.deepEqual(workOrderCloseOutOptions(input), before);
});

test("preparing a new invoice links to missing history and billing handoff, never an imaginary existing invoice", () => {
  const input = { ...base, hasCompleteEvidence: false, hasCurrentInvoice: false,
    workOrder: { ...workOrder, status: "wip", functionalStatus: "Work in Progress", visits: [{ checkOutAt: null }] } };
  assert.deepEqual(workOrderCloseOutReviewSteps({ ...input, action: "review_billing" }).map(step => step.label), ["History", "Job progress"]);
  assert.deepEqual(workOrderCloseOutReviewSteps({ ...input, workOrder, action: "review_billing" }).map(step => step.label), ["History"]);
  for (const action of ["capital_complete", "capital_billed", "capital_to_billing", "external_quote"] as const) {
    assert.deepEqual(workOrderCloseOutReviewSteps({ ...input, action }), []);
  }
});

test("capital and closed work have no ordinary review checklist, and billing-only work needs no field-completion link", () => {
  for (const work of [{ ...workOrder, status: "closed" }, { ...workOrder, status: "capital" },
    { ...workOrder, isCapital: true }, { ...workOrder, status: "pending_capital_completion" }]) {
    assert.deepEqual(reviewSteps({ workOrder: work, hasCompleteEvidence: false, hasCurrentInvoice: true, hasUnresolvedContractorInvoices: true }), []);
  }
  assert.deepEqual(reviewSteps({ workOrder: { ...workOrder, billingOnly: true, functionalStatus: "Work in Progress" } }), []);
  assert.deepEqual(reviewSteps({ workOrder: { ...workOrder, status: "assigned" } }).map(step => step.target), ["progress"]);
});

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
