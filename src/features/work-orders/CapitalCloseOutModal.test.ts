import assert from "node:assert/strict";
import test from "node:test";
import { primitiveHarness, uiInvoke, uiNodes, uiText, type UiNode } from "../../lib/forms/primitiveComponentTestHarness";
import { createCapitalCloseOutAttempt, capitalCloseOutError } from "./capitalCloseOut";

const doc = { id: "21000000-0000-4000-8000-000000000001", num: "SYNTHETIC-QUOTE", documentKind: "capital_quote",
  state: "approved", invoiceVersion: 3, submissionRecorded: true };
const find = (tree: unknown, predicate: (node: UiNode) => boolean) => { const node = uiNodes(tree).find(predicate); assert.ok(node); return node; };
function setup(overrides: Record<string, unknown> = {}) {
  let actor = { id: "synthetic-staff", role: "manager", active: true };
  const work = { id: "SYNTHETIC-CAPITAL", status: "pending_capital_completion", workflowCycle: 0,
    contractorAssignmentVersion: 0, lifecycleVersion: 2 };
  const sent: Record<string, unknown>[] = []; const completed: string[] = []; let closed = 0;
  let transport: (args: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }> = async args => {
    const payload = args.p_payload as Record<string, unknown>;
    return { data: { applied: true, reason: "applied", operationId: args.p_operation_id, workOrderId: work.id,
      assignmentVersion: 0, workflowCycle: 0, lifecycleVersion: 5, functionalStatus: "Completed",
      activityId: "21000000-0000-4000-8000-000000000002", outcome: payload.outcome, documentId: payload.documentId,
      invoiceVersion: payload.invoiceVersion, invoiceCreated: false, csvExported: false,
      workOrderStatus: payload.outcome === "billed" ? "closed" : "pending_invoice" }, error: null };
  };
  const h = primitiveHarness("src/features/work-orders/CapitalCloseOutModal.tsx", {
    "../directory/queries": { useDirectoryActor: () => actor },
    "./queries": { useWorkOrderByIdQuery: () => ({ data: work, isPending: false, isError: false, refetch() {} }) },
    "@tanstack/react-query": { useQueryClient: () => ({ invalidateQueries: () => Promise.reject(new Error("synthetic refresh failure")) }) },
    "../../lib/forms/useUnsavedChangesGuard": { useUnsavedChangesGuard: ({ onClose }: { onClose(): void }) => ({ requestClose: onClose, dialog: null }) },
    "./capitalCloseOut": { createCapitalCloseOutAttempt, capitalCloseOutError,
      runCapitalCloseOutAttempt: (attempt: ReturnType<typeof createCapitalCloseOutAttempt>) => attempt(async (_name, args) => {
        sent.push(args); return transport(args);
      }) },
  });
  const props = { workOrderId: work.id, documents: [doc], hasCompleteEvidence: true,
    onClose: () => { closed++; }, onDone: (outcome: string) => completed.push(outcome), onReviewDocument() {}, ...overrides };
  const render = () => h.render("CapitalCloseOutModal", props);
  const submit = (tree: unknown) => uiInvoke(find(tree, node => node.type === "form"), "onSubmit", { preventDefault() {} });
  const setDate = (tree: unknown) => uiInvoke(find(tree, node => node.props.type === "date"), "onChange", { target: { value: "2026-10-01" } });
  return { ...h, props, work, render, submit, setDate, sent, completed, closed: () => closed,
    setTransport: (next: typeof transport) => { transport = next; }, setActor: (next: typeof actor) => { actor = next; } };
}

test("capital Close out has exactly two outcomes, defaults to billed, and does not write until confirmation", async () => {
  const h = setup(); let tree = h.render();
  assert.deepEqual(uiNodes(tree).filter(node => node.props.type === "radio").map(node => node.props.value), ["billed", "send_to_billing"]);
  assert.match(uiText(tree), /Completed and billed/); assert.match(uiText(tree), /Completed, send to billing/);
  assert.equal(h.sent.length, 0); h.setDate(tree); tree = h.render(); await h.submit(tree);
  assert.equal(h.sent.length, 1); assert.deepEqual(h.completed, ["billed"]); assert.equal(h.closed(), 1);
  assert.equal((h.sent[0].p_payload as Record<string, unknown>).documentId, doc.id);
});

