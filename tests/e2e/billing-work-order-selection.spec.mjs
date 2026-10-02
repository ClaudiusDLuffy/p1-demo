import { accounts, expect, login, openSidebarPage, test, waitForApplicationRequestsToSettle } from "./fixtures.mjs";

async function openInvoice(page, width = 1440) {
  await login(page, accounts.backoffice);
  await openSidebarPage(page, "7-Eleven billing");
  await page.setViewportSize({ width, height: width === 320 ? 568 : 900 });
  await page.getByRole("button", { name: "+ Create Invoice", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Create P1 to 7-Eleven invoice", exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel("Invoice #")).not.toHaveValue("");
  return dialog;
}

for (const width of [1440, 320]) {
  test(`invoice work-order dropdown commits the first selection and subsequent changes at ${width}px`, async ({ page }) => {
    const dialog = await openInvoice(page, width);
    const picker = dialog.locator('button[aria-label="Invoice work order"]');
    const field = dialog.locator('input[name="workOrderId"]');
    await picker.click();
    const options = page.getByRole("listbox").getByRole("option");
    await expect(options.nth(2)).toBeVisible();
    const firstId = (await options.nth(1).innerText()).split(" - Store #")[0].trim();
    const secondId = (await options.nth(2).innerText()).split(" - Store #")[0].trim();
    await options.nth(1).click();
    await expect(field).toHaveValue(firstId);
    await expect(picker).toContainText(firstId);
    await expect(dialog.getByText(`Contractor invoices on ${firstId}`, { exact: true })).toBeVisible();
    await waitForApplicationRequestsToSettle(page);
    await expect(field).toHaveValue(firstId);
    await expect(dialog.getByLabel("Store number", { exact: true })).not.toHaveValue("");

    await picker.click();
    await page.getByRole("option", { name: new RegExp(`^${secondId} - Store #`) }).click();
    await expect(field).toHaveValue(secondId);
    await expect(dialog.getByText(`Contractor invoices on ${secondId}`, { exact: true })).toBeVisible();
    await picker.click();
    await page.getByRole("option", { name: "Standalone invoice", exact: true }).click();
    await expect(field).toHaveValue("");
    await expect(picker).toContainText("Standalone invoice");
    await expect(dialog.getByText(/^Contractor invoices on /)).toHaveCount(0);
  });
}

test("invoice work-order search result sticks after clearing search and loading details", async ({ page }) => {
  const dialog = await openInvoice(page);
  await dialog.getByLabel("Search work order", { exact: true }).fill("E2E-FOCUSED-BILL");
  const matches = dialog.getByRole("listbox", { name: "Matching work orders" });
  await matches.getByRole("option", { name: /^E2E-FOCUSED-BILL / }).click();
  await expect(dialog.locator('input[name="workOrderId"]')).toHaveValue("E2E-FOCUSED-BILL");
  await expect(dialog.getByLabel("Search work order", { exact: true })).toHaveValue("");
  await waitForApplicationRequestsToSettle(page);
  await expect(dialog.locator('button[aria-label="Invoice work order"]')).toContainText("E2E-FOCUSED-BILL");
  await expect(dialog.getByText("Contractor invoices on E2E-FOCUSED-BILL", { exact: true })).toBeVisible();
});

test("a slow work-order detail response cannot undo a later keyboard selection", async ({ page }) => {
  const dialog = await openInvoice(page);
  const picker = dialog.locator('button[aria-label="Invoice work order"]');
  const field = dialog.locator('input[name="workOrderId"]');
  await picker.click();
  const options = page.getByRole("listbox").getByRole("option");
  await expect(options.nth(2)).toBeVisible();
  const firstId = (await options.nth(1).innerText()).split(" - Store #")[0].trim();
  const secondId = (await options.nth(2).innerText()).split(" - Store #")[0].trim();
  let release;
  const held = new Promise(resolve => { release = resolve; });
  let heldCount = 0;
  await page.route("**/rest/v1/rpc/get_portal_work_order", async route => {
    if (route.request().postDataJSON()?.p_work_order_id === firstId) {
      heldCount++;
      await held;
    }
    await route.fallback();
  });
  try {
    await options.nth(1).click();
    await expect.poll(() => heldCount).toBeGreaterThan(0);
    await expect(field).toHaveValue(firstId);
    await expect(picker).toContainText(firstId);
    await expect(dialog.getByRole("button", { name: "Save as Draft", exact: true })).toBeDisabled();
    await picker.click();
    // Its searchable input owns keyboard navigation when there are many rows.
    const keyboardTarget = page.getByRole("combobox", { name: "Search Invoice work order" });
    await keyboardTarget.press("ArrowDown");
    await keyboardTarget.press("Enter");
    await expect(field).toHaveValue(secondId);
    await expect(picker).toContainText(secondId);
  } finally {
    release();
  }
  await waitForApplicationRequestsToSettle(page);
  await expect(field).toHaveValue(secondId);
  await expect(picker).toContainText(secondId);
  await expect(dialog.getByText(`Contractor invoices on ${secondId}`, { exact: true })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Save as Draft", exact: true })).toBeEnabled();
});

test.describe("touch input", () => {
  test.use({ isMobile: true, hasTouch: true });
  test("mobile invoice picker commits a tapped work order", async ({ page }) => {
    const dialog = await openInvoice(page, 320);
    const picker = dialog.locator('button[aria-label="Invoice work order"]');
    await picker.tap();
    const option = page.getByRole("listbox").getByRole("option").nth(1);
    await expect(option).toBeVisible();
    const id = (await option.innerText()).split(" - Store #")[0].trim();
    await option.tap();
    await expect(dialog.locator('input[name="workOrderId"]')).toHaveValue(id);
    await expect(picker).toContainText(id);
    await expect(dialog.getByText(`Contractor invoices on ${id}`, { exact: true })).toBeVisible();
  });
});
