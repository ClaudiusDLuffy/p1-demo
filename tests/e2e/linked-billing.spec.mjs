import { accounts, expect, login, openSidebarPage, openWorkOrder, test, waitForApplicationRequestsToSettle } from "./fixtures.mjs";
import { linkedBillingFixture as fixture, linkedBillingSql as sql, linkedBillingCounts as counts } from "../../scripts/e2e/linked-billing-test-support.mjs";

async function navigate(page, label) {
  if (page.viewportSize().width > 720) return openSidebarPage(page, label);
  await page.getByRole("button", { name: "Open menu", exact: true }).click();
  await page.getByRole("dialog", { name: "Navigation menu" }).getByRole("button", { name: label, exact: true }).click();
}
async function openForm(page, source) {
  await navigate(page, "7-Eleven billing");
  await page.getByRole("searchbox", { name: "Search billing invoices and work orders" }).fill(source);
  const row = page.locator(".billing-ready-row").filter({ hasText: source });
  const button = row.getByRole("button", { name: "Billed under another work order", exact: true });
  await expect(button).toBeVisible();
  if (page.viewportSize().width === 320) await button.tap(); else await button.click();
  const dialog = page.getByRole("dialog", { name: "Billed under another work order", exact: true });
  await expect(dialog.getByRole("button", { name: "Link invoice and close" })).toBeEnabled(); return dialog;
}
async function selectInvoice(dialog, f) {
  await dialog.getByLabel("Billing work order number (required)").fill(f.target);
  await dialog.getByRole("button", { name: "Find submitted invoices" }).click();
  await dialog.getByRole("radio", { name: new RegExp(f.number) }).check();
}
async function fill(dialog, f) {
  await selectInvoice(dialog, f);
  await dialog.getByLabel("Audit note (required)").fill("Synthetic submitted invoice covers both work orders.");
  await dialog.getByRole("checkbox").check();
}
async function details(page, id) {
  await navigate(page, "Work orders");
  if (page.viewportSize().width > 720) return openWorkOrder(page, id);
  await page.locator('input[placeholder^="Search WO#"]:visible').fill(id);
  const hideClosed = page.getByRole("checkbox", { name: "Hide closed calls" });
  if (await hideClosed.isChecked()) await hideClosed.uncheck();
  await page.locator(".mobile-card:visible, .card-hover:visible").filter({ has: page.getByText(id, { exact: true }) }).first().click();
}
for (const width of [1440, 320]) {
  test.describe(`${width}px linked billing`, () => {
    if (width === 320) test.use({ isMobile: true, hasTouch: true });
    test("validates coverage, closes without duplicate invoices and links both histories", async ({ page }, testInfo) => {
      const f = fixture(); await page.setViewportSize({ width, height: width === 320 ? 568 : 1000 });
      await login(page, accounts.backoffice); const dialog = await openForm(page, f.source);
      await dialog.getByRole("button", { name: "Link invoice and close" }).click();
      await expect(dialog.getByRole("alert")).toContainText("Select a submitted invoice");
      await fill(dialog, f);
      await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
      await page.getByRole("dialog", { name: "Unsaved changes" }).getByRole("button", { name: "Keep editing" }).click();
      const bounds = await dialog.locator(".modal-inner").evaluate(el => ({ right: el.getBoundingClientRect().right, width: el.clientWidth, content: el.scrollWidth }));
      expect(bounds.content).toBeLessThanOrEqual(bounds.width + 1); expect(bounds.right).toBeLessThanOrEqual(width + 1);
      await page.screenshot({ path: testInfo.outputPath(`linked-billing-${width}.png`) });
      await dialog.getByRole("button", { name: "Link invoice and close" }).click();
      await expect(dialog.getByRole("status")).toContainText("This work order is closed");
      await dialog.getByRole("button", { name: "Done", exact: true }).click();
      await expect(page.locator(".billing-ready-row").filter({ hasText: f.source })).toHaveCount(0);
      expect(counts(f.source)).toEqual({ status: "closed", functionalStatus: "Completed", links: 1, invoices: 0, events: 2 });
      await details(page, f.source);
      const history = page.getByRole("region", { name: "Linked billing", exact: true });
      await expect(history).toContainText(f.number);
      await history.getByRole("button", { name: `View ${f.target}`, exact: true }).click();
      await expect(history).toContainText("Invoice covers another work order");
      await history.getByRole("button", { name: `View ${f.source}`, exact: true }).click();
      await expect(history).toContainText("Billed under another work order");
      await waitForApplicationRequestsToSettle(page);
    });
  });
}
test("Awaiting Parts explains why closure is unavailable", async ({ page }) => {
  const f = fixture(); sql(`update public.work_orders set status='parts',functional_status='Awaiting Parts',billing_only=false where id='${f.source}';`);
  await login(page, accounts.manager); await details(page, f.source);
  await expect(page.getByText(/Billing closure is unavailable while this work order is Awaiting Parts/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Billed under another work order", exact: true })).toHaveCount(0);
  await waitForApplicationRequestsToSettle(page);
});
test("changing destination clears selection and draft invoices are excluded", async ({ page }) => {
  const f = fixture(); const draft = fixture(); sql(`update public.invoices set state='draft' where id='${draft.invoice}';`);
  await login(page, accounts.manager); const dialog = await openForm(page, f.source); await fill(dialog, f);
  await dialog.getByLabel("Billing work order number (required)").fill(draft.target);
  await expect(dialog.getByRole("checkbox")).not.toBeChecked();
  await expect(dialog.getByRole("checkbox")).toBeDisabled();
  await dialog.getByRole("button", { name: "Find submitted invoices" }).click();
  await expect(dialog.getByText(/No eligible submitted P1 invoices found/)).toBeVisible();
  await expect(dialog.getByRole("radio")).toHaveCount(0);
  await dialog.getByRole("button", { name: "Link invoice and close" }).click();
  await expect(dialog.getByRole("alert")).toContainText("Select a submitted invoice");
  expect(counts(f.source).links).toBe(0); await waitForApplicationRequestsToSettle(page);
});
test("lost committed response retries the frozen request once without duplicating history", async ({ page }) => {
  const f = fixture(); await login(page, accounts.manager); const dialog = await openForm(page, f.source); await fill(dialog, f);
  const calls = [];
  await page.route("**/rest/v1/rpc/record_work_order_linked_billing_v1", async route => {
    calls.push(route.request().postDataJSON()); const response = await route.fetch(); expect(response.ok()).toBe(true);
    if (calls.length === 1) await route.fulfill({ status: 200, contentType: "application/json", body: "null" });
    else await route.fulfill({ response });
  });
  await dialog.getByRole("button", { name: "Link invoice and close" }).click();
  await expect(dialog.getByRole("alert")).toContainText("could not be confirmed");
  await expect(dialog.getByLabel("Audit note (required)")).toBeDisabled();
  await dialog.getByRole("button", { name: "Retry same request" }).click();
  await expect(dialog.getByRole("status")).toContainText("This work order is closed");
  expect(calls).toHaveLength(2); expect(calls[1]).toEqual(calls[0]); expect(counts(f.source).events).toBe(2);
  await waitForApplicationRequestsToSettle(page);
});
test("invoice changed since selection blocks the close", async ({ page }) => {
  const f = fixture(); await login(page, accounts.manager); const dialog = await openForm(page, f.source); await fill(dialog, f);
  // Owner-only fixture writes intentionally bypass normal command versioning;
  // emulate the version increment that a real invoice command performs.
  sql(`update public.invoices set total=125,invoice_version=invoice_version+1 where id='${f.invoice}';`);
  await dialog.getByRole("button", { name: "Link invoice and close" }).click();
  await expect(dialog.getByRole("alert")).toContainText("work order or invoice changed");
  expect(counts(f.source).links).toBe(0); await waitForApplicationRequestsToSettle(page);
});
test("pending save blocks double submission and dismissal", async ({ page }) => {
  const f = fixture(); await login(page, accounts.manager); const dialog = await openForm(page, f.source); await fill(dialog, f);
  let release; let calls = 0; const held = new Promise(resolve => { release = resolve; });
  await page.route("**/rest/v1/rpc/record_work_order_linked_billing_v1", async route => { calls++; await held; await route.fallback(); });
  try {
    await dialog.getByRole("button", { name: "Link invoice and close" }).click();
    await expect.poll(() => calls).toBe(1);
    await expect(dialog.getByRole("button", { name: "Recording…" })).toBeDisabled();
    await expect(dialog.getByRole("button", { name: "Cancel", exact: true })).toBeDisabled();
    await page.keyboard.press("Escape"); await expect(dialog).toBeVisible();
  } finally { release(); }
  await expect(dialog.getByRole("status")).toContainText("This work order is closed");
  expect(calls).toBe(1); await waitForApplicationRequestsToSettle(page);
});
test("contractor view contains no linked billing controls or staff history", async ({ page }) => {
  await login(page, accounts.direct); await openWorkOrder(page, "E2E-DIRECT-INVOICE");
  await expect(page.getByRole("region", { name: "Linked billing", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Billed under another work order", exact: true })).toHaveCount(0);
  await waitForApplicationRequestsToSettle(page);
});
