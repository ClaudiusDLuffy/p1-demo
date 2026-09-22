import { readFileSync } from "node:fs";
import { accounts, expect, login, openSidebarPage, test } from "./fixtures.mjs";

const currentVersion = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version;
const currentDeployment = "local-development";
const nextDeployment = "synthetic-deployment-next";

async function advanceVersionCheckClock(page) {
  await page.evaluate(() => {
    const actualNow = Date.now.bind(Date);
    Date.now = () => actualNow() + 20_000;
    window.dispatchEvent(new Event("online"));
  });
}

test("a stale anonymous browser is automatically signed out and reloads the clean current build", async ({ page }) => {
  let versionChecks = 0;
  await page.route("**/api/version?**", async route => {
    versionChecks += 1;
    const stale = versionChecks === 1;
    await route.fulfill({ status: 200, contentType: "application/json", headers: { "Cache-Control": "no-store" },
      body: JSON.stringify({ deploymentVersion: stale ? nextDeployment : currentDeployment,
        displayVersion: stale ? "2.1.24" : currentVersion }) });
  });
  await page.goto("/");
  await expect.poll(() => new URL(page.url()).searchParams.get("p1-build")).toBe(nextDeployment);
  await expect(page.getByPlaceholder("you@p1pros.com")).toBeVisible();
  await expect(page.getByLabel(`Portal version ${currentVersion}`, { exact: true })).toBeVisible();
  await expect(page.getByLabel(`Sign-in portal version ${currentVersion}`, { exact: true })).toBeVisible();
  expect(versionChecks).toBeGreaterThanOrEqual(2);
});
test("a deployment replaces an authenticated dirty mobile session without an unload deadlock", async ({ page }) => {
  let stale = false;
  await page.route("**/api/version?**", route => route.fulfill({
    status: 200, contentType: "application/json", headers: { "Cache-Control": "no-store" },
    body: JSON.stringify({ deploymentVersion: stale ? nextDeployment : currentDeployment,
      displayVersion: stale ? "2.1.24" : currentVersion }),
  }));
  await login(page, accounts.manager);
  await openSidebarPage(page, "Work orders");
  await page.setViewportSize({ width: 320, height: 568 });
  await page.getByRole("button", { name: "+ Create Work Order", exact: true }).first().click();
  const dialog = page.getByRole("dialog", { name: "Create Work Order" });
  await dialog.getByPlaceholder("e.g. FWKD11400123").fill("E2E-VERSION-DIRTY");
  const dialogs = [];
  page.on("dialog", nativeDialog => { dialogs.push(nativeDialog.type()); void nativeDialog.dismiss(); });
  stale = true;
  await advanceVersionCheckClock(page);
  await expect(page.getByRole("alert", { name: "Updating the P1 Portal" })).toBeVisible();
  await expect.poll(() => new URL(page.url()).searchParams.get("p1-build")).toBe(nextDeployment);
  await expect(page.getByPlaceholder("you@p1pros.com")).toBeVisible();
  expect(dialogs).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
});
