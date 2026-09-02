import assert from "node:assert/strict";
import test from "node:test";

import {
  canDuplicateWorkOrderForReassignment,
  canRejectUnassignedWorkOrder,
} from "./workOrderDispatchActions";

const rejectable = {
  isOperationalStaff: true,
  status: "unassigned",
  functionalStatus: "New",
  contractorId: null,
  assignedTechnicianProfileId: null,
  technicianOnJob: null,
  contractorAssignmentVersion: 0,
  contractorAssignmentStartedAt: null,
  dispatchedAt: null,
  startTime: null,
  endTime: null,
  billingOnly: false,
  hasActiveInvoices: false,
};

test("reject is available only for untouched never-assigned calls", () => {
  assert.equal(canRejectUnassignedWorkOrder(rejectable), true);
  assert.equal(canRejectUnassignedWorkOrder({ ...rejectable, contractorAssignmentVersion: 1 }), false);
  assert.equal(canRejectUnassignedWorkOrder({ ...rejectable, dispatchedAt: new Date().toISOString() }), false);
  assert.equal(canRejectUnassignedWorkOrder({ ...rejectable, status: "assigned" }), false);
  assert.equal(canRejectUnassignedWorkOrder({ ...rejectable, billingOnly: true }), false);
  assert.equal(canRejectUnassignedWorkOrder({ ...rejectable, hasActiveInvoices: true }), false);
});

test("reject is hidden from contractors and invoice controllers", () => {
  assert.equal(canRejectUnassignedWorkOrder({ ...rejectable, isOperationalStaff: false }), false);
  assert.equal(canRejectUnassignedWorkOrder({ ...rejectable, isInvoiceController: true }), false);
});

const duplicable = {
  isOperationalStaff: true,
  workOrderId: "WOT1215047",
  status: "wip",
  contractorId: "contractor-1",
  contractorAssignmentVersion: 1,
  billingOnly: false,
  isCapital: false,
};

test("duplicate-for-reassignment requires an existing contractor assignment", () => {
  assert.equal(canDuplicateWorkOrderForReassignment(duplicable), true);
  assert.equal(canDuplicateWorkOrderForReassignment({ ...duplicable, status: "parts" }), true);
  assert.equal(canDuplicateWorkOrderForReassignment({ ...duplicable, status: "pending_invoice" }), true);
  assert.equal(canDuplicateWorkOrderForReassignment({ ...duplicable, status: "unassigned" }), false);
  assert.equal(canDuplicateWorkOrderForReassignment({ ...duplicable, contractorId: null }), false);
  assert.equal(canDuplicateWorkOrderForReassignment({ ...duplicable, contractorAssignmentVersion: 0 }), false);
  assert.equal(canDuplicateWorkOrderForReassignment({ ...duplicable, workOrderId: "FWKD11400001" }), false);
  assert.equal(canDuplicateWorkOrderForReassignment({
    ...duplicable,
    workOrderId: "WOT1215047-1",
    duplicateRootWorkOrderId: "WOT1215047",
  }), true);
});

test("duplicate-for-reassignment excludes accounting, capital, and contractor contexts", () => {
  assert.equal(canDuplicateWorkOrderForReassignment({ ...duplicable, isInvoiceController: true }), false);
  assert.equal(canDuplicateWorkOrderForReassignment({ ...duplicable, isOperationalStaff: false }), false);
  assert.equal(canDuplicateWorkOrderForReassignment({ ...duplicable, billingOnly: true }), false);
  assert.equal(canDuplicateWorkOrderForReassignment({ ...duplicable, isCapital: true }), false);
  assert.equal(canDuplicateWorkOrderForReassignment({ ...duplicable, status: "closed" }), false);
});
