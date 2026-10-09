import assert from "node:assert/strict";
import test from "node:test";
import { primitiveHarness, uiInvoke, uiNodes, uiText, type UiNode } from "./primitiveComponentTestHarness";
import * as capital from "../../features/work-orders/capitalSelfService";
import { createExternalBillingAttempt } from "../../features/billing/externalBillingCommands";
import { createLinkedBillingAttempt } from "../../features/billing/linkedBillingCommands";
import { ExternalBillingError } from "../../features/billing/externalBillingContracts";
import { LinkedBillingError, type LinkedBillingCandidate } from "../../features/billing/linkedBillingContracts";

const find = (tree: unknown, predicate: (node: UiNode) => boolean) => { const node = uiNodes(tree).find(predicate); assert.ok(node); return node; };
const button = (tree: unknown, label: string) => find(tree, node => node.type === "button" && uiText(node.props.children) === label);
const check = (tree: unknown) => uiInvoke(find(tree, node => node.type === "input" && node.props.type === "checkbox"), "onChange", { target: { checked: true } });
const submit = (tree: unknown) => uiInvoke(find(tree, node => node.type === "form"), "onSubmit", { preventDefault() {} });
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
const operation = "00000000-0000-4000-8000-000000000101";
const work = { id: "SYNTHETIC-CLOSE-OUT", status: "pending_invoice", functionalStatus: "Completed",
  contractorAssignmentVersion: 2, workflowCycle: 1, lifecycleVersion: 7 };
const candidate: LinkedBillingCandidate = { workOrderId: "SYNTHETIC-DESTINATION", invoiceId: operation, invoiceNumber: "SYNTHETIC-P1",
  invoiceDate: "2026-10-01", invoiceVersion: 4, assignmentVersion: 1, workflowCycle: 0, state: "submitted" };
const queries = (data: object = work) => ({ useWorkOrderByIdQuery: () => ({ data, isError: false, isPending: false }) });
const queryClient = { useQueryClient: () => ({ invalidateQueries: async () => { throw new Error("synthetic refresh failure"); } }) };
const guard = { useUnsavedChangesGuard: (options: { onClose(): void }) => ({ requestClose: options.onClose, dialog: null }) };

for (const action of ["capital_external_handoff", "capital_confirmed_completion"] as const) test(`guided ${action} validates confirmation/reference and records an automatic audit note`, async () => {
  const inputs: Record<string, unknown>[] = []; let saves = 0;
  const h = primitiveHarness("src/features/work-orders/CapitalSelfServiceModal.tsx", {
    "./queries": queries(), "@tanstack/react-query": queryClient,
    "../../lib/forms/useUnsavedChangesGuard": guard,
    "../directory/queries": { useDirectoryActor: () => ({ id: "staff-A", role: "manager", active: true }) },
    "./capitalSelfService": { ...capital, createCapitalAttempt: (data: unknown, fields: Record<string, unknown>) => {
      const attempt = capital.createCapitalAttempt(data, fields, operation); inputs.push(fields); return attempt;
    }, runCapitalAttempt: async () => { saves++; return { action }; } },
  });
  const props = { workOrderId: work.id, action, guidedCloseOut: true, onClose() {} };
  let tree = h.render("CapitalSelfServiceModal", props); assert.match(uiText(tree), /Additional details \(optional\)/);
  await submit(tree); assert.equal(saves, 0);
  check(tree); tree = h.render("CapitalSelfServiceModal", props);
  if (action === "capital_external_handoff") {
    await submit(tree); assert.equal(saves, 0);
    uiInvoke(find(tree, node => node.type === "input" && String(node.props.id).endsWith("-ref")), "onChange", { target: { value: "REAL-REFERENCE-SYNTHETIC" } });
    tree = h.render("CapitalSelfServiceModal", props);
  }
  await submit(tree); assert.equal(saves, 1); assert.match(String(inputs[0].note), /Staff confirmed/);
  tree = h.render("CapitalSelfServiceModal", props);
  assert.equal(uiNodes(tree).some(node => node.props.role === "alert"), false);
  if (action === "capital_confirmed_completion") assert.match(uiText(tree), /not yet billed or closed/);
});

