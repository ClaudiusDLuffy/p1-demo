import { jsPDF } from 'jspdf';
import { randomUUID } from 'node:crypto';
import { accounts, expect, login, openSidebarPage, openWorkOrder, test } from './fixtures.mjs';
import { priorInvoiceFixture, quotePrior as q } from '../../scripts/e2e/prior-contractor-invoice-fixtures.mjs';
import { linkedBillingSql as sql } from '../../scripts/e2e/linked-billing-test-support.mjs';

test.beforeEach(async ({ context }) => {
  await context.route('**/*', async route => {
    try {
      await (['localhost', '127.0.0.1', '[::1]'].includes(new URL(route.request().url()).hostname)
        ? route.continue() : route.abort('blockedbyclient'));
    } catch (error) {
      // The shared fixture drains page routes during teardown. A request
      // already handled by that drain must not fail this context's fallback.
      if (!String(error).includes('Route is already handled!')) throw new Error('Local request routing failed');
    }
  });
});
async function openPrior(page, f, actor = accounts.manager) {
  await login(page, actor);
  if (page.viewportSize().width <= 720) {
    await page.getByRole('button', { name: 'Open menu', exact: true }).click();
    await page.getByRole('dialog', { name: 'Navigation menu', exact: true }).getByRole('button', { name: 'Work orders', exact: true }).click();
  } else await openSidebarPage(page, 'Work orders');
  if (page.viewportSize().width <= 720) {
    await page.getByPlaceholder('Search WO#, INC#, store, keyword...').fill(f.work);
    const hideClosed = page.getByRole('checkbox', { name: 'Hide closed calls' });
    if (await hideClosed.isChecked()) await hideClosed.uncheck();
    const row = page.locator('.mobile-card:visible, .card-hover:visible, tr:visible')
      .filter({ has: page.getByText(f.work, { exact: true }) }).first();
    await expect(row).toBeVisible(); await row.click();
    await expect(page.locator('.work-order-reference').filter({ hasText: f.work }).first()).toBeVisible();
  } else await openWorkOrder(page, f.work);
  const disclosure = page.getByRole('button', { name: /Invoices, estimates and documents/ });
  if (await disclosure.isVisible().catch(() => false)) await disclosure.click();
  const panel = page.getByRole('region', { name: 'Previous contractor invoices', exact: true });
  await expect(panel).toBeVisible();
  await panel.getByRole('button', { name: 'Upload previous contractor invoice', exact: true }).click();
  return page.getByRole('dialog', { name: 'Upload previous contractor invoice', exact: true });
}
async function fill(dialog, f, { file = true, number = `SYNTHETIC-PRIOR-${randomUUID().slice(0, 8)}` } = {}) {
  await dialog.getByLabel('Previous contractor assignment', { exact: true }).selectOption(f.history);
  await dialog.getByLabel('Contractor invoice number', { exact: true }).fill(number);
  await dialog.getByLabel('Invoice date', { exact: true }).fill(f.day);
  await dialog.getByLabel('Invoice total', { exact: true }).fill('125.50');
  await dialog.getByLabel('Sales tax included in total', { exact: true }).fill('5.50');
  await dialog.getByLabel('Audit note', { exact: true }).fill('Synthetic invoice for work before reassignment.');
  if (file) await attach(dialog, number);
  return number;
}
async function attach(dialog, number) {
  const pdf = new jsPDF(); pdf.text(`Synthetic contractor invoice ${number}`, 15, 20); pdf.text('Total 125.50 / tax included 5.50', 15, 35);
  await dialog.getByLabel('Original invoice PDF', { exact: true }).setInputFiles({ name: 'synthetic-prior.pdf',
    mimeType: 'application/pdf', buffer: Buffer.from(pdf.output('arraybuffer')) });
}
const invoice = f => JSON.parse(sql(`select to_jsonb(i) from public.invoices i where work_order_id=${q(f.work)} and prior_assignment_id is not null and deleted_at is null order by created_at desc limit 1`));
const parent = f => JSON.parse(sql(`select to_jsonb(w) from public.work_orders w where id=${q(f.work)}`));
async function invoiceActions(page, row, number) {
  if (page.viewportSize().width <= 720) await row.getByRole('button', { name: `Invoice ${number} actions`, exact: true }).click();
}
async function submit(dialog) {
  await dialog.getByRole('checkbox', { name: /I checked the original PDF/ }).check();
  await dialog.getByRole('button', { name: 'Upload and send for review', exact: true }).click();
  await expect(dialog.getByRole('status')).toHaveText('Previous contractor invoice submitted for P1 review.');
  await dialog.getByRole('button', { name: 'Done', exact: true }).click();
}
for (const [label, options, actor] of [['regular', {}, accounts.manager], ['capital', { capital: true }, accounts.backoffice],
  ['closed', { closed: true }, accounts.dispatcher], ['same company assigned again', { returning: true }, accounts.manager]]) {
  test(`${label}: upload original, review approval and download without changing assignment/status`, async ({ page }, testInfo) => {
    const f = priorInvoiceFixture(options); const before = parent(f); const dialog = await openPrior(page, f, actor);
    const number = await fill(dialog, f); await submit(dialog);
    const saved = invoice(f); expect(saved).toMatchObject({ num: number, state: 'submitted', total: 125.50, sales_tax: 5.50,
      prior_assignment_id: f.history, contractor_id: f.priorContractor, paid_at: null, qbo_synced_at: null });
    expect(saved.pdf_storage_path).toBeTruthy(); expect(parent(f)).toEqual(before);
    const row = page.locator('.wo-invoice-row').filter({ hasText: `#${number}` });
    await expect(row).toContainText('Previous contractor bill');
    await invoiceActions(page, row, number);
    await row.getByRole('button', { name: 'Approve', exact: true }).click();
    await expect.poll(() => invoice(f).state).toBe('approved'); expect(parent(f)).toEqual(before);
    const download = page.waitForEvent('download'); await row.getByRole('button', { name: 'Download', exact: true }).filter({ visible: true }).click();
    expect((await download).suggestedFilename()).toMatch(/\.pdf$/i);
    expect(sql(`select count(*) from public.invoices where work_order_id=${q(f.work)} and invoice_type='staff'`)).toBe('0');
    await page.screenshot({ path: testInfo.outputPath('prior-invoice-approved.png') });
  });
}
test('save without PDF, reopen retained draft, attach and submit same invoice', async ({ page }) => {
  const f = priorInvoiceFixture(); const before = parent(f); const dialog = await openPrior(page, f); const number = await fill(dialog, f, { file: false });
  await dialog.getByRole('button', { name: 'Save draft', exact: true }).click();
  await expect(dialog.getByRole('status')).toHaveText('Previous contractor invoice draft saved.');
  const id = invoice(f).id;
  await dialog.getByRole('button', { name: 'Done', exact: true }).click();
  await page.getByRole('button', { name: `Resume prior invoice ${number}`, exact: true }).click();
  const resumed = page.getByRole('dialog', { name: 'Upload previous contractor invoice', exact: true });
  await attach(resumed, number); await submit(resumed);
  expect(invoice(f).id).toBe(id); expect(invoice(f).state).toBe('submitted'); expect(parent(f)).toEqual(before);
});
test('missing PDF/confirmation creates no bill; cancellation discards the unsaved form', async ({ page }) => {
  const f = priorInvoiceFixture(); const dialog = await openPrior(page, f); await fill(dialog, f, { file: false });
  await dialog.getByRole('button', { name: 'Upload and send for review', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('Attach the original invoice PDF');
  expect(sql(`select count(*) from public.invoices where work_order_id=${q(f.work)}`)).toBe('0');
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  const discard = page.getByRole('dialog').filter({ hasText: /unsaved/i }).last();
  await expect(discard).toBeVisible();
});
for (const command of ['save_prior_contractor_invoice_v1', 'submit_prior_contractor_invoice_v1']) {
  test(`lost ${command} response retries the same operation without duplicate bill`, async ({ page }) => {
    const f = priorInvoiceFixture(); const before = parent(f); const dialog = await openPrior(page, f); await fill(dialog, f);
    let lost = false; const operations = [];
    await page.route(`**/rest/v1/rpc/${command}`, async route => {
      operations.push(route.request().postDataJSON().p_operation_id);
      if (!lost) { const response = await route.fetch(); expect(response.status()).toBe(200); lost = true; await route.abort('failed'); }
      else await route.continue();
    });
    await dialog.getByRole('checkbox', { name: /I checked the original PDF/ }).check();
    await dialog.getByRole('button', { name: 'Upload and send for review', exact: true }).click();
    await expect(dialog.getByRole('alert')).toContainText('Retry');
    await dialog.getByRole('button', { name: 'Retry same submission', exact: true }).click();
    await expect(dialog.getByRole('status')).toHaveText('Previous contractor invoice submitted for P1 review.');
    expect(new Set(operations).size).toBe(1);
    expect(sql(`select count(*) from public.invoices where work_order_id=${q(f.work)} and deleted_at is null`)).toBe('1');
    expect(parent(f)).toEqual(before);
  });
}
test('assignment changes while modal open are rejected without recording a bill', async ({ page }) => {
  const f = priorInvoiceFixture(); const dialog = await openPrior(page, f); await fill(dialog, f);
  sql(`update public.work_orders set contractor_id=(select id from public.profiles where email='e2e.direct@p1.invalid') where id=${q(f.work)}`);
  const before = parent(f);
  await dialog.getByRole('button', { name: 'Save draft', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('changed'); expect(parent(f)).toEqual(before);
  expect(sql(`select count(*) from public.invoices where work_order_id=${q(f.work)}`)).toBe('0');
});

test('reject a prior bill, correct the same bill as staff, resubmit and approve without reopening current work', async ({ page }) => {
  const f = priorInvoiceFixture(); const before = parent(f); const dialog = await openPrior(page, f); const number = await fill(dialog, f); await submit(dialog);
  const id = invoice(f).id;
  let row = page.locator('.wo-invoice-row').filter({ hasText: `#${number}` });
  await invoiceActions(page, row, number); await row.getByRole('button', { name: 'Reject', exact: true }).click();
  const reject = page.getByRole('dialog', { name: /Reject invoice/ });
  await reject.getByRole('textbox').fill('Synthetic correction requested: verify the total.');
  await reject.getByRole('button', { name: /Reject/, exact: true }).click();
  await expect.poll(() => invoice(f).state).toBe('rejected'); expect(parent(f)).toEqual(before);
  await page.getByRole('button', { name: `Resume prior invoice ${number}`, exact: true }).click();
  const resumed = page.getByRole('dialog', { name: 'Upload previous contractor invoice', exact: true });
  await resumed.getByLabel('Audit note', { exact: true }).fill('Synthetic staff verified the original PDF and corrected the bill.');
  await submit(resumed);
  expect(invoice(f).id).toBe(id); expect(invoice(f).state).toBe('revised'); expect(invoice(f).review_revision).toBe(2);
  row = page.locator('.wo-invoice-row').filter({ hasText: `#${number}` });
  await invoiceActions(page, row, number); await row.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect.poll(() => invoice(f).state).toBe('approved'); expect(parent(f)).toEqual(before);
});
