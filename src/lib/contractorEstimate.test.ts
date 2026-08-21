import assert from "node:assert/strict";
import test from "node:test";
import {
  canConvertContractorEstimate,
  canCreateContractorEstimate,
  canEditContractorEstimate,
  contractorEstimateLineAmount,
  contractorEstimateTotals,
  validateContractorEstimate,
  type EditableContractorEstimate,
} from "./contractorEstimate";

const estimate = (overrides: Partial<EditableContractorEstimate> = {}): EditableContractorEstimate => ({
  quoteDate: "2026-08-22",
  validUntil: "2026-09-22",
  terms: "Net 30",
  notes: "Replace failed compressor",
  salesTax: 5.25,
  lines: [
    { type: "Labor", description: "Diagnostic labor", qty: 2, rate: 85 },
    { type: "Parts/Hardware", description: "Compressor", qty: 1, rate: 550 },
  ],
  ...overrides,
});

test("estimate totals use the same rounded per-line amounts as persistence", () => {
  assert.equal(contractorEstimateLineAmount({ qty: 3, rate: 33.335 }), 100.02);
  assert.deepEqual(contractorEstimateTotals([
    { type: "Labor", description: "A", qty: 3, rate: 33.335 },
    { type: "Other", description: "B", qty: 1, rate: 0.105 },
  ], 1.005), {
    subtotal: 100.13,
    salesTax: 1.01,
    total: 101.14,
  });
});

test("drafts may be empty while submitted estimates need priced, described lines", () => {
  assert.deepEqual(validateContractorEstimate(estimate({ lines: [] })), []);
  assert.match(
    validateContractorEstimate(estimate({ lines: [] }), { submitting: true }).join(" "),
    /at least one priced line/i,
  );
  assert.match(
    validateContractorEstimate(estimate({
      lines: [{ type: "Labor", description: "", qty: 1, rate: 10 }],
    }), { submitting: true }).join(" "),
    /needs a description/i,
  );
});

test("truck charge description is optional and monetary inputs stay nonnegative", () => {
  assert.deepEqual(validateContractorEstimate(estimate({
    lines: [{ type: "Truck Charge", description: "", qty: 1, rate: 60 }],
  }), { submitting: true }), []);
  assert.match(
    validateContractorEstimate(estimate({ salesTax: -1 })).join(" "),
    /nonnegative/i,
  );
  assert.match(
    validateContractorEstimate(estimate({
      lines: [{ type: "Labor", description: "Labor", qty: 0, rate: 85 }],
    })).join(" "),
    /quantity greater than zero/i,
  );
});

test("tax alone is not a priced estimate and sub-cent quantities are rejected", () => {
  assert.match(
    validateContractorEstimate(estimate({
      salesTax: 10,
      lines: [{ type: "Truck Charge", description: "", qty: 1, rate: 0 }],
    }), { submitting: true }).join(" "),
    /at least one priced line/i,
  );
  assert.match(
    validateContractorEstimate(estimate({
      lines: [{ type: "Labor", description: "Diagnostic", qty: 0.004, rate: 100 }],
    })).join(" "),
    /quantity greater than zero/i,
  );
});

test("valid-until and bounded text rules are enforced before an RPC call", () => {
  assert.match(
    validateContractorEstimate(estimate({ validUntil: "2026-08-21" })).join(" "),
    /cannot be before/i,
  );
  assert.match(
    validateContractorEstimate(estimate({ terms: "x".repeat(101) })).join(" "),
    /terms cannot exceed/i,
  );
});

test("only invoice-capable contractors on open work orders can manage estimates", () => {
  const contractorAccess = {
    isManager: false,
    canInvoice: true,
    workOrderStatus: "completed",
  };
  assert.equal(canCreateContractorEstimate(contractorAccess), true);
  assert.equal(canEditContractorEstimate({ state: "draft" }, contractorAccess), true);
  assert.equal(canEditContractorEstimate({ state: "submitted" }, contractorAccess), false);
  assert.equal(canConvertContractorEstimate({ state: "submitted" }, contractorAccess), true);
  assert.equal(canCreateContractorEstimate({ ...contractorAccess, isManager: true }), false);
  assert.equal(canCreateContractorEstimate({ ...contractorAccess, canInvoice: false }), false);
  assert.equal(canCreateContractorEstimate({ ...contractorAccess, workOrderStatus: "closed" }), false);
});
