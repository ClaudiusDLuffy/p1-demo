import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import {
  isCapitalLifecycleStage,
  isCapitalWorkOrder,
} from "./workOrderView";
import { assignmentBoundaryPatch } from "./workOrderAssignmentBoundary";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");
const list = read("src/features/work-orders/WorkOrderList.tsx");
const detail = read("src/features/work-orders/WorkOrderDetail.tsx");
const capitalView = read("src/features/work-orders/CapitalProjects.tsx");
const dashboard = read("src/features/dashboard/DashboardWorkBuckets.tsx");
const history = read("src/features/work-orders/HistoryView.tsx");
const billingList = read("src/features/billing/BillingInvoiceList.tsx");
const billingCreate = read("src/features/billing/BillingInvoiceCreateModal.tsx");
const hook = read("src/features/work-orders/useWorkOrders.ts");
const shell = read("src/components/PortalShell.tsx");
const intake = read("src/lib/emailIntakeProcessor.ts");
const migration = read("supabase/migrations/0115_capital_work_orders_remain_operational.sql");
const audit = read("supabase/audits/0115_capital_work_orders_remain_operational_verification.sql");

test("capital classification survives every portal lifecycle label", () => {
  assert.equal(isCapitalLifecycleStage({ status: "capital" }), true);
  assert.equal(isCapitalLifecycleStage({ status: "pending_capital_completion" }), true);
  assert.equal(isCapitalLifecycleStage({ status: "pending_invoice", isCapital: true }), false);
  assert.equal(isCapitalWorkOrder({ status: "pending_invoice", isCapital: true }), true);
  assert.equal(isCapitalWorkOrder({ status: "capital", isCapital: false }), true);
  assert.equal(isCapitalWorkOrder({ status: "assigned", isCapital: false }), false);
});

