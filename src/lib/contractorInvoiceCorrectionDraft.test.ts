import assert from "node:assert/strict";
import test from "node:test";
import {
  CONTRACTOR_INVOICE_CORRECTION_DRAFT_MAX_AGE_MS,
  correctionDraftMatchesSnapshot,
  createContractorInvoiceCorrectionDraft,
  validateContractorInvoiceCorrectionDraft,
} from "./contractorInvoiceCorrectionDraft";

const invoiceId = "00000000-0000-4000-8000-000000000001";
const snapshot = {
  workOrderId: "WOT100",
  expectedAssignmentVersion: 2,
  expectedWorkflowCycle: 3,
  invoiceId,
  expectedInvoiceVersion: 4,
};

test("rejected invoice correction draft preserves partial authored values without file bytes", () => {
  const draft = createContractorInvoiceCorrectionDraft({
    savedAt: "2026-09-15T00:00:00.000Z",
    snapshot,
    replacementPdfNeedsReselection: true,
    form: {
      num: "9256",
      invoiceDate: "2026-09-12",
      serviceDate: "2026-09-12",
      terms: "Net 30",
      tax: "",
      cme: "",
      uploadOnly: false,
      uploadedTotal: "",
      lines: [{ type: "Labor", desc: "Corrected hours", qty: 1, rate: "" }],
    },
  });
  assert.equal(draft.form.lines[0].rate, "");
  assert.equal(draft.replacementPdfNeedsReselection, true);
  assert.deepEqual(Object.keys(draft).sort(), ["form", "replacementPdfNeedsReselection", "savedAt", "snapshot", "version"]);
  assert.equal(validateContractorInvoiceCorrectionDraft(draft)?.form.num, "9256");
  assert.ok(CONTRACTOR_INVOICE_CORRECTION_DRAFT_MAX_AGE_MS > 0);
});

test("correction recovery is fenced by the captured invoice and work-order versions", () => {
  const draft = createContractorInvoiceCorrectionDraft({ form: {}, snapshot });
  assert.equal(correctionDraftMatchesSnapshot(draft, snapshot), true);
  assert.equal(correctionDraftMatchesSnapshot(draft, { ...snapshot, expectedInvoiceVersion: 5 }), false);
  assert.equal(correctionDraftMatchesSnapshot(draft, { ...snapshot, expectedWorkflowCycle: 4 }), false);
  assert.equal(validateContractorInvoiceCorrectionDraft({ ...draft, token: "must-not-persist" }), null);
});
