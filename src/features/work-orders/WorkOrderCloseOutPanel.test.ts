import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { primitiveHarness, uiInvoke, uiNodes, uiText, type UiNode } from "../../lib/forms/primitiveComponentTestHarness";

const find = (tree: unknown, predicate: (node: UiNode) => boolean) => { const node = uiNodes(tree).find(predicate); assert.ok(node); return node; };
const button = (tree: unknown, label: string) => find(tree, node => node.type === "button" && uiText(node.props.children) === label);
const base = {
  workOrder: { id: "SYNTHETIC-WO", status: "pending_invoice", functionalStatus: "Completed", workflowCycle: 1,
    contractorAssignmentVersion: 2, updatedAt: "2026-10-01T12:00:00Z", visits: [] },
  hasCompleteEvidence: true, hasStaffDocuments: false, hasAnyDocuments: false,
  hasUnresolvedContractorInvoices: false, canCloseFollowUp: false, billingDocument: null,
  onOpenBilling() {}, async onCloseFollowUp() { return true; }, async onCloseWithoutInvoice() { return true; },
};
function harness(initialActor: object | null = { id: "staff-A", role: "manager", active: true }) {
  let actor = initialActor;
  const h = primitiveHarness("src/features/work-orders/WorkOrderCloseOutPanel.tsx", {
    "../directory/queries": { useDirectoryActor: () => actor },
    "../billing/ExternalBillingModal": { ExternalBillingModal: "ExternalForm" },
    "../billing/LinkedBillingModal": { LinkedBillingModal: "LinkedForm" },
    "./CapitalSelfServiceModal": { CapitalSelfServiceModal: "CapitalForm" },
    "./CloseReopenedFollowUpModal": { default: "FollowUpForm" },
    "./CloseOutNoInvoiceModal": { CloseOutNoInvoiceModal: "NoInvoiceForm" },
  });
  return { ...h, setActor: (next: object | null) => { actor = next; } };
}

for (const actor of [null, { role: "contractor", active: true }, { role: "manager", active: false },
  { role: "manager", active: true, staffPermissions: ["invoice_controller"] }]) test(`close-out controls are hidden from ${JSON.stringify(actor)}`, () => {
  assert.equal(harness(actor).render("WorkOrderCloseOutPanel", base), null);
});

for (const role of ["manager", "dispatcher", "back_office"]) test(`${role} gets one entry point; choosing an outcome opens an existing form without closing`, () => {
  const h = harness({ id: "staff-A", role, active: true });
  let calls = 0; const props = { ...base, onCloseFollowUp: async () => { calls++; return true; } };
  let tree = h.render("WorkOrderCloseOutPanel", props);
  assert.equal(uiNodes(tree).filter(node => node.type === "button").length, 1);
  uiInvoke(button(tree, "Close out"), "onClick"); tree = h.render("WorkOrderCloseOutPanel", props);
  uiInvoke(button(tree, "Billed under another work order"), "onClick"); tree = h.render("WorkOrderCloseOutPanel", props);
  assert.equal(find(tree, node => node.type === "LinkedForm").props.guidedCloseOut, true);
  assert.equal(calls, 0);
});

test("billing review opens the existing invoice, never silently creates or finalizes another", () => {
  const h = harness(); const calls: unknown[][] = [];
  const props = { ...base, billingDocument: { id: "existing-invoice" }, onOpenBilling: (...args: unknown[]) => calls.push(args) };
  let tree = h.render("WorkOrderCloseOutPanel", props); uiInvoke(button(tree, "Close out"), "onClick");
  tree = h.render("WorkOrderCloseOutPanel", props); uiInvoke(button(tree, "Review or finish P1 billing"), "onClick");
  assert.deepEqual(calls, [[base.workOrder.id, "existing-invoice"]]);
});

test("capital completion opens installation confirmation, not a closure or automatic final invoice", () => {
  const h = harness(); let opened = 0;
  const props = { ...base, workOrder: { ...base.workOrder, status: "pending_capital_completion" },
    billingDocument: { id: "approved-quote" }, onOpenBilling: () => opened++ };
  let tree = h.render("WorkOrderCloseOutPanel", props); uiInvoke(button(tree, "Close out"), "onClick");
  tree = h.render("WorkOrderCloseOutPanel", props); uiInvoke(button(tree, "Installation is complete"), "onClick");
  tree = h.render("WorkOrderCloseOutPanel", props);
  const form = find(tree, node => node.type === "CapitalForm");
  assert.equal(form.props.action, "capital_confirmed_completion"); assert.equal(form.props.guidedCloseOut, true);
  assert.equal(form.props.onDone, undefined); assert.equal(opened, 0);
});

