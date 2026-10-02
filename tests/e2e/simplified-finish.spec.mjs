import { accounts, expect, login, openSidebarPage, sidebar, test, waitForApplicationRequestsToSettle } from "./fixtures.mjs";

async function openSimplified(page) {
  await login(page, accounts.manager);
  await openSidebarPage(page, "Simplified");
  await expect(page.getByRole("button", { name: "Export filtered list" })).toBeEnabled();
}
async function downloadedText(download) {
  const stream = await download.createReadStream();
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

test("unassigned is a direct server-filtered queue and retains dispatch actions", async ({ page }, testInfo) => {
  await openSimplified(page);
  await page.getByRole("navigation", { name: "Work filters" }).getByRole("button", { name: "Unassigned", exact: true }).click();
  await expect(page.getByLabel("Work status", { exact: true })).toHaveCount(0);
  await waitForApplicationRequestsToSettle(page);
  const rows = page.locator("article");
  expect(await rows.count()).toBeGreaterThan(0);
  for (const row of await rows.all()) await expect(row).toContainText("Assign a contractor");
  await page.screenshot({ path: testInfo.outputPath("simplified-unassigned-desktop.png") });
  await rows.first().getByRole("button").click();
  await expect(page.getByRole("button", { name: "Show full details" })).toBeVisible();
  await page.getByText("Dispatch and billing actions", { exact: true }).click();
  await expect(page.getByRole("button", { name: /Assign|Dispatch/ }).first()).toBeVisible();
});

test("export traverses beyond loaded rows without expanding the on-screen list", async ({ page }) => {
  await openSimplified(page);
  await expect(page.locator("article")).toHaveCount(50);
  const reads = [];
  page.on("request", request => {
    if (request.url().includes("/rpc/list_work_orders_rows_v1") && request.postDataJSON()?.p_limit === 100) reads.push(request.postDataJSON());
  });
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export filtered list" }).click();
  const csv = await downloadedText(await download);
  const ids = csv.split("\r\n").slice(1).map(line => line.split(",")[0]);
  expect(ids.length).toBeGreaterThan(100);
  expect(new Set(ids).size).toBe(ids.length);
  expect(reads.length).toBeGreaterThan(1);
  expect(reads[0].p_cursor).toBeNull();
  expect(reads[1].p_cursor).toBeTruthy();
  await expect(page.locator("article")).toHaveCount(50);
  await expect(page.getByText(`Exported ${ids.length} matching work orders.`, { exact: true })).toBeVisible();
});

test("capital export contains only the chosen stage even when the list is paged", async ({ page }) => {
  await openSimplified(page);
  await page.getByRole("navigation", { name: "Work filters" }).getByRole("button", { name: "Capital", exact: true }).click();
  await page.getByLabel("Capital status", { exact: true }).selectOption("capital_equipment_ordered");
  await expect(page.getByRole("button", { name: "Open E2E-CAPITAL-BOARD-ORDERED", exact: true })).toBeVisible();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export filtered list" }).click();
  const csv = await downloadedText(await download);
  expect(csv).toContain("E2E-CAPITAL-BOARD-ORDERED");
  expect(csv).not.toContain("E2E-CAPITAL-BOARD-SUBMITTED");
  expect(csv).toContain("Equipment ordered — waiting for equipment");
});

test("failed export downloads nothing and can retry with the same filters", async ({ page }) => {
  await openSimplified(page);
  const downloads = [];
  page.on("download", value => downloads.push(value));
  await page.route("**/rest/v1/rpc/list_work_orders_rows_v1", async route => {
    const args = route.request().postDataJSON();
    if (args?.p_limit !== 100 || !args.p_cursor) return route.fallback();
    await route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ code: "22023", message: "Synthetic export continuation failure" }) });
  });
  await page.getByRole("button", { name: "Export filtered list" }).click();
  await expect(page.getByRole("region", { name: "Work, made simple" }).getByRole("alert")).toContainText("No partial file was downloaded");
  expect(downloads).toHaveLength(0);
  await page.unroute("**/rest/v1/rpc/list_work_orders_rows_v1");
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export filtered list" }).click();
  await download;
  expect(downloads).toHaveLength(1);
});

test("cancelled export suppresses a late response and unlocks filtering", async ({ page }) => {
  await openSimplified(page);
  let release;
  const held = new Promise(resolve => { release = resolve; });
  const downloads = [];
  page.on("download", value => downloads.push(value));
  await page.route("**/rest/v1/rpc/list_work_orders_rows_v1", async route => {
    if (route.request().postDataJSON()?.p_limit !== 100) return route.fallback();
    await held;
    await route.abort();
  });
  try {
    await page.getByRole("button", { name: "Export filtered list" }).click();
    await expect(page.getByRole("button", { name: "Cancel export" })).toBeVisible();
    await expect(page.getByLabel("Search work orders", { exact: true })).toBeDisabled();
    await page.getByRole("button", { name: "Cancel export" }).click();
    await expect(page.getByText("Export cancelled. No file was downloaded.")).toBeVisible();
    await expect(page.getByLabel("Search work orders", { exact: true })).toBeEnabled();
    expect(downloads).toHaveLength(0);
  } finally { release(); }
});

