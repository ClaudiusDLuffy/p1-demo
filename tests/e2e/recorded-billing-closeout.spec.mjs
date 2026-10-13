import { accounts, expect, login, openSidebarPage, test, waitForApplicationRequestsToSettle } from './fixtures.mjs';
import { reportedInvoiceFixture, reportedInvoiceSnapshot } from '../../scripts/e2e/reported-invoice-fixtures.mjs';
import { linkedBillingSql as sql } from '../../scripts/e2e/linked-billing-test-support.mjs';

test.beforeEach(async ({ context }) => {
  await context.route('**/*', async route => {
    if (['localhost', '127.0.0.1', '[::1]'].includes(new URL(route.request().url()).hostname)) await route.continue();
    else await route.abort('blockedbyclient');
  });
});
async function open(page, f) {
  await openSidebarPage(page, 'Simplified');
  await page.getByPlaceholder('Search WO, store, city, keyword…').fill(f.work);
  await page.getByRole('button', { name: `Open ${f.work}`, exact: true }).click();
  await page.getByRole('button', { name: 'Close out', exact: true }).click();
  return page.getByRole('dialog', { name: 'Close out work order', exact: true });
}
async function form(page, f) {
  const choose = await open(page, f);
  await expect(choose.getByRole('button', { name: 'Already billed, close work order', exact: true })).toBeEnabled();
  await choose.getByRole('button', { name: 'Already billed, close work order', exact: true }).click();
  return page.getByRole('dialog', { name: 'Close already billed work order', exact: true });
}
function unchangedBilling(f, before) {
  const after = reportedInvoiceSnapshot(f);
  expect(after.invoices).toEqual(before.invoices); expect(after.billedEvents).toBe(1);
  expect(after.externalBillings).toBe(0); expect(after.links).toBe(0);
  expect(sql(`select count(*) from public.activities where work_order_id='${f.work}' and event_key='work_order_billing_closeout_reconciled'`)).toBe('1');
  return after;
}

