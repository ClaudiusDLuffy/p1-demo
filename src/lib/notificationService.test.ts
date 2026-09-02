import assert from "node:assert/strict";
import test from "node:test";
import {
  createDispatchNotificationPlan,
  createInvoicePaymentHoldNotificationPlan,
  createInvoiceReviewNotificationPlan,
} from "./notificationService";

const workOrder = {
  id: "WOT0000001",
  storeNumber: "12345",
  city: "Dallas",
  state: "TX",
  address: "100 Main St, Dallas, TX",
  priority: "p2",
  summary: "Walk-in cooler not cooling",
};

test("alerts staff and service inbox when a call needs assignment", () => {
  const plan = createDispatchNotificationPlan(
    { workOrder, contractorAssigned: false },
    ["lynzy@p1pros.com", "landryd@phospitality.com"],
  );

  assert.deepEqual(plan.contractorRecipients, []);
  assert.deepEqual(plan.internalRecipients, [
    "lynzy@p1pros.com",
    "landryd@phospitality.com",
    "service@p1pros.com",
  ]);
  assert.equal(plan.ownerSubject, "New TX Call Needs Assignment - WOT0000001");
  assert.match(plan.ownerBody, /waiting for contractor assignment/);
  assert.match(plan.ownerBody, /Contractor: Unassigned/);
});

test("keeps assignment emails scoped to the assigned contractor", () => {
  const plan = createDispatchNotificationPlan(
    {
      workOrder: { ...workOrder, state: "VA" },
      contractorAssigned: true,
      contractorEmail: "pro.ops.inc@gmail.com",
      contractorName: "Pro-Ops",
    },
    ["lynzy@p1pros.com", "landryd@phospitality.com"],
  );

  assert.deepEqual(plan.contractorRecipients, [
    "pro.ops.inc@gmail.com",
    "service@pro-opsinc.com",
  ]);
  assert.deepEqual(plan.internalRecipients, [
    "lynzy@p1pros.com",
    "landryd@phospitality.com",
  ]);
  assert.equal(plan.ownerSubject, "New VA Call Dispatched - WOT0000001");
});

test("deduplicates repeated configured owner emails", () => {
  const plan = createDispatchNotificationPlan(
    { workOrder, contractorAssigned: false },
    [
      "lynzy@p1pros.com",
      "landryd@phospitality.com",
      "landryd@phospitality.com",
    ],
  );

  assert.equal(
    plan.internalRecipients.filter(email => email === "landryd@phospitality.com").length,
    1,
  );
});

test("reassignment dispatch keeps the canonical WOT and labels the portal copy", () => {
  const plan = createDispatchNotificationPlan({
    workOrder: {
      ...workOrder,
      id: "WOT0000001-1",
      externalWorkOrderId: "WOT0000001",
    },
    contractorAssigned: true,
    contractorEmail: "contractor@example.com",
  });

  assert.equal(plan.ownerSubject, "New TX Call Dispatched - WOT0000001");
  assert.equal(plan.contractorSubject, "New Work Order Assigned - WOT0000001");
  assert.match(plan.ownerBody, /Work Order: WOT0000001/);
  assert.match(plan.ownerBody, /Portal reassignment reference: WOT0000001-1/);
});

test("rejection email identifies the invoice, work order, and correction reason", () => {
  const plan = createInvoiceReviewNotificationPlan({
    event: "rejected",
    recipients: [
      "Nancy@Example.com",
      "nancy@example.com",
      " invoices@example.com ",
    ],
    invoice: {
      num: "4352",
      workOrderId: "WOT1007298",
      storeNumber: "42522",
      rejectionReason: "Please attach the missing parts receipt.",
    },
  });

  assert.deepEqual(plan.recipients, [
    "nancy@example.com",
    "invoices@example.com",
  ]);
  assert.match(plan.subject, /4352 rejected/);
  assert.match(plan.body, /WOT1007298/);
  assert.match(plan.body, /missing parts receipt/);
  assert.match(plan.body, /edit and resubmit/i);
});

test("retraction email tells the contractor no resubmission is needed", () => {
  const plan = createInvoiceReviewNotificationPlan({
    event: "retraction",
    recipients: ["contractor@example.com"],
    invoice: {
      num: "4352",
      workOrderId: "WOT1007298",
    },
  });

  assert.match(plan.subject, /rejection withdrawn/);
  assert.match(plan.body, /now approved/);
  assert.match(plan.body, /no correction or resubmission is needed/i);
});

test("invoice review email uses the canonical WOT and labels a reassignment copy", () => {
  const plan = createInvoiceReviewNotificationPlan({
    event: "rejected",
    recipients: ["contractor@example.com"],
    invoice: {
      num: "4353",
      workOrderId: "WOT1007298-1",
      externalWorkOrderId: "WOT1007298",
    },
  });

  assert.match(plan.body, /Work Order: WOT1007298/);
  assert.match(plan.body, /P1 portal reassignment reference: WOT1007298-1/);
});

test("payment hold email tells accounting why an invoice is excluded", () => {
  const plan = createInvoicePaymentHoldNotificationPlan({
    event: "placed",
    recipients: ["EmilyB@PHospitality.com", "emilyb@phospitality.com"],
    invoice: {
      num: "6879",
      workOrderId: "WOT1143877",
      contractorName: "Anderson Mechanical",
      total: 155,
    },
    actorName: "Lynnette Price",
    reason: "Possible duplicate — controller review required",
  });

  assert.deepEqual(plan.recipients, ["emilyb@phospitality.com"]);
  assert.match(plan.subject, /Payment hold placed/);
  assert.match(plan.body, /WOT1143877/);
  assert.match(plan.body, /Anderson Mechanical/);
  assert.match(plan.body, /\$155\.00/);
  assert.match(plan.body, /excluded from the QuickBooks handoff queue/);
});

test("payment hold email uses the canonical WOT and labels a reassignment copy", () => {
  const plan = createInvoicePaymentHoldNotificationPlan({
    event: "placed",
    recipients: ["emily@example.com"],
    invoice: {
      num: "6880",
      workOrderId: "WOT1143877-2",
      externalWorkOrderId: "WOT1143877",
    },
    actorName: "Lynnette Price",
    reason: "Controller review required",
  });

  assert.match(plan.body, /Work Order: WOT1143877/);
  assert.match(plan.body, /P1 portal reassignment reference: WOT1143877-2/);
});
