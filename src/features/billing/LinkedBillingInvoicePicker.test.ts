import assert from "node:assert/strict";
import test from "node:test";
import { primitiveHarness, uiInvoke, uiNodes, uiText, type UiNode } from "../../lib/forms/primitiveComponentTestHarness";
import type { LinkedBillingCandidate } from "./linkedBillingContracts";

const candidate: LinkedBillingCandidate = { workOrderId: "SYNTHETIC-OTHER", invoiceId: "21000000-0000-4000-8000-000000000001",
  invoiceNumber: "SYNTHETIC-BILL", invoiceDate: "2026-11-25", state: "submitted", invoiceVersion: 1,
  assignmentVersion: 0, workflowCycle: 0 };
const find = (tree: unknown, predicate: (node: UiNode) => boolean) => {
  const result = uiNodes(tree).find(predicate); assert.ok(result); return result;
};
function setup() {
  let result: Record<string, unknown> = { isFetching: false, isSuccess: false, isError: false };
  let options: Record<string, unknown> = {}; let refetches = 0;
  const selected: (LinkedBillingCandidate | null)[] = [];
  const props = { sourceWorkOrderId: "SYNTHETIC-SOURCE", selected: null as LinkedBillingCandidate | null, disabled: false,
    onSelect(value: LinkedBillingCandidate | null) { selected.push(value); props.selected = value; } };
  const h = primitiveHarness("src/features/billing/LinkedBillingInvoicePicker.tsx", {
    "../directory/queries": { useDirectoryActor: () => ({ id: "staff", role: "manager", active: true }) },
    "@tanstack/react-query": { useQuery: (next: Record<string, unknown>) => { options = next; return { ...result, refetch() { refetches++; } }; } },
  });
  const render = () => h.render("LinkedBillingInvoicePicker", props);
  const fill = (suffix: string, value: string) => uiInvoke(find(render(), node => node.type === "Input"
    && String(node.props.id).endsWith(suffix)), "onChange", { target: { value } });
  const click = (label: string) => uiInvoke(find(render(), node => node.type === "button" && uiText(node.props.children) === label), "onClick");
  return { props, selected, render, fill, click, options: () => options, refetches: () => refetches,
    setResult: (value: Record<string, unknown>) => { result = value; } };
}
test("picker explains find, select and exact-filter semantics without searching or selecting on open", () => {
  const h = setup(); const tree = h.render();
  assert.equal(h.options().enabled, false); assert.equal(h.selected.length, 0);
  assert.match(uiText(tree), /Find the invoice on the other work order/);
  assert.match(uiText(tree), /including NA or N\/A, is an exact invoice-number filter/);
});
test("a work-order number alone, or one search result, never silently selects billing coverage", () => {
  const h = setup(); h.fill("-work", candidate.workOrderId); h.click("Find submitted invoices");
  h.setResult({ isSuccess: true, data: { items: [candidate], hasMore: false } });
  const tree = h.render(); const radio = find(tree, node => node.props.type === "radio");
  assert.equal(radio.props.checked, false); assert.equal(h.props.selected, null);
  assert.match(uiText(tree), /2\. Select the invoice/);
  uiInvoke(radio, "onChange"); assert.equal(h.props.selected, candidate);
  assert.match(uiText(h.render()), /Selected invoice: #SYNTHETIC-BILL/);
});
test("NA remains an exact search; a clear explicit action removes that filter and re-searches the same WO", () => {
  const h = setup(); h.fill("-work", candidate.workOrderId); h.fill("-invoice", "NA");
  h.click("Find submitted invoices"); h.render();
  assert.equal((h.options().queryKey as unknown[])[2] && ((h.options().queryKey as unknown[])[2] as { invoiceNumber: string }).invoiceNumber, "NA");
  h.setResult({ isSuccess: true, data: { items: [], hasMore: false } });
  h.click("Search all invoices on this WO"); h.render();
  assert.equal(JSON.stringify((h.options().queryKey as unknown[])[2]), JSON.stringify({ workOrderId: candidate.workOrderId, invoiceNumber: "" }));
  assert.equal(h.props.selected, null);
});
test("editing either field clears previously selected coverage and results", () => {
  for (const suffix of ["-work", "-invoice"]) {
    const h = setup(); h.props.selected = candidate; h.fill(suffix, "changed"); h.render();
    assert.equal(h.props.selected, null); assert.equal(h.options().enabled, false);
  }
});
test("same-work-order and missing-work-order lookups show guidance, not candidate requests", () => {
  for (const work of ["", "SYNTHETIC-SOURCE"]) {
    const h = setup(); h.fill("-work", work); h.click("Find submitted invoices"); const tree = h.render();
    assert.equal(h.options().enabled, false); assert.match(uiText(tree), /Enter a different work order number/);
  }
});
test("retrying the same search refetches and still requires explicit selection", () => {
  const h = setup(); h.fill("-work", candidate.workOrderId); h.click("Find submitted invoices"); h.render();
  h.click("Find submitted invoices"); assert.equal(h.refetches(), 1); assert.equal(h.props.selected, null);
});
