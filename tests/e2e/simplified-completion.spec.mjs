import { accounts, expect, login, openSidebarPage, test, waitForApplicationRequestsToSettle } from "./fixtures.mjs";

async function openFocusedJob(page, id) {
  await page.getByPlaceholder("Search WO, store, city, keyword…").fill(id);
  await page.getByRole("button", { name: `Open ${id}`, exact: true }).click();
  await expect(page.getByRole("button", { name: "Show full details" })).toBeVisible();
}

test("simplified filters query capital stages and closed history without loading unrelated pages", async ({ page }) => {
  await login(page, accounts.manager);
  await openSidebarPage(page, "Simplified");
  const filters = page.getByRole("navigation", { name: "Work filters" });
  await filters.getByRole("button", { name: "Capital", exact: true }).click();
  await page.getByLabel("Capital status", { exact: true }).selectOption("capital_equipment_ordered");
  await expect(page.getByRole("button", { name: "Open E2E-CAPITAL-BOARD-ORDERED", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Open E2E-CAPITAL-BOARD-SUBMITTED", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Open E2E-CAPITAL-BOARD-ORDERED", exact: true }).click();
  await expect(page.getByText("Equipment ordered — waiting for equipment", { exact: true }).first()).toBeVisible();
  await page.getByRole("button", { name: "Back to previous view" }).click();
  await filters.getByRole("button", { name: "Closed", exact: true }).click();
  await openFocusedJob(page, "E2E-CLOSED-REOPEN");
  await expect(page.getByRole("button", { name: "Reopen work order", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Start work", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Back to previous view" }).click();
  await filters.getByRole("button", { name: "Open", exact: true }).click();
  await page.getByPlaceholder("Search WO, store, city, keyword…").fill("");
  await page.getByLabel("Work status", { exact: true }).selectOption("parts");
  await waitForApplicationRequestsToSettle(page);
  const rows = page.locator("article");
  expect(await rows.count()).toBeGreaterThan(0);
  for (const row of await rows.all()) await expect(row).toContainText("Awaiting Parts");
  await filters.getByRole("button", { name: "Breached", exact: true }).click();
  await waitForApplicationRequestsToSettle(page);
  await expect(page.getByRole("button", { name: "Breached", exact: true })).toHaveAttribute("aria-pressed", "true");
});

test("focused details preserve shared actions, attachment entry, drafts and full-view access", async ({ page }) => {
  await login(page, accounts.manager);
  await openSidebarPage(page, "Simplified");
  await openFocusedJob(page, "E2E-CAPITAL-DECLINE");
  await expect(page.getByText("SLA countdown", { exact: true })).toBeHidden();
  const capital = page.getByRole("region", { name: "Capital actions", exact: true });
  await expect(capital.getByRole("button", { name: "Capital declined - restore field workflow", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Attachments", exact: true }).click();
  await expect(page.locator("#work-order-attachments")).toBeFocused();
  await expect(page.getByText("Choose photos", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Invoice / estimate documents", exact: true }).click();
  await expect(page.locator("#work-order-documents")).toHaveAttribute("open", "");
  const note = page.getByPlaceholder("Enter the service or job update that must be copied to 7-Eleven...");
  await note.fill("Synthetic unsaved focused-view note");
  await page.getByRole("button", { name: "Show full details" }).click();
  await expect(page.getByText("SLA countdown", { exact: true })).toBeVisible();
  await expect(note).toHaveValue("Synthetic unsaved focused-view note");
  await page.getByRole("button", { name: "Show simplified details" }).click();
  await expect(note).toHaveValue("Synthetic unsaved focused-view note");
  await note.clear();
});

test("simplified invoice entry displays one queue without the repeated All list", async ({ page }) => {
  await login(page, accounts.manager);
  await openSidebarPage(page, "Simplified");
  await page.getByRole("navigation", { name: "Work filters" }).getByRole("button", { name: "Invoices", exact: true }).click();
  const queues = page.getByRole("navigation", { name: "Invoice queues" });
  await expect(queues).toBeVisible();
  await expect(page.locator("#billing-bucket-all")).toHaveCount(0);
  await expect(page.locator("#billing-bucket-submitted")).toBeVisible();
  await page.locator('button[aria-controls="billing-bucket-submitted"]').click();
  await expect(page.locator("#billing-bucket-submitted")).toBeHidden();
  await page.locator('button[aria-controls="billing-bucket-submitted"]').click();
  await expect(page.locator("#billing-bucket-submitted")).toBeVisible();
  await queues.getByRole("button", { name: "Sent to 7-Eleven", exact: true }).click();
  await expect(page.locator("#billing-bucket-submitted")).toHaveCount(0);
  await expect(page.locator("#billing-bucket-sent")).toBeVisible();
  await queues.getByRole("button", { name: "Drafts", exact: true }).click();
  await expect(page.getByText("#P1-E2E-EDIT-001", { exact: true }).first()).toBeVisible();
  await page.getByRole("button", { name: "Back to simplified work", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Work, made simple" })).toBeVisible();
});

test.describe("focused details at 320x568", () => {
  test.use({ viewport: { width: 320, height: 568 }, screen: { width: 320, height: 568 }, isMobile: true, hasTouch: true });
  test("mobile attachments and detail disclosures remain reachable without horizontal scroll", async ({ page }, testInfo) => {
    await login(page, accounts.manager);
    await page.getByRole("button", { name: "Open menu", exact: true }).click();
    await page.getByRole("dialog", { name: "Navigation menu" }).getByRole("button", { name: "Simplified", exact: true }).click();
    await openFocusedJob(page, "E2E-STAFF-CAPITAL");
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBe(320);
    await page.getByRole("button", { name: "Attachments", exact: true }).tap();
    await expect(page.locator("#work-order-attachments")).toBeFocused();
    await page.getByText("Completion record and visit corrections", { exact: true }).click();
    await expect.poll(() => page.locator(".content-pad").evaluate(el => el.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("focused-mobile.png") });
  });
});
