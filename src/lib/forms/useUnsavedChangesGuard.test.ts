import assert from "node:assert/strict";
import test from "node:test";
import type { DiscardChangesDialogProps } from "../../components/ui/DiscardChangesDialog";
import type { UnsavedChangesOptions } from "./useUnsavedChangesGuard";
import { createUnsavedChangesHarness } from "./test-support/unsavedChangesHarness";

function dialogProps(value: unknown): DiscardChangesDialogProps {
  assert.ok(value && typeof value === "object" && "props" in value);
  return value.props as DiscardChangesDialogProps;
}
const settle = async () => { await Promise.resolve(); await Promise.resolve(); };

test("actual guard keeps dirty form mounted, then deliberately discards (DOM_SIMULATED hooks)", async () => {
  const h = createUnsavedChangesHarness(); let closed = 0, purged = 0;
  const options: UnsavedChangesOptions = { dirty: true, onClose: () => { closed += 1; }, onDiscard: () => { purged += 1; } };
  h.useGuard(options).requestClose("backdrop");
  assert.equal(closed, 0); assert.equal(h.listenerCount(), 1);
  dialogProps(h.useGuard(options).dialog).onKeepEditing();
  assert.equal(h.useGuard(options).dialog, null);
  h.useGuard(options).requestClose("escape");
  dialogProps(h.useGuard(options).dialog).onDiscard(); await settle();
  assert.equal(closed, 1); assert.equal(purged, 1);
  h.unmount(); assert.equal(h.listenerCount(), 0); assert.equal(h.registeredCount(), 0);
});
test("keep-draft is checked again and cannot use a pending or failed persistence claim", async () => {
  const h = createUnsavedChangesHarness(); let closed = 0, confirmed = false;
  const options: UnsavedChangesOptions = { dirty: true, persistence: "dirty_persisted", onClose: () => { closed += 1; }, onKeepDraft: () => confirmed };
  h.useGuard(options).requestClose("close_button");
  assert.equal(h.listenerCount(), 0);
  dialogProps(h.useGuard(options).dialog).onKeepDraft?.(); await settle();
  assert.equal(closed, 0); assert.equal(dialogProps(h.useGuard(options).dialog).failed, true);
  confirmed = true; options.persistence = "dirty_persisting";
  dialogProps(h.useGuard(options).dialog).onKeepDraft?.(); await settle(); assert.equal(closed, 0);
  options.persistence = "dirty_persisted";
  dialogProps(h.useGuard(options).dialog).onKeepDraft?.(); await settle(); assert.equal(closed, 1);
  h.unmount();
});
test("failed discard retains input; duplicate and in-flight requests are blocked", async () => {
  const h = createUnsavedChangesHarness(); let closed = 0, discard = 0;
  const options: UnsavedChangesOptions = { dirty: true, busy: true, onClose: () => { closed += 1; },
    onDiscard: () => { discard += 1; throw new Error("synthetic failure"); } };
  h.useGuard(options).requestClose("cancel_button"); assert.equal(h.useGuard(options).dialog, null);
  options.busy = false; h.useGuard(options).requestClose("cancel_button");
  const props = dialogProps(h.useGuard(options).dialog); props.onDiscard(); props.onDiscard(); await settle();
  assert.equal(discard, 1); assert.equal(closed, 0); assert.equal(dialogProps(h.useGuard(options).dialog).failed, true);
  h.unmount();
});
test("unmount or disabled identity prevents a late accepted dismissal", async () => {
  for (const unmount of [true, false]) {
    const h = createUnsavedChangesHarness(); let closed = 0; let finish: (value: boolean) => void = () => undefined;
    const options: UnsavedChangesOptions = { dirty: true, onClose: () => { closed += 1; },
      onDiscard: () => new Promise<boolean>(resolve => { finish = resolve; }) };
    h.useGuard(options).requestClose("navigation"); dialogProps(h.useGuard(options).dialog).onDiscard();
    if (unmount) h.unmount(); else { options.enabled = false; h.useGuard(options); }
    finish(true); await settle(); assert.equal(closed, 0); h.unmount();
  }
});
test("a persistent host cannot close the next identity or form after old confirmation resolves", async () => {
  const h = createUnsavedChangesHarness(); let closed = 0; let finish: (value: boolean) => void = () => undefined;
  const options: UnsavedChangesOptions = { dirty: true, scopeKey: "user-a:form-a", onClose: () => { closed += 1; },
    onDiscard: () => new Promise<boolean>(resolve => { finish = resolve; }) };
  h.useGuard(options).requestClose("navigation"); dialogProps(h.useGuard(options).dialog).onDiscard();
  options.scopeKey = "user-b:form-b"; h.useGuard(options);
  finish(true); await settle(); assert.equal(closed, 0); assert.equal(h.useGuard(options).dialog, null);
  h.unmount();
});