test("manual capital flow and quote revision still require a human audit reason", async () => {
  for (const [action, guidedCloseOut] of [["capital_confirmed_completion", false], ["capital_quote_revision", true]] as const) {
    let saves = 0;
    const h = primitiveHarness("src/features/work-orders/CapitalSelfServiceModal.tsx", {
      "./queries": queries(), "@tanstack/react-query": queryClient, "../../lib/forms/useUnsavedChangesGuard": guard,
      "../directory/queries": { useDirectoryActor: () => ({ id: "staff-A", active: true }) },
      "./capitalSelfService": { ...capital, createCapitalAttempt: (data: unknown, fields: unknown) => capital.createCapitalAttempt(data, fields, operation),
        runCapitalAttempt: async () => { saves++; return {}; } },
    });
    const props = { workOrderId: work.id, action, guidedCloseOut, quote: { id: operation, invoiceVersion: 4 }, onClose() {} };
    let tree = h.render("CapitalSelfServiceModal", props); check(tree); tree = h.render("CapitalSelfServiceModal", props);
    await submit(tree); assert.equal(saves, 0); assert.match(uiText(tree), /Audit note \(required\)/);
  }
});

for (const kind of ["external", "linked"] as const) test(`guided ${kind} billing preserves required fields and retry identity after a lost response`, async () => {
  let currentWork = { ...work }; const calls: unknown[] = []; const inputs: string[] = [];
  let first = true; let closes = 0; let creations = 0;
  const h = primitiveHarness(`src/features/billing/${kind === "external" ? "ExternalBillingModal" : "LinkedBillingModal"}.tsx`, {
    "../work-orders/queries": { useWorkOrderByIdQuery: () => ({ data: currentWork, isError: false, isPending: false }) },
    "@tanstack/react-query": queryClient, "../../lib/forms/useUnsavedChangesGuard": guard,
    "./LinkedBillingInvoicePicker": { LinkedBillingInvoicePicker: "Picker" },
    "./externalBillingCommands": { createExternalBillingAttempt: (data: unknown, fields: Parameters<typeof createExternalBillingAttempt>[1]) => {
      const attempt = createExternalBillingAttempt(data, fields, operation); creations++; inputs.push(fields.note); return attempt;
    } },
    "./linkedBillingCommands": { createLinkedBillingAttempt: (data: unknown, selected: LinkedBillingCandidate, note: string, confirmed: boolean) => {
      const attempt = createLinkedBillingAttempt(data, selected, note, confirmed, operation); creations++; inputs.push(note); return attempt;
    } },
    [kind === "external" ? "./externalBillingRepository" : "./linkedBillingRepository"]: {
      [kind === "external" ? "runExternalBillingAttempt" : "runLinkedBillingAttempt"]: async (attempt: unknown) => {
        calls.push(attempt);
        if (first) { first = false; throw kind === "external" ? new ExternalBillingError("EXTERNAL_BILLING_UNCONFIRMED") : new LinkedBillingError("LINKED_BILLING_UNCONFIRMED"); }
        return { billingSystem: "QuickBooks", invoiceReference: "SYNTHETIC-REF", billedOn: "2026-10-01",
          billingWorkOrderId: candidate.workOrderId, invoiceNumber: candidate.invoiceNumber };
      },
    },
  });
  const props = { workOrderId: work.id, guidedCloseOut: true, onClose: () => closes++ };
  const name = kind === "external" ? "ExternalBillingModal" : "LinkedBillingModal";
  let tree = h.render(name, props); await submit(tree); assert.equal(calls.length, 0);
  if (kind === "external") {
    // Confirmation does not substitute for the actual invoice/date.
    check(tree); tree = h.render(name, props); await submit(tree); assert.equal(calls.length, 0);
    uiInvoke(find(tree, node => node.type === "Input" && String(node.props.id).endsWith("-reference")), "onChange", { target: { value: "SYNTHETIC-REF" } });
    tree = h.render(name, props);
    uiInvoke(find(tree, node => node.type === "Input" && node.props.type === "date"), "onChange", { target: { value: "2026-10-01" } });
  } else {
    uiInvoke(find(tree, node => node.type === "Picker"), "onSelect", candidate); tree = h.render(name, props);
    await submit(tree); assert.equal(calls.length, 0); check(tree);
  }
  tree = h.render(name, props); await submit(tree); assert.equal(calls.length, 1); assert.equal(creations, 1);
  assert.match(inputs[0], /SYNTHETIC-CLOSE-OUT, cycle 1/);
  tree = h.render(name, props); assert.match(uiText(tree), /Retry same request/);
  assert.equal(find(tree, node => node.type === "fieldset").props.disabled, true);
  currentWork = { ...currentWork, status: "closed", workflowCycle: 9, lifecycleVersion: 99 };
  tree = h.render(name, props); await submit(tree); assert.equal(calls.length, 2); assert.equal(creations, 1);
  assert.equal(calls[0], calls[1]); tree = h.render(name, props);
  assert.match(uiText(tree), /work order is closed/); assert.equal(uiNodes(tree).some(node => node.props.role === "alert"), false);
  assert.equal(uiNodes(tree).some(node => node.type === "form"), false);
  assert.equal(calls.length, 2); assert.equal(closes, 0);
});

