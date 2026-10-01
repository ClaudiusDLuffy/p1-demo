// Real invoice editor/shared dialog, synthetic localhost reads. Does not certify
// the full authenticated shell, database mutations/RLS, or physical Safari/iOS.
import { build } from "esbuild";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";
import { chromium, webkit, expect } from "@playwright/test";
import { createServer } from "node:http";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const reproduce = process.argv.includes("--reproduce");
const evidence = "/Users/nxs/p1-stabilization-recovery/billing-calculator-2026-10-02";
mkdirSync(evidence, { recursive: true });
let javascript;
let stylesheet;
const server = createServer((request, response) => {
  if (request.url === "/app.js") { response.setHeader("Content-Type", "text/javascript"); response.end(javascript); return; }
  if (request.url === "/app.css") { response.setHeader("Content-Type", "text/css"); response.end(stylesheet); return; }
  response.setHeader("Content-Type", "text/html");
  response.end('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/app.css"></head><body><div id="root"></div><script src="/app.js"></script></body></html>');
});
await new Promise((done, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", done); });
const origin = `http://127.0.0.1:${server.address().port}`;
const results = [];
try {
  const bundle = await build({ entryPoints: ["scripts/billing-calculator-test-support/browserEntry.tsx"], bundle: true, write: false,
    outfile: "/private/tmp/p1-billing-calculator.js", jsx: "automatic", platform: "browser", define: {
      "process.env.NODE_ENV": '"test"', "process.env.NEXT_PUBLIC_SUPABASE_URL": JSON.stringify(origin),
      "process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY": '"sb_publishable_synthetic_billing"',
      "process.env.NEXT_PUBLIC_P1_APP_ENV": '"development"',
    } });
  javascript = bundle.outputFiles.find(file => file.path.endsWith(".js")).contents;
  const css = await postcss([tailwind()]).process(readFileSync("src/app/globals.css", "utf8"), { from: resolve("src/app/globals.css") });
  const constants = await build({ entryPoints: ["src/lib/constants.ts"], bundle: true, write: false, platform: "node", format: "esm" });
  const { T } = await import(`data:text/javascript;base64,${Buffer.from(constants.outputFiles[0].text).toString("base64")}`);
  // Include the real shell's responsive modal/field/button rules, not mock CSS.
  const shell = readFileSync("src/components/PortalShell.tsx", "utf8");
  const shellCss = shell.match(/const CSS = `([\s\S]*?)`;/)?.[1];
  if (!shellCss) throw new Error("Shared shell styles were not found");
  stylesheet = css.css + shellCss.replace(/\$\{T\.(\w+)\}/g, (_, key) => T[key])
    + (bundle.outputFiles.find(file => file.path.endsWith(".css"))?.text || "");

  for (const [engine, driver] of Object.entries({ chromium, webkit })) {
    const browser = await driver.launch({ headless: true });
    try {
      for (const mobile of [false, true]) {
        const context = await browser.newContext({ viewport: mobile ? { width: 320, height: 568 } : { width: 1440, height: 900 },
          isMobile: mobile, hasTouch: mobile, serviceWorkers: "block" });
        // A manufactured localhost-only session, never a developer browser's
        // cookies/storage. Every API response still comes from the route below.
        await context.addInitScript(() => {
          const user = { id: "10000000-0000-4000-8000-000000000001", email: "billing@example.test",
            aud: "authenticated", role: "authenticated", app_metadata: {}, user_metadata: {}, created_at: "2026-01-01T00:00:00Z" };
          const expires = Math.floor(Date.now() / 1000) + 3600;
          const encode = value => btoa(JSON.stringify(value)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
          localStorage.setItem("sb-127-auth-token", JSON.stringify({ user, expires_at: expires, expires_in: 3600,
            token_type: "bearer", refresh_token: "synthetic-local-refresh", access_token: `${encode({ alg: "HS256", typ: "JWT" })}.${encode({ sub: user.id, exp: expires, role: "authenticated" })}.c3ludGhldGlj` }));
        });
        const page = await context.newPage();
        const errors = [];
        const mutations = [];
        page.on("pageerror", error => errors.push(error.message));
        await context.route("**/*", route => {
          const request = route.request(); const url = new URL(request.url());
          if (url.origin !== origin) { errors.push("Blocked non-local request"); return route.abort(); }
          const send = body => route.fulfill({ contentType: "application/json", body: JSON.stringify(body) });
          if (url.pathname === "/rest/v1/rpc/list_work_orders_rows_v1") return send({ items: [], hasMore: false, nextCursor: null, pageSize: 30 });
          if (["/rest/v1/state_sales_tax_rates", "/rest/v1/billing_tax_rules"].includes(url.pathname)) return send([]);
          if (url.pathname === "/api/billing-invoices" && url.searchParams.has("nextNumber")) return send({ num: "SYNTHETIC-100" });
          if (url.pathname.startsWith("/rest/") || url.pathname.startsWith("/api/") || url.pathname.startsWith("/auth/")) {
            mutations.push({ method: request.method(), path: url.pathname });
            return route.fulfill({ status: 400, contentType: "application/json", body: '{"message":"Unexpected synthetic request"}' });
          }
          return route.continue();
        });
        const calculator = page.locator('aside[aria-label="Profit calculator"]');
        const activate = locator => mobile ? locator.tap() : locator.click();
        const editor = page.getByRole("dialog", { name: "Create P1 to 7-Eleven invoice", exact: true });
        const checkLayout = async () => {
          const layout = await calculator.evaluate(element => {
            const bounds = element.getBoundingClientRect();
            return { fits: element.scrollWidth <= element.clientWidth, left: bounds.left, right: bounds.right, width: innerWidth,
              inDialog: Boolean(element.closest("dialog[open]")), inForm: Boolean(element.closest("form")) };
          });
          expect(layout.fits).toBe(true); expect(layout.left).toBeGreaterThanOrEqual(0);
          expect(layout.right).toBeLessThanOrEqual(layout.width); expect(layout.inDialog).toBe(true); expect(layout.inForm).toBe(false);
          const controls = await calculator.locator("input, button").evaluateAll(elements => elements.map(element => ({
            label: element.getAttribute("aria-label") || element.closest("label")?.textContent.trim(),
            height: element.getBoundingClientRect().height,
          })));
          // WebKit can report 43.999984px for a computed 44px control.
          for (const control of controls) expect(Math.round(control.height * 100) / 100, JSON.stringify(control)).toBeGreaterThanOrEqual(44);
        };
        try {
          await page.goto(origin);
          await activate(page.getByRole("button", { name: "Profit calculator", exact: true }));
          await calculator.getByLabel("Cost", { exact: true }).fill("100");
          await calculator.getByLabel("Sell price", { exact: true }).fill("200");
          await activate(page.getByRole("button", { name: "Create invoice", exact: true }));
          await expect(editor).toBeVisible();
          await expect(editor.locator('input[name="num"]')).toHaveValue("SYNTHETIC-100");
          if (reproduce) {
            expect(await calculator.evaluate(element => Boolean(element.closest("dialog")))).toBe(false);
            await page.screenshot({ path: `${evidence}/before-${engine}-${mobile ? "mobile" : "desktop"}.png` });
            let blocked = false;
            try { await calculator.getByLabel("Cost", { exact: true }).click({ timeout: 500 }); } catch { blocked = true; }
            expect(blocked).toBe(true);
            results.push({ engine, mobile, reproduced: "Calculator outside native dialog; pointer interaction blocked" });
            continue;
          }
          await checkLayout();
          await expect(calculator.getByLabel("Cost", { exact: true })).toHaveValue("100");
          await calculator.getByLabel("Cost", { exact: true }).fill("150");
          await calculator.getByLabel("Sell price", { exact: true }).fill("200");
          await calculator.getByLabel("Target margin %", { exact: true }).fill("25");
          await expect(calculator.getByText("$50", { exact: true })).toBeVisible();
          await expect(calculator.getByText("25.0%", { exact: true })).toBeVisible();
          await expect(calculator.getByText("$200", { exact: true })).toBeVisible();
          await calculator.getByLabel("Target margin %", { exact: true }).press("Enter");
          await expect(editor.getByText(/Invoice was not saved/)).toHaveCount(0);
          await expect(editor).toBeVisible();
          await calculator.getByLabel("Cost", { exact: true }).click();
          await page.keyboard.press("Tab");
          await expect(calculator.getByLabel("Sell price", { exact: true })).toBeFocused();
          await editor.locator(".modal-inner").evaluate(element => { element.scrollTop = 0; });
          await page.screenshot({ path: `${evidence}/${engine}-${mobile ? "mobile" : "desktop"}-editor.png` });
          await activate(page.getByRole("button", { name: "Collapse profit calculator" }));
          await expect(page.getByRole("button", { name: "Profit calculator", exact: true })).toBeFocused();
          await activate(page.getByRole("button", { name: "Profit calculator", exact: true }));
          await expect(calculator.getByLabel("Cost", { exact: true })).toHaveValue("150");
          // Calculator-only edits must not mark the invoice dirty.
          await editor.getByRole("button", { name: "Close", exact: true }).click();
          await expect(editor).toHaveCount(0);
          await expect(page.getByRole("dialog", { name: "Unsaved changes" })).toHaveCount(0);
          await expect(calculator.getByLabel("Cost", { exact: true })).toHaveValue("150");
          // Keep unrelated modal isolation intact (no globally raised z-index).
          await page.getByRole("button", { name: "Unrelated dialog", exact: true }).click();
          const outsideFocus = await calculator.getByLabel("Cost", { exact: true }).evaluate(input => {
            input.focus(); return document.activeElement === input;
          });
          expect(outsideFocus).toBe(false);
          await page.getByRole("button", { name: "Return to billing", exact: true }).click();
          // An editor opened from a work order also owns the calculator.
          await page.getByRole("button", { name: "Switch page", exact: true }).click();
          await expect(calculator).toHaveCount(0);
          await page.getByRole("button", { name: "Create invoice", exact: true }).click();
          await expect(calculator.getByLabel("Cost", { exact: true })).toHaveValue("150");
          await checkLayout();
          // Real form/draft guard with calculator use, nested confirmation, and reopen.
          await editor.locator('input[name="storeNumber"]').pressSequentially("54321");
          await editor.locator('input[name="storeNumber"]').press("Tab");
          await expect(editor.getByText(/Draft autosaved on this device/)).toBeVisible();
          await calculator.getByLabel("Cost", { exact: true }).fill("160");
          await editor.getByRole("button", { name: "Close", exact: true }).click();
          const confirm = page.getByRole("dialog", { name: "Unsaved changes", exact: true });
          await expect(confirm).toBeVisible();
          expect(await calculator.getByLabel("Cost", { exact: true }).evaluate(input => { input.focus(); return document.activeElement === input; })).toBe(false);
          await confirm.getByRole("button", { name: "Keep editing" }).click();
          await expect(editor.locator('input[name="storeNumber"]')).toHaveValue("54321");
          await expect(calculator.getByLabel("Cost", { exact: true })).toHaveValue("160");
          await editor.getByRole("button", { name: "Close", exact: true }).click();
          await confirm.getByRole("button", { name: "Close and keep draft" }).click();
          await expect(editor).toHaveCount(0);
          await expect(calculator).toHaveCount(0);
          await page.getByRole("button", { name: "Create invoice", exact: true }).click();
          await expect(editor.locator('input[name="storeNumber"]')).toHaveValue("54321");
          await expect(calculator.getByLabel("Cost", { exact: true })).toHaveValue("160");
          await editor.getByRole("button", { name: "Discard draft", exact: true }).click();
          await confirm.getByRole("button", { name: "Discard draft", exact: true }).click();
          await expect(editor).toHaveCount(0);
          await page.getByRole("button", { name: "Switch page", exact: true }).click();
          // Only open/closed preference persists, not calculator amounts.
          expect(await page.evaluate(() => Object.keys(localStorage).filter(key => key.includes("calculator")))).toEqual(["p1-billing-profit-calculator-open"]);
          await page.reload();
          await expect(calculator.getByLabel("Cost", { exact: true })).toHaveValue("");
          for (const actor of ["contractor", "controller"]) {
            await page.getByLabel("Test actor").selectOption(actor);
            await expect(calculator).toHaveCount(0);
          }
          await page.getByLabel("Test actor").selectOption("staff");
          await calculator.getByLabel("Cost", { exact: true }).fill("123");
          await page.getByLabel("Test actor").selectOption("second-staff");
          await expect(calculator.getByLabel("Cost", { exact: true })).toHaveValue("");
          // A denied preference write must not stop calculator interaction.
          await page.evaluate(() => {
            const setItem = Storage.prototype.setItem;
            Storage.prototype.setItem = function (key, value) {
              if (key === "p1-billing-profit-calculator-open") throw new Error("Synthetic preference storage failure");
              return setItem.call(this, key, value);
            };
          });
          await activate(page.getByRole("button", { name: "Collapse profit calculator" }));
          await activate(page.getByRole("button", { name: "Profit calculator", exact: true }));
          await calculator.getByLabel("Cost", { exact: true }).fill("80");
          await calculator.getByLabel("Sell price", { exact: true }).fill("50");
          await expect(calculator.getByText("$-30", { exact: true })).toBeVisible();
          // Escape closes the clean real editor, including its owned slot.
          await activate(page.getByRole("button", { name: "Create invoice", exact: true }));
          await expect(editor).toBeVisible();
          await page.keyboard.press("Escape");
          await expect(editor).toHaveCount(0);
          expect(await calculator.evaluate(element => Boolean(element.closest("dialog")))).toBe(false);
          expect(mutations).toEqual([]); expect(errors).toEqual([]);
          results.push({ engine, viewport: mobile ? "320x568 touch" : "1440x900", passed: true,
            scopes: ["invoice-owned calculator", "math", "keyboard", "no implicit submit", "collapse focus", "unrelated modal isolation",
              "work-order entry", "nested confirmation", "draft keep/reopen/discard", "no amount persistence", "actor reset", "preference failure", "Escape cleanup"], mutations: 0, errors: 0 });
        } catch (error) {
          await page.screenshot({ path: `${evidence}/failure-${engine}-${mobile ? "mobile" : "desktop"}.png` });
          console.error(JSON.stringify({ engine, mobile, errors, mutations }));
          throw error;
        } finally { await context.close(); }
      }
    } finally { await browser.close(); }
  }
  writeFileSync(`${evidence}/${reproduce ? "before" : "after"}-results.json`, JSON.stringify({ scope: "Actual editor components; synthetic HTTP; not full authenticated shell", results }, null, 2));
  console.log(JSON.stringify({ evidence, results }, null, 2));
} finally { await new Promise(done => server.close(done)); }
