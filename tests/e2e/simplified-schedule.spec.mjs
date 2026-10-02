import { accounts, expect, login, openSidebarPage, test, waitForApplicationRequestsToSettle } from "./fixtures.mjs";

async function openMobilePage(page, name) {
  await page.getByRole("button", { name: "Open menu", exact: true }).click();
  await page.getByRole("dialog", { name: "Navigation menu" }).getByRole("button", { name, exact: true }).click();
}

async function expectNarrowLayout(page) {
  await expect.poll(() => page.locator(".content-pad").evaluate(element => ({
    documentWidth: document.documentElement.scrollWidth,
    fitsContent: element.scrollWidth <= window.innerWidth,
    viewport: window.innerWidth,
  }))).toEqual({ documentWidth: 320, fitsContent: true, viewport: 320 });
}

async function loadRemainingWork(page) {
  const more = page.getByRole("button", { name: "Load more work orders" });
  await waitForApplicationRequestsToSettle(page);
  // Bounded traversal of the disposable fixture collection; catch stuck cursors.
  for (let batch = 0; batch < 10 && await more.isVisible(); batch += 1) {
    await more.click();
    await waitForApplicationRequestsToSettle(page);
    await expect(page.getByRole("button", { name: "Loading…", exact: true })).toBeHidden();
  }
  await expect(more).toBeHidden();
}

test("staff simplified workspace exposes focused filters and real work-order details", async ({ page }) => {
  await login(page, accounts.manager);
  await openSidebarPage(page, "Simplified");

  await expect(page.getByRole("heading", { name: "Work, made simple" })).toBeVisible();
  const filters = page.getByRole("navigation", { name: "Work filters" });
  for (const name of ["Unassigned", "Open", "Breached", "Capital", "Closed", "Invoices"]) {
    await expect(filters.getByRole("button", { name, exact: true })).toBeVisible();
  }
  await expect(page.locator("article")).toHaveCount(50);
  await page.getByRole("button", { name: "Load more work orders" }).click();
  await expect.poll(() => page.locator("article").count()).toBeGreaterThan(50);
  await loadRemainingWork(page);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Work, made simple" })).toBeVisible();

  const search = page.getByPlaceholder("Search WO, store, city, keyword…");
  await search.fill("E2E");
  const firstDetails = page.getByRole("button", { name: /^Open E2E-/ }).first();
  await expect(firstDetails).toBeVisible();
  await firstDetails.click();
  await expect(page.locator(".work-order-reference:visible")).toBeVisible();
  await expect(page.getByRole("button", { name: "Show full details" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Attachments", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Back to previous view" }).click();
  await expect(page.getByRole("heading", { name: "Work, made simple" })).toBeVisible();
});

test("desktop pending work stays compact and dragging requests confirmation without writing", async ({ page }) => {
  await login(page, accounts.companyAdmin);
  await openSidebarPage(page, "My Schedule");
  const pending = page.getByRole("button", { name: /Unscheduled/ });
  await expect(pending).toHaveAttribute("aria-expanded", "false");
  await pending.click();
  await expect(page.locator("#pending-schedule-work article")).toHaveCount(3);
  const firstId = await page.locator("#pending-schedule-work article strong").first().innerText();
  await page.getByRole("button", { name: "Next work", exact: true }).click();
  await expect(page.locator("#pending-schedule-work article strong").first()).not.toHaveText(firstId);
  await page.getByRole("button", { name: "Previous work", exact: true }).click();
  const writes = [];
  page.on("request", request => { if (request.url().includes("/rpc/set_work_order_eta_v1")) writes.push(request); });
  const target = page.locator('[aria-label="Work schedule calendar"] [data-muted="false"]').first();
  await target.scrollIntoViewIfNeeded();
  await page.locator("#pending-schedule-work article").first().dragTo(target, { sourcePosition: { x: 40, y: 20 } });
  const dialog = page.getByRole("dialog", { name: `Schedule ${firstId}` });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  expect(writes).toHaveLength(0);
});

test("schedule uses ETA date windows and recovers from a window read failure", async ({ page }) => {
  await login(page, accounts.manager);
  await openSidebarPage(page, "My Schedule");
  await waitForApplicationRequestsToSettle(page);
  await expect(page.getByRole("button", { name: "Load more work orders" })).toHaveCount(0);
  await page.route("**/rest/v1/work_orders?*", async route => {
    const query = new URL(route.request().url()).searchParams;
    if (!query.getAll("eta").some(value => value.startsWith("gte."))) return route.fallback();
    await route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ code: "22023", message: "Synthetic date-window failure" }) });
  });
  await page.getByRole("button", { name: "Next month" }).click();
  await expect(page.getByRole("region", { name: "My Schedule", exact: true }).getByRole("alert")).toContainText("Your schedule could not be loaded");
  await page.unroute("**/rest/v1/work_orders?*");
  await page.getByRole("button", { name: "Retry schedule" }).click();
  await expect(page.getByRole("button", { name: "Retry schedule" })).toBeHidden();
});

