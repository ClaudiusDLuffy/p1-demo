import { accounts, expect, login, sidebar, test } from "./fixtures.mjs";

const staffNavigation = ["Dashboard", "My Work", "Work orders", "Capital", "Contractor bills", "7-Eleven billing", "Contractors", "Contractor view", "History"];

const matrix = [
  ["manager", accounts.manager, staffNavigation, ["Controller", "My jobs"]],
  ["dispatcher", accounts.dispatcher, staffNavigation, ["Controller", "My jobs"]],
  ["back office", accounts.backoffice, staffNavigation, ["Controller", "My jobs"]],
  ["accounting handoff", accounts.accounting, staffNavigation, ["Controller", "My jobs"]],
  ["invoice controller", accounts.controller, ["Controller", "Contractor bills"], ["Work orders", "7-Eleven billing", "Contractors"]],
  ["direct contractor", accounts.direct, ["My jobs", "Closed jobs", "Invoices"], ["Work orders", "My Team"]],
  ["company administrator", accounts.companyAdmin, ["My jobs", "Closed jobs", "My Team", "Invoices"], ["Work orders"]],
  ["second company administrator", accounts.companyAdminTwo, ["My jobs", "Closed jobs", "My Team", "Invoices"], ["Work orders"]],
  ["invoice technician", accounts.invoiceTech, ["My jobs", "Closed jobs", "Invoices"], ["My Team", "Work orders"]],
  ["report-only technician", accounts.reportTech, ["My jobs", "Closed jobs"], ["Invoices", "My Team", "Work orders"]],
  ["team lead", accounts.teamLead, ["My jobs", "Closed jobs", "My Team"], ["Invoices", "Work orders"]],
  ["team member", accounts.teamMember, ["My jobs", "Closed jobs"], ["Invoices", "My Team", "Work orders"]],
];

for (const [label, account, visible, hidden] of matrix) {
  test(`${label} sees only its authorized navigation`, async ({ page }) => {
    await login(page, account);
    const nav = sidebar(page);
    for (const item of visible) {
      await expect(nav.locator("button").filter({ hasText: item }).first(), `${label}: ${item}`).toBeVisible();
    }
    for (const item of hidden) {
      await expect(nav.locator("button").filter({ hasText: item }), `${label}: hidden ${item}`).toHaveCount(0);
    }
  });
}

