import { accounts, expect, login, openSidebarPage, openWorkOrder, test, waitForApplicationRequestsToSettle } from './fixtures.mjs';
import { reportedInvoiceFixture, reportedInvoiceSnapshot } from '../../scripts/e2e/reported-invoice-fixtures.mjs';
import { localSupabaseRuntime } from '../../scripts/e2e/local-supabase-runtime.mjs';

const runtime = localSupabaseRuntime();
test.beforeEach(async ({ context }) => {
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) await route.continue();
    else await route.abort('blockedbyclient');
  });
});

async function closeOut(page, f) {
  await openSidebarPage(page, 'Simplified');
  await page.getByPlaceholder('Search WO, store, city, keyword…').fill(f.work.toLowerCase());
  await page.getByRole('button', { name: `Open ${f.work}`, exact: true }).click();
  await page.getByRole('button', { name: 'Close out', exact: true }).click();
}
function assertRegularSnapshot(s) {
  expect(s.status).toBe('pending_invoice'); expect(s.functionalStatus).toBe('Completed');
  expect(s.closedAt).toBeNull(); expect(s.workflowCycle).toBe(0); expect(s.openVisits).toBe(0);
  expect(s.reopenEvents).toBe(0); expect(s.billedEvents).toBe(1);
  expect(s.invoices).toHaveLength(2);
  expect(s.invoices.find(i => i.invoice_type === 'staff')).toMatchObject({
    state: 'approved', document_kind: 'invoice', total: 803.22, paid_at: null });
  expect(s.invoices.find(i => i.invoice_type === 'contractor')).toMatchObject({ state: 'paid', total: 500 });
}
function assertCapitalSnapshot(s) {
  expect(s.status).toBe('pending_capital_completion'); expect(s.openVisits).toBe(0);
  expect(s.invoices).toHaveLength(2); expect(s.billedEvents).toBe(0); expect(s.quoteSubmissionEvents).toBe(0);
  expect(s.invoices.find(i => i.invoice_type === 'staff')).toMatchObject({
    state: 'approved', document_kind: 'capital_quote', total: 5542, paid_at: null });
  expect(s.invoices.find(i => i.invoice_type === 'contractor')).toMatchObject({
    state: 'paid', total: 420, paid_at: null });
}

test('reported regular WO: recorded billing offers reconciliation while alternate billing stays blocked', async ({ page }, testInfo) => {
  const f = reportedInvoiceFixture('regular_billed_still_open');
  const before = reportedInvoiceSnapshot(f); assertRegularSnapshot(before);
  await login(page, accounts.manager); await closeOut(page, f);
  const dialog = page.getByRole('dialog', { name: 'Close out work order', exact: true });
  await expect(dialog.getByRole('button', { name: 'Already billed, close work order', exact: true })).toBeEnabled();
  await expect(dialog.getByRole('button', { name: 'Billed outside the portal', exact: true })).toBeDisabled();
  await expect(dialog.getByRole('button', { name: 'Billed under another work order', exact: true })).toBeDisabled();
  await expect(dialog.getByRole('button', { name: 'No billing is required', exact: true })).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: 'Follow-up resolved, prior billing covers it', exact: true })).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('regular-replica-blocked.png') });
  await dialog.getByRole('region', { name: 'Billed outside the portal', exact: true })
    .getByRole('link', { name: 'Invoice on this WO', exact: true }).click();
  await expect(page.locator('.invoice-detail-container')).toContainText(`#${f.staffNumber}`);
  await expect(page.locator('.invoice-detail-container')).toContainText('803.22');
  await expect(page.getByRole('button', { name: 'Billed to 7-Eleven', exact: true })).toHaveCount(0);
  await expect(page.getByRole('dialog', { name: 'Create P1 to 7-Eleven invoice', exact: true })).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('regular-replica-existing-invoice.png') });
  expect(reportedInvoiceSnapshot(f)).toEqual(before);
  await waitForApplicationRequestsToSettle(page);
});

