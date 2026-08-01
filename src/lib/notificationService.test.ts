import assert from "node:assert/strict";
import test from "node:test";
import { createDispatchNotificationPlan } from "./notificationService";

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
    ["lynzy@p1pros.com"],
  );

  assert.deepEqual(plan.contractorRecipients, []);
  assert.deepEqual(plan.internalRecipients, [
    "lynzy@p1pros.com",
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
    ["lynzy@p1pros.com"],
  );

  assert.deepEqual(plan.contractorRecipients, [
    "pro.ops.inc@gmail.com",
    "service@pro-opsinc.com",
  ]);
  assert.deepEqual(plan.internalRecipients, ["lynzy@p1pros.com"]);
  assert.equal(plan.ownerSubject, "New VA Call Dispatched - WOT0000001");
});