test("disabled outcomes cannot be entered even through their click handler", () => {
  const h = harness(); const props = { ...base, workOrder: { ...base.workOrder, visits: [{ checkOutAt: null }] } };
  let tree = h.render("WorkOrderCloseOutPanel", props); uiInvoke(button(tree, "Close out"), "onClick");
  tree = h.render("WorkOrderCloseOutPanel", props);
  const action = button(tree, "Billed outside the portal"); assert.equal(action.props.disabled, true);
  uiInvoke(action, "onClick"); tree = h.render("WorkOrderCloseOutPanel", props);
  assert.equal(uiNodes(tree).some(node => node.type === "ExternalForm"), false);
});

for (const action of ["follow_up", "no_invoice"] as const) test(`${action} submits the captured cycle/version, never newly refreshed values`, async () => {
  const h = harness(); const calls: unknown[][] = [];
  const props = { ...base, canCloseFollowUp: true, onCloseFollowUp: async (...args: unknown[]) => { calls.push(args); return true; },
    onCloseWithoutInvoice: async (...args: unknown[]) => { calls.push(args); return true; } };
  let tree = h.render("WorkOrderCloseOutPanel", props); uiInvoke(button(tree, "Close out"), "onClick");
  tree = h.render("WorkOrderCloseOutPanel", props);
  uiInvoke(button(tree, action === "follow_up" ? "Follow-up resolved, prior billing covers it" : "No billing is required"), "onClick");
  tree = h.render("WorkOrderCloseOutPanel", { ...props, workOrder: { ...props.workOrder, workflowCycle: 9, updatedAt: "2026-10-09T12:00:00Z" } });
  await uiInvoke(find(tree, node => node.type === (action === "follow_up" ? "FollowUpForm" : "NoInvoiceForm")), "onConfirm", "confirmed audit note");
  const snapshot = calls[0][0] as typeof base.workOrder;
  assert.equal(snapshot.id, base.workOrder.id); assert.equal(snapshot.workflowCycle, 1);
  assert.equal(snapshot.contractorAssignmentVersion, 2); assert.equal(snapshot.updatedAt, base.workOrder.updatedAt);
});

test("actor/WO switches remove selected forms, but a closed refresh keeps an uncertain form mounted for reconciliation", () => {
  const h = harness(); let tree = h.render("WorkOrderCloseOutPanel", base);
  uiInvoke(button(tree, "Close out"), "onClick"); tree = h.render("WorkOrderCloseOutPanel", base);
  uiInvoke(button(tree, "Billed outside the portal"), "onClick");
  tree = h.render("WorkOrderCloseOutPanel", { ...base, workOrder: { ...base.workOrder, status: "closed" } });
  assert.ok(uiNodes(tree).some(node => node.type === "ExternalForm"));
  tree = h.render("WorkOrderCloseOutPanel", { ...base, workOrder: { ...base.workOrder, id: "OTHER-SYNTHETIC-WO" } });
  assert.equal(uiNodes(tree).some(node => node.type === "ExternalForm"), false);
  h.setActor({ id: "staff-B", role: "manager", active: true }); tree = h.render("WorkOrderCloseOutPanel", base);
  assert.equal(uiNodes(tree).some(node => node.type === "ExternalForm"), false);
});

test("Simplified consolidates duplicate controls but retains legacy/full view and snapshot-aware shell callbacks", () => {
  const detail = readFileSync("src/features/work-orders/WorkOrderDetail.tsx", "utf8");
  const shell = readFileSync("src/components/PortalShell.tsx", "utf8");
  assert.match(detail, /showActions=\{!focused\}/);
  assert.match(detail, /hideCloseOutActions=\{focused\}/);
  assert.match(detail, /!focused && canCloseReopenedFollowUp/);
  assert.match(detail, /visitPage\?\.hasMore === false/);
  assert.match(shell, /onCloseReopenedFollowUp=\{async \(snapshot, reason\)[\s\S]*doCloseReopenedFollowUp\(snapshot.id, snapshot.workflowCycle/);
  assert.match(shell, /onCloseOutWithoutInvoice=\{async snapshot[\s\S]*doCloseWithoutInvoice\(snapshot.id, snapshot.workflowCycle/);
  assert.match(shell, /onCloseOutWithoutInvoice=\{async snapshot[\s\S]*const expectedUpdatedAt = snapshot.updatedAt/);
  assert.match(shell, /const current = await loadWorkOrderById\(snapshot.id\);[\s\S]*!noInvoiceCloseSnapshotMatches\(current, snapshot\)/);
});
