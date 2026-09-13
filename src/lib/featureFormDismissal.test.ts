import assert from "node:assert/strict";
import test from "node:test";
import { partsModuleHarness, partsButton, partsFind, partsInvoke, partsElements } from "./partsSmsOperatorTestHarness";

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const actor = { id: "synthetic-manager", active: true, role: "manager", staffPermissions: [] };
const invoice = { id: "11000000-0000-4000-8000-000000000001", num: "SYNTHETIC-1", state: "submitted",
  total: 25, subtotal: 25, salesTax: 0, wot: "SYNTHETIC-WO", contractor: "synthetic-contractor", lines: [] };
const props = { page: "invoices", selectedInvoice: invoice.id, invoices: [invoice], workOrders: [],
  isManager: true, currentUser: actor, fmt: (value: number) => String(value), setSelectedInvoice() {},
  doCorrectInvoiceTotal() {}, doPlaceInvoicePaymentHold() {} };

function detail(mocks: Record<string, unknown> = {}) {
  return partsModuleHarness("src/features/invoices/InvoiceDetail.tsx", {
    "../billing/queries": { useBillingInvoiceByIdQuery: () => ({}) },
    "./invoiceLineQueries": { useInvoiceLinePage: () => ({ lines: [] }) },
    "../directory/queries": { useDirectorySelection: () => ({}) },
    "../financial-notifications/FinancialNoticeStatus": { default: "notice-status" }, ...mocks,
  });
}

test("invoice rejection Cancel/Escape requires deliberate discard and keeps authored reason", async () => {
  const h = detail();
  partsInvoke(partsButton(h.render(props), "Reject"), "onClick");
  partsInvoke(partsFind(h.render(props), "textarea"), "onChange", { target: { value: "Synthetic review reason" } });
  const field = partsFind(h.render(props), "textarea");
  assert.ok(h.render(props).some(item => item.type === "label" && item.props.htmlFor === field.props.id));
  partsInvoke(partsFind(h.render(props), "shared-modal"), "onRequestClose", "escape");
  partsInvoke(partsFind(h.render(props), "DiscardChangesDialog"), "onKeepEditing");
  assert.equal(partsFind(h.render(props), "textarea").props.value, "Synthetic review reason");
  partsInvoke(partsButton(h.render(props), "Cancel"), "onClick");
  partsInvoke(partsFind(h.render(props), "DiscardChangesDialog"), "onDiscard"); await tick();
  assert.equal(h.render(props).some(item => item.type === "shared-modal"), false);
});

test("invoice rejection pending command blocks dismissal; failed result retains reason for correction", async () => {
  const h = detail(); let complete: (value: boolean) => void = () => undefined; let commands = 0;
  const input = { ...props, doRejectInvoice: async () => { commands++; return new Promise<boolean>(resolve => { complete = resolve; }); } };
  partsInvoke(partsButton(h.render(input), "Reject"), "onClick");
  partsInvoke(partsFind(h.render(input), "textarea"), "onChange", { target: { value: "Synthetic reason" } });
  const submit = partsButton(partsElements(partsFind(h.render(input), "shared-modal")), "Reject");
  const pending = partsInvoke(submit, "onClick");
  assert.equal(partsFind(h.render(input), "shared-modal").props.dismissDisabled, true);
  partsInvoke(partsFind(h.render(input), "shared-modal"), "onRequestClose", "backdrop");
  assert.equal(h.render(input).some(item => item.type === "DiscardChangesDialog"), false);
  assert.equal(partsFind(h.render(input), "textarea").props.disabled, true);
  complete(false); await pending;
  assert.equal(commands, 1); assert.equal(partsFind(h.render(input), "textarea").props.value, "Synthetic reason");
  assert.equal(partsFind(h.render(input), "shared-modal").props.dismissDisabled, false);
});

