import assert from "node:assert/strict";
import test from "node:test";
import { primitiveHarness, uiNodes, uiText, uiInvoke } from "../../lib/forms/primitiveComponentTestHarness";

const evidence = { workOrderId: "SYNTHETIC-WO", invoiceNumber: "SYNTHETIC-40", billedAt: "2026-08-06T12:00:00Z" };
function harness() {
  let calls = 0, attempts = 0, invalidations = 0, uncertain = false;
  const h = primitiveHarness("src/features/work-orders/RecordedBillingCloseOutModal.tsx", {
    "@tanstack/react-query": { useQueryClient: () => ({ invalidateQueries: async () => { invalidations++; } }) },
    "../directory/queries": { useDirectoryActor: () => ({ id: "staff", active: true, role: "manager" }) },
    "../../lib/forms/useUnsavedChangesGuard": { useUnsavedChangesGuard: () => ({ requestClose() {}, dialog: null }) },
    "./recordedBillingCloseOut": {
      createRecordedBillingCloseOutAttempt: () => { attempts++; return {}; },
      runRecordedBillingCloseOutAttempt: async () => { calls++; if (uncertain) throw new Error("Synthetic transport failure"); return { invoiceNumber: evidence.invoiceNumber }; },
      recordedBillingCloseOutError: () => ({ message: "Retry this unchanged request", uncertain: true }),
    },
  });
  return { ...h, stats: () => ({ calls, attempts, invalidations }), setUncertain: (next: boolean) => { uncertain = next; } };
}
function node(tree: unknown, type: string, text?: string) {
  const found = uiNodes(tree).find(n => n.type === type && (!text || uiText(n.props.children) === text));
  assert.ok(found); return found;
}
test("staff must explicitly confirm before the reconciliation command is created", async () => {
  const h = harness(); const props = { evidence, onClose() {} };
  let tree = h.render("RecordedBillingCloseOutModal", props);
  await uiInvoke(node(tree, "button", "Confirm already billed and close"), "onClick");
  assert.equal(h.stats().calls, 0); assert.equal(h.stats().attempts, 0);
  tree = h.render("RecordedBillingCloseOutModal", props); assert.match(uiText(tree), /Confirm that the job is finished/);
  uiInvoke(node(tree, "input"), "onChange", { target: { checked: true } });
  tree = h.render("RecordedBillingCloseOutModal", props);
  await uiInvoke(node(tree, "button", "Confirm already billed and close"), "onClick");
  await new Promise<void>(resolve => setImmediate(resolve));
  tree = h.render("RecordedBillingCloseOutModal", props);
  assert.match(uiText(tree), /Work order closed using the existing recorded billing/);
  assert.equal(h.stats().calls, 1); assert.equal(h.stats().invalidations, 1);
});
test("uncertain saves lock confirmation and retain the same attempt for retry", async () => {
  const h = harness(); h.setUncertain(true); const props = { evidence, onClose() {} };
  let tree = h.render("RecordedBillingCloseOutModal", props);
  uiInvoke(node(tree, "input"), "onChange", { target: { checked: true } });
  tree = h.render("RecordedBillingCloseOutModal", props);
  await uiInvoke(node(tree, "button", "Confirm already billed and close"), "onClick");
  await new Promise<void>(resolve => setImmediate(resolve));
  tree = h.render("RecordedBillingCloseOutModal", props); assert.equal(node(tree, "input").props.disabled, true);
  h.setUncertain(false);
  await uiInvoke(node(tree, "button", "Retry same request"), "onClick");
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.deepEqual(h.stats(), { calls: 2, attempts: 1, invalidations: 1 });
});
