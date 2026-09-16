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

test("the floating profit calculator stays below the shared modal fallback layer", () => {
  const calculator = source("src/features/billing/FloatingProfitCalculator.tsx");
  const portalShell = source("src/components/PortalShell.tsx");
  const modal = source("src/components/ui/Modal.tsx");
  assert.match(calculator, /zIndex: 45/);
  assert.match(portalShell, /\.app-toast \{[\s\S]*?z-index: 45;/);
  assert.match(modal, /zIndex: 50/);
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
