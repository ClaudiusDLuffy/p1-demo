import assert from "node:assert/strict";
import test from "node:test";
import {
  canCloseReopenedFollowUpWithoutBilling,
  currentResumeWorkCycle,
  normalizeFollowUpCloseReason,
  validateFollowUpCloseReason,
} from "./reopenedFollowUpClose";

const reopenedAt = "2026-09-02T14:22:18.351555+00:00";

const workOrder = {
  status: "assigned",
  workflowCycle: 1,
  billingOnly: false,
  isCapital: false,
  activities: [{
    eventKey: "work_order_reopened",
    eventData: { mode: "resume_work" },
    workflowCycle: 1,
    createdAt: reopenedAt,
  }, {
    eventKey: "staff_billing",
    eventData: {
      action: "billed_to_7_eleven",
      invoiceId: "staff-invoice-id",
    },
    workflowCycle: 0,
    createdAt: "2026-08-28T17:19:59.245317+00:00",
  }, {
    eventKey: "invoice_submitted",
    eventData: { invoiceId: "contractor-invoice-id" },
    workflowCycle: 0,
    createdAt: "2026-08-06T17:03:07.279568+00:00",
  }],
};

const contractorInvoice = {
  id: "contractor-invoice-id",
  state: "paid",
  createdAt: "2026-08-06T17:03:07.279568+00:00",
};

const staffInvoice = {
  id: "staff-invoice-id",
  state: "approved",
  documentKind: "invoice",
  createdAt: "2026-08-24T20:23:48.069080+00:00",
};

const eligibility = (overrides: Record<string, unknown> = {}) =>
  canCloseReopenedFollowUpWithoutBilling({
    workOrder,
    contractorInvoices: [contractorInvoice],
    staffInvoices: [staffInvoice],
    isOperationalStaff: true,
    isInvoiceController: false,
    hasCompleteEvidence: true,
    ...overrides,
  });

test("finds only the current resume-work reopen boundary", () => {
  assert.deepEqual(currentResumeWorkCycle({
    ...workOrder,
    workflowCycle: 2,
    activities: [
      ...workOrder.activities,
      {
        eventKey: "work_order_reopened",
        eventData: { mode: "billing_follow_up" },
        workflowCycle: 2,
        createdAt: "2026-09-03T00:00:00Z",
      },
    ],
  }), null);

  assert.deepEqual(currentResumeWorkCycle(workOrder), {
    workflowCycle: 1,
    reopenedAt,
  });
});

test("allows the WOT1015920-shaped prior-billed follow-up", () => {
  assert.equal(eligibility(), true);
});

test("requires resolved prior invoices and a prior staff billing document", () => {
  assert.equal(eligibility({
    contractorInvoices: [{ ...contractorInvoice, state: "submitted" }],
  }), false);
  assert.equal(eligibility({ staffInvoices: [] }), false);
  assert.equal(eligibility({
    staffInvoices: [{ ...staffInvoice, documentKind: "capital_quote" }],
  }), false);
});

test("requires complete history and matching prior billing provenance", () => {
  assert.equal(eligibility({ hasCompleteEvidence: false }), false);
  assert.equal(eligibility({
    workOrder: {
      ...workOrder,
      activities: workOrder.activities.filter(activity =>
        activity.eventKey !== "staff_billing",
      ),
    },
  }), false);
  assert.equal(eligibility({
    staffInvoices: [{ ...staffInvoice, id: "another-invoice" }],
  }), false);
});

test("a prior contractor draft cannot masquerade as a previously submitted bill", () => {
  assert.equal(eligibility({
    workOrder: {
      ...workOrder,
      activities: workOrder.activities.filter(activity => activity.eventKey !== "invoice_submitted"),
    },
  }), false);
  assert.equal(eligibility({
    contractorInvoices: [{ ...contractorInvoice, id: "different-bill" }],
  }), false);
});

