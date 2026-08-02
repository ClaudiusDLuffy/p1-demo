import assert from "node:assert/strict";
import test from "node:test";
import { getFloatingPanelPosition } from "./floatingPanel";

test("a bottom picker flips above a trigger near the viewport edge", () => {
  const position = getFloatingPanelPosition({
    trigger: { top: 680, right: 320, bottom: 724, left: 100, width: 220 },
    panelWidth: 318,
    panelHeight: 430,
    viewportWidth: 1200,
    viewportHeight: 800,
  });

  assert.equal(position.placement, "top");
  assert.equal(position.top, 242);
  assert.ok(position.top + position.maxHeight <= 784);
});

test("a picker stays below when there is enough room", () => {
  const position = getFloatingPanelPosition({
    trigger: { top: 100, right: 320, bottom: 144, left: 100, width: 220 },
    panelWidth: 318,
    panelHeight: 430,
    viewportWidth: 1200,
    viewportHeight: 800,
  });

  assert.equal(position.placement, "bottom");
  assert.equal(position.top, 152);
});

test("an oversized picker is constrained to a short viewport", () => {
  const position = getFloatingPanelPosition({
    trigger: { top: 220, right: 320, bottom: 264, left: 100, width: 220 },
    panelWidth: 318,
    panelHeight: 430,
    viewportWidth: 600,
    viewportHeight: 320,
  });

  assert.equal(position.maxHeight, 288);
  assert.ok(position.top >= 16);
  assert.ok(position.top + position.maxHeight <= 304);
});

test("a right picker falls back to the left at the viewport edge", () => {
  const position = getFloatingPanelPosition({
    trigger: { top: 100, right: 1180, bottom: 144, left: 1000, width: 180 },
    panelWidth: 318,
    panelHeight: 430,
    viewportWidth: 1200,
    viewportHeight: 800,
    preferredPlacement: "right",
  });

  assert.equal(position.placement, "left");
  assert.equal(position.left, 674);
});
