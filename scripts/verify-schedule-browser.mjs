// Real feature/shared UI + synthetic HTTP responses only. Not a database/RLS
// certification. No production configuration, session or customer data is read.
import { build } from "esbuild";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";
import { chromium, webkit, expect } from "@playwright/test";
import { createServer } from "node:http";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const evidence = "/Users/nxs/p1-stabilization-recovery/schedule-filters-2026-09-28";
mkdirSync(evidence, { recursive: true });
const origin = "http://127.0.0.1:3911";
const bundle = await build({ entryPoints: ["scripts/schedule-test-support/browserEntry.tsx"], bundle: true, write: false,
  outfile: "/private/tmp/p1-schedule-browser.js", jsx: "automatic", platform: "browser", define: {
    "process.env.NODE_ENV": '"test"', "process.env.NEXT_PUBLIC_SUPABASE_URL": JSON.stringify(origin),
    "process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY": '"sb_publishable_synthetic_schedule"',
    "process.env.NEXT_PUBLIC_P1_APP_ENV": '"development"',
  } });
const css = await postcss([tailwind()]).process(readFileSync("src/app/globals.css", "utf8"), { from: resolve("src/app/globals.css") });
// Use the application's actual shared button rules, not a mock visual design.
const constants = await build({ entryPoints: ["src/lib/constants.ts"], bundle: true, write: false, platform: "node", format: "esm" });
const { T } = await import(`data:text/javascript;base64,${Buffer.from(constants.outputFiles[0].text).toString("base64")}`);
const shell = readFileSync("src/components/PortalShell.tsx", "utf8");
const buttons = shell.split("\n").filter(line => /^\.btn-(soft|accent)/.test(line)).join("\n").replace(/\$\{T\.(\w+)\}/g, (_, key) => T[key]);
const javascript = bundle.outputFiles.find(file => file.path.endsWith(".js")).contents;
const pickerCss = bundle.outputFiles.find(file => file.path.endsWith(".css"))?.text || "";
const server = createServer((request, response) => {
  if (request.url === "/app.js") { response.setHeader("Content-Type", "text/javascript"); response.end(javascript); return; }
  if (request.url === "/app.css") { response.setHeader("Content-Type", "text/css"); response.end(css.css + pickerCss + buttons); return; }
  response.setHeader("Content-Type", "text/html");
  response.end('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/app.css"></head><body><div id="root"></div><script src="/app.js"></script></body></html>');
});
await new Promise(resolveListen => server.listen(3911, "127.0.0.1", resolveListen));
const company = "20000000-0000-4000-8000-000000000001";
const makeRow = (id, eta = null, status = "assigned") => ({ id, eta, status, priority: "p1", functional_status: status === "wip" ? "Work in Progress" : "Dispatched",
  store_number: "12345", city: "Synthetic City", store_timezone: "America/Chicago", contractor_id: company,
  summary: "Synthetic scheduled service", deleted_at: null, contractor_assignment_version: 1, workflow_cycle: 0, lifecycle_version: 0 });
