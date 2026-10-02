import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { getFloatingPanelPosition } from "./floatingPanel";

const source = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

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

  assert.equal(position.maxHeight, 196);
  assert.ok(position.top + position.maxHeight <= 212);
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

test("a preferred top picker falls below when the trigger is near the top", () => {
  const position = getFloatingPanelPosition({
    trigger: { top: 12, right: 300, bottom: 56, left: 20, width: 280 },
    panelWidth: 318, panelHeight: 430, viewportWidth: 320, viewportHeight: 568,
    preferredPlacement: "top",
  });
  assert.equal(position.placement, "bottom");
  assert.equal(position.top, 64);
  assert.ok(position.maxHeight > 0);
});

test("short mobile dropdowns fit beside their trigger instead of overlapping it", () => {
  for (const top of [60, 200, 420]) {
    const position = getFloatingPanelPosition({ trigger: { top, right: 300, bottom: top + 44, left: 20, width: 280 },
      panelWidth: 318, panelHeight: 360, viewportWidth: 320, viewportHeight: 568 });
    assert.ok(position.left >= 16 && position.left + position.width <= 304);
    assert.ok(position.placement === "top" ? position.top + position.maxHeight <= top - 8 : position.top >= top + 52);
  }
});

test("the calculator requires an owned host and cannot fall back to a floating overlay", () => {
  const calculator = source("src/features/billing/BillingProfitCalculator.tsx");
  assert.match(calculator, /if \(!visible \|\| !host\) return null/);
  assert.match(calculator, /return createPortal\(calculator, host\)/);
  assert.doesNotMatch(calculator, /\bfixed\b|\bsticky\b|z-\[|zIndex/);
});

test("work-order activity menus stay above mobile navigation and below modals", () => {
  const activity = source("src/features/work-orders/WorkOrderActivityPanels.tsx");
  const portalShell = source("src/components/PortalShell.tsx");
  const modal = source("src/components/ui/Modal.tsx");

  assert.match(portalShell, /className="mobile-bottom-nav"[\s\S]*?zIndex: 40/);
  assert.match(activity, /position: "fixed", inset: 0, zIndex: 42/);
  assert.match(activity, /position: "absolute", top: 34, right: 0, zIndex: 43/);
  assert.doesNotMatch(activity, /className="card" style=\{\{ overflow: "hidden"/);
  assert.equal(activity.match(/className="card" style=\{\{ overflow: "visible"/g)?.length, 2);
  assert.match(modal, /zIndex: 50/);
});
