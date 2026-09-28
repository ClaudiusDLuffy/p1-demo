// Shared production navigation with synthetic role/count props. No services,
// sessions, environment files or customer records. Does not test PortalShell.
import { build } from "esbuild";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";
import { chromium, webkit, expect } from "@playwright/test";
import { createServer } from "node:http";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const evidence = "/Users/nxs/p1-stabilization-recovery/stable-navigation-2026-09-29";
mkdirSync(evidence, { recursive: true });
const bundle = await build({ entryPoints: ["scripts/navigation-test-support/browserEntry.tsx"], bundle: true, write: false,
  jsx: "automatic", platform: "browser", define: { "process.env.NODE_ENV": '"test"' } });
const css = await postcss([tailwind()]).process(readFileSync("src/app/globals.css", "utf8"), { from: resolve("src/app/globals.css") });
const server = createServer((request, response) => {
  if (request.url === "/app.js") { response.setHeader("Content-Type", "text/javascript"); response.end(bundle.outputFiles[0].contents); return; }
  if (request.url === "/app.css") { response.setHeader("Content-Type", "text/css"); response.end(css.css); return; }
  response.setHeader("Content-Type", "text/html");
  response.end('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/app.css"></head><body><div id="root"></div><script src="/app.js"></script></body></html>');
});
await new Promise((resolveListen, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolveListen); });
const origin = `http://127.0.0.1:${server.address().port}`;
const results = [];
try {
  for (const [engine, driver] of Object.entries({ chromium, webkit })) {
    const browser = await driver.launch({ headless: true });
    try {
      for (const mobile of [false, true]) {
        const context = await browser.newContext({ viewport: mobile ? { width: 320, height: 568 } : { width: 1440, height: 720 },
          isMobile: mobile, hasTouch: mobile });
        const page = await context.newPage();
        const errors = [];
        page.on("pageerror", error => errors.push(error.message));
        await context.route("**/*", route => {
          if (new URL(route.request().url()).origin === origin) return route.continue();
          errors.push("Blocked unexpected non-local request"); return route.abort();
        });
        const openMenu = async () => {
          if (mobile) await page.getByRole("button", { name: "Open menu", exact: true }).tap();
          return (mobile ? page.getByRole("dialog", { name: "Navigation menu" }) : page.locator("aside:visible")).getByRole("navigation", { name: "Portal pages" });
        };
        const labels = menu => menu.getByRole("button").evaluateAll(buttons => buttons.map(button => button.getAttribute("aria-label")));
        const checkLayout = async menu => {
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
          const layout = await menu.evaluate(nav => {
            const rect = nav.getBoundingClientRect();
            return { fits: nav.scrollWidth <= nav.clientWidth, top: rect.top, bottom: rect.bottom, height: innerHeight,
              contained: [...nav.querySelectorAll("button")].every(button => [...button.children].every(child => {
                const b = button.getBoundingClientRect(); const c = child.getBoundingClientRect();
                return c.left >= b.left && c.right <= b.right && b.height >= 44;
              })) };
          });
          expect(layout.fits).toBe(true); expect(layout.contained).toBe(true);
          expect(layout.top).toBeGreaterThanOrEqual(0); expect(layout.bottom).toBeLessThan(layout.height);
        };
        await page.goto(origin);
        let menu = await openMenu();
        const baseline = await labels(menu);
        expect(baseline).toHaveLength(11);
        for (const destination of ["My Schedule", "Simplified", "My Schedule", "7-Eleven billing", "Work orders", "Simplified", "Dashboard"]) {
          expect(await labels(menu)).toEqual(baseline);
          await expect(menu.getByText("More tools", { exact: true })).toHaveCount(0);
          await checkLayout(menu);
          await menu.getByRole("button", { name: destination, exact: true }).click();
          await expect(page.getByRole("heading", { name: destination, exact: true })).toBeVisible();
          if (mobile) await expect(page.getByRole("dialog", { name: "Navigation menu" })).toHaveCount(0);
          menu = await openMenu();
          await expect(menu.getByRole("button", { name: destination, exact: true })).toHaveAttribute("aria-current", "page");
        }
        // Reloading either focused URL also keeps the complete role-based menu.
        for (const portal of ["simplified", "my_schedule"]) {
          await page.goto(`${origin}/?portal=${portal}`);
          menu = await openMenu();
          expect(await labels(menu)).toEqual(baseline);
          await expect(page.getByLabel("Current page")).toHaveText(portal);
        }
        await menu.getByRole("button", { name: "My Schedule", exact: true }).scrollIntoViewIfNeeded();
        await expect(menu.getByRole("button", { name: "My Schedule", exact: true })).toContainText("Beta");
        await checkLayout(menu);
        await page.screenshot({ path: `${evidence}/${engine}-${mobile ? "mobile" : "desktop"}.png` });
        // All lower items stay reachable without pushing the account footer offscreen.
        await menu.getByRole("button", { name: "History", exact: true }).scrollIntoViewIfNeeded();
        const signOut = page.getByRole("button", { name: "Sign out", exact: true }).filter({ visible: true });
        await expect(signOut).toBeInViewport();
        await menu.getByRole("button", { name: "History", exact: true }).click();
        await expect(page.getByLabel("Current page")).toHaveText("history");
        for (const role of ["contractor", "controller"]) {
          await page.goto(`${origin}/?role=${role}&portal=my_schedule`);
          menu = await openMenu();
          const expected = role === "contractor" ? ["My jobs", "My Schedule", "Closed jobs", "My Team", "Invoices"] : ["Controller", "Contractor bills"];
          expect(await labels(menu)).toEqual(expected);
          await checkLayout(menu);
          if (role === "contractor") {
            await menu.getByRole("button", { name: "My jobs", exact: true }).click();
            menu = await openMenu();
            expect(await labels(menu)).toEqual(expected);
          }
        }
        expect(errors).toEqual([]);
        results.push({ engine, viewport: mobile ? "320x568 touch" : "1440x720", managerTransitions: 7,
          focusedUrlReloads: 2, restrictedRoles: 2, layout: "passed", errors: 0 });
        await context.close();
      }
    } finally { await browser.close(); }
  }
  writeFileSync(`${evidence}/browser-results.json`, JSON.stringify({ scope: "shared navigation component, not full authenticated portal", results }, null, 2));
  console.log(JSON.stringify({ evidence, results }, null, 2));
} finally { await new Promise(resolveClose => server.close(resolveClose)); }