const fixtureRows = () => [
  ...Array.from({ length: 105 }, (_, i) => makeRow(`OLD-${String(i).padStart(3, "0")}`, "2026-09-28T15:00:00Z")),
  makeRow("NEXT-MONTH", "2026-10-20T15:00:00Z"),
  ...Array.from({ length: 8 }, (_, i) => makeRow(`PENDING-${i}`)),
  makeRow("PROGRESS", "2026-09-28T15:00:00Z", "wip"),
];
const results = [];
try {
  for (const engine of ["chromium", "webkit"]) for (const mobile of [false, true]) {
    const browser = await (engine === "chromium" ? chromium : webkit).launch({ headless: true });
    const context = await browser.newContext({ viewport: mobile ? { width: 320, height: 568 } : { width: 1440, height: 1000 },
      isMobile: mobile, hasTouch: mobile, timezoneId: "America/Chicago" });
    const page = await context.newPage();
    const errors = []; const reads = []; const writes = []; let failCalendar = false; let failSave = false;
    const rows = fixtureRows();
    page.on("pageerror", error => errors.push(error.message));
    await page.clock.setFixedTime(new Date("2026-09-28T17:00:00Z"));
    await context.route("**/*", async route => {
      const request = route.request(); const url = new URL(request.url());
      if (url.origin !== origin) { errors.push(`Blocked external host: ${url.hostname}`); return route.abort(); }
      const send = (body, status = 200, headers = {}) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body), headers });
      if (url.pathname === "/rest/v1/work_orders") {
        reads.push({ method: request.method(), query: url.search });
        if (failCalendar && url.searchParams.getAll("eta").some(value => value.startsWith("gte.")) && request.method() !== "HEAD") return send({ code: "22023", message: "Synthetic read failure" }, 400);
        let selected = rows;
        for (const [column, expression] of url.searchParams) {
          if (["select", "order", "offset", "limit", "or"].includes(column)) continue;
          const [operator, ...rest] = expression.split("."); const value = rest.join(".");
          if (operator === "eq") selected = selected.filter(row => row[column] === value);
          if (operator === "neq") selected = selected.filter(row => row[column] !== value);
          if (operator === "gt") selected = selected.filter(row => row[column] > value);
          if (operator === "gte") selected = selected.filter(row => row[column] && row[column] >= value);
          if (operator === "lt") selected = selected.filter(row => row[column] && row[column] < value);
          if (operator === "is" && value === "null") selected = selected.filter(row => row[column] === null);
          if (operator === "not" && value === "is.null") selected = selected.filter(row => row[column] != null);
          if (operator === "in") selected = selected.filter(row => value.slice(1, -1).split(",").includes(row[column]));
        }
        if (url.searchParams.has("or")) {
          const term = url.searchParams.get("or").match(/%([^%]*)%/)?.[1]?.toLowerCase() || "";
          selected = selected.filter(row => [row.id, row.store_number, row.city].some(value => value.toLowerCase().includes(term)));
        }
        selected.sort((a, b) => a.id.localeCompare(b.id));
        const total = selected.length; const offset = Number(url.searchParams.get("offset") || 0);
        const visible = selected.slice(offset, offset + Number(url.searchParams.get("limit") || 100));
        return send(request.method() === "HEAD" ? null : visible, 200, { "content-range": total ? `${offset}-${Math.max(offset, offset + visible.length - 1)}/${total}` : "*/0" });
      }
      if (url.pathname.endsWith("/set_work_order_eta_v1")) {
        const payload = request.postDataJSON(); writes.push(payload);
        if (failSave) return send({ code: "PT409", message: "STALE_VERSION" }, 409);
        const target = rows.find(row => row.id === payload.p_work_order_id); if (target) target.eta = payload.p_eta;
        return send({ applied: true, reason: "applied", workOrderId: payload.p_work_order_id, operationId: payload.p_operation_id,
          assignmentVersion: payload.p_expected_assignment_version, workflowCycle: payload.p_expected_workflow_cycle,
          lifecycleVersion: payload.p_expected_lifecycle_version + 1, activityId: "30000000-0000-4000-8000-000000000001",
          workOrderStatus: "assigned", functionalStatus: "Dispatched" });
      }
      if (url.pathname.startsWith("/rest/v1/rpc/")) {
        const args = request.postDataJSON();
        if (url.pathname.includes("directory") && args?.p_domain === "contractor_filter") {
          const item = { id: company, name: "Extremely long synthetic contractor company name for narrow dropdown testing" };
          return send(args.p_id ? item : { items: [item], pageSize: 25, hasMore: false, nextCursor: null });
        }
        if (url.pathname.includes("directory") && args?.p_domain === "company_technicians") return send({ items: [], pageSize: 25, hasMore: false, nextCursor: null });
        return send(null);
      }
      return route.continue();
    });
    const checkWidth = async () => expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    try {
      await page.goto(origin);
      await expect(page.getByText("106", { exact: true }).first()).toBeVisible();
      await expect(page.getByRole("button", { name: "Load more work orders" })).toHaveCount(0);
      expect(reads.some(read => read.query.includes("id=gt."))).toBe(true);
      await checkWidth();
      await page.getByRole("button", { name: "Next month" }).click();
      await expect(page.getByText("NEXT-MONTH", { exact: false }).first()).toBeVisible({ timeout: mobile ? 100 : 5000 }).catch(async error => {
        if (!mobile) throw error; // Mobile month cells deliberately show counts.
        await expect(page.getByRole("button", { name: /Oct 20, 2026, 1 scheduled/ })).toBeVisible();
      });
      await page.getByRole("button", { name: "Today", exact: true }).click();
      await page.getByRole("button", { name: "week", exact: true }).click();
      await expect(page.getByText("OLD-104", { exact: true })).toBeVisible();
      await checkWidth();
      await page.getByRole("button", { name: "day", exact: true }).click();
      await page.getByRole("button", { name: "View details", exact: true }).first().click();
      await expect(page.getByLabel("Opened work order")).not.toBeEmpty();
      await page.getByLabel("Search schedule").fill("PENDING");
      await page.getByRole("button", { name: /Unscheduled/ }).click();
      await expect(page.locator("#pending-schedule-work article")).toHaveCount(3);
      await expect(page.getByText("1–3 of 8", { exact: true })).toBeVisible();
      await page.getByRole("button", { name: "Next work" }).click();
      await expect(page.getByText("4–6 of 8", { exact: true })).toBeVisible();
      await page.getByLabel("Search schedule").fill("PENDING-7");
      await expect(page.locator("#pending-schedule-work article")).toHaveCount(1);
      await page.getByRole("button", { name: "Filters", exact: true }).click();
      const filterDialog = page.getByRole("dialog", { name: "Schedule filters" });
      await filterDialog.getByRole("combobox", { name: "Work status" }).click();
      const option = page.getByRole("option", { name: "Awaiting parts", exact: true });
      await expect(option).toBeVisible();
      const bounds = await page.getByRole("listbox").evaluate(element => {
        const rect = element.parentElement.getBoundingClientRect(); return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: innerWidth, height: innerHeight };
      });
      expect(bounds.left).toBeGreaterThanOrEqual(0); expect(bounds.right).toBeLessThanOrEqual(bounds.width);
      expect(bounds.top).toBeGreaterThanOrEqual(0); expect(bounds.bottom).toBeLessThanOrEqual(bounds.height);
      await option.click();
      await filterDialog.getByRole("button", { name: "Company", exact: true }).click();
      await page.getByRole("option", { name: /^Extremely long synthetic/ }).click();
      const trigger = filterDialog.getByRole("button", { name: "Company", exact: true });
      const contained = await trigger.evaluate(button => {
        const bounds = button.getBoundingClientRect(); const [label, arrow] = [...button.children].map(child => child.getBoundingClientRect());
        return label.right <= arrow.left && arrow.right <= bounds.right && arrow.bottom <= bounds.bottom;
      });
      expect(contained).toBe(true);
      await checkWidth();
      await page.screenshot({ path: `${evidence}/${engine}-${mobile ? "mobile" : "desktop"}-filters.png` });
      await page.keyboard.press("Escape");
      await page.getByRole("button", { name: "Clear filters", exact: true }).click();
      await page.getByLabel("Search schedule").fill("PENDING-7");
      await page.getByRole("button", { name: "Schedule", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "Schedule PENDING-7" });
      await dialog.getByRole("button", { name: "Date", exact: true }).click();
      await expect(page.getByRole("dialog", { name: "Choose date" })).toBeVisible();
      await checkWidth();
      await page.keyboard.press("Escape");
      await dialog.getByRole("button", { name: "Time", exact: true }).click();
      await expect(page.getByRole("dialog", { name: "Choose time" })).toBeVisible();
      await checkWidth();
      await page.keyboard.press("Escape");
      await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
      expect(writes).toHaveLength(0);
      await page.getByRole("button", { name: "Schedule", exact: true }).click();
      failSave = true;
      await dialog.getByRole("button", { name: "Confirm schedule" }).evaluate(button => { button.click(); button.click(); });
      await expect(dialog.getByRole("alert")).toContainText("changed in another session");
      expect(writes).toHaveLength(1);
      failSave = false;
      await dialog.getByRole("button", { name: "Confirm schedule" }).click();
      await expect(dialog).toHaveCount(0);
      expect(writes).toHaveLength(2);
      expect(writes[1].p_eta).toBe("2026-09-28T14:00:00.000Z");
      await expect(page.getByRole("button", { name: /Unscheduled/ })).toContainText("0");
      await expect(page.getByRole("region", { name: "Work schedule calendar" }).getByText("PENDING-7", { exact: true })).toBeVisible();
      await page.getByRole("button", { name: "Clear filters", exact: true }).click();
      failCalendar = true;
      await page.getByRole("button", { name: "Next day" }).click();
      await expect(page.getByRole("alert")).toContainText("Your schedule could not be loaded");
      failCalendar = false;
      await page.getByRole("button", { name: "Retry schedule" }).click();
      await expect(page.getByRole("alert")).toHaveCount(0);
      await expect(page.getByText("No work is scheduled for this day.")).toBeVisible();
      await page.getByRole("button", { name: "month", exact: true }).click();
      await page.getByRole("button", { name: /Unscheduled/ }).click();
      await page.screenshot({ path: `${evidence}/${engine}-${mobile ? "mobile" : "desktop"}.png`, fullPage: true });
      const prior = reads.length;
      await page.goto(`${origin}/?role=technician`);
      await expect(page.getByText("107", { exact: true }).first()).toBeVisible();
      expect(reads.slice(prior).every(read => new URLSearchParams(read.query).get("contractor_id") === `eq.${company}`)).toBe(true);
      await page.getByRole("button", { name: "Filters", exact: true }).click();
      await expect(page.getByLabel("Company", { exact: true })).toHaveCount(0);
      await expect(page.getByLabel("Technician", { exact: true })).toHaveCount(0);
      expect(errors).toEqual([]);
      results.push({ engine, mobile, passed: true, readCount: reads.length, syntheticWriteCount: writes.length,
        checks: ["complete date-window read", "month/week/day navigation", "work detail link", "search", "server-paged unscheduled queue", "filter reset", "dropdown bounds", "long-label icon containment", "date/time pickers", "cancel without write", "stale save and double-click guard", "confirmed ETA and invalidation", "read failure and retry", "empty day", "contractor request scope", "no page errors"] });
    } catch (error) {
      await page.screenshot({ path: `${evidence}/${engine}-${mobile ? "mobile" : "desktop"}-failure.png`, fullPage: true });
      results.push({ engine, mobile, passed: false, error: String(error), errors });
      console.error(String(error));
      process.exitCode = 1;
    } finally { await browser.close(); }
    console.log(JSON.stringify(results.at(-1)));
  }
} finally {
  server.close();
  writeFileSync(`${evidence}/browser-results.json`, JSON.stringify(results, null, 2));
}
