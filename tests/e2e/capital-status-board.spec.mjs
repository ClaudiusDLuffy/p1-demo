import { accounts, expect, login, openSidebarPage, test } from "./fixtures.mjs";

test("capital status board filters exact stages and remains usable at 320x568", async ({ page }) => {
  await login(page, accounts.manager);
  await openSidebarPage(page, "Capital");
  const filter = page.getByLabel("Capital status", { exact: true });
  await expect(filter).toBeVisible();
  await filter.selectOption("capital_quote_submitted");
  const submittedCard = page.locator(".card-hover").filter({ hasText: "E2E-CAPITAL-BOARD-SUBMITTED" });
  await expect(submittedCard).toBeVisible();
  await expect(submittedCard.locator('[data-capital-stage="capital_quote_submitted"]')).toHaveText("Quote submitted — pending capital approval");
  await expect(page.getByText("E2E-CAPITAL-BOARD-ORDERED", { exact: true })).toHaveCount(0);
  await filter.selectOption("capital_equipment_ordered");
  const orderedCard = page.locator(".card-hover").filter({ hasText: "E2E-CAPITAL-BOARD-ORDERED" });
  await expect(orderedCard).toBeVisible();
  await expect(orderedCard.locator('[data-capital-stage="capital_equipment_ordered"]')).toHaveText("Equipment ordered — waiting for equipment");
  await expect(page.getByText("E2E-CAPITAL-BOARD-SUBMITTED", { exact: true })).toHaveCount(0);
  await page.setViewportSize({ width: 320, height: 568 });
  await expect(filter).toBeInViewport();
  const layout = await page.evaluate(() => ({ width: window.innerWidth, documentWidth: document.documentElement.scrollWidth }));
  expect(layout).toEqual({ width: 320, documentWidth: 320 });
});
