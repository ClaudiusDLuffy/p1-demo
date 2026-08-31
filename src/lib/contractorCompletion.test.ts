import assert from "node:assert/strict";
import test from "node:test";
import { getContractorCompletionControl } from "./contractorCompletion";

const eligibleInvoiceContractor = {
  isManager: false,
  canInvoice: true,
  billingOnly: false,
  invoicingComplete: false,
  workOrderStatus: "wip",
};

test("invoice-capable contractors always see the final action on eligible work", () => {
  assert.deepEqual(
    getContractorCompletionControl({
      ...eligibleInvoiceContractor,
      invoiceStates: [],
    }),
    {
      visible: true,
      enabled: false,
      label: "Create invoice to complete job",
      blockedReason: "Submit at least one contractor invoice before completing work and invoicing.",
    },
  );
});

test("drafts and rejected invoices visibly block atomic completion", () => {
  for (const state of ["draft", "rejected"]) {
    const control = getContractorCompletionControl({
      ...eligibleInvoiceContractor,
      invoiceStates: [state],
    });
    assert.equal(control.visible, true, state);
    assert.equal(control.enabled, false, state);
    assert.equal(control.label, "Finish invoice to complete job", state);
    assert.match(control.blockedReason || "", /drafts.*rejected invoices/i, state);
  }
});

test("a ready invoice set enables the one atomic completion action", () => {
  for (const state of ["submitted", "revised", "approved", "paid"]) {
    assert.deepEqual(
      getContractorCompletionControl({
        ...eligibleInvoiceContractor,
        invoiceStates: [state],
      }),
      {
        visible: true,
        enabled: true,
        label: "Complete work & invoicing",
        blockedReason: null,
      },
      state,
    );
  }

  const mixedControl = getContractorCompletionControl({
    ...eligibleInvoiceContractor,
    invoiceStates: ["submitted", "draft"],
  });
  assert.equal(mixedControl.enabled, false);
  assert.equal(mixedControl.label, "Finish invoice to complete job");
});

test("the control stays unavailable outside the approved contractor work scope", () => {
  const excludedInputs = [
    { isManager: true },
    { canInvoice: false },
    { billingOnly: true },
    { invoicingComplete: true },
    { workOrderStatus: "assigned" },
    { workOrderStatus: "parts" },
    { workOrderStatus: "closed" },
    { workOrderStatus: "capital" },
    { workOrderStatus: "pending_capital_completion" },
  ];

  for (const override of excludedInputs) {
    const control = getContractorCompletionControl({
      ...eligibleInvoiceContractor,
      invoiceStates: ["submitted"],
      ...override,
    });
    assert.equal(control.visible, false, JSON.stringify(override));
    assert.equal(control.enabled, false, JSON.stringify(override));
  }
});