test("completed, send to billing confirms in the same screen with no billing evidence or invoice/export callback", async () => {
  const h = setup(); let tree = h.render();
  uiInvoke(find(tree, node => node.props.value === "send_to_billing"), "onChange"); tree = h.render();
  assert.equal(uiNodes(tree).some(node => node.props.type === "date"), false);
  await h.submit(tree); assert.deepEqual(h.completed, ["send_to_billing"]);
  const payload = h.sent[0].p_payload as Record<string, unknown>;
  assert.equal(payload.billedOn, null); assert.equal(payload.invoiceReference, "");
});

test("an unsubmitted quote can be marked inline, but the form never assumes submission", async () => {
  const h = setup({ documents: [{ ...doc, state: "draft", submissionRecorded: false }] });
  let tree = h.render(); h.setDate(tree); tree = h.render(); await h.submit(tree);
  assert.equal(h.sent.length, 0);
  tree = h.render(); uiInvoke(find(tree, node => node.props.type === "checkbox"), "onChange", { target: { checked: true } });
  tree = h.render(); await h.submit(tree);
  assert.equal((h.sent[0].p_payload as Record<string, unknown>).markQuoteSubmitted, true);
  assert.deepEqual(h.completed, ["billed"]);
});

test("incomplete history, missing billing evidence, and active-visit blockers cannot write", async () => {
  for (const overrides of [{ hasCompleteEvidence: false }, { completionBlocker: "Actual checkout required" }, {}]) {
    const h = setup(overrides); await h.submit(h.render()); assert.equal(h.sent.length, 0);
  }
});

test("uncertain writes keep the same request frozen even if current documents, blockers, or versions refresh", async () => {
  const h = setup(); let tree = h.render(); h.setDate(tree); tree = h.render();
  h.setTransport(async () => { throw new Error("synthetic lost response"); });
  await h.submit(tree); tree = h.render();
  assert.equal(find(tree, node => node.type === "fieldset").props.disabled, true);
  assert.match(uiText(tree), /Retry same request/);
  h.work.lifecycleVersion = 5;
  h.props.documents = [];
  h.props.hasCompleteEvidence = false;
  Object.assign(h.props, { billedBlocker: "Newly loaded conflicting history" });
  tree = h.render();
  assert.equal(find(tree, node => node.props.type === "submit").props.disabled, false);
  h.setTransport(async args => ({ data: { applied: false, reason: "already_applied", operationId: args.p_operation_id,
    workOrderId: h.work.id, assignmentVersion: 0, workflowCycle: 0, lifecycleVersion: 5, functionalStatus: "Completed",
    activityId: "21000000-0000-4000-8000-000000000002", outcome: "billed", documentId: doc.id, invoiceVersion: 3,
    workOrderStatus: "closed", invoiceCreated: false, csvExported: false }, error: null }));
  await h.submit(tree);
  assert.deepEqual(h.sent[0], h.sent[1]); assert.deepEqual(h.completed, ["billed"]);
});

test("double clicks dispatch once and a late response from an old actor cannot navigate the new session", async () => {
  const h = setup(); let finish!: (value: { data: unknown; error: unknown }) => void;
  h.setTransport(() => new Promise(resolve => { finish = resolve; }));
  let tree = h.render(); h.setDate(tree); tree = h.render(); const saving = h.submit(tree);
  await h.submit(h.render()); assert.equal(h.sent.length, 1);
  h.setActor({ id: "other-staff", role: "manager", active: true }); h.render();
  finish({ data: { applied: true, reason: "applied", operationId: h.sent[0].p_operation_id, workOrderId: h.work.id,
    assignmentVersion: 0, workflowCycle: 0, lifecycleVersion: 5, functionalStatus: "Completed", workOrderStatus: "closed",
    activityId: "21000000-0000-4000-8000-000000000002", outcome: "billed", documentId: doc.id, invoiceVersion: 3,
    invoiceCreated: false, csvExported: false }, error: null });
  await saving; assert.equal(h.closed(), 0); assert.deepEqual(h.completed, []);
});