test("total correction distinguishes untouched value from edited value without changing totals", async () => {
  const h = detail();
  partsInvoke(partsButton(h.render(props), "Correct total"), "onClick");
  partsInvoke(partsButton(h.render(props), "Cancel"), "onClick");
  assert.equal(h.render(props).some(item => item.type === "shared-modal"), false);
  partsInvoke(partsButton(h.render(props), "Correct total"), "onClick");
  partsInvoke(partsFind(h.render(props), "input"), "onChange", { target: { value: "26.00" } });
  partsInvoke(partsButton(h.render(props), "Cancel"), "onClick");
  assert.ok(partsFind(h.render(props), "DiscardChangesDialog"));
  assert.equal(invoice.total, 25);
});

test("payment-hold reason uses the same dirty dismissal contract and no action runs on discard", async () => {
  const h = detail({ "../../lib/financialNotificationCommands": { prepareInvoicePaymentHold: async () => ({
    invoiceId: invoice.id, expectedSourceEventId: null,
  }) } });
  let actions = 0;
  const input = { ...props, invoices: [{ ...invoice, state: "approved" }], doPlaceInvoicePaymentHold() { actions++; } };
  partsInvoke(partsButton(h.render(input), "Hold / Do not pay"), "onClick"); await tick();
  partsInvoke(partsFind(h.render(input), "textarea"), "onChange", { target: { value: "Synthetic hold reason" } });
  partsInvoke(partsButton(h.render(input), "Cancel"), "onClick");
  partsInvoke(partsFind(h.render(input), "DiscardChangesDialog"), "onDiscard"); await tick();
  assert.equal(actions, 0); assert.equal(h.render(input).some(item => item.type === "shared-modal"), false);
});

test("batch rejection preserves the selected revisions and reason while dirty dismissal is cancelled", async () => {
  let calls = 0;
  const h = partsModuleHarness("src/features/invoices/InvoiceList.tsx", {
    "./queries": { useInvoicesPageQuery: () => ({ data: { items: [{ ...invoice, reviewRevision: 2 }], totalCount: 1 } }) },
    "../directory/queries": { useDirectoryLabels: () => ({ getUser: () => ({ name: "Synthetic contractor" }) }) },
    "../../lib/useCursorPagination": { useCursorPagination: () => ({ position: { cursor: null, page: 1 } }) },
    "./ControllerExportPanel": { default: "controller-export" },
    "../financial-notifications/FinancialNoticeQueue": { default: "notice-queue" },
  });
  const input = { ...props, selectedInvoice: null, invTab: "submitted", doBatchReviewInvoices: async () => { calls++; return false; } };
  const checkbox = h.render(input).find(item => item.props["aria-label"] === `Select invoice ${invoice.num} for batch review`);
  assert.ok(checkbox); partsInvoke(checkbox, "onChange");
  partsInvoke(partsButton(h.render(input), "Reject selected"), "onClick");
  partsInvoke(partsFind(h.render(input), "textarea"), "onChange", { target: { value: "Synthetic batch reason" } });
  partsInvoke(partsButton(h.render(input), "Cancel"), "onClick");
  partsInvoke(partsFind(h.render(input), "DiscardChangesDialog"), "onKeepEditing");
  assert.equal(partsFind(h.render(input), "textarea").props.value, "Synthetic batch reason");
  assert.equal(partsFind(h.render(input), "shared-modal").props.title, "Reject 1 invoices");
  partsInvoke(partsButton(h.render(input), "Reject 1"), "onClick"); await tick();
  assert.equal(calls, 1); assert.equal(partsFind(h.render(input), "textarea").props.value, "Synthetic batch reason");
});

