import { accounts, expect, login, openSidebarPage, test } from "./fixtures.mjs";

for (const width of [1440, 320]) {
  test(`calculator stays in Billing and its invoice dialog at ${width}px`, async ({ page }, testInfo) => {
    await login(page, accounts.backoffice);
    await openSidebarPage(page, "7-Eleven billing");
    await page.setViewportSize({ width, height: width === 320 ? 568 : 900 });
    const calculator = page.getByRole("complementary", { name: "Profit calculator" });
    await calculator.getByRole("button", { name: "Profit calculator", exact: true }).click();
    await calculator.getByLabel("Cost", { exact: true }).fill("150");
    await calculator.getByLabel("Sell price", { exact: true }).fill("200");
    await expect(calculator.getByText("25.0%", { exact: true })).toBeVisible();

    const assertLayout = async inDialog => {
      expect(await calculator.evaluate(element => ({
        position: getComputedStyle(element).position,
        inDialog: Boolean(element.closest("dialog[open]")),
        inForm: Boolean(element.closest("form")),
        fits: element.scrollWidth <= element.clientWidth && element.getBoundingClientRect().right <= innerWidth,
      }))).toEqual({ position: "static", inDialog, inForm: false, fits: true });
    };
    await assertLayout(false);
    await page.screenshot({ path: testInfo.outputPath("billing-calculator.png"), animations: "disabled" });
    await page.getByRole("button", { name: "+ Create Invoice", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Create P1 to 7-Eleven invoice", exact: true });
    await expect(dialog).toBeVisible();
    await expect(calculator).toHaveCount(1);
    await expect(calculator.getByLabel("Cost", { exact: true })).toHaveValue("150");
    await assertLayout(true);
    await calculator.getByLabel("Cost", { exact: true }).fill("125");
    await calculator.getByLabel("Sell price", { exact: true }).press("Enter");
    await expect(dialog).toBeVisible();
    await dialog.locator(".modal-inner").evaluate(element => { element.scrollTop = 0; });
    await page.screenshot({ path: testInfo.outputPath("invoice-calculator.png"), animations: "disabled" });
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole("dialog", { name: "Unsaved changes" })).toHaveCount(0);
    await expect(calculator.getByLabel("Cost", { exact: true })).toHaveValue("125");
    await assertLayout(false);
    await page.setViewportSize({ width: 1440, height: 900 });
    await openSidebarPage(page, "Dashboard");
    await expect(calculator).toHaveCount(0);
    await openSidebarPage(page, "7-Eleven billing");
    await expect(calculator.getByLabel("Cost", { exact: true })).toHaveValue("125");
  });
}

for (const account of [accounts.direct, accounts.controller]) {
  test(`calculator is not offered to ${account.name}`, async ({ page }) => {
    await login(page, account);
    await expect(page.getByRole("complementary", { name: "Profit calculator" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /profit calculator/i })).toHaveCount(0);
  });
}
