import { syntheticPassword } from "../../scripts/e2e/local-supabase-runtime.mjs";
import { accounts, expect, login, openSidebarPage, openWorkOrder, test } from "./fixtures.mjs";

test("deactivating a linked technician revokes the live data scope and blocks a fresh login", async ({ page, browser }) => {
  await login(page, accounts.revocationTech);
  await openSidebarPage(page, "My jobs");
  await openWorkOrder(page, "E2E-ACCESS-REVOCATION");
  await expect(page.getByRole("button", { name: "Start work", exact: true })).toBeVisible();

  const origin = new URL(page.url()).origin;
  const managerContext = await browser.newContext({
    baseURL: origin,
    bypassCSP: true,
    viewport: { width: 1440, height: 1000 },
  });
  const managerPage = await managerContext.newPage();
  try {
    await login(managerPage, accounts.manager);
    await openSidebarPage(managerPage, "Contractors");
    await managerPage.getByRole("searchbox", { name: "Search contractors" }).fill("Synthetic Company Admin");

    const company = managerPage.locator(".contractors-grid .card")
      .filter({ has: managerPage.getByText("Synthetic Company Admin", { exact: true }) })
      .first();
    await expect(company).toBeVisible();
    await company.getByRole("button", { name: "View technicians", exact: true }).click();
    const team = managerPage.getByRole("region", { name: "Synthetic Company Admin technicians" });
    await expect(team).toBeVisible();
    const technician = team.getByText("Synthetic Revocation Technician", { exact: true });
    const technicianRow = technician.locator("xpath=ancestor::div[.//button[normalize-space()='Remove']][1]");
    await technicianRow.getByRole("button", { name: "Remove", exact: true }).click();

    const dialog = managerPage.getByRole("dialog", { name: "Remove technician access" });
    await expect(dialog.getByText(/Their login and current job access will be removed/i)).toBeVisible();
    await dialog.getByRole("button", { name: "Deactivate access", exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(managerPage.locator(".app-toast")).toContainText(/Technician access deactivated/i);
    await expect(technicianRow.getByText(/Inactive/)).toBeVisible();

    // The still-open technician tab may retain its Auth token briefly, but a
    // profile refresh must discard its old query scope and all actionable job UI.
    const refresh = page.getByRole("button", { name: "Refresh portal", exact: true }).first();
    if (await refresh.isVisible().catch(() => false)) await refresh.click();
    await expect(page.locator(".work-order-reference")).toHaveCount(0);
    await expect(page.getByText("E2E-ACCESS-REVOCATION", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Start work", exact: true })).toHaveCount(0);
    await expect(page.getByText("Your account is inactive. Contact an administrator.", { exact: true })).toBeVisible();
    await expect(page.locator(".app-root")).toHaveCount(0);

    // The Auth ban is a second wall: a new browser cannot establish another
    // session even with the formerly valid password.
    const deniedContext = await browser.newContext({
      baseURL: origin,
      bypassCSP: true,
      viewport: { width: 1440, height: 1000 },
    });
    try {
      const deniedPage = await deniedContext.newPage();
      await deniedPage.goto("/");
      await deniedPage.getByPlaceholder("you@p1pros.com").fill(accounts.revocationTech.email);
      await deniedPage.locator('input[type="password"]').fill(process.env.P1_E2E_PASSWORD || syntheticPassword);
      await deniedPage.getByRole("button", { name: "Sign in", exact: true }).click();
      await expect(deniedPage.getByText("Your account is inactive. Contact an administrator.", { exact: true })).toBeVisible();
      await expect(deniedPage.locator(".app-root")).toHaveCount(0);
    } finally {
      await deniedContext.close();
    }
  } finally {
    // Keep the all-at-once suite isolated: restore only this disposable
    // synthetic account through the same administrator UI before the test exits.
    const reactivate = managerPage.getByRole("button", { name: "Reactivate", exact: true });
    if (await reactivate.isVisible().catch(() => false)) {
      await reactivate.click();
      const edit = managerPage.getByRole("dialog", { name: "Edit technician access" });
      await expect(edit.locator('input[type="email"]')).toHaveValue(accounts.revocationTech.email);
      await edit.getByRole("button", { name: "Save access", exact: true }).click();
      await expect(edit).toBeHidden();
      await expect(managerPage.locator(".app-toast")).toContainText(/Technician access saved/i);
    }
    await managerContext.close();
  }
});
