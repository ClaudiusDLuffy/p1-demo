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

test("the export route requires active staff with the additive capability", () => {
  assert.match(exportRoute, /STAFF_ROLES\.has\(profile\.role/);
  assert.match(exportRoute, /canExportQuickBooksProfile/);
  assert.doesNotMatch(exportRoute, /isInvoiceControllerProfile/);
});

test("the export panel does not turn an accountant into a restricted controller", () => {
  assert.match(exportPanel, /canExportQuickBooks\(currentUser\)/);
  assert.doesNotMatch(exportPanel, /isInvoiceController\(currentUser\)/);
  assert.match(dashboard, /const controller = isInvoiceController\(currentUser\)/);
  assert.match(dashboard, /<ControllerExportPanel/);
});
