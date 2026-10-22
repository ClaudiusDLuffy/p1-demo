import { accounts, test, expect, login, sidebar } from "./fixtures.mjs";

for (const account of [accounts.manager, accounts.backoffice, accounts.controller]) {
  test(`${account.name} can manage VA team rosters`, async ({ page }) => {
    await login(page, account);
    await sidebar(page).getByRole("button", { name: "VA Teams", exact: true }).click();
    await expect(page.getByRole("heading", { name: "VA team access" })).toBeVisible();
    await page.getByRole("button", { name: /Synthetic VA Team/ }).click();
    await expect(page.getByLabel("Team name")).toHaveValue("Synthetic VA Team");
    await expect(page.getByRole("checkbox", { name: /Synthetic VA Coordinator/ })).toBeChecked();
    await expect(page.getByRole("checkbox", { name: /Synthetic Team Member/ })).toBeChecked();
    await expect(page.getByRole("checkbox", { name: /Synthetic Invoice Technician/ })).toHaveCount(0);
    await page.getByRole("button", { name: "Save team access", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "Team access saved." })).toBeVisible();
  });
}

for (const account of [accounts.dispatcher, accounts.direct]) {
  test(`${account.name} cannot open VA team management`, async ({ page }) => {
    await login(page, account);
    await expect(sidebar(page).getByRole("button", { name: "VA Teams", exact: true })).toHaveCount(0);
  });
}

test("VA team screen fits desktop and phone viewports without horizontal overflow", async ({ page }, testInfo) => {
  await login(page, accounts.manager);
  await sidebar(page).getByRole("button", { name: "VA Teams", exact: true }).click();
  await expect(page.getByRole("heading", { name: "VA team access" })).toBeVisible();
  await page.getByRole("button", { name: /Synthetic VA Team/ }).click();
  await expect(page.getByRole("button", { name: "Save team access", exact: true })).toBeVisible();

  for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    await expect(page.getByRole("heading", { name: "VA team access" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Save team access", exact: true })).toBeVisible();
    const layout = await page.evaluate(() => {
      const screen = document.querySelector('main[aria-label="VA team management"]');
      const grid = document.querySelector(".va-coordinator-grid");
      const save = [...document.querySelectorAll("button")].find(button => button.textContent?.trim() === "Save team access");
      return {
        viewportWidth: window.innerWidth,
        documentWidth: document.documentElement.scrollWidth,
        screenRight: screen?.getBoundingClientRect().right ?? Infinity,
        gridRight: grid?.getBoundingClientRect().right ?? Infinity,
        saveRight: save?.getBoundingClientRect().right ?? Infinity,
        columns: grid ? getComputedStyle(grid).gridTemplateColumns.split(" ").length : 0,
      };
    });
    expect(layout.documentWidth, `document overflow at ${viewport.width}px`).toBeLessThanOrEqual(layout.viewportWidth + 1);
    expect(layout.screenRight, `screen overflow at ${viewport.width}px`).toBeLessThanOrEqual(layout.viewportWidth + 1);
    expect(layout.gridRight, `team grid overflow at ${viewport.width}px`).toBeLessThanOrEqual(layout.viewportWidth + 1);
    expect(layout.saveRight, `save action overflow at ${viewport.width}px`).toBeLessThanOrEqual(layout.viewportWidth + 1);
    if (viewport.width < 900) expect(layout.columns).toBe(1);
    await testInfo.attach(`va-teams-${viewport.width}px.png`, { body: await page.screenshot(), contentType: "image/png" });
    if (viewport.width < 900) {
      const saveButton = page.getByRole("button", { name: "Save team access", exact: true });
      await saveButton.scrollIntoViewIfNeeded();
      const footerLayout = await saveButton.evaluate(button => {
        const buttonRect = button.getBoundingClientRect();
        const nav = document.querySelector(".mobile-bottom-nav");
        const navTop = nav?.getBoundingClientRect().top ?? window.innerHeight;
        const hit = document.elementFromPoint(buttonRect.left + buttonRect.width / 2, buttonRect.top + buttonRect.height / 2);
        return { buttonBottom: buttonRect.bottom, navTop, hitButton: hit === button || button.contains(hit) };
      });
      expect(footerLayout.buttonBottom, "save action is not hidden behind mobile navigation").toBeLessThanOrEqual(footerLayout.navTop);
      expect(footerLayout.hitButton, "save action remains the topmost clickable control").toBe(true);
      await testInfo.attach("va-teams-mobile-save-controls.png", { body: await page.screenshot(), contentType: "image/png" });
    }
  }
});

test("Cancel discards new and edited team changes and exits the editor", async ({ page }) => {
  await login(page, accounts.manager);
  await sidebar(page).getByRole("button", { name: "VA Teams", exact: true }).click();
  await expect(page.getByRole("heading", { name: "VA team access" })).toBeVisible();

  await page.getByRole("button", { name: "New team", exact: true }).click();
  await page.getByLabel("Team name").fill("Unsaved synthetic team");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByLabel("Team name")).toHaveCount(0);
  await expect(page.getByText("Select a team to edit or choose New team.")).toBeVisible();
  await expect(page.getByRole("button", { name: /Unsaved synthetic team/ })).toHaveCount(0);

  await page.getByRole("button", { name: /Synthetic VA Team/ }).click();
  await page.getByLabel("Team name").fill("Unsaved renamed team");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByLabel("Team name")).toHaveCount(0);
  await page.getByRole("button", { name: /Synthetic VA Team/ }).click();
  await expect(page.getByLabel("Team name")).toHaveValue("Synthetic VA Team");
});