test("work-order invoice rejection retains reason and blocks dismissal during its command", async () => {
  const wo = { id: invoice.wot, status: "pending_approval", functionalStatus: "Completed", contractor: invoice.contractor,
    activities: [], visits: [], photos: [], assignmentHistory: [] };
  const h = partsModuleHarness("src/features/work-orders/WorkOrderDetail.tsx", {
    "../directory/queries": { useDirectoryLabels: () => ({ getUser: () => null }), useDirectorySelection: () => ({}) },
    "../billing/queries": { useBillingInvoicePageQuery: () => ({ data: { items: [], hasMore: false } }) },
    "../invoices/queries": { useInvoicesPageQuery: () => ({ data: { items: [invoice], hasMore: false } }) },
    "./queries": { useWorkOrdersPageQuery: () => ({ data: { items: [] } }), useWorkOrderPartsQuery: () => ({ data: [] }), useP1PartCostsQuery: () => ({ data: [] }) },
    "./useInvoicePartHints": { useInvoicePartHints: () => ({ data: [] }) },
    "../../components/ui/TA": { TA: "textarea" },
  });
  let complete: (value: boolean) => void = () => undefined;
  const input = { page: "wo_detail", selectedWO: wo.id, woData: wo, isManager: true, currentUser: actor,
    fmt: props.fmt, slaLabel: () => null, slaRemaining: () => null,
    doRejectInvoice: async () => new Promise<boolean>(resolve => { complete = resolve; }) };
  partsInvoke(partsButton(h.render(input), "Reject"), "onClick");
  partsInvoke(partsFind(h.render(input), "textarea"), "onChange", { target: { value: "Synthetic work-order reason" } });
  partsInvoke(partsFind(h.render(input), "shared-modal"), "onRequestClose", "escape");
  partsInvoke(partsFind(h.render(input), "DiscardChangesDialog"), "onKeepEditing");
  const pending = partsInvoke(partsButton(partsElements(partsFind(h.render(input), "shared-modal")), "Reject"), "onClick");
  assert.equal(partsFind(h.render(input), "shared-modal").props.dismissDisabled, true);
  partsInvoke(partsFind(h.render(input), "shared-modal"), "onRequestClose", "backdrop");
  assert.equal(h.render(input).some(item => item.type === "DiscardChangesDialog"), false);
  complete(false); await pending;
  assert.equal(partsFind(h.render(input), "textarea").props.value, "Synthetic work-order reason");
});

test("inline part edit retains a failed save, disables in-flight fields, and requires deliberate Cancel", async () => {
  const h = partsModuleHarness("src/features/work-orders/WorkOrderDetail.tsx", {
    "../../components/ui/Input": { Input: "input" },
    "../../components/ui/Field": { Field: "field" },
  }, ["PartsPanel"]);
  const part = { id: "synthetic-part", description: "Synthetic original", qty: 1, status: "ordered" };
  const loadingStates: Record<string, boolean> = {};
  let accepted = false;
  const input = { woId: "WOT-SYNTHETIC", parts: [part], isManager: true, T: {}, loadingStates,
    doUpdatePart: async () => accepted, billingHintState: "ready" };
  const render = () => partsElements(h.call("PartsPanel", input));
  partsInvoke(partsButton(render(), "Edit"), "onClick");
  partsInvoke(partsFind(render(), "input"), "onChange", { target: { value: "Synthetic edited" } });
  loadingStates["updatePart_" + part.id] = true;
  assert.equal(render().filter(item => item.type === "input").length, 5);
  assert.ok(render().filter(item => item.type === "input").every(item => item.props.disabled === true));
  assert.equal(partsButton(render(), "Cancel").props.disabled, true);
  loadingStates["updatePart_" + part.id] = false;
  await partsInvoke(partsButton(render(), "Save"), "onClick");
  assert.equal(partsFind(render(), "input").props.value, "Synthetic edited");
  assert.ok(render().some(item => item.props.role === "alert"));
  partsInvoke(partsButton(render(), "Cancel"), "onClick");
  partsInvoke(partsFind(render(), "DiscardChangesDialog"), "onKeepEditing");
  assert.equal(partsFind(render(), "input").props.value, "Synthetic edited");
  accepted = true; await partsInvoke(partsButton(render(), "Save"), "onClick");
  assert.equal(render().some(item => item.type === "input"), false);
  assert.equal(part.description, "Synthetic original");
});
