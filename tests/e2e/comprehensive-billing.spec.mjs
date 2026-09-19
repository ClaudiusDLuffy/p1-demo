import { accounts, expect, login, openSidebarPage, test } from "./fixtures.mjs";

const equipmentTags = [
  "7-ELEVEN: HVAC", "7-ELEVEN: Fountain", "7-ELEVEN: Vault Project", "7-ELEVEN: A/C",
  "7-ELEVEN: Lift Station", "7-ELEVEN: Vault", "7-ELEVEN: Ice", "7-ELEVEN: Ovens",
  "7-ELEVEN: EMS System", "7-ELEVEN: Floors", "7-ELEVEN: Roof", "7-ELEVEN: Frozen",
  "7-ELEVEN: CO2", "7-ELEVEN: Slurpee", "7-ELEVEN: Miscellaneous", "7-ELEVEN: Coffee",
  "7-ELEVEN: Engineering Drawings", "7-ELEVEN: Dish Machine", "7-ELEVEN: Hot Food",
  "7-ELEVEN: Refrigeration", "7-ELEVEN: Emergency", "7-ELEVEN: Ceilings",
  "7-ELEVEN: Plumbing", "7-ELEVEN: General Maintenance",
];

async function popupOptions(page, trigger) {
  await trigger.click();
  const listbox = page.getByRole("listbox");
  await expect(listbox).toBeVisible();
  const options = listbox.getByRole("option");
  await expect(options.first()).toBeVisible();
  const labels = (await options.allTextContents()).map(label => label.replace(/Selected$/, ""));
  await trigger.click();
  await expect(listbox).toBeHidden();
  return labels;
}

test("staff billing queues, search, sort, collapse, and tax-rule CRUD are functional", async ({ page }) => {
  await login(page, accounts.backoffice);
  await openSidebarPage(page, "7-Eleven billing");
  await expect(page.getByRole("searchbox", { name: "Search billing invoices and work orders" })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Sort billing invoices" }).locator("option")).toHaveText([
    "Invoice number", "Invoice date", "Work order", "Store", "Territory", "Amount", "Status",
  ]);
  for (const bucket of ["Ready to Bill", "All", "Drafts", "Please send to 7-Eleven", "Sent to 7-Eleven", "Recently Approved"]) {
    const button = page.getByRole("button", { name: new RegExp(`^${bucket}`) });
    await expect(button).toBeVisible();
    const before = await button.getAttribute("aria-expanded");
    await button.click();
    await expect(button).toHaveAttribute("aria-expanded", before === "true" ? "false" : "true");
    await button.click();
    await expect(button).toHaveAttribute("aria-expanded", before);
  }

  await page.getByRole("button", { name: /Automatic taxability rules/ }).click();
  await page.getByRole("button", { name: "+ Add rule", exact: true }).click();
  const panel = page.getByRole("region", { name: "Billing tax rules" });
  await panel.getByLabel("Name").fill("Synthetic compressor tax rule");
  await panel.getByLabel("Priority").fill("75");
  await panel.getByLabel("Result").selectOption("taxable");
  await panel.getByLabel("Description keywords").fill("compressor, synthetic-tax");
  await panel.getByRole("button", { name: "Save rule", exact: true }).click();
  await expect(panel.getByText("Synthetic compressor tax rule", { exact: true })).toBeVisible();
  const rule = panel.getByText("Synthetic compressor tax rule", { exact: true })
    .locator("xpath=ancestor::div[.//button[normalize-space()='Edit']][1]");
  await rule.getByRole("button", { name: "Edit", exact: true }).click();
  await panel.getByLabel("Priority").fill("76");
  await panel.getByRole("button", { name: "Save rule", exact: true }).click();
  await expect(rule.getByText("#76", { exact: true })).toBeVisible();
  await rule.getByRole("button", { name: "Disable", exact: true }).click();
  await expect(rule.getByRole("button", { name: "Enable", exact: true })).toBeVisible();
});