test("linked invoice attachments return to the same invoice and handoff leaves Send for Sent", async ({ page }) => {
  await openSimplified(page);
  await page.getByRole("navigation", { name: "Work filters" }).getByRole("button", { name: "Invoices", exact: true }).click();
  await page.getByText("#P1-E2E-SEND-001", { exact: true }).first().click();
  await page.getByRole("button", { name: "Attachments", exact: true }).click();
  await expect(page.locator("#work-order-attachments")).toBeFocused();
  await page.getByRole("button", { name: "Back to previous view" }).click();
  await expect(page.getByText("#P1-E2E-SEND-001", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Billed to 7-Eleven", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Confirm 7-Eleven billing" });
  await expect(dialog).toContainText("does not upload");
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByRole("button", { name: "Billed to 7-Eleven", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Billed to 7-Eleven", exact: true }).click();
  await page.route("**/api/billing-invoices?**", route => route.request().method() === "PATCH"
    ? route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: "Synthetic stale invoice", code: "STALE_VERSION" }) })
    : route.fallback());
  await dialog.getByRole("button", { name: "Billed to 7-Eleven", exact: true }).click();
  await expect(dialog.getByRole("alert")).toBeVisible();
  await expect(dialog).toBeVisible();
  await page.unroute("**/api/billing-invoices?**");
  await dialog.getByRole("button", { name: "Billed to 7-Eleven", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("button", { name: "Billed to 7-Eleven", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Back to billing", exact: true }).click();
  const queues = page.getByRole("navigation", { name: "Invoice queues" });
  await queues.getByRole("button", { name: "Send to 7-Eleven", exact: true }).click();
  await expect(page.getByText("#P1-E2E-SEND-001", { exact: true })).toHaveCount(0);
  await queues.getByRole("button", { name: "Sent to 7-Eleven", exact: true }).click();
  await expect(page.getByText("#P1-E2E-SEND-001", { exact: true }).first()).toBeVisible();
});

test("leaving Simplified cancels an export even if its response arrives later", async ({ page }) => {
  await openSimplified(page);
  let release;
  const held = new Promise(resolve => { release = resolve; });
  let exportStarted = false;
  const downloads = [];
  page.on("download", value => downloads.push(value));
  await page.route("**/rest/v1/rpc/list_work_orders_rows_v1", async route => {
    if (route.request().postDataJSON()?.p_limit !== 100) return route.fallback();
    const response = await route.fetch();
    exportStarted = true;
    await held;
    await route.fulfill({ response }).catch(() => undefined);
  });
  try {
    await page.getByRole("button", { name: "Export filtered list" }).click();
    await expect.poll(() => exportStarted).toBe(true);
    await openSidebarPage(page, "My Schedule");
    await expect(page.getByRole("heading", { name: "My Schedule", exact: true })).toBeVisible();
    release();
    await waitForApplicationRequestsToSettle(page);
    await openSidebarPage(page, "Simplified");
    await expect(page.getByRole("button", { name: "Export filtered list" })).toBeEnabled();
    expect(downloads).toHaveLength(0);
  } finally { release(); }
});

test("an initial schedule read failure is retryable and an empty schedule is usable", async ({ page }) => {
  await login(page, accounts.manager);
  await page.route("**/rest/v1/work_orders?*", route => route.fulfill({
    status: 400, contentType: "application/json", body: JSON.stringify({ code: "22023", message: "Synthetic read failure" }),
  }));
  await openSidebarPage(page, "My Schedule");
  await expect(page.getByRole("alert").filter({ hasText: "Your schedule could not be loaded." })).toContainText("No work-order data was changed.");
  await page.unroute("**/rest/v1/work_orders?*");
  await page.route("**/rest/v1/work_orders?*", route => route.fulfill({
    status: 200, contentType: "application/json",
    headers: { "content-range": "*/0", "access-control-expose-headers": "content-range" }, body: JSON.stringify([]),
  }));
  await page.getByRole("button", { name: "Retry schedule", exact: true }).click();
  await page.getByRole("button", { name: "Retry counts", exact: true }).click();
  const calendar = page.getByRole("region", { name: "Work schedule calendar" });
  await expect(calendar).toBeVisible();
  await page.getByRole("button", { name: /Unscheduled/ }).click();
  await expect(page.getByText("No matching work is awaiting an ETA.", { exact: true })).toBeVisible();
  await calendar.getByRole("button", { name: "day", exact: true }).click();
  await expect(calendar.getByText("No work is scheduled for this day.", { exact: true })).toBeVisible();
  await calendar.getByRole("button", { name: "Next day", exact: true }).click();
  await expect(calendar.getByText("No work is scheduled for this day.", { exact: true })).toBeVisible();
});

test("Beta is visible and double-click ETA submission sends only one request", async ({ page }) => {
  await login(page, accounts.companyAdmin);
  await expect(sidebar(page).getByRole("button", { name: "My Schedule", exact: true })).toContainText("Beta");
  await openSidebarPage(page, "My Schedule");
  await expect(page.getByRole("region", { name: "My Schedule", exact: true }).getByText("Beta", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: /Unscheduled/ }).click();
  await page.getByRole("button", { name: "Schedule", exact: true }).first().click();
  const dialog = page.getByRole("dialog", { name: /^Schedule / });
  let release;
  const held = new Promise(resolve => { release = resolve; });
  let calls = 0;
  await page.route("**/rest/v1/rpc/set_work_order_eta_v1", async route => {
    calls++;
    await held;
    await route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ code: "PT409", message: "STALE_VERSION", details: null, hint: null }) });
  });
  try {
    await dialog.getByRole("button", { name: "Confirm schedule" }).evaluate(button => { button.click(); button.click(); });
    await expect.poll(() => calls).toBe(1);
    await expect(dialog.getByRole("button", { name: "Saving…" })).toBeDisabled();
    await expect(dialog.getByRole("button", { name: "Cancel", exact: true })).toBeDisabled();
  } finally { release(); }
  await expect(dialog.getByRole("alert")).toContainText("changed in another session");
  expect(calls).toBe(1);
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
});