for (const actor of [accounts.manager, accounts.dispatcher, accounts.backoffice]) {
  test(`${actor.name}: confirm and close the exact already-billed replica without new billing or exports`, async ({ page }, testInfo) => {
    const f = reportedInvoiceFixture('regular_billed_still_open'); const before = reportedInvoiceSnapshot(f); const downloads = [];
    page.on('download', d => downloads.push(d.suggestedFilename()));
    await login(page, actor); const dialog = await form(page, f);
    await expect(dialog).toContainText(f.staffNumber);
    await dialog.getByRole('button', { name: 'Confirm already billed and close', exact: true }).click();
    await expect(dialog.getByRole('alert')).toContainText('Confirm that the job is finished');
    expect(reportedInvoiceSnapshot(f).status).toBe('pending_invoice');
    await dialog.getByRole('checkbox').check();
    await dialog.getByRole('button', { name: 'Confirm already billed and close', exact: true }).click();
    await expect(dialog.getByRole('status')).toContainText('Work order closed using the existing recorded billing');
    await page.screenshot({ path: testInfo.outputPath('already-billed-closed.png') });
    const after = unchangedBilling(f, before); expect(after.status).toBe('closed'); expect(after.functionalStatus).toBe('Completed');
    expect(downloads).toHaveLength(0);
    await dialog.getByRole('button', { name: 'Done', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Close out', exact: true })).toHaveCount(0);
    await waitForApplicationRequestsToSettle(page);
  });
}

test('lost successful response retries the identical frozen request and records one reconciliation', async ({ page }) => {
  const f = reportedInvoiceFixture('regular_billed_still_open'); const before = reportedInvoiceSnapshot(f);
  await login(page, accounts.manager); const dialog = await form(page, f); const calls = [];
  await page.route('**/rest/v1/rpc/reconcile_recorded_billing_closeout_v1', async route => {
    calls.push(route.request().postDataJSON()); const response = await route.fetch(); expect(response.ok()).toBe(true);
    if (calls.length === 1) await route.fulfill({ status: 200, contentType: 'application/json', body: 'null' });
    else await route.fulfill({ response });
  });
  await dialog.getByRole('checkbox').check(); await dialog.getByRole('button', { name: 'Confirm already billed and close', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('could not be verified');
  await expect(dialog.getByRole('checkbox')).toBeDisabled();
  await dialog.getByRole('button', { name: 'Retry same request', exact: true }).click();
  await expect(dialog.getByRole('status')).toContainText('Work order closed');
  expect(calls).toHaveLength(2); expect(calls[0]).toEqual(calls[1]); unchangedBilling(f, before);
  await waitForApplicationRequestsToSettle(page);
});

test('invoice changed after evidence capture blocks closure and does not silently refresh the confirmation', async ({ page }) => {
  const f = reportedInvoiceFixture('regular_billed_still_open'); await login(page, accounts.manager); const dialog = await form(page, f);
  await dialog.getByRole('checkbox').check();
  sql(`update public.invoices set invoice_version=invoice_version+1 where id='${f.staffInvoice}'`);
  await dialog.getByRole('button', { name: 'Confirm already billed and close', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('This record changed');
  expect(reportedInvoiceSnapshot(f).status).toBe('pending_invoice');
  expect(sql(`select count(*) from public.activities where work_order_id='${f.work}' and event_key='work_order_billing_closeout_reconciled'`)).toBe('0');
  await waitForApplicationRequestsToSettle(page);
});

test('new pending update after evidence capture blocks the command without creating closure evidence', async ({ page }) => {
  const f = reportedInvoiceFixture('regular_billed_still_open'); await login(page, accounts.manager); const dialog = await form(page, f);
  await dialog.getByRole('checkbox').check();
  sql(`insert into public.activities(work_order_id,author_id,author_name,text,type,event_key,activity_channel)
    select '${f.work}',id,'Synthetic staff','Synthetic later update','note','note','field_note'
    from public.profiles where email='e2e.manager@p1.invalid'`);
  expect(sql(`select count(*) from public.activities where work_order_id='${f.work}' and requires_7eleven_sync and synced_to_7eleven_at is null`)).toBe('1');
  await dialog.getByRole('button', { name: 'Confirm already billed and close', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('pending 7-Eleven updates');
  expect(reportedInvoiceSnapshot(f).status).toBe('pending_invoice');
  await waitForApplicationRequestsToSettle(page);
});

test('pending save blocks double submission, cancellation and escape', async ({ page }) => {
  const f = reportedInvoiceFixture('regular_billed_still_open'); await login(page, accounts.manager); const dialog = await form(page, f);
  let release; let calls = 0; const held = new Promise(resolve => { release = resolve; });
  await page.route('**/rest/v1/rpc/reconcile_recorded_billing_closeout_v1', async route => { calls++; await held; await route.fallback(); });
  try {
    await dialog.getByRole('checkbox').check(); await dialog.getByRole('button', { name: 'Confirm already billed and close', exact: true }).click();
    await expect.poll(() => calls).toBe(1);
    await expect(dialog.getByRole('button', { name: 'Closing…', exact: true })).toBeDisabled();
    await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeDisabled();
    await page.keyboard.press('Escape'); await expect(dialog).toBeVisible();
  } finally { release(); }
  await expect(dialog.getByRole('status')).toContainText('Work order closed'); expect(calls).toBe(1);
  await waitForApplicationRequestsToSettle(page);
});

test('approved invoice without a billing handoff does not acquire the new closeout option', async ({ page }) => {
  const f = reportedInvoiceFixture('regular_billed_still_open');
  sql(`update public.activities set event_data=jsonb_set(event_data,'{action}','"created"')
    where work_order_id='${f.work}' and event_data->>'action'='billed_to_7_eleven'`);
  await login(page, accounts.manager); const choose = await open(page, f);
  await expect(choose.getByText('Checking existing recorded billing…', { exact: true })).toBeHidden();
  await expect(choose.getByRole('button', { name: 'Already billed, close work order', exact: true })).toHaveCount(0);
  await expect(choose.getByRole('button', { name: 'Billed outside the portal', exact: true })).toBeDisabled();
  await waitForApplicationRequestsToSettle(page);
});

test('the guarded already-billed confirmation fits a 320px viewport', async ({ page }, testInfo) => {
  const f = reportedInvoiceFixture('regular_billed_still_open'); await login(page, accounts.manager); const dialog = await form(page, f);
  await page.setViewportSize({ width: 320, height: 720 });
  const bounds = await dialog.locator('.modal-inner').evaluate(el => ({ width: el.clientWidth, content: el.scrollWidth, right: el.getBoundingClientRect().right }));
  expect(bounds.content).toBeLessThanOrEqual(bounds.width + 1); expect(bounds.right).toBeLessThanOrEqual(321);
  await page.screenshot({ path: testInfo.outputPath('recorded-billing-320.png') });
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(dialog).toBeHidden();
  await waitForApplicationRequestsToSettle(page);
});
