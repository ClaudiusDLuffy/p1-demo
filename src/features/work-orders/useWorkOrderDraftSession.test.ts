import assert from "node:assert/strict";
import test from "node:test";
import { primitiveHarness } from "../../lib/forms/primitiveComponentTestHarness";

test("same-call failures can recover their draft but an unmounted call cannot write through an old setter", () => {
  const h = primitiveHarness("src/features/work-orders/useWorkOrderDraftSession.ts");
  type Session = { captureDraftSession: (channel: "field_note" | "general") => () => boolean; markDraftEdited: (channel: "field_note" | "general") => void };
  const session = h.render("useWorkOrderDraftSession", { workOrderId: "SYNTHETIC-A", actorId: "actor-A" }) as Session;
  const cleanups = h.effects.map(effect => effect());
  const isCurrent = session.captureDraftSession("field_note");
  assert.equal(isCurrent(), true);
  session.markDraftEdited("general");
  assert.equal(isCurrent(), true, "Independent composer edits do not invalidate this draft");
  session.markDraftEdited("field_note");
  assert.equal(isCurrent(), false, "Never replace a newer same-call edit, even if the user cleared it again");
  const currentBeforeUnmount = session.captureDraftSession("field_note");
  cleanups.forEach(cleanup => { if (typeof cleanup === "function") cleanup(); });
  assert.equal(isCurrent(), false);
  assert.equal(currentBeforeUnmount(), false);
  const nextSession = h.render("useWorkOrderDraftSession", { workOrderId: "SYNTHETIC-B", actorId: "actor-B" }) as Session;
  h.effects.forEach(effect => effect());
  assert.equal(nextSession.captureDraftSession("field_note")(), true);
  assert.equal(isCurrent(), false);
});
