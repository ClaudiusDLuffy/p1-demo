import { accounts, expect, login, openSidebarPage, test } from "./fixtures.mjs";

test("staff can pull submitted contractor invoice lines into a new P1 invoice", async ({ page }) => {
  await login(page, accounts.backoffice);
  await openSidebarPage(page, "7-Eleven billing");
  await page.getByRole("button", { name: "+ Create Invoice", exact: true }).click();

  const dialog = page.getByRole("dialog", { name: "Create P1 to 7-Eleven invoice", exact: true });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Search work order", { exact: true }).fill("E2E-REVIEW-APPROVE");
  await page.getByRole("listbox", { name: "Matching work orders" })
    .getByRole("option", { name: /^E2E-REVIEW-APPROVE / }).click();

  await expect(dialog.getByText("Contractor invoices on E2E-REVIEW-APPROVE", { exact: true })).toBeVisible();
  const source = dialog.getByRole("checkbox", { name: /E2E-SUBMITTED-APPROVE/ });
  await expect(source).toBeVisible();
  await source.check();

  await dialog.getByRole("button", { name: "Pull lines + calculate", exact: true }).click();
  await expect(page.getByText("Pulled 1 line item", { exact: true })).toBeVisible();
  await expect(dialog.getByLabel("Line 1 description", { exact: true })).toHaveValue("Synthetic approval labor");
  await expect(dialog.getByLabel("Line 1 quantity", { exact: true })).toHaveValue("1");
  await expect(dialog.getByLabel("Line 1 rate", { exact: true })).not.toHaveValue("");
});