test("guided linked billing resets coverage confirmation when its candidate changes", async () => {
  let saves = 0;
  const h = primitiveHarness("src/features/billing/LinkedBillingModal.tsx", {
    "../work-orders/queries": queries(), "@tanstack/react-query": queryClient, "../../lib/forms/useUnsavedChangesGuard": guard,
    "./LinkedBillingInvoicePicker": { LinkedBillingInvoicePicker: "Picker" },
    "./linkedBillingCommands": { createLinkedBillingAttempt: (data: unknown, selected: LinkedBillingCandidate, note: string, confirmed: boolean) => createLinkedBillingAttempt(data, selected, note, confirmed, operation) },
    "./linkedBillingRepository": { runLinkedBillingAttempt: async () => { saves++; return {}; } },
  });
  const props = { workOrderId: work.id, guidedCloseOut: true, onClose() {} };
  let tree = h.render("LinkedBillingModal", props);
  uiInvoke(find(tree, node => node.type === "Picker"), "onSelect", candidate); tree = h.render("LinkedBillingModal", props); check(tree);
  tree = h.render("LinkedBillingModal", props); uiInvoke(find(tree, node => node.type === "Picker"), "onSelect", { ...candidate, invoiceVersion: 5 });
  tree = h.render("LinkedBillingModal", props); await submit(tree); assert.equal(saves, 0);
});

for (const guidedCloseOut of [false, true]) test(`follow-up closure ${guidedCloseOut ? "generates its routine reason" : "keeps manual reason mandatory"} and is single-flight`, async () => {
  const reasons: string[] = []; let closes = 0; let finish: (value: boolean) => void = () => {};
  const pending = new Promise<boolean>(resolve => { finish = resolve; });
  const h = primitiveHarness("src/features/work-orders/CloseReopenedFollowUpModal.tsx", { "../../lib/forms/useUnsavedChangesGuard": guard });
  const props = { workOrderId: work.id, workflowCycle: 1, guidedCloseOut, onClose: () => closes++, onConfirm: async (reason: string) => { reasons.push(reason); return pending; } };
  let tree = h.render("default", props); uiInvoke(button(tree, "Close follow-up — no additional billing"), "onClick"); await flush(); assert.equal(reasons.length, 0);
  check(tree); tree = h.render("default", props);
  if (!guidedCloseOut) {
    uiInvoke(button(tree, "Close follow-up — no additional billing"), "onClick"); await flush(); assert.equal(reasons.length, 0);
    uiInvoke(find(tree, node => node.type === "TA"), "onChange", { target: { value: "Prior bill covers resolved work" } }); tree = h.render("default", props);
  }
  const closeButton = button(tree, "Close follow-up — no additional billing");
  uiInvoke(closeButton, "onClick"); uiInvoke(closeButton, "onClick"); assert.equal(reasons.length, 1);
  if (guidedCloseOut) assert.match(reasons[0], /Staff confirmed the follow-up is resolved/);
  else assert.equal(reasons[0], "Prior bill covers resolved work");
  tree = h.render("default", props); assert.equal(find(tree, node => node.type === "Modal").props.dismissDisabled, true);
  finish(true); await flush(); assert.equal(closes, 1);
});

test("no-invoice guided closure requires the explicit unbilled outcome, prevents double-clicks and only closes after confirmed success", async () => {
  let calls = 0; let closes = 0; let finish: (value: boolean) => void = () => {};
  const pending = new Promise<boolean>(resolve => { finish = resolve; });
  const h = primitiveHarness("src/features/work-orders/CloseOutNoInvoiceModal.tsx", { "../../lib/forms/useUnsavedChangesGuard": guard });
  const props = { workOrderId: work.id, onClose: () => closes++, onConfirm: async () => { calls++; return pending; } };
  let tree = h.render("CloseOutNoInvoiceModal", props); uiInvoke(button(tree, "Confirm no billing and close"), "onClick"); assert.equal(calls, 0);
  check(tree); tree = h.render("CloseOutNoInvoiceModal", props);
  const action = button(tree, "Confirm no billing and close"); uiInvoke(action, "onClick"); uiInvoke(action, "onClick"); assert.equal(calls, 1);
  tree = h.render("CloseOutNoInvoiceModal", props); assert.equal(find(tree, node => node.type === "Modal").props.dismissDisabled, true);
  finish(false); await flush(); assert.equal(closes, 0); tree = h.render("CloseOutNoInvoiceModal", props);
  assert.match(uiText(tree), /Closure was not confirmed/);
});
