import assert from "node:assert/strict";
import test from "node:test";
import {
  getContractorCompletionControl,
  workOrderStatusAfterFieldCompletion,
} from "./contractorCompletion";

const eligibleFieldWork = {
  isManager: false,
  billingOnly: false,
  fieldWorkComplete: false,
  workOrderStatus: "wip",
};

test("eligible contractors receive field completion without an invoice gate", () => {
  assert.deepEqual(getContractorCompletionControl(eligibleFieldWork), {
    visible: true,
    enabled: true,
    action: "complete",
    label: "Mark work complete",
    blockedReason: null,
  });
});

test("invoice-driven statuses do not hide unfinished field completion", () => {
  for (const workOrderStatus of [
    "wip",
    "pending_invoice",
    "pending_approval",
    "pending_payment",
  ]) {
    const control = getContractorCompletionControl({
      ...eligibleFieldWork,
      workOrderStatus,
    });
    assert.equal(control.visible, true, workOrderStatus);
    assert.equal(control.action, "complete", workOrderStatus);
    assert.equal(control.label, "Mark work complete", workOrderStatus);
  }
});

test("field completion preserves invoice workflow queues", () => {
  for (const workOrderStatus of [
    "pending_invoice",
    "pending_approval",
    "pending_payment",
  ]) {
    assert.equal(
      workOrderStatusAfterFieldCompletion(workOrderStatus),
      workOrderStatus,
    );
  }

  for (const workOrderStatus of ["wip", "unassigned", null, undefined]) {
    assert.equal(
      workOrderStatusAfterFieldCompletion(workOrderStatus),
      "completed",
    );
  }
});

test("field completion stays unavailable outside the approved work scope", () => {
  const excludedInputs = [
    { isManager: true },
    { billingOnly: true },
    { fieldWorkComplete: true },
    { workOrderStatus: "unassigned" },
    { workOrderStatus: "assigned" },
    { workOrderStatus: "parts" },
    { workOrderStatus: "completed" },
    { workOrderStatus: "closed" },
    { workOrderStatus: "capital" },
    { workOrderStatus: "pending_capital_completion" },
    { workOrderStatus: "unexpected_status" },
  ];

  for (const override of excludedInputs) {
    const control = getContractorCompletionControl({
      ...eligibleFieldWork,
      ...override,
    });
    assert.equal(control.visible, false, JSON.stringify(override));
    assert.equal(control.enabled, false, JSON.stringify(override));
    assert.equal(control.action, null, JSON.stringify(override));
  }
});
