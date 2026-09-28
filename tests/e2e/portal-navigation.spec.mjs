import { accounts, expect, login, test } from "./fixtures.mjs";

for (const mobile of [false, true]) {
  test.describe(mobile ? "stable mobile navigation" : "stable desktop navigation", () => {
    test.use({ viewport: mobile ? { width: 320, height: 568 } : { width: 1440, height: 900 },
      isMobile: mobile, hasTouch: mobile });

    test("Simplified and My Schedule never replace the role-based menu", async ({ page }) => {
      await login(page, accounts.manager);
      const openMenu = async () => {
        if (mobile) await page.getByRole("button", { name: "Open menu", exact: true }).click();
        return (mobile ? page.getByRole("dialog", { name: "Navigation menu" }) : page.locator(".desktop-sidebar"))
          .getByRole("navigation", { name: "Portal pages" });
      };
      const labels = menu => menu.getByRole("button").evaluateAll(buttons => buttons.map(button => button.getAttribute("aria-label")));
      let menu = await openMenu();
      const initial = await labels(menu);
      expect(initial).toContain("Work orders");
      expect(initial).toContain("My Schedule");
      expect(initial).toContain("Simplified");
      for (const destination of ["My Schedule", "Simplified", "My Schedule", "7-Eleven billing", "Work orders", "Dashboard"]) {
        await menu.getByRole("button", { name: destination, exact: true }).click();
        if (mobile) await expect(page.getByRole("dialog", { name: "Navigation menu" })).toHaveCount(0);
        menu = await openMenu();
        expect(await labels(menu)).toEqual(initial);
        await expect(menu.getByRole("button", { name: destination, exact: true })).toHaveAttribute("aria-current", "page");
        await expect(menu.locator("details")).toHaveCount(0);
      }
      await menu.getByRole("button", { name: "History", exact: true }).click();
      menu = await openMenu();
      await expect(menu.getByRole("button", { name: "History", exact: true })).toHaveAttribute("aria-current", "page");
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    });
  });
}