test("technician schedule stays assignment-scoped and links to the real start and pause workflow", async ({ page }) => {
  await login(page, accounts.reportTech);
  await openSidebarPage(page, "My Schedule");
  await page.getByRole("button", { name: /Unscheduled/ }).click();
  const pending = page.locator("#pending-schedule-work");
  await waitForApplicationRequestsToSettle(page);
  for (let batch = 0; batch < 5 && !await pending.getByText("E2E-FOCUSED-FIELD", { exact: true }).isVisible(); batch += 1) {
    const next = pending.getByRole("button", { name: "Next work", exact: true });
    if (!await next.isEnabled()) break;
    await next.click();
  }
  await expect(pending.getByText("E2E-FOCUSED-FIELD", { exact: true })).toBeVisible();
  await expect(pending.getByText("E2E-ETA", { exact: true })).toHaveCount(0);
  await expect(pending.getByText("E2E-DIRECT-INVOICE", { exact: true })).toHaveCount(0);
  const card = pending.locator("article").filter({ hasText: "E2E-FOCUSED-FIELD" });
  await card.getByRole("button", { name: "Details", exact: true }).click();
  await expect(page.getByRole("button", { name: "Show full details", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Start work", exact: true }).click();
  const start = page.getByRole("dialog", { name: "Start work", exact: true });
  await start.getByPlaceholder("What are you seeing on site?").fill("Synthetic focused start from My Schedule.");
  await start.getByRole("button", { name: "Start work", exact: true }).click();
  await expect(start).toBeHidden();
  await page.getByRole("button", { name: "Pause (parts)", exact: true }).click();
  const pause = page.getByRole("dialog", { name: "Pause work", exact: true });
  await pause.getByRole("combobox", { name: "Reason" }).click();
  await page.getByRole("option", { name: "Temporary fix - equipment partially working", exact: true }).click();
  await pause.getByPlaceholder("Explain what was done so far...").fill("Synthetic focused checkout.");
  await pause.getByRole("button", { name: "Pause work", exact: true }).click();
  await expect(pause).toBeHidden();
  await expect(page.getByText("7-Eleven: Awaiting Parts", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Back to previous view" }).click();
  await expect(page.getByRole("heading", { name: "My Schedule", exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { name: "My Schedule", exact: true })).toBeVisible();
  await page.getByRole("button", { name: /Unscheduled/ }).click();
  await expect(pending.getByText("E2E-FOCUSED-FIELD", { exact: true })).toHaveCount(0);
});

test.describe("320x568 My Schedule", () => {
  test.use({
    viewport: { width: 320, height: 568 },
    screen: { width: 320, height: 568 },
    deviceScaleFactor: 2,
    hasTouch: true,
    isMobile: true,
  });

  test("simplified workspace stays within the narrow viewport", async ({ page }) => {
    await login(page, accounts.manager);
    await openMobilePage(page, "Simplified");
    await expect(page.getByRole("heading", { name: "Work, made simple" })).toBeVisible();
    await expect(page.getByPlaceholder("Search WO, store, city, keyword…")).toBeVisible();
    await expectNarrowLayout(page);
    const filters = page.locator('[aria-label="Work filters"]');
    expect(await filters.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await filters.getByRole("button", { name: "Capital", exact: true }).click();
    await expect(page.getByLabel("Capital status", { exact: true })).toBeVisible();
    await page.getByLabel("Capital status", { exact: true }).selectOption("capital_equipment_ordered");
    await expect(page.getByRole("button", { name: "Open E2E-CAPITAL-BOARD-ORDERED", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Open E2E-CAPITAL-BOARD-SUBMITTED", exact: true })).toHaveCount(0);
    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: "Export filtered list" }).click();
    expect((await download).suggestedFilename()).toMatch(/\.csv$/);
    await page.getByPlaceholder("Search WO, store, city, keyword…").fill("no-such-job");
    await expect(page.getByRole("button", { name: "Export filtered list" })).toBeDisabled();
    await waitForApplicationRequestsToSettle(page);
  });

  test("calendar views and ETA confirmation work without horizontal overflow", async ({ page }) => {
    await login(page, accounts.companyAdmin);
    await openMobilePage(page, "My Schedule");

    await expect(page.getByRole("heading", { name: "My Schedule" })).toBeVisible();
    await expect(page.getByRole("button", { name: /Unscheduled/ })).toHaveAttribute("aria-expanded", "false");
    await expect(page.locator("#pending-schedule-work")).toBeHidden();
    await expect(page.getByRole("button", { name: "month", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "week", exact: true }).click();
    await page.getByRole("button", { name: "day", exact: true }).click();
    await page.getByRole("button", { name: "month", exact: true }).click();

    await page.reload();
    await expect(page.getByRole("heading", { name: "My Schedule" })).toBeVisible();
    await page.getByRole("button", { name: /Unscheduled/ }).click();

    const scheduleButton = page.getByRole("button", { name: "Schedule", exact: true }).first();
    await expect(scheduleButton).toBeVisible();
    await scheduleButton.click();
    const dialog = page.getByRole("dialog", { name: /^Schedule / });
    await expect(dialog).toBeVisible();
    const scheduledId = (await dialog.getByRole("heading").textContent())?.replace(/^Schedule\s+/, "").trim();
    expect(scheduledId).toBeTruthy();
    await dialog.getByRole("button", { name: "Date", exact: true }).click();
    await page.getByRole("dialog", { name: "Choose date" }).getByRole("button", { name: "Clear", exact: true }).click();
    await dialog.getByRole("button", { name: "Confirm schedule" }).click();
    await expect(dialog.getByRole("alert")).toHaveText("Choose both a date and a time.");
    await dialog.getByRole("button", { name: "Date", exact: true }).click();
    await page.getByRole("dialog", { name: "Choose date" }).getByRole("button", { name: "Today", exact: true }).click();
    await expect(dialog.getByRole("alert")).toBeHidden();
    await dialog.getByRole("button", { name: "Time", exact: true }).click();
    await page.getByRole("dialog", { name: "Choose time" }).getByRole("button", { name: "Hour 10", exact: true }).click();
    await page.getByRole("dialog", { name: "Choose time" }).getByRole("button", { name: "Minute 30", exact: true }).click();
    await dialog.getByRole("button", { name: "Time", exact: true }).click();
    await dialog.getByRole("button", { name: "Confirm schedule" }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText(scheduledId, { exact: true }).first()).toBeVisible();
    await expect(page.locator("#pending-schedule-work")).toBeHidden();

    const layout = await page.evaluate(() => {
      const content = document.querySelector(".content-pad");
      if (!(content instanceof HTMLElement)) throw new Error("Missing portal content scroller.");
      return {
        viewport: window.innerWidth,
        documentWidth: document.documentElement.scrollWidth,
        contentWidth: content.scrollWidth,
        overflowing: Array.from(content.querySelectorAll("*"))
          .filter(element => {
            if (!(element instanceof HTMLElement) || element.offsetParent === null) return false;
            const rect = element.getBoundingClientRect();
            return rect.left < -1 || rect.right > window.innerWidth + 1;
          }).length,
      };
    });
    expect(layout.viewport).toBe(320);
    expect(layout.documentWidth).toBe(320);
    expect(layout.contentWidth).toBeLessThanOrEqual(320);
    expect(layout.overflowing).toBe(0);

    // A schedule is an ETA, not an implicit clock-in. Its details use the same field workflow.
    await page.getByText(scheduledId, { exact: true }).locator("../..").getByRole("button", { name: "View details", exact: true }).click();
    await expect(page.getByRole("button", { name: "Show full details", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Start work", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Start work", exact: true }).click();
    const start = page.getByRole("dialog", { name: "Start work", exact: true });
    await expect(start).toBeVisible();
    await start.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(start).toBeHidden();
    await page.getByRole("button", { name: "Back to previous view" }).click();
    await expect(page.getByRole("heading", { name: "My Schedule" })).toBeVisible();
  });

  test("failed ETA save retains the dialog and values without false success", async ({ page }) => {
    await login(page, accounts.companyAdmin);
    await openMobilePage(page, "My Schedule");
    await page.getByRole("button", { name: /Unscheduled/ }).click();
    await page.getByRole("button", { name: "Schedule", exact: true }).first().click();
    const dialog = page.getByRole("dialog", { name: /^Schedule / });
    await page.route("**/rest/v1/rpc/set_work_order_eta_v1", route => route.fulfill({
      status: 409, contentType: "application/json",
      body: JSON.stringify({ code: "PT409", message: "STALE_VERSION", details: null, hint: null }),
    }));
    await dialog.getByRole("button", { name: "Confirm schedule" }).click();
    await expect(dialog.getByRole("alert")).toContainText("changed in another session");
    await expect(dialog).toBeVisible();
    await expectNarrowLayout(page);
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(dialog).toBeHidden();
  });
});