test("Work orders includes capital while the focused Capital view remains", () => {
  assert.match(list, /scope: hideClosed \? "active" : "all"/);
  assert.doesNotMatch(
    list,
    /fallbackStateFilteredWOs\.filter\(\(w: any\) =>[\s\S]{0,120}pending_capital_completion/,
  );
  assert.match(list, /placeholder="Search WO#, INC#, store, keyword\.\.\."/);
  assert.ok((list.match(/<CapitalWorkOrderBadge workOrder=\{wo\}/g) || []).length >= 2);
  assert.match(capitalView, /scope: "capital"/);
  assert.match(capitalView, /also remain searchable in Work orders/);
  assert.match(dashboard, /<CapitalWorkOrderBadge workOrder=\{workOrder\} small/);
  assert.ok((history.match(/<CapitalWorkOrderBadge workOrder=\{w\} small/g) || []).length >= 2);
  assert.match(billingList, /<CapitalWorkOrderBadge workOrder=\{workOrder\} small/);
  assert.match(billingCreate, /<CapitalWorkOrderBadge workOrder=\{wo\} small/);
  assert.match(billingCreate, /isCapitalWorkOrder\(wo\) \? " · Capital"/);
});

test("capital detail exposes guarded assignment controls and a classification badge", () => {
  assert.match(detail, /canAssignCurrentWorkOrder && contractorsOnly\.map/);
  assert.match(detail, /canChangeCurrentAssignment && \(/);
  assert.match(detail, /<CapitalWorkOrderBadge workOrder=\{woData\}/);
  assert.match(detail, /isManager && !invoiceController && canFlagWorkOrderCapital\(woData\)/);
  assert.match(detail, /woData\.status === "pending_capital_completion" && isManager && !invoiceController/);
  assert.match(shell, /The capital identity, approval state, and P1 capital quote stay on this work order/);
  assert.match(shell, /remain in its current[\s\S]*Capital[\s\S]*stage with no contractor/);
  assert.match(detail, /return to \$\{woData\.contractor \? "dispatched" : "unassigned"\}/);
  assert.match(capitalView, /getUser\(wo\.contractor\)\?\.name \|\| "Unassigned"/);
});

test("client transitions preserve capital state but clear outgoing field data", () => {
  const transitionedAt = "2026-09-03T10:00:00.000Z";
  const capitalReassignment = assignmentBoundaryPatch(
    { contractor: "old-contractor" },
    {
      contractorId: "new-contractor",
      assignmentVersion: 4,
      assignmentStartedAt: transitionedAt,
      dispatchedAt: transitionedAt,
      status: "pending_capital_completion",
      functionalStatus: "Pending Capital Completion",
      isCapital: true,
      capitalStatus: "Approved",
    },
  );

  assert.equal(capitalReassignment.contractor, "new-contractor");
  assert.equal(capitalReassignment.status, "pending_capital_completion");
  assert.equal(capitalReassignment.functionalStatus, "Pending Capital Completion");
  assert.equal(capitalReassignment.isCapital, true);
  assert.equal(capitalReassignment.capitalStatus, "Approved");
  assert.equal(capitalReassignment.dispatchedAt, transitionedAt);
  assert.equal(capitalReassignment.contractorAssignmentVersion, 4);
  assert.equal(capitalReassignment.contractorAssignmentStartedAt, transitionedAt);
  for (const field of [
    "eta",
    "startTime",
    "technicianOnJob",
    "assetModel",
    "resolutionNotes",
    "partNeeded",
    "invoiceTotal",
    "capitalNotes",
    "assignedTechnicianProfileId",
    "contractorInvoicingCompletedAt",
  ]) {
    assert.equal(capitalReassignment[field], null, field);
  }
  assert.equal(capitalReassignment.nteFlagged, false);
  assert.equal(capitalReassignment.nteFlagAmount, null);

  const capitalAssignment = assignmentBoundaryPatch(
    { contractor: null },
    {
      contractorId: "new-contractor",
      assignmentVersion: 1,
      assignmentStartedAt: transitionedAt,
      dispatchedAt: transitionedAt,
      status: "capital",
      functionalStatus: "Work in Progress",
      isCapital: true,
      capitalStatus: "Review",
    },
  );
  assert.deepEqual(capitalAssignment, {
    contractor: "new-contractor",
    contractorAssignmentVersion: 1,
    contractorAssignmentStartedAt: transitionedAt,
    status: "capital",
    functionalStatus: "Work in Progress",
    dispatchedAt: transitionedAt,
    isCapital: true,
    capitalStatus: "Review",
  });

  const ordinaryUnassignment = assignmentBoundaryPatch(
    { contractor: "old-contractor" },
    {
      contractorId: null,
      assignmentVersion: 3,
      assignmentStartedAt: null,
      dispatchedAt: null,
      status: "unassigned",
      functionalStatus: "New",
      isCapital: false,
      capitalStatus: null,
    },
  );
  assert.equal(ordinaryUnassignment.status, "unassigned");
  assert.equal(ordinaryUnassignment.functionalStatus, "New");
  assert.equal(ordinaryUnassignment.isCapital, false);
  assert.equal(ordinaryUnassignment.dispatchedAt, null);

  assert.equal((hook.match(/assignmentBoundaryPatch\(/g) || []).length, 4);
  assert.match(hook, /const result = await declineCapitalWorkOrder\(/);
  assert.match(hook, /contractorAssignmentVersion: result\.assignmentVersion/);
  assert.doesNotMatch(hook, /status: hasContractor \? "assigned" : "unassigned"/);
});

test("database assignment boundary preserves capital workflow and privacy", () => {
  const boundaryStart = migration.indexOf(
    "create or replace function public.protect_work_order_assignment_boundary",
  );
  const transitionStart = migration.indexOf(
    "create or replace function public.transition_work_order_contractor",
  );
  assert.ok(boundaryStart >= 0 && transitionStart > boundaryStart);
  const boundary = migration.slice(boundaryStart, transitionStart);
  const transition = migration.slice(transitionStart);

  assert.match(boundary, /preserve_capital_identity/);
  assert.match(boundary, /preserve_capital_stage/);
  assert.match(boundary, /new\.is_capital := preserve_capital_identity/);
  assert.match(boundary, /new\.capital_status := case/);
  assert.match(boundary, /new\.status := old\.status/);
  assert.match(boundary, /insert into public\.work_order_assignment_history/);
  assert.match(boundary, /new\.capital_notes := null/);
  assert.match(boundary, /new\.contractor_assignment_version := old\.contractor_assignment_version \+ 1/);
  assert.doesNotMatch(boundary, /(?:update|delete from) public\.invoices/i);

  assert.match(transition, /from public\.work_orders work_order[\s\S]*for update/);
  assert.match(transition, /p_expected_assignment_version/);
  assert.match(transition, /profile\.is_assignable = true/);
  assert.match(transition, /'capital',[\s\S]*'pending_capital_completion'/);
  assert.match(transition, /Billing-only work orders cannot be dispatched/);
  assert.match(transition, /Outgoing contractor notification was not queued/);
  assert.doesNotMatch(transition, /coalesce\(v_work_order\.is_capital, false\)[\s\S]{0,40}raise exception/);
});

test("capital identity is canonicalized at intake and covered by a release audit", () => {
  assert.match(intake, /update\(\{ status: "capital", is_capital: true \}\)/);
  assert.match(migration, /set is_capital = true[\s\S]*status::text in \('capital', 'pending_capital_completion'\)/);
  for (const check of [
    "capital_lifecycle_preserved",
    "ordinary_assignment_behavior_preserved",
    "outgoing_contractor_fields_cleared",
    "transition_locked_and_versioned",
    "capital_assignment_states_allowed",
    "linked_staff_billing_untouched",
    "capital_identity_issue_count",
    "all_checks_pass",
  ]) {
    assert.match(audit, new RegExp(check));
  }
});
