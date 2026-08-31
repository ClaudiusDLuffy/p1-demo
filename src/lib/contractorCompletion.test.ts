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
      action: "create_invoice",
      label: "Create invoice to complete job",
      blockedReason: "Submit at least one contractor invoice before completing work and invoicing.",
    },
  );
});

test("draft invoices route contractors back to the draft", () => {
  const control = getContractorCompletionControl({
    ...eligibleInvoiceContractor,
    invoiceStates: ["draft"],
  });
  assert.equal(control.visible, true);
  assert.equal(control.enabled, false);
  assert.equal(control.action, "finish_invoice");
  assert.equal(control.label, "Finish invoice to complete job");
  assert.match(control.blockedReason || "", /submit or delete drafts/i);
});

test("rejected invoices route contractors to correction first", () => {
  const control = getContractorCompletionControl({
    ...eligibleInvoiceContractor,
    invoiceStates: ["submitted", "draft", "rejected"],
  });
  assert.equal(control.visible, true);
  assert.equal(control.enabled, false);
  assert.equal(control.action, "correct_invoice");
  assert.equal(control.label, "Correct invoice to complete job");
  assert.match(control.blockedReason || "", /rejected invoices/i);
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
        action: "complete",
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
  assert.equal(mixedControl.action, "finish_invoice");
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
    assert.equal(control.action, null, JSON.stringify(override));
  }
});
