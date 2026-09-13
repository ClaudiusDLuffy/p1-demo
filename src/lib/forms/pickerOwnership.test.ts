import assert from "node:assert/strict";
import test from "node:test";
import { primitiveHarness, uiInvoke, uiNodes } from "./primitiveComponentTestHarness";

for (const [name, positionSlot] of [["DatePickerField", 4], ["TimePickerField", 6]] as const) {
  test(`${name} belongs to parent modal portal and consumes Escape before parent dismissal`, () => {
    const host = { id: "synthetic-owned-layer" }; const portals: unknown[] = []; let focused = 0;
    const h = primitiveHarness("src/components/ui/DateTimePicker.tsx", {
      "./Modal": { useModalPortalHost: () => host },
      "react-dom": { createPortal: (children: unknown, target: unknown) => { portals.push(target); return children; } },
      "react-day-picker": { DayPicker: "DayPicker" }, "react-day-picker/style.css": {}, "./Sel": { Sel: "Sel" },
    });
    const props = { value: name === "DatePickerField" ? "2026-09-10" : "12:30", onChange() {}, "aria-label": "Synthetic date or time" };
    let tree = h.render(name, props);
    const trigger = uiNodes(tree).find(node => node.type === "button"); assert.ok(trigger);
    assert.equal(trigger.props["aria-label"], props["aria-label"]);
    assert.equal(trigger.props["aria-expanded"], false); assert.ok(trigger.props["aria-controls"]);
    (trigger.props.ref as { current: unknown }).current = { focus() { focused++; } };
    uiInvoke(trigger, "onClick"); h.slots[positionSlot] = { width: 320, left: 10, top: 30, maxHeight: 400 };
    tree = h.render(name, props); assert.equal(portals.at(-1), host);
    const popup = uiNodes(tree).find(node => node.props.role === "dialog"); assert.ok(popup);
    assert.equal(popup.props["aria-modal"], "false"); assert.ok(popup.props["aria-label"]);
    let prevented = false; let stopped = false;
    uiInvoke(popup, "onKeyDown", { key: "Escape", defaultPrevented: false, preventDefault() { prevented = true; }, stopPropagation() { stopped = true; } });
    assert.equal(prevented, true); assert.equal(stopped, true); assert.equal(focused, 1);
    tree = h.render(name, props); assert.equal(uiNodes(tree).some(node => node.props.role === "dialog"), false);
  });
}
