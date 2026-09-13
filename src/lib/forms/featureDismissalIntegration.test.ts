import assert from "node:assert/strict";
import test from "node:test";
import type { UnsavedChangesOptions } from "./useUnsavedChangesGuard";
import type { ModalDismissReason } from "./dismissal";
import { primitiveHarness, uiInvoke, uiNodes, uiText, type UiNode } from "./primitiveComponentTestHarness";
const find = (tree: unknown, testNode: (node: UiNode) => boolean) => { const node = uiNodes(tree).find(testNode); assert.ok(node); return node; };
const button = (tree: unknown, label: string) => find(tree, node => node.type === "button" && uiText(node.props.children) === label);
function guardCapture() {
  let latest: UnsavedChangesOptions | null = null;
  const requests: string[] = [];
  return {
    mock: { useUnsavedChangesGuard: (options: UnsavedChangesOptions) => {
      latest = options;
      return { requestClose: (reason: ModalDismissReason) => {
        requests.push(reason); if (!options.dirty && !options.busy) options.onClose(reason);
      }, dialog: "confirmation-layer" };
    } },
    get options() { assert.ok(latest); return latest; }, requests,
  };
}
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
test("follow-up reason Cancel/X share guard, preserve pending input, authoritative success closes", async () => {
  const guard = guardCapture(); let closes = 0; let finish: (result: boolean) => void = () => undefined;
  const pending = new Promise<boolean>(resolve => { finish = resolve; });
  const h = primitiveHarness("src/features/work-orders/CloseReopenedFollowUpModal.tsx", {
    "../../lib/forms/useUnsavedChangesGuard": guard.mock,
  });
  const props = { workOrderId: "SYNTHETIC-WO", onClose: () => closes++, onConfirm: () => pending };
  let tree = h.render("default", props); assert.equal(guard.options.dirty, false);
  uiInvoke(find(tree, node => node.type === "TA"), "onChange", { target: { value: "Prior invoice includes this repair" } });
  tree = h.render("default", props); assert.equal(guard.options.dirty, true);
  uiInvoke(button(tree, "Cancel"), "onClick"); assert.deepEqual(guard.requests, ["cancel_button"]); assert.equal(closes, 0);
  uiInvoke(find(tree, node => node.type === "Modal"), "onRequestClose", "escape"); assert.equal(closes, 0);
  uiInvoke(button(tree, "Close follow-up — no additional billing"), "onClick"); tree = h.render("default", props);
  assert.equal(guard.options.busy, true); assert.equal(find(tree, node => node.type === "Modal").props.dismissDisabled, true);
  finish(true); await flush(); assert.equal(closes, 1);
});

test("technician invite baseline is clean; user edits are guarded without directory/API changes", () => {
  const guard = guardCapture();
  const contractor = { id: "00000000-0000-4000-8000-000000000001", name: "Synthetic company", role: "contractor" };
  const directory = { items: [contractor], search: "", setSearch() {}, position: { page: 1 }, waiting: false, isError: false };
  const h = primitiveHarness("src/features/contractors/ContractorList.tsx", {
    "../../lib/forms/useUnsavedChangesGuard": guard.mock,
    "@tanstack/react-query": { useQueryClient: () => ({}) },
    "../directory/queries": { useDirectoryActor: () => ({ id: "synthetic", role: "manager", active: true }), useDirectoryPage: () => directory },
    "../directory/DirectorySelect": { DirectoryError: "error", DirectoryPageControls: "pages" },
    "../../lib/supabase/client": {},
  });
  const props = { page: "contractors", isManager: true, nav() {}, setFilterC() {} };
  let tree = h.render("default", props); uiInvoke(button(tree, "+ Add"), "onClick"); tree = h.render("default", props);
  assert.equal(guard.options.enabled, true); assert.equal(guard.options.dirty, false);
  const name = find(tree, node => node.type === "input" && node.props.required === true && !node.props.type);
  uiInvoke(name, "onChange", { target: { value: "Synthetic technician" } }); tree = h.render("default", props);
  assert.equal(guard.options.dirty, true); uiInvoke(button(tree, "Cancel"), "onClick");
  assert.deepEqual(guard.requests, ["cancel_button"]); tree = h.render("default", props);
  assert.equal(find(tree, node => node.type === "input" && !node.props.type && node.props.required === true).props.value, "Synthetic technician");
});

test("estimate draft fields are dirty but independently committed attachments are not discardable draft data", () => {
  const guard = guardCapture();
  const h = primitiveHarness("src/features/estimates/ContractorEstimatePanel.tsx", {
    "../../lib/forms/useUnsavedChangesGuard": guard.mock,
    "@tanstack/react-query": { useQueryClient: () => ({}) }, "../../lib/db": {},
    "../invoices/queries": {}, "../work-orders/queries": {},
    "./queries": { useContractorEstimatesQuery: () => ({ data: [] }), useContractorEstimateTemplatesQuery: () => ({ data: [] }) },
  });
  const props = { workOrder: { id: "SYNTHETIC-WO", status: "wip" }, currentUser: { canInvoice: true }, isManager: false, fire() {} };
  let tree = h.render("default", props); uiInvoke(button(tree, "+ New estimate"), "onClick"); tree = h.render("default", props);
  assert.equal(guard.options.dirty, false);
  const editor = h.slots[0]; assert.ok(editor && typeof editor === "object");
  h.slots[0] = { ...editor, attachments: [{ id: "synthetic-already-saved" }] };
  h.render("default", props); assert.equal(guard.options.dirty, false);
  // Test only the document fields: no attachment provider operation occurs.
  h.slots[0] = { ...editor, notes: "Unsaved synthetic scope" };
  tree = h.render("default", props); assert.equal(guard.options.dirty, true);
  uiInvoke(button(tree, "Cancel"), "onClick"); assert.deepEqual(guard.requests, ["cancel_button"]);
  tree = h.render("default", props); assert.ok(uiNodes(tree).some(node => node.type === "Modal"));
  h.slots[2] = "save"; tree = h.render("default", props); assert.equal(guard.options.busy, true);
  assert.equal(find(tree, node => node.type === "Modal").props.dismissDisabled, true);
});
