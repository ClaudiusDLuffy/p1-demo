import { accounts, expect, login, openSidebarPage, test } from "./fixtures.mjs";

test("a stale browser build receives a visible update and reloads onto the current version", async ({ page }) => {
  let versionChecks = 0;
  await page.route("**/api/version?**", async route => {
    versionChecks += 1;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "Cache-Control": "no-store" },
      body: JSON.stringify({
        deploymentVersion: versionChecks === 1 ? "dpl_synthetic-new-build" : "local-development",
        displayVersion: versionChecks === 1 ? "synthetic-" : "local",
      }),
    });
  });

  await page.goto("/");
  await expect(page.getByLabel("Portal build local")).toBeVisible();
  await expect(page.getByLabel("Sign-in portal version local")).toBeVisible();
  const update = page.locator('section[aria-label="Portal update available"]');
  await expect(update).toBeVisible();
  await expect(update).toContainText("local → synthetic-");

  const reloaded = page.waitForEvent("domcontentloaded");
  const checkedAfterReload = page.waitForResponse(response => response.url().includes("/api/version?"));
  await update.getByRole("button", { name: "Update now" }).click();
  await reloaded;
  await checkedAfterReload;
  await expect(page.getByPlaceholder("you@p1pros.com")).toBeVisible();
  await expect(page.getByRole("alert", { name: "Portal update available" })).toHaveCount(0);
  expect(versionChecks).toBeGreaterThanOrEqual(2);
});

test("an available update does not discard a dirty work-order form", async ({ page }) => {
  let versionChecks = 0;
  await page.route("**/api/version?**", async route => {
    versionChecks += 1;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "Cache-Control": "no-store" },
      body: JSON.stringify({ deploymentVersion: "dpl_synthetic-new-build" }),
    });
  });

  await login(page, accounts.manager);
  await openSidebarPage(page, "Work orders");
  await page.getByRole("button", { name: "+ Create Work Order", exact: true }).first().click();
  const dialog = page.getByRole("dialog", { name: "Create Work Order" });
  await dialog.getByPlaceholder("e.g. FWKD11400123").fill("E2E-VERSION-DIRTY");

  const checksBeforeUpdate = versionChecks;
  const update = page.locator('section[aria-label="Portal update available"]');
  // Native modal dialogs occupy the browser top layer, so the update card
  // cannot steal a real pointer click from an active form. Invoke the handler
  // directly here to verify the independent dirty-form reload boundary.
  await update.locator("button").evaluate(button => button.click());

  await expect(update.locator('[role="status"]')).toContainText("Save or discard the form");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByPlaceholder("e.g. FWKD11400123")).toHaveValue("E2E-VERSION-DIRTY");
  expect(versionChecks).toBe(checksBeforeUpdate);
});
