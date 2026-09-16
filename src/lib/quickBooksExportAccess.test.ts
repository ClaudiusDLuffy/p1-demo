import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { controllerBoundaryHarness } from "../server/controller-exports/testing/boundaryHarness";

const source = (path: string) => readFileSync(
  resolve(process.cwd(), path),
  "utf8",
);

const exportPanel = source("src/features/invoices/ControllerExportPanel.tsx");
const dashboard = source("src/features/dashboard/Dashboard.tsx");
const invoiceList = source("src/features/invoices/InvoiceList.tsx");

test("all active staff can read the queue while the handoff remains capability-gated", async () => {
  for (const role of ["manager", "dispatcher", "back_office"]) for (const permissions of [[], ["invoice_controller"], ["quickbooks_export"], ["quickbooks_handoff"]]) {
    const h = controllerBoundaryHarness({ authorization: { role, permissions } });
    const headers = { Authorization: "Bearer synthetic-controller" };
    const queue = await h.route("GET", new Request("https://synthetic.invalid/api/controller-exports", { headers }));
    assert.equal(queue.status, 200); assert.equal((await queue.json()).canHandoff, permissions.includes("quickbooks_handoff"));
    const stage = await h.route("POST", new Request("https://synthetic.invalid/api/controller-exports", { method: "POST", headers, body: "{}" }));
    assert.equal(stage.status, permissions.includes("quickbooks_handoff") ? 200 : 403);
    assert.equal(h.service.calls.filter(call => call.method === "stage").length, permissions.includes("quickbooks_handoff") ? 1 : 0);
  }
});

test("the export panel does not turn an accountant into a restricted controller", () => {
  assert.match(exportPanel, /canHandoffQuickBooks\(currentUser\)/);
  assert.doesNotMatch(exportPanel, /isInvoiceController\(currentUser\)/);
  assert.match(dashboard, /const controller = isInvoiceController\(currentUser\)/);
  assert.match(dashboard, /<ControllerExportPanel/);
  assert.match(invoiceList, /\{isManager && \(\s*<ControllerExportPanel/);
});

test("the QuickBooks audit log stays closed until accounting opens it", () => {
  assert.match(exportPanel, /const \[showHistory, setShowHistory\] = useState\(false\)/);
  assert.match(exportPanel, /showHistory \? "Hide audit log" : "View audit log"/);
  assert.match(exportPanel, /setShowHistory\(true\)/);
});