test.describe("mobile schedule scenarios at 320x568", () => {
  test.use({ viewport: { width: 320, height: 568 }, screen: { width: 320, height: 568 }, isMobile: true, hasTouch: true });

  test("simultaneous ETAs remain separate through month, week, day and details", async ({ page }, testInfo) => {
    await login(page, accounts.manager);
    const today = await page.evaluate(() => {
      const date = new Date();
      return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
    });
    let ids = [];
    // Synthetic presentation fixture: retain authorized real local IDs, set two equal ETAs.
    await page.route("**/rest/v1/work_orders?*", async route => {
      const url = new URL(route.request().url());
      const bounds = url.searchParams.getAll("eta");
      if (route.request().method() !== "GET" || !bounds.some(value => value.startsWith("gte."))) return route.fallback();
      const eta = `${today}T14:00:00Z`;
      const from = bounds.find(value => value.startsWith("gte.")).slice(4);
      const to = bounds.find(value => value.startsWith("lt.")).slice(3);
      // Only the schedule presentation response is synthetic. Fetch actual
      // locally authorized rows and respect the requested date window.
      url.searchParams.delete("eta");
      url.searchParams.set("limit", "2");
      const response = await route.fetch({ url: url.toString() });
      if (!response.ok()) return route.fulfill({ response });
      const body = await response.json();
      expect(Array.isArray(body)).toBe(true);
      ids = body.slice(0, 2).map(row => row.id);
      const rows = Date.parse(eta) >= Date.parse(from) && Date.parse(eta) < Date.parse(to)
        ? body.slice(0, 2).map(row => ({ ...row, store_timezone: "America/Chicago", eta })) : [];
      await route.fulfill({ response, json: rows, headers: { ...response.headers(), "content-range": rows.length ? "0-1/2" : "*/0" } });
    });
    await page.getByRole("button", { name: "Open menu", exact: true }).tap();
    const menu = page.getByRole("dialog", { name: "Navigation menu" });
    await expect(menu.getByRole("button", { name: "My Schedule", exact: true })).toContainText("Beta");
    await menu.getByRole("button", { name: "My Schedule", exact: true }).tap();
    const calendar = page.getByRole("region", { name: "Work schedule calendar" });
    const dateCell = calendar.locator('button[data-selected="true"]');
    await expect(dateCell).toHaveAttribute("aria-label", /2 scheduled/);
    await dateCell.tap();
    await expect(calendar.getByRole("button", { name: "week", exact: true })).toHaveAttribute("data-active", "true");
    for (const id of ids) await expect(calendar.getByText(id, { exact: true })).toBeVisible();
    await expect.poll(() => page.locator(".content-pad").evaluate(element => element.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("schedule-week-320.png") });
    await calendar.locator('section[data-selected="true"]').getByRole("button", { name: /^View / }).tap();
    await expect(calendar.getByRole("button", { name: "View details", exact: true })).toHaveCount(2);
    await page.screenshot({ path: testInfo.outputPath("schedule-day-320.png") });
    const selectedId = ids[1];
    await calendar.getByRole("button", { name: "View details", exact: true }).nth(1).tap();
    await expect(page.locator(".work-order-reference:visible")).toHaveText(selectedId);
    await expect(page.getByRole("button", { name: "Attachments", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Back to previous view" }).tap();
    await expect(calendar).toBeVisible();
    await calendar.getByRole("button", { name: "Next day", exact: true }).tap();
    await expect(calendar.getByText("No work is scheduled for this day.")).toBeVisible();
    await calendar.getByRole("button", { name: "Previous day", exact: true }).tap();
    await expect(calendar.getByRole("button", { name: "View details", exact: true })).toHaveCount(2);
  });
});