test('reported regular WO: existing mark-billed API replay reports already billed but does not repair the open status', async ({ page }) => {
  const f = reportedInvoiceFixture('regular_billed_still_open');
  const before = reportedInvoiceSnapshot(f); assertRegularSnapshot(before);
  await login(page, accounts.manager);
  // This is explicitly an authenticated local API probe, not an offered UI action.
  const result = await page.evaluate(async invoiceId => {
    const entry = Object.entries(localStorage).find(([name]) => name.endsWith('-auth-token'));
    if (!entry) throw new Error('Synthetic session unavailable');
    const session = JSON.parse(entry[1]);
    const response = await fetch(`/api/billing-invoices?id=${encodeURIComponent(invoiceId)}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
      body: JSON.stringify({ action: 'mark_billed' }),
    });
    const body = await response.json(); return { status: response.status, finalization: body.finalization, code: body.code };
  }, f.staffInvoice);
  expect(result.status).toBe(200);
  expect(result.finalization).toMatchObject({ applied: false, reason: 'already_billed',
    transitioned: false, workOrderClosed: false, workOrderStatus: 'pending_invoice', visitsClosed: 0 });
  expect(reportedInvoiceSnapshot(f)).toEqual(before);
  await waitForApplicationRequestsToSettle(page);
});

test('reported capital: approved quote without a submission event requires explicit inline attestation; review creates no bill', async ({ page }, testInfo) => {
  const f = reportedInvoiceFixture('capital_different_company');
  const before = reportedInvoiceSnapshot(f); assertCapitalSnapshot(before);
  const closeCommands = []; const downloads = [];
  page.on('request', request => { if (request.url().includes('/rpc/close_out_capital_v1')) closeCommands.push(request.url()); });
  page.on('download', download => downloads.push(download.suggestedFilename()));
  await login(page, accounts.manager); await closeOut(page, f);
  const dialog = page.getByRole('dialog', { name: 'Close out capital', exact: true });
  await expect(dialog).toContainText(`Using quote #${f.staffNumber}`);
  await expect(dialog.getByRole('checkbox', { name: /Mark this quote submitted now/ })).not.toBeChecked();
  await dialog.getByRole('button', { name: 'Confirm completed and billed', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('Confirm the actual quote submission');
  expect(closeCommands).toHaveLength(0); expect(reportedInvoiceSnapshot(f)).toEqual(before);
  await page.screenshot({ path: testInfo.outputPath('capital-replica-attestation.png') });
  await dialog.getByRole('button', { name: 'Review existing document', exact: true }).click();
  await expect(page.locator('.invoice-detail-container')).toContainText(`#${f.staffNumber}`);
  await expect(page.locator('.invoice-detail-container')).toContainText('$5,542');
  await expect(page.getByRole('button', { name: 'Download SaasAnt CSV', exact: true })).toBeVisible();
  expect(downloads).toHaveLength(0); expect(reportedInvoiceSnapshot(f)).toEqual(before);
  await waitForApplicationRequestsToSettle(page);
});

test('synthetic additional attestation: capital send-to-billing keeps it open without another invoice or export', async ({ page }) => {
  const f = reportedInvoiceFixture('capital_different_company');
  const before = reportedInvoiceSnapshot(f); const downloads = [];
  page.on('download', download => downloads.push(download.suggestedFilename()));
  await login(page, accounts.manager); await closeOut(page, f);
  const dialog = page.getByRole('dialog', { name: 'Close out capital', exact: true });
  await dialog.getByRole('radio', { name: /Completed, send to billing/ }).check();
  await dialog.getByRole('checkbox', { name: /Mark this quote submitted now/ }).check();
  await dialog.getByRole('button', { name: 'Confirm send to billing', exact: true }).click();
  await expect(dialog).toBeHidden();
  const after = reportedInvoiceSnapshot(f);
  expect(after.status).toBe('pending_invoice'); expect(after.closedAt).toBeNull();
  expect(after.functionalStatus).toBe('Completed'); expect(after.capitalStatus).toBe('Installed');
  expect(after.invoices).toHaveLength(2); expect(after.quoteSubmissionEvents).toBe(1);
  expect(after.billedEvents).toBe(0); expect(after.externalBillings).toBe(0);
  expect(after.invoices.find(i => i.invoice_type === 'contractor')).toEqual(before.invoices.find(i => i.invoice_type === 'contractor'));
  expect(downloads).toHaveLength(0);
  await waitForApplicationRequestsToSettle(page);
});

test('reported capital without a P1 quote: reproduce missing quote-reference validation, then complete billed closeout', async ({ page }, testInfo) => {
  const f = reportedInvoiceFixture('capital_external_quote_unrecorded');
  const before = reportedInvoiceSnapshot(f);
  expect(before.status).toBe('capital'); expect(before.functionalStatus).toBe('Work in Progress');
  expect(before.openVisits).toBe(0); expect(before.invoices).toHaveLength(1);
  expect(before.invoices[0]).toMatchObject({ invoice_type: 'contractor', state: 'paid', num: f.contractorNumber, total: 3170 });
  expect(before.quoteSubmissionEvents).toBe(0); expect(before.externalQuoteHandoffs).toBe(0);
  expect(before.externalBillings).toBe(0); expect(before.billedEvents).toBe(0);

  const closeCommands = []; const downloads = [];
  page.on('request', request => { if (request.url().includes('/rpc/close_out_capital_v1')) closeCommands.push(request.url()); });
  page.on('download', download => downloads.push(download.suggestedFilename()));
  await login(page, accounts.manager); await closeOut(page, f);
  const dialog = page.getByRole('dialog', { name: 'Close out capital', exact: true });
  await expect(dialog.getByLabel('Quote reference in 7-Eleven')).toBeVisible();
  await dialog.getByLabel('Existing billed invoice reference').fill('SYNTHETIC-7E-INVOICE');
  await dialog.getByLabel('Actual billing date').fill('2026-10-27');
  await dialog.getByRole('checkbox', { name: /I confirm this external quote was submitted and approved/ }).check();
  await dialog.getByRole('button', { name: 'Confirm completed and billed', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('Confirm the actual quote submission');
  expect(closeCommands).toHaveLength(0);
  expect(reportedInvoiceSnapshot(f)).toEqual(before);
  await page.screenshot({ path: testInfo.outputPath('capital-no-quote-reference-blocked.png') });

  await dialog.getByLabel('Quote reference in 7-Eleven').fill('SYNTHETIC-APPROVED-QUOTE');
  await dialog.getByRole('button', { name: 'Confirm completed and billed', exact: true }).click();
  await expect(dialog).toBeHidden();
  const after = reportedInvoiceSnapshot(f);
  expect(after.status).toBe('closed'); expect(after.functionalStatus).toBe('Completed');
  expect(after.capitalStatus).toBe('Installed'); expect(after.closedAt).not.toBeNull();
  expect(after.invoices).toHaveLength(1);
  expect(after.invoices[0]).toEqual(before.invoices[0]);
  expect(after.externalQuoteHandoffs).toBe(1); expect(after.externalBillings).toBe(1);
  expect(after.capitalCloseOutEvents).toBe(1); expect(after.billedEvents).toBe(0);
  expect(downloads).toHaveLength(0);
  expect(closeCommands).toHaveLength(1);
  await waitForApplicationRequestsToSettle(page);
});

async function browserHeader(page, work) {
  return page.evaluate(async ({ work, origin, key }) => {
    const entry = Object.entries(localStorage).find(([name]) => name.endsWith('-auth-token'));
    if (!entry) throw new Error('Synthetic session unavailable');
    const session = JSON.parse(entry[1]);
    const response = await fetch(`${origin}/rest/v1/rpc/get_portal_work_order`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', apikey: key, Authorization: `Bearer ${session.access_token}` },
      body: JSON.stringify({ p_work_order_id: work }),
    });
    const body = await response.json(); return { status: response.status, found: body?.id === work };
  }, { work, origin: runtime.NEXT_PUBLIC_SUPABASE_URL, key: runtime.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY });
}

for (const actor of [accounts.companyAdmin, accounts.companyAdminTwo, accounts.invoiceTech, accounts.reportTech]) {
  test(`reported capital: ${actor.name} in the other company cannot read or search the original WO`, async ({ page }, testInfo) => {
    const f = reportedInvoiceFixture('capital_different_company');
    const before = reportedInvoiceSnapshot(f); assertCapitalSnapshot(before);
    await login(page, actor);
    expect(await browserHeader(page, f.work)).toEqual({ status: 200, found: false });
    await page.getByRole('searchbox', { name: 'Search my jobs', exact: true }).fill(f.work.toLowerCase());
    await expect(page.getByText(`No accessible work order found for ${f.work}.`, { exact: true })).toBeVisible();
    await expect(page.getByText(f.work, { exact: true })).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath('capital-other-company-denied.png') });
    expect(reportedInvoiceSnapshot(f)).toEqual(before);
    await waitForApplicationRequestsToSettle(page);
  });
}

test('reported capital: current standalone contractor can search it and review the paid contractor invoice', async ({ page }, testInfo) => {
  const f = reportedInvoiceFixture('capital_different_company');
  const before = reportedInvoiceSnapshot(f); await login(page, accounts.direct);
  expect(await browserHeader(page, f.work)).toEqual({ status: 200, found: true });
  await page.getByRole('searchbox', { name: 'Search my jobs', exact: true }).fill(f.work.toLowerCase());
  await openWorkOrder(page, f.work);
  const documents = page.getByRole('button', { name: /Invoices, estimates and documents/ });
  if (await documents.isVisible().catch(() => false)) await documents.click();
  await expect(page.getByText(f.contractorNumber, { exact: false }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Close out', exact: true })).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('capital-current-contractor-visible.png') });
  expect(reportedInvoiceSnapshot(f)).toEqual(before);
  await waitForApplicationRequestsToSettle(page);
});