test("requires a pre-reopen billing event for every prior P1 invoice", () => {
  assert.equal(eligibility({
    staffInvoices: [
      staffInvoice,
      {
        ...staffInvoice,
        id: "second-staff-invoice-id",
        createdAt: "2026-08-25T20:23:48.069080+00:00",
      },
    ],
  }), false);

  assert.equal(eligibility({
    workOrder: {
      ...workOrder,
      activities: [
        ...workOrder.activities,
        {
          eventKey: "staff_billing",
          eventData: {
            action: "billed_to_7_eleven",
            invoiceId: "second-staff-invoice-id",
          },
          workflowCycle: 0,
          createdAt: "2026-08-29T17:19:59.245317+00:00",
        },
      ],
    },
    staffInvoices: [
      staffInvoice,
      {
        ...staffInvoice,
        id: "second-staff-invoice-id",
        createdAt: "2026-08-25T20:23:48.069080+00:00",
      },
    ],
  }), true);
});

test("blocks staff or contractor billing activity during the reopened cycle", () => {
  for (const activity of [
    {
      eventKey: "staff_invoice_ready",
      eventData: { invoiceId: "staff-invoice-id" },
      workflowCycle: 1,
      createdAt: "2026-09-02T15:00:00Z",
    },
    {
      eventKey: "staff_billing",
      eventData: {
        action: "billed_to_7_eleven",
        invoiceId: "staff-invoice-id",
      },
      workflowCycle: 1,
      createdAt: "2026-09-02T15:00:00Z",
    },
    {
      eventKey: "invoice_resubmitted",
      eventData: { invoiceId: "contractor-invoice-id" },
      workflowCycle: 1,
      createdAt: "2026-09-02T15:00:00Z",
    },
    {
      eventKey: "invoice_approved",
      eventData: { invoiceId: "contractor-invoice-id" },
      workflowCycle: 1,
      createdAt: "2026-09-02T15:00:00Z",
    },
    ...["created", "updated", "deleted"].map(action => ({
      eventKey: "staff_billing",
      eventData: { action, invoiceId: "staff-invoice-id" },
      workflowCycle: 1,
      createdAt: "2026-09-02T15:00:00Z",
    })),
  ]) {
    assert.equal(eligibility({
      workOrder: {
        ...workOrder,
        activities: [...workOrder.activities, activity],
      },
    }), false);
  }
});

test("blocks invoices created in the reopened cycle", () => {
  assert.equal(eligibility({
    contractorInvoices: [
      contractorInvoice,
      { state: "submitted", createdAt: "2026-09-02T15:00:00Z" },
    ],
  }), false);
});

test("fails closed for malformed dates and invoices deleted during the follow-up", () => {
  assert.equal(eligibility({
    contractorInvoices: [
      contractorInvoice,
      { state: "approved", createdAt: "not-a-date" },
    ],
  }), false);
  assert.equal(eligibility({
    contractorInvoices: [
      contractorInvoice,
      {
        state: "submitted",
        createdAt: "2026-09-02T15:00:00Z",
        deletedAt: "2026-09-02T16:00:00Z",
      },
    ],
  }), false);
});

test("blocks unauthorized, unsafe, and billing states", () => {
  assert.equal(eligibility({ isOperationalStaff: false }), false);
  assert.equal(eligibility({ isInvoiceController: true }), false);
  assert.equal(eligibility({
    workOrder: { ...workOrder, status: "pending_invoice" },
  }), false);
  assert.equal(eligibility({
    workOrder: { ...workOrder, hasPendingSevenElevenSync: true },
  }), false);
  assert.equal(eligibility({
    workOrder: { ...workOrder, hasPendingContractorAttention: true },
  }), false);
});

test("normalizes and validates the required close reason", () => {
  assert.equal(normalizeFollowUpCloseReason("  Already billed  "), "Already billed");
  assert.match(validateFollowUpCloseReason("  ") || "", /at least 3/);
  assert.match(validateFollowUpCloseReason("x".repeat(1001)) || "", /1000/);
  assert.equal(validateFollowUpCloseReason("Covered by the prior invoice"), null);
});
