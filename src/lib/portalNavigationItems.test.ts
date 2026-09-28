import assert from "node:assert/strict";
import test from "node:test";
import {
  buildBottomNavigationItems,
  buildPortalNavigationItems,
  portalNavigationRole,
  portalPageTitle,
  initialFocusedPortalPage,
} from "./portalNavigationItems";

const emptyCounts = {
  capital: null,
  contractorActive: null,
  contractorAttention: null,
  contractorInvoice: null,
  history: null,
  open: null,
  pendingApproval: null,
  staffWork: null,
};

test("builds role-specific portal navigation without leaking manager pages", () => {
  const contractor = buildPortalNavigationItems({
    invoiceController: false,
    isManager: false,
    canInvoice: true,
    counts: emptyCounts,
  });
  assert.deepEqual(contractor.map(item => item.id), ["my_jobs", "my_schedule", "history", "invoices"]);

  const manager = buildPortalNavigationItems({ invoiceController: false, isManager: true, counts: emptyCounts });
  assert.ok(manager.some(item => item.id === "simplified"));
  assert.ok(manager.some(item => item.id === "my_schedule"));
  assert.equal(manager.find(item => item.id === "my_schedule")?.beta, true);
  assert.equal(contractor.find(item => item.id === "my_schedule")?.beta, true);
  assert.equal(manager.filter(item => item.beta).length, 1);
  assert.ok(!contractor.some(item => item.id === "simplified"));
});

test("restores focused tabs only for their allowed navigation roles", () => {
  assert.equal(initialFocusedPortalPage("contractor", "?portal=my_schedule"), "my_schedule");
  assert.equal(initialFocusedPortalPage("manager", "?portal=my_schedule"), "my_schedule");
  assert.equal(initialFocusedPortalPage("manager", "?portal=simplified"), "simplified");
  assert.equal(initialFocusedPortalPage("contractor", "?portal=simplified"), "my_jobs");
  assert.equal(initialFocusedPortalPage("controller", "?portal=my_schedule"), "dashboard");
  assert.equal(initialFocusedPortalPage("controller", "?portal=simplified"), "dashboard");
  assert.equal(initialFocusedPortalPage("contractor", "?portal=unknown"), "my_jobs");
  assert.equal(initialFocusedPortalPage("manager", ""), "dashboard");
});

test("selects stable bottom navigation for each role", () => {
  const controllerRole = portalNavigationRole({ invoiceController: true, isManager: false });
  const controller = buildPortalNavigationItems({ invoiceController: true, isManager: false, counts: emptyCounts });
  assert.deepEqual(buildBottomNavigationItems(controller, controllerRole).map(item => item.id), ["dashboard", "invoices"]);

  const contractorRole = portalNavigationRole({ invoiceController: false, isManager: false });
  const contractor = buildPortalNavigationItems({ invoiceController: false, isManager: false, counts: emptyCounts });
  assert.deepEqual(buildBottomNavigationItems(contractor, contractorRole).map(item => item.id), ["my_jobs", "my_schedule", "history"]);
});

test("resolves contextual page titles", () => {
  assert.equal(portalPageTitle("work_orders", { isManager: true, selectedWorkOrderTitle: "WOT123" }), "WOT123");
  assert.equal(portalPageTitle("invoices", { isManager: false }), "Invoices");
  assert.equal(portalPageTitle("unknown", { isManager: true }), "P1 Service Portal");
});