test("staff creates and submits a complete P1-to-7-Eleven invoice", async ({ page }) => {
  await login(page, accounts.backoffice);
  await openSidebarPage(page, "7-Eleven billing");
  const search = page.getByRole("searchbox", { name: "Search billing invoices and work orders" });
  await search.fill("E2E-STAFF-BILL-SUBMIT");
  const readyRow = page.getByText("E2E-STAFF-BILL-SUBMIT", { exact: true })
    .locator("xpath=ancestor::div[.//button[normalize-space()='Create invoice']][1]");
  await readyRow.getByRole("button", { name: "Create invoice", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Create P1 to 7-Eleven invoice" });
  await expect(dialog).toBeVisible();

  await dialog.getByLabel("Invoice #").fill("P1-E2E-SUBMITTED-001");
  expect(await popupOptions(page, dialog.getByRole("combobox", { name: "Invoice territory" }))).toEqual([
    "Select territory", "Virginia", "Texas", "Florida", "+ Add new territory",
  ]);
  await dialog.getByRole("combobox", { name: "Invoice territory" }).click();
  await page.getByRole("option", { name: "Virginia", exact: true }).click();
  await expect(dialog.getByRole("combobox", { name: "Invoice territory" })).toContainText("Virginia");
  await dialog.getByRole("combobox", { name: "Invoice territory" }).click();
  await page.getByRole("option", { name: "Texas", exact: true }).click();
  expect(await popupOptions(page, dialog.getByRole("button", { name: "QuickBooks equipment tag" }))).toEqual(equipmentTags);
  expect(await popupOptions(page, dialog.getByRole("combobox", { name: "Invoice payment terms" }))).toEqual([
    "Net 60", "Net 30", "Net 15", "Due on receipt",
  ]);

  for (const label of ["Labor", "OT Labor", "Parts", "Travel", "Warranty", "Refrigerant"]) {
    await expect(dialog.getByRole("button", { name: new RegExp(`^\\+ ${label}`) })).toBeVisible();
  }
  await dialog.getByRole("button", { name: /^\+ Labor/ }).click();
  await dialog.getByLabel("Line 1 description").fill("Synthetic P1 labor submitted to 7-Eleven");
  expect(await popupOptions(page, dialog.getByRole("combobox", { name: "Line 1 type" }))).toEqual([
    "Travel", "Labor", "OT Labor", "Parts/Hardware", "Shipping", "Warranty", "Other",
  ]);
  await dialog.getByRole("button", { name: "Submit Invoice", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText("#P1-E2E-SUBMITTED-001", { exact: true })).toBeVisible();
});

test("billing calculations persist exact quantities, markup, tax, subtotal, and total", async ({ page }) => {
  await login(page, accounts.backoffice);
  await openSidebarPage(page, "7-Eleven billing");
  const search = page.getByRole("searchbox", { name: "Search billing invoices and work orders" });
  await search.fill("E2E-STAFF-BILL-CALC");
  const readyRow = page.getByText("E2E-STAFF-BILL-CALC", { exact: true })
    .locator("xpath=ancestor::div[.//button[normalize-space()='Create invoice']][1]");
  await readyRow.getByRole("button", { name: "Create invoice", exact: true }).click();
  let dialog = page.getByRole("dialog", { name: "Create P1 to 7-Eleven invoice" });

  await dialog.getByLabel("Invoice #").fill("P1-E2E-CALC-001");
  await dialog.getByRole("button", { name: /^\+ Labor/ }).click();
  await dialog.getByLabel("Line 1 description").fill("Synthetic calculation labor");
  await dialog.getByLabel("Line 1 quantity").fill("2.5");
  await dialog.getByLabel("Line 1 rate").fill("100");
  await dialog.getByRole("button", { name: /^\+ Parts/ }).click();
  await dialog.getByLabel("Line 2 description").fill("Synthetic calculation part");
  await dialog.getByLabel("Line 2 quantity").fill("2");
  await dialog.getByLabel("Line 2 rate").fill("80");
  await dialog.getByLabel("Line 2 markup percent").fill("25");
  await dialog.getByLabel("Line 2 taxable").check();
  await dialog.getByLabel("Manual sales tax amount").fill("16.50");

  await expect(dialog.getByText(/^\$450(?:\.00)?$/).first()).toBeVisible();
  await expect(dialog.getByText(/^\$16\.5(?:0)?$/).first()).toBeVisible();
  await expect(dialog.getByText(/^\$466\.5(?:0)?$/).first()).toBeVisible();
  await dialog.getByRole("button", { name: "Save as Draft", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText("#P1-E2E-CALC-001", { exact: true })).toBeVisible();

  await page.getByText("#P1-E2E-CALC-001", { exact: true }).click();
  await page.getByRole("button", { name: "Edit invoice", exact: true }).click();
  dialog = page.getByRole("dialog", { name: "Edit invoice #P1-E2E-CALC-001" });
  await expect(dialog.getByLabel("Line 1 quantity")).toHaveValue("2.5");
  await expect(dialog.getByLabel("Line 1 rate")).toHaveValue("100");
  await expect(dialog.getByLabel("Line 2 quantity")).toHaveValue("2");
  await expect(dialog.getByLabel("Line 2 rate")).toHaveValue("100");
  await expect(dialog.getByLabel("Line 2 markup percent")).toHaveValue("25");
  await expect(dialog.getByLabel("Line 2 taxable")).toBeChecked();
  await expect(dialog.getByLabel("Manual sales tax amount")).toHaveValue("16.5");
  await expect(dialog.getByText(/^\$466\.5(?:0)?$/).first()).toBeVisible();
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await expect(dialog).toBeHidden();
});

test("staff edits a billing draft, downloads PDF and CSV, then deletes it", async ({ page }) => {
  await login(page, accounts.backoffice);
  await openSidebarPage(page, "7-Eleven billing");
  const search = page.getByRole("searchbox", { name: "Search billing invoices and work orders" });
  await search.fill("P1-E2E-EDIT-001");
  const draftRow = page.getByRole("row").filter({ hasText: "#P1-E2E-EDIT-001" }).first();
  await expect(draftRow).toBeVisible();
  await draftRow.click();
  await expect(page.getByRole("button", { name: "Edit invoice", exact: true })).toBeVisible();

  const pdf = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download PDF", exact: true }).click();
  expect((await pdf).suggestedFilename()).toMatch(/P1-E2E-EDIT-001.*\.pdf/i);
  const csv = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download SaasAnt CSV", exact: true }).click();
  expect((await csv).suggestedFilename()).toMatch(/\.csv$/i);

  await page.getByRole("button", { name: "Edit invoice", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Edit invoice #P1-E2E-EDIT-001" });
  await dialog.getByLabel("Line 1 description").fill("Synthetic edited staff billing labor");
  await dialog.getByRole("button", { name: "Save Draft", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText("Synthetic edited staff billing labor", { exact: true }).first()).toBeVisible();

  await page.getByRole("button", { name: "Delete", exact: true }).click();
  const confirm = page.getByRole("dialog", { name: "Delete billing invoice" });
  await confirm.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(confirm).toBeHidden();
  await expect(page.getByText("#P1-E2E-EDIT-001", { exact: true })).toHaveCount(0);
});
