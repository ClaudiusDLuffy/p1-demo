import assert from "node:assert/strict";
import test from "node:test";
import type { WorkOrderReadModel } from "../work-orders/data/workOrderReadContracts";
import { isResolutionBreached, nextActionLabel, simplifiedWorkQuery } from "./simplifiedWorkModel";
import { workOrderReadArgs } from "../work-orders/data/workOrderReadRepository";

const workOrder = (overrides: Partial<WorkOrderReadModel>): WorkOrderReadModel => ({
  id: "WOT-SYNTHETIC",
  externalWorkOrderId: "WOT-SYNTHETIC",
  status: "assigned",
  priority: "p3",
  functionalStatus: "Dispatched",
  contractorAssignmentVersion: 1,
  workflowCycle: 0,
  lifecycleVersion: 0,
  detailsLoaded: false,
  hasPendingContractorAttention: false,
  hasPendingSevenElevenSync: false,
  ...overrides,
} as WorkOrderReadModel);

test("resolution badges exclude completed work and invalid deadlines", () => {
  const now = Date.parse("2026-09-28T12:00:00Z");
  assert.equal(isResolutionBreached(workOrder({ resolutionBreachAt: "2026-09-28T11:00:00Z" }), now), true);
  assert.equal(isResolutionBreached(workOrder({ resolutionBreachAt: "invalid" }), now), false);
  assert.equal(isResolutionBreached(workOrder({ status: "closed", resolutionBreachAt: "2026-09-28T11:00:00Z" }), now), false);
});

test("next action uses lifecycle hints without claiming financial handoff eligibility", () => {
  const row = workOrder({ id: "WOT-SEARCH", city: "Synthetic City", eta: null });
  assert.equal(nextActionLabel(row), "Set an ETA");
  assert.equal(nextActionLabel(workOrder({ status: "pending_invoice" })), "Review invoicing status");
  assert.equal(nextActionLabel(workOrder({ status: "pending_payment" })), "Track payment");
});

test("focused views use existing server-side scope, status and search before pagination", () => {
  const unassigned = workOrderReadArgs(simplifiedWorkQuery("unassigned", "parts", "example", null));
  assert.equal(unassigned.args.p_scope, "dashboard_unassigned");
  assert.equal(unassigned.args.p_status, null);
  assert.equal(unassigned.args.p_search, "example");
  const capital = workOrderReadArgs(simplifiedWorkQuery("capital", "capital_equipment_ordered", "example", null));
  assert.equal(capital.args.p_scope, "capital");
  assert.equal(capital.args.p_status, "capital_equipment_ordered");
  assert.equal(capital.args.p_search, "example");
  assert.equal(capital.tableMode, false);
  const closed = workOrderReadArgs(simplifiedWorkQuery("closed", "all", "", "synthetic-company"));
  assert.equal(closed.args.p_scope, "history");
  assert.equal(closed.args.p_contractor_id, "synthetic-company");
  const breached = workOrderReadArgs(simplifiedWorkQuery("breached", "all", "", null));
  assert.equal(breached.tableMode, true);
  assert.ok("p_sla_filter" in breached.args);
  assert.equal(breached.args.p_sla_filter, "overdue");
  assert.equal(simplifiedWorkQuery("open", "parts", "", null).status, "parts");
});
