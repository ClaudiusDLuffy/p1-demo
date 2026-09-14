import assert from "node:assert/strict";
import test from "node:test";
import { decideDismissal, needsUnloadWarning } from "./dismissal";
import type { DirtyPersistenceState, ModalDismissReason } from "./dismissal";
import { dirtyFormRegistrySize, hasDirtySensitiveForms, registerDirtySensitiveForm } from "./dirtyFormRegistry";

const reasons: ModalDismissReason[] = ["close_button", "escape", "backdrop", "cancel_button", "navigation", "programmatic"];
const states: DirtyPersistenceState[] = ["clean", "dirty_not_persisted", "dirty_persisting", "dirty_persisted", "persist_failed"];
for (const reason of reasons) for (const persistence of states) {
  test(`${reason}/${persistence}: dirty never silently closes (PURE_STATE)`, () => {
    assert.equal(decideDismissal({ reason, persistence, dirty: true, busy: false }).action,
      persistence === "dirty_persisted" ? "confirm_keep_draft" : "confirm_discard");
    assert.equal(decideDismissal({ reason, persistence, dirty: false, busy: false }).action, "close");
    assert.equal(decideDismissal({ reason, persistence, dirty: true, busy: true }).action, "blocked");
  });
}
test("authoritative submitted path bypasses stale dirty state", () => {
  assert.equal(decideDismissal({ reason: "submitted", persistence: "dirty_persisting", dirty: true, busy: true }).action, "close");
});
test("unload warns only for actual unconfirmed input", () => {
  for (const state of states) {
    assert.equal(needsUnloadWarning(false, state), false);
    assert.equal(needsUnloadWarning(true, state), state !== "dirty_persisted");
  }
});
test("dirty summary remains bounded and cleanup idempotent", () => {
  assert.equal(hasDirtySensitiveForms(), false);
  const cleanups = Array.from({ length: 1000 }, () => registerDirtySensitiveForm());
  assert.equal(dirtyFormRegistrySize(), 128);
  assert.equal(hasDirtySensitiveForms(), true);
  for (const cleanup of cleanups) { cleanup(); cleanup(); }
  assert.equal(dirtyFormRegistrySize(), 0);
  assert.equal(hasDirtySensitiveForms(), false);
});
