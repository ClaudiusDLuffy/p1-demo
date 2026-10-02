import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { accounts, expect, login, openSidebarPage, openWorkOrder, test, waitForApplicationRequestsToSettle } from "./fixtures.mjs";

// The runner already verifies localhost credentials; this explicitly named
// disposable database contains only synthetic fixtures.
function sql(statement) {
  return execFileSync("docker", ["exec", "-i", "supabase_db_p1-demo-e2e", "psql", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "postgres", "-At"],
    { input: statement, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}
function fixture() {
  const id = `E2E-EXTERNAL-UI-${randomUUID().slice(0,8)}`;
  sql(`insert into public.work_orders(id,status,functional_status,billing_only,store_number,summary)
    values ('${id}','pending_invoice','Completed',true,'E2E001','Synthetic external billing browser test');`);
  return id;
}
async function navigate(page, label) {
  if (page.viewportSize().width > 720) return openSidebarPage(page, label);
  await page.getByRole("button", { name: "Open menu", exact: true }).click();
  await page.getByRole("dialog", { name: "Navigation menu" }).getByRole("button", { name: label, exact: true }).click();
}
async function openForm(page, id) {
  await navigate(page, "7-Eleven billing");
  await page.getByRole("searchbox", { name: "Search billing invoices and work orders" }).fill(id);
  const row = page.locator(".billing-ready-row").filter({ hasText: id });
  await expect(row).toBeVisible();
  const action = row.getByRole("button", { name: "Billed outside the portal", exact: true });
  const bounds = await action.boundingBox();
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(page.viewportSize().width);
  if (page.viewportSize().width === 320) await action.tap();
  else await action.click();
  const dialog = page.getByRole("dialog", { name: "Billed outside the portal", exact: true });
  await expect(dialog.getByRole("button", { name: "Record external billing and close" })).toBeEnabled();
  return dialog;
}
async function fillForm(dialog) {
  await dialog.getByLabel("Invoice reference (required)").fill("SYNTHETIC-SHARED-10000");
  await dialog.getByLabel("Billing date (required)").fill("2026-01-01");
  await dialog.getByLabel("Audit note (required)").fill("Synthetic invoice covers two separate work orders.");
}
async function verifyNoDuplicate(id) {
  const result = JSON.parse(sql(`select jsonb_build_object('status',status,'functionalStatus',functional_status,
    'records',(select count(*) from public.work_order_external_billings where work_order_id='${id}'),
    'invoices',(select count(*) from public.invoices where work_order_id='${id}'),
    'events',(select count(*) from public.activities where work_order_id='${id}' and event_key='work_order_billed_externally'))
    from public.work_orders where id='${id}';`));
  expect(result).toEqual({ status: "closed", functionalStatus: "Completed", records: 1, invoices: 0, events: 1 });
}
for (const width of [1440, 320]) {
  test.describe(`${width}px external billing`, () => {
  if (width === 320) test.use({ isMobile: true, hasTouch: true });
  test(`external billing validates, records a shared reference, clears the queue and retains history at ${width}px`, async ({ page }, testInfo) => {
    const first = fixture(); const second = fixture();
    await page.setViewportSize({ width, height: width === 320 ? 568 : 1000 });
    await login(page, accounts.backoffice);
    let dialog = await openForm(page, first);
    await dialog.getByRole("button", { name: "Record external billing and close" }).click();
    await expect(dialog.getByRole("alert")).toContainText("Enter the billing system");
    await fillForm(dialog);
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await page.getByRole("dialog", { name: "Unsaved changes", exact: true }).getByRole("button", { name: "Keep editing" }).click();
    await expect(dialog.getByLabel("Invoice reference (required)")).toHaveValue("SYNTHETIC-SHARED-10000");
    const layout = await dialog.locator(".modal-inner").evaluate(el => ({ content: el.scrollWidth, width: el.clientWidth, right: el.getBoundingClientRect().right }));
    expect(layout.content).toBeLessThanOrEqual(layout.width + 1);
    expect(layout.right).toBeLessThanOrEqual(width + 1);
    await page.screenshot({ path: testInfo.outputPath(`external-billing-${width}.png`) });
    await dialog.getByRole("button", { name: "Record external billing and close" }).click();
    await expect(dialog.getByRole("status")).toContainText("This work order is closed");
    await dialog.getByRole("button", { name: "Done", exact: true }).click();
    await expect(page.locator(".billing-ready-row").filter({ hasText: first })).toHaveCount(0);
    await verifyNoDuplicate(first);
    dialog = await openForm(page, second);
    await fillForm(dialog);
    await dialog.getByRole("button", { name: "Record external billing and close" }).click();
    await expect(dialog.getByRole("status")).toContainText("This work order is closed");
    await dialog.getByRole("button", { name: "Done", exact: true }).click();
    await verifyNoDuplicate(second);
    await navigate(page, "Work orders");
    if (width === 320) {
      await page.locator('input[placeholder^="Search WO#"]:visible').fill(first);
      const hideClosed = page.getByRole("checkbox", { name: "Hide closed calls" });
      if (await hideClosed.isChecked()) await hideClosed.uncheck();
      await page.locator(".mobile-card:visible, .card-hover:visible").filter({ has: page.getByText(first, { exact: true }) }).first().click();
    } else await openWorkOrder(page, first);
    const history = page.getByRole("region", { name: "External billing", exact: true });
    await expect(history).toContainText("Invoice #SYNTHETIC-SHARED-10000");
    await expect(history.getByRole("button", { name: "Billed outside the portal", exact: true })).toHaveCount(0);
    await waitForApplicationRequestsToSettle(page);
  });
  });
}

test("a lost successful response retries the same operation without another closure", async ({ page }) => {
  const id = fixture();
  await login(page, accounts.manager);
  const dialog = await openForm(page, id);
  await fillForm(dialog);
  const calls = [];
  await page.route("**/rest/v1/rpc/record_work_order_external_billing_v1", async route => {
    calls.push(route.request().postDataJSON());
    const response = await route.fetch();
    expect(response.ok()).toBe(true);
    if (calls.length === 1) await route.fulfill({ status: 200, contentType: "application/json", body: "null" });
    else await route.fulfill({ response });
  });
  await dialog.getByRole("button", { name: "Record external billing and close" }).click();
  await expect(dialog.getByRole("alert")).toContainText("could not be confirmed");
  await expect(dialog.getByLabel("Invoice reference (required)")).toBeDisabled();
  await dialog.getByRole("button", { name: "Retry same request" }).click();
  await expect(dialog.getByRole("status")).toContainText("This work order is closed");
  expect(calls).toHaveLength(2); expect(calls[1]).toEqual(calls[0]);
  await verifyNoDuplicate(id);
  await waitForApplicationRequestsToSettle(page);
});

test("stale version cannot close work", async ({ page }) => {
  const id = fixture();
  await login(page, accounts.manager);
  const dialog = await openForm(page, id);
  await fillForm(dialog);
  sql(`update public.work_orders set functional_status='Awaiting Parts' where id='${id}';`);
  await dialog.getByRole("button", { name: "Record external billing and close" }).click();
  await expect(dialog.getByRole("alert")).toContainText("This work order changed");
  expect(sql(`select count(*) from public.work_order_external_billings where work_order_id='${id}'`)).toBe("0");
  await waitForApplicationRequestsToSettle(page);
});

test("contractors cannot see external billing details or actions", async ({ page }) => {
  await login(page, accounts.direct);
  await openWorkOrder(page, "E2E-DIRECT-INVOICE");
  await expect(page.getByRole("region", { name: "External billing", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Billed outside the portal", exact: true })).toHaveCount(0);
  await waitForApplicationRequestsToSettle(page);
});

test("unsent field updates block closure without marking anything submitted", async ({ page }) => {
  const id = fixture();
  sql(`insert into public.activities(work_order_id,author_id,author_name,text,type,event_key,activity_channel)
    select '${id}',id,name,'Synthetic pending field note','note','note','field_note'
    from public.profiles where email='e2e.manager@p1.invalid';`);
  await login(page, accounts.manager);
  const dialog = await openForm(page, id);
  await fillForm(dialog);
  await dialog.getByRole("button", { name: "Record external billing and close" }).click();
  await expect(dialog.getByRole("alert")).toContainText("Complete pending 7-Eleven updates");
  expect(sql(`select status from public.work_orders where id='${id}'`)).toBe("pending_invoice");
  expect(sql(`select count(*) from public.activities where work_order_id='${id}' and requires_7eleven_sync and synced_to_7eleven_at is null`)).toBe("1");
  expect(sql(`select count(*) from public.work_order_external_billings where work_order_id='${id}'`)).toBe("0");
  await waitForApplicationRequestsToSettle(page);
});

test("pending save blocks dismissal and duplicate submission", async ({ page }) => {
  const id = fixture();
  await login(page, accounts.manager);
  const dialog = await openForm(page, id);
  await fillForm(dialog);
  let release; let requests = 0;
  const held = new Promise(resolve => { release = resolve; });
  await page.route("**/rest/v1/rpc/record_work_order_external_billing_v1", async route => {
    requests++;
    await held;
    await route.fallback();
  });
  try {
    await dialog.getByRole("button", { name: "Record external billing and close" }).click();
    await expect.poll(() => requests).toBe(1);
    await expect(dialog.getByRole("button", { name: "Recording…" })).toBeDisabled();
    await expect(dialog.getByRole("button", { name: "Cancel", exact: true })).toBeDisabled();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeVisible();
  } finally { release(); }
  await expect(dialog.getByRole("status")).toContainText("This work order is closed");
  expect(requests).toBe(1);
  await verifyNoDuplicate(id);
  await waitForApplicationRequestsToSettle(page);
});
