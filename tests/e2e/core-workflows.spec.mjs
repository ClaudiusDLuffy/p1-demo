import { accounts, expect, login, openSidebarPage, openWorkOrder, test } from "./fixtures.mjs";

test("email-intake New assignment can start work", async ({ page }) => {
  await login(page, accounts.invoiceTech);
  await openSidebarPage(page, "My jobs");
  await openWorkOrder(page, "E2E-NEW-START");
  await page.getByRole("button", { name: "Start work", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Start work" });
  await expect(dialog).toBeVisible();
  await dialog.getByPlaceholder("What are you seeing on site?").fill("Synthetic E2E start-work verification.");
  await dialog.getByRole("button", { name: "Start work", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("button", { name: "Pause (parts)", exact: true })).toBeVisible();
});

test("manager can flag an eligible work order as capital", async ({ page }) => {
  await login(page, accounts.manager);
  await openSidebarPage(page, "Work orders");
  await openWorkOrder(page, "E2E-STAFF-CAPITAL");
  await page.getByRole("button", { name: "Flag capital", exact: true }).click();
  await expect(page.getByText("Portal: Capital Replacement", { exact: true }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Create capital quote", exact: true })).toBeVisible();
});

test("contractor line type remains selectable and invoice saves as a draft", async ({ page }) => {
  await login(page, accounts.direct);
  await openSidebarPage(page, "My jobs");
  await openWorkOrder(page, "E2E-DIRECT-INVOICE");
  await page.getByRole("button", { name: "Create or upload invoice", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Create invoice" });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Invoice #").fill("E2E-DRAFT-001");
  await dialog.getByRole("button", { name: "+ Labor", exact: true }).click();
  const lineType = dialog.getByRole("combobox", { name: "Line 1 type" });
  await lineType.click();
  await page.getByRole("option", { name: "Parts/Hardware", exact: true }).click();
  await expect(lineType).toContainText("Parts/Hardware");
  await dialog.getByLabel("Line 1 description").fill("Synthetic replacement part");
  await dialog.getByLabel("Line 1 quantity").fill("1");
  await dialog.getByLabel("Line 1 rate").fill("125");
  await dialog.getByRole("button", { name: "Save as draft", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText("#E2E-DRAFT-001", { exact: true })).toBeVisible();
  await expect(page.getByText("Draft", { exact: true }).first()).toBeVisible();
});
