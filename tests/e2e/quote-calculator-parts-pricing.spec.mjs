import { accounts, test, expect, login, openSidebarPage, openWorkOrder } from "./fixtures.mjs";

const currency = value => new RegExp(`\\$${value}(?:\\.00)?`);

test("part type and contractor price changes immediately update P1 rates and quote total", async ({ page }) => {
  await login(page, accounts.manager);
  await openSidebarPage(page, "Work orders");
  await openWorkOrder(page, "WOTEST7");
  await page.getByRole("button", { name: "Open quote calculator" }).click();

  const dialog = page.getByRole("dialog", { name: "Quote calculator" });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator(".quote-footer-total strong")).toHaveText(currency("110"));

  await dialog.getByRole("button", { name: "Add lines", exact: true }).click();
  await dialog.getByRole("button", { name: "Add", exact: true }).click();
  await dialog.getByLabel("Quote line 2 type").click();
  await dialog.getByRole("option", { name: "Parts/Hardware", exact: true }).click();
  await dialog.getByLabel("Quote line 2 description").fill("Synthetic replacement part");
  await dialog.getByLabel("Quote line 2 contractor rate").fill("100");

  await expect(dialog.getByLabel("Quote line 2 P1 rate")).toHaveValue("125");
  await expect(dialog.locator(".quote-footer-total strong")).toHaveText(currency("235"));

  await dialog.getByLabel("Quote line 2 contractor rate").fill("200");
  await expect(dialog.getByLabel("Quote line 2 P1 rate")).toHaveValue("250");
  await expect(dialog.locator(".quote-footer-total strong")).toHaveText(currency("360"));

  await dialog.getByLabel("Quote line 2 P1 rate").fill("300");
  await expect(dialog.locator(".quote-footer-total strong")).toHaveText(currency("410"));
});
