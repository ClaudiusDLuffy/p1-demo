import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { primitiveHarness, uiInvoke, uiNodes, uiText, type UiNode } from "../../lib/forms/primitiveComponentTestHarness";

const find = (tree: unknown, predicate: (node: UiNode) => boolean) => { const node = uiNodes(tree).find(predicate); assert.ok(node); return node; };
const button = (tree: unknown, label: string) => find(tree, node => node.type === "button" && uiText(node.props.children) === label);
const card = (tree: unknown, label: string) => find(tree, node => node.type === "section" && node.props["aria-label"] === label);
const link = (tree: unknown, label: string) => find(tree, node => node.type === "a" && uiText(node.props.children) === label);
const followLink = (node: UiNode) => {
  let prevented = false;
  uiInvoke(node, "onClick", { preventDefault() { prevented = true; } });
  assert.equal(prevented, true, "Section focus must wait for the chooser to unmount, not use native anchor scrolling");
};
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
    "./CapitalCloseOutModal": { CapitalCloseOutModal: "SimpleCapitalForm" },
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

test("contextual invoice link opens only the exact existing invoice while blocked billing outcomes stay blocked", () => {
  const h = harness(); const calls: unknown[][] = [];
  const props = { ...base, billingDocument: { id: "existing-invoice" }, onOpenBilling: (...args: unknown[]) => calls.push(args),
    workOrder: { ...base.workOrder, visits: [{ checkOutAt: null }] } };
  let tree = h.render("WorkOrderCloseOutPanel", props); uiInvoke(button(tree, "Close out"), "onClick");
  tree = h.render("WorkOrderCloseOutPanel", props);
  assert.equal(button(tree, "Billed outside the portal").props.disabled, true);
  const review = link(card(tree, "Review or finish P1 billing"), "Invoice on this WO");
  assert.equal(review.props.href, "#work-order-documents");
  assert.equal(uiNodes(card(tree, "Review or finish P1 billing")).some(node => node.type === "a" && uiText(node.props.children) === "Checkout"), false);
  followLink(review);
  assert.deepEqual(calls, [[base.workOrder.id, "existing-invoice"]]);
  tree = h.render("WorkOrderCloseOutPanel", props);
  assert.equal(uiNodes(tree).some(node => node.type === "Modal" || node.type === "ExternalForm"), false);
  uiInvoke(button(tree, "Close out"), "onClick"); tree = h.render("WorkOrderCloseOutPanel", props);
  assert.equal(button(tree, "Billed outside the portal").props.disabled, true);
});

for (const [label, section, patch] of [
  ["Checkout", "visits", { workOrder: { ...base.workOrder, visits: [{ checkOutAt: null }] } }],
  ["History", "history", { hasCompleteEvidence: false }],
  ["Updates", "updates", { workOrder: { ...base.workOrder, hasPendingSevenElevenSync: true } }],
  ["Contractor invoices", "documents", { hasUnresolvedContractorInvoices: true }],
  ["Job progress", "progress", { workOrder: { ...base.workOrder, functionalStatus: "Work in Progress" } }],
] as const) test(`${label} navigates within the same WO without invoking any closeout command`, () => {
  const h = harness(); const calls: unknown[][] = []; let writes = 0;
  const props = { ...base, ...patch, onReviewSection: (...args: unknown[]) => calls.push(args),
    onCloseFollowUp: async () => { writes++; return true; }, onCloseWithoutInvoice: async () => { writes++; return true; } };
  let tree = h.render("WorkOrderCloseOutPanel", props); uiInvoke(button(tree, "Close out"), "onClick");
  tree = h.render("WorkOrderCloseOutPanel", props);
  const review = link(card(tree, "Billed outside the portal"), label);
  assert.equal(review.props.className?.toString().includes("btn-"), false);
  assert.ok(String(review.props.href).startsWith("#work-order-"));
  followLink(review);
  assert.deepEqual(calls, [[base.workOrder.id, section]]); assert.equal(writes, 0);
  tree = h.render("WorkOrderCloseOutPanel", props);
  assert.equal(uiNodes(tree).some(node => ["Modal", "ExternalForm", "LinkedForm", "NoInvoiceForm"].includes(String(node.type))), false);
});

test("no prerequisite links are shown when there is no destination callback or nothing needs review", () => {
  const h = harness();
  const props = { ...base, hasCompleteEvidence: false, workOrder: { ...base.workOrder, visits: [{ checkOutAt: null }] } };
  let tree = h.render("WorkOrderCloseOutPanel", props); uiInvoke(button(tree, "Close out"), "onClick");
  tree = h.render("WorkOrderCloseOutPanel", props);
  assert.equal(uiNodes(tree).some(node => node.type === "a"), false);
  tree = h.render("WorkOrderCloseOutPanel", { ...base, onReviewSection() {} });
  assert.equal(uiNodes(tree).some(node => node.type === "a"), false);
});

test("compact review links live under their own billing choice, with no separate helper-button list", () => {
  const h = harness();
  const props = { ...base, billingDocument: { id: "existing-invoice" }, onReviewSection() {},
    workOrder: { ...base.workOrder, visits: [{ checkOutAt: null }] } };
  let tree = h.render("WorkOrderCloseOutPanel", props); uiInvoke(button(tree, "Close out"), "onClick");
  tree = h.render("WorkOrderCloseOutPanel", props);
  assert.equal(uiNodes(tree).some(node => node.props["aria-label"] === "Still needs review"), false);
  assert.equal(uiNodes(card(tree, "Review or finish P1 billing")).filter(node => node.type === "a").length, 1);
  for (const label of ["Billed under another work order", "Billed outside the portal"]) {
    const choice = card(tree, label);
    assert.equal(button(choice, label).props.disabled, true);
    assert.deepEqual(uiNodes(choice).filter(node => node.type === "a").map(node => uiText(node.props.children)), ["Invoice on this WO", "Checkout"]);
    assert.equal(uiNodes(choice).filter(node => node.type === "button").length, 1, "Only the billing action is a button");
  }
  assert.match(uiText(card(tree, "Billed under another work order")), /different work order.*not an invoice on this WO/);
  assert.match(uiText(card(tree, "Billed outside the portal")), /outside P1.*no P1 billing invoice on this WO/);
});

