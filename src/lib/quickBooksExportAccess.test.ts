import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const source = (path: string) => readFileSync(
  resolve(process.cwd(), path),
  "utf8",
);

const exportRoute = source("src/app/api/controller-exports/route.ts");
const exportPanel = source("src/features/invoices/ControllerExportPanel.tsx");
const dashboard = source("src/features/dashboard/Dashboard.tsx");

test("all active staff can read the queue while the handoff remains capability-gated", () => {
  assert.match(exportRoute, /STAFF_ROLES\.has\(profile\.role/);
  assert.match(exportRoute, /canHandoffQuickBooksProfile/);
  assert.match(exportRoute, /if \(!auth\.canHandoff\)/);
  assert.doesNotMatch(exportRoute, /isInvoiceControllerProfile/);
});

test("the export panel does not turn an accountant into a restricted controller", () => {
  assert.match(exportPanel, /canHandoffQuickBooks\(currentUser\)/);
  assert.doesNotMatch(exportPanel, /isInvoiceController\(currentUser\)/);
  assert.match(dashboard, /const controller = isInvoiceController\(currentUser\)/);
  assert.match(dashboard, /<ControllerExportPanel/);
});

test("the QuickBooks audit log stays closed until accounting opens it", () => {
  assert.match(exportPanel, /const \[showHistory, setShowHistory\] = useState\(false\)/);
  assert.match(exportPanel, /showHistory \? "Hide audit log" : "View audit log"/);
  assert.match(exportPanel, /setShowHistory\(true\)/);
});
