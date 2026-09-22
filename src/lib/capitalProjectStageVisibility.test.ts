import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { CAPITAL_PROJECT_FILTERS, capitalProjectStage } from "../features/work-orders/capitalProjectStage";

const capitalView = readFileSync(resolve("src/features/work-orders/CapitalProjects.tsx"), "utf8");

test("capital project stages describe the complete operational board", () => {
  assert.deepEqual(CAPITAL_PROJECT_FILTERS.map(option => option.label), [
    "All capital statuses", "Waiting for quote", "Quote submitted — pending capital approval",
    "Approved — work authorized", "Equipment ordered — waiting for equipment", "Equipment received",
    "Installation scheduled", "Installed",
  ]);
  assert.deepEqual(capitalProjectStage({ status: "capital", capitalStatus: null }), {
    filter: "capital_waiting_quote", label: "Waiting for quote", tone: "waiting",
  });
  assert.deepEqual(capitalProjectStage({ status: "pending_capital_completion", capitalStatus: null }), {
    filter: "capital_quote_submitted", label: "Quote submitted — pending capital approval", tone: "submitted",
  });
  assert.equal(capitalProjectStage({ status: "capital", capitalStatus: "Pending approval" }).filter, "capital_quote_submitted");
});
test("persisted authorization, equipment, scheduling, and installation stages remain distinct", () => {
  const expectations = new Map([
    ["Approved - work authorized", "capital_work_authorized"], ["Equipment ordered", "capital_equipment_ordered"],
    ["Equipment received", "capital_equipment_received"], ["Installation scheduled", "capital_installation_scheduled"],
    ["Installed", "capital_installed"],
  ]);
  for (const [capitalStatus, filter] of expectations) {
    assert.equal(capitalProjectStage({ status: "parts", capitalStatus }).filter, filter);
  }
});

test("capital list sends the selected stage to the server and resets pagination", () => {
  assert.match(capitalView, /aria-label="Capital status"/);
  assert.match(capitalView, /status: capitalFilter/);
  assert.match(capitalView, /setPosition\(firstCursorPosition\); setCapitalFilter/);
  assert.match(capitalView, /data-capital-stage=\{stage\.filter\}/);
  assert.match(capitalView, /scope: "capital"/);
  assert.doesNotMatch(capitalView, /\.filter\([^)]*capitalFilter/);
});
