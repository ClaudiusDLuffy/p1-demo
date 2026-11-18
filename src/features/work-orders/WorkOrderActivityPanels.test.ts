import assert from "node:assert/strict";
import test from "node:test";
import { primitiveHarness, uiNodes } from "../../lib/forms/primitiveComponentTestHarness";

test("copy confirmation preserves line breaks and wraps unbroken note text", () => {
  const h = primitiveHarness("src/features/work-orders/WorkOrderActivityPanels.tsx", {
    "./useWorkOrderDraftSession": { useWorkOrderDraftSession: () => ({ captureDraftSession: () => () => true, markDraftEdited() {} }) },
  });
  const props = { activities: [], workOrderId: "SYNTHETIC-WRAP", currentUser: { id: "synthetic-va" },
    isVaCoordinator: true, isManager: false, readOnly: true, isLoading: () => false,
    fieldNoteText: "", onMarkVaNoteCopiedToSevenEleven: async () => true };
  h.render("default", props);
  const text = "Long unbroken note\n" + "L".repeat(4000);
  h.slots[1] = { id: "synthetic-note", text };
  const tree = h.render("default", props);
  const note = uiNodes(tree).find(node => node.type === "div" && node.props.children === text)!;
  assert.ok(note);
  const style = note.props.style as Record<string, unknown>;
  assert.equal(style.whiteSpace, "pre-wrap");
  assert.equal(style.overflowWrap, "anywhere");
});