test("follow-up choice has only its own required links, not new invoice or field-completion requirements", () => {
  const h = harness();
  const props = { ...base, canCloseFollowUp: true, billingDocument: { id: "existing-invoice" }, onReviewSection() {},
    workOrder: { ...base.workOrder, functionalStatus: "Work in Progress", visits: [{ checkOutAt: null }] } };
  let tree = h.render("WorkOrderCloseOutPanel", props); uiInvoke(button(tree, "Close out"), "onClick");
  tree = h.render("WorkOrderCloseOutPanel", props);
  const followUp = card(tree, "Follow-up resolved, prior billing covers it");
  assert.deepEqual(uiNodes(followUp).filter(node => node.type === "a").map(node => uiText(node.props.children)), ["Checkout"]);
});

test("paged-history loading remains in the chooser, reports failures, and never clears a guard by itself", async () => {
  const h = harness(); let loads = 0;
  const props = { ...base, hasCompleteEvidence: false, canLoadMoreHistory: true, onReviewSection() {},
    onLoadMoreHistory: async () => { loads++; throw new Error("Synthetic read failed"); } };
  let tree = h.render("WorkOrderCloseOutPanel", props); uiInvoke(button(tree, "Close out"), "onClick");
  tree = h.render("WorkOrderCloseOutPanel", props);
  await uiInvoke(button(tree, "Load more close-out history"), "onClick");
  tree = h.render("WorkOrderCloseOutPanel", props);
  assert.equal(loads, 1); assert.match(uiText(tree), /History could not load/);
  assert.equal(button(tree, "Billed outside the portal").props.disabled, true);
  const busy = h.render("WorkOrderCloseOutPanel", { ...props, historyLoading: true });
  assert.equal(button(busy, "Loading history...").props.disabled, true);
});

test("review destinations are mounted in both layouts and focus waits until the chooser closes", () => {
  const detail = readFileSync("src/features/work-orders/WorkOrderDetail.tsx", "utf8");
  for (const id of ["work-order-visits", "work-order-activity", "work-order-documents", "work-order-progress"]) {
    assert.ok(detail.includes(`id="${id}"`), `${id} must have a real destination`);
  }
  assert.match(detail, /closeOutReview\.workOrderId === selectedWO && closeOutReview\.workOrderId === woData\?\.id/);
  assert.match(detail, /closeOutReview\.actorId === currentUser\?\.id/);
  assert.match(detail, /currentUser\?\.active === true && isManager && !invoiceController/);
  assert.match(detail, /focusWorkOrderSection\(sections\[closeOutReview\.section\]\)/);
});

test("one capital Close out click opens the two-outcome confirmation directly, without a quote-page detour", () => {
  const h = harness(); let opened = 0;
  const props = { ...base, workOrder: { ...base.workOrder, status: "pending_capital_completion" },
    billingDocument: { id: "approved-quote" }, onOpenBilling: () => opened++ };
  let tree = h.render("WorkOrderCloseOutPanel", props); uiInvoke(button(tree, "Close out"), "onClick");
  tree = h.render("WorkOrderCloseOutPanel", props);
  const form = find(tree, node => node.type === "SimpleCapitalForm");
  assert.equal(form.props.workOrderId, props.workOrder.id);
  assert.equal(form.props.hasCompleteEvidence, true); assert.equal(opened, 0);
  assert.equal(uiNodes(tree).some(node => node.type === "Modal"), false);
  assert.equal(uiNodes(tree).some(node => node.props["aria-label"] === "Still needs review"), false);
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
  assert.match(detail, /showActions=\{!focused && !isCapitalCloseOutWork\(woData\)\}/);
  assert.match(detail, /!focused && canCloseReopenedFollowUp && !isCapitalCloseOutWork\(woData\)/);
  assert.match(detail, /!focused && isManager && !isCapitalCloseOutWork\(woData\) && woData.status !== "closed" && !hasAnyLiveInvoice/);
  assert.match(detail, /hideCloseOutActions=\{focused \|\| isCapitalCloseOutWork\(woData\)\}/);
  assert.match(detail, /!focused && canCloseReopenedFollowUp/);
  assert.match(detail, /visitPage\?\.hasMore === false/);
  assert.match(shell, /onCloseReopenedFollowUp=\{async \(snapshot, reason\)[\s\S]*doCloseReopenedFollowUp\(snapshot.id, snapshot.workflowCycle/);
  assert.match(shell, /onCloseOutWithoutInvoice=\{async snapshot[\s\S]*doCloseWithoutInvoice\(snapshot.id, snapshot.workflowCycle/);
  assert.match(shell, /onCloseOutWithoutInvoice=\{async snapshot[\s\S]*const expectedUpdatedAt = snapshot.updatedAt/);
  assert.match(shell, /const current = await loadWorkOrderById\(snapshot.id\);[\s\S]*!noInvoiceCloseSnapshotMatches\(current, snapshot\)/);
});
