import assert from "node:assert/strict";
import test from "node:test";
import { primitiveHarness, uiInvoke, uiNodes, uiText, type UiNode } from "../../lib/forms/primitiveComponentTestHarness";
import { createCapitalCloseOutAttempt, capitalCloseOutError, validateCapitalCloseOutForm } from "./capitalCloseOut";

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
    "./capitalCloseOut": { createCapitalCloseOutAttempt, capitalCloseOutError, validateCapitalCloseOutForm,
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

test("external quote closeout identifies, focuses and clears each missing field without a request", async () => {
  const h = setup({ documents: [] });
  const control = (suffix: string) => find(h.render(), node => String(node.props.id || "").endsWith(suffix));
  const fill = (suffix: string, value: string) => uiInvoke(control(suffix), "onChange", { target: { value } });
  const focused: string[] = [];
  const submitAndCommit = async () => {
    await h.submit(h.render()); h.render(); h.effects.at(-1)?.();
  };
  for (const suffix of ["-quote", "-submitted", "-invoice", "-date"]) {
    const ref = control(suffix).props.ref as { current: unknown };
    ref.current = { focus() { focused.push(suffix); }, scrollIntoView() {} };
  }
  // The reported state: billing evidence entered and checkbox checked, but no quote reference.
  fill("-invoice", "SYNTHETIC-BILL"); fill("-date", "2026-10-01");
  uiInvoke(control("-submitted"), "onChange", { target: { checked: true } });
  await submitAndCommit();
  assert.equal(h.sent.length, 0); assert.equal(focused.at(-1), "-quote");
  assert.equal(control("-quote").props["aria-invalid"], true);
  assert.match(uiText(h.render()), /Enter the approved quote reference from 7-Eleven/);
  assert.match(String(control("-quote").props["aria-describedby"]), /quoteReference-error/);
  fill("-quote", "SYNTHETIC-QUOTE");
  assert.equal(control("-quote").props["aria-invalid"], undefined);
  assert.equal(uiNodes(h.render()).some(node => node.props.role === "alert"), false);

  uiInvoke(control("-submitted"), "onChange", { target: { checked: false } });
  await submitAndCommit();
  assert.equal(h.sent.length, 0); assert.equal(focused.at(-1), "-submitted");
  assert.match(uiText(h.render()), /Confirm the actual quote submission using the checkbox/);
  uiInvoke(control("-submitted"), "onChange", { target: { checked: true } });
  fill("-invoice", "   ");
  await submitAndCommit();
  assert.equal(h.sent.length, 0); assert.equal(focused.at(-1), "-invoice");
  assert.match(uiText(h.render()), /Enter the existing billed invoice reference/);
  fill("-invoice", "SYNTHETIC-BILL"); fill("-date", "");
  await submitAndCommit();
  assert.equal(h.sent.length, 0); assert.equal(focused.at(-1), "-date");
  assert.match(uiText(h.render()), /Enter the actual billing date/);
  fill("-date", "2026-10-01"); await h.submit(h.render());
  assert.equal(h.sent.length, 1); assert.equal(h.closed(), 1);
  assert.deepEqual((h.sent[0].p_payload as Record<string, unknown>).quoteReference, "SYNTHETIC-QUOTE");
});

test("switching to send-to-billing removes obsolete invoice errors but still requires quote evidence", async () => {
  const h = setup({ documents: [] });
  const fill = (suffix: string, value: string) => uiInvoke(find(h.render(), node => String(node.props.id || "").endsWith(suffix)),
    "onChange", { target: { value } });
  fill("-quote", "SYNTHETIC-QUOTE");
  uiInvoke(find(h.render(), node => node.props.type === "checkbox"), "onChange", { target: { checked: true } });
  await h.submit(h.render()); assert.match(uiText(h.render()), /Enter the existing billed invoice reference/);
  uiInvoke(find(h.render(), node => node.props.value === "send_to_billing"), "onChange");
  assert.equal(uiNodes(h.render()).some(node => node.props.role === "alert"), false);
  assert.equal(uiNodes(h.render()).some(node => node.props.type === "date"), false);
  await h.submit(h.render()); assert.equal(h.sent.length, 1);
  const payload = h.sent[0].p_payload as Record<string, unknown>;
  assert.equal(payload.outcome, "send_to_billing"); assert.equal(payload.invoiceReference, "");
  assert.equal(payload.billedOn, null); assert.equal(payload.quoteReference, "SYNTHETIC-QUOTE");
});

test("inactive, contractor and controller actors cannot render or submit capital closeout", async () => {
  const actors = [{ id: "inactive-staff", role: "manager", active: false },
    { id: "synthetic-contractor", role: "contractor", active: true },
    { id: "synthetic-controller", role: "back_office", active: true, staffPermissions: ["invoice_controller"] }];
  for (const actor of actors) {
    const h = setup(); h.setActor(actor);
    assert.equal(h.render(), null); assert.equal(h.sent.length, 0);
  }
});
