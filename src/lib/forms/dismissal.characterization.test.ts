import assert from "node:assert/strict";
import test from "node:test";

// Frozen Batch 4B closeout behavior, characterized before the Phase 7A guard.
// This deliberately retains the old reset -> close ordering as a regression
// comparison, not as a production dismissal implementation.
test("legacy work-order Cancel discards dirty input without asking (PURE_STATE)", () => {
  let draft = "synthetic unsaved work";
  let open = true;
  const reset = () => { draft = ""; };
  const onClose = () => { open = false; };
  const discardAndClose = () => { reset(); onClose(); };
  discardAndClose();
  assert.equal(draft, "");
  assert.equal(open, false);
});

test("legacy modal callback has no dirty or in-flight decision (PURE_STATE)", () => {
  let requests = 0;
  const onClose = () => { requests += 1; };
  const backdrop = (sameTarget: boolean, closeOnBackdrop = true) => {
    if (closeOnBackdrop && sameTarget) onClose();
  };
  backdrop(false);
  backdrop(true, false);
  assert.equal(requests, 0);
  backdrop(true);
  assert.equal(requests, 1);
});
