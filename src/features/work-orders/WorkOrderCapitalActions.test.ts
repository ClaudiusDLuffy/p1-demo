import assert from "node:assert/strict";
import test from "node:test";
import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { WorkOrderCapitalActions } from "./WorkOrderCapitalActions";

const props: ComponentProps<typeof WorkOrderCapitalActions> = {
  workOrderId: "SYNTHETIC-CAPITAL", status: "assigned", enabled: true, canFlag: true,
  hasOpenVisit: false, isLoading: () => false,
  onFlag: () => {}, onDecline: () => {}, onResume: () => {}, onComplete: () => {},
};
const render = (overrides: Partial<typeof props> = {}) => renderToStaticMarkup(createElement(WorkOrderCapitalActions, { ...props, ...overrides }));

test("shared capital actions hide commands for an ineligible viewer", () => {
  assert.equal(render({ enabled: false }), "");
  assert.match(render(), />Flag capital</);
  assert.equal(render({ canFlag: false }), "");
});

test("capital actions retain stage eligibility and prevent skipping an active visit", () => {
  assert.match(render({ status: "capital", canFlag: false }), /Capital declined - restore field workflow/);
  const waiting = render({ status: "pending_capital_completion", canFlag: false, hasOpenVisit: true });
  assert.equal((waiting.match(/disabled=""/g) || []).length, 2);
  assert.match(waiting, /Waiting for active visit checkout/);
  assert.match(waiting, /Checkout required before completion/);
  const ready = render({ status: "pending_capital_completion", canFlag: false });
  assert.doesNotMatch(ready, /disabled/);
  assert.match(ready, /Authorize &amp; resume capital work/);
  assert.match(ready, /Capital Completed/);
});

test("loading disables the existing capital command without changing its eligibility", () => {
  assert.match(render({ isLoading: key => key === "capitalFlag_SYNTHETIC-CAPITAL" }), /disabled=""/);
});

test("Simplified hides duplicated completion controls while full view retains them", () => {
  const simplified = render({ status: "pending_capital_completion", canFlag: false, hideCloseOutActions: true });
  assert.doesNotMatch(simplified, /Capital Completed/);
  assert.match(simplified, /Authorize &amp; resume capital work/);
  assert.doesNotMatch(render({ status: "capital", hideCloseOutActions: true, onRecordExternal: () => {} }), /Record external capital quote/);
  assert.match(render({ status: "capital", onRecordExternal: () => {} }), /Record external capital quote/);
});
