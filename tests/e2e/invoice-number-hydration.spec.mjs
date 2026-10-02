import { accounts, expect, login, openSidebarPage, openWorkOrder, test } from "./fixtures.mjs";

const forms = [
  { name: "contractor", route: "**/rest/v1/rpc/next_contractor_invoice_num", responsePath: "/rest/v1/rpc/next_contractor_invoice_num",
    account: accounts.direct, button: "Create or upload invoice", dialog: "Create invoice", preview: /^\d+$/ },
  { name: "staff billing", route: "**/api/billing-invoices?nextNumber=1", responsePath: "/api/billing-invoices",
    account: accounts.backoffice, button: "+ Create Invoice", dialog: "Create P1 to 7-Eleven invoice", preview: /^P1-/ },
];

async function prepare(page, form, width) {
  await login(page, form.account);
  if (form.name === "contractor") await openWorkOrder(page, "E2E-MOBILE-INVOICE");
  else await openSidebarPage(page, "7-Eleven billing");
  await page.setViewportSize({ width, height: width === 320 ? 568 : 900 });
}

for (const form of forms) for (const width of [1440, 320]) {
  test(`${form.name}: typing into a focused pending number replaces the arriving suggestion at ${width}px`, async ({ page }) => {
    await prepare(page, form, width);
    let release;
    const held = new Promise(resolve => { release = resolve; });
    let intercepted = false;
    await page.route(form.route, async route => {
      const response = await route.fetch();
      const status = response.status();
      const headers = response.headers();
      const body = await response.body();
      intercepted = true;
      await held;
      await route.fulfill({ status, headers, body });
    });
    try {
      await page.getByRole("button", { name: form.button, exact: true }).click();
      const input = page.getByRole("dialog", { name: form.dialog, exact: true }).getByLabel("Invoice #");
      await expect.poll(() => intercepted).toBe(true);
      await expect(input).toHaveValue("");
      await input.focus();
      release();
      await expect(input).toHaveValue(form.preview);
      await expect(input).toBeFocused();
      await input.pressSequentially("AUDIT-REPLACE-456");
      await expect(input).toHaveValue("AUDIT-REPLACE-456");
    } finally { release(); }
  });

  test(`${form.name}: late invoice-number hydration preserves a manually entered number at ${width}px`, async ({ page }) => {
    await prepare(page, form, width);
    let release;
    let intercepted = false;
    const held = new Promise(resolve => { release = resolve; });
    await page.route(form.route, async route => {
      const response = await route.fetch();
      const status = response.status();
      const headers = response.headers();
      const body = await response.body();
      intercepted = true;
      await held;
      await route.fulfill({ status, headers, body });
    });
    try {
      await page.getByRole("button", { name: form.button, exact: true }).click();
      const dialog = page.getByRole("dialog", { name: form.dialog, exact: true });
      const number = dialog.getByLabel("Invoice #");
      await expect.poll(() => intercepted).toBe(true);
      await expect(number).toHaveValue("");
      // Narrow the timing boundary without asserting that merely focusing
      // an untouched field must suppress its expected number suggestion.
      await number.fill("AUDIT-MANUAL-123");
      await expect(number).toHaveValue("AUDIT-MANUAL-123");
      const response = page.waitForResponse(value => value.request().url().includes(form.responsePath)
        && (form.name === "contractor" || new URL(value.url()).searchParams.has("nextNumber")));
      release();
      expect((await response).ok()).toBe(true);
      await page.waitForLoadState("networkidle");
      await expect(number).toHaveValue("AUDIT-MANUAL-123");
      // This regression does not submit or save an invoice.
    } finally {
      release();
    }
  });
}
