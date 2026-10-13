import { randomUUID } from 'node:crypto';
import { accounts, expect, login, openSidebarPage, openWorkOrder, test, waitForApplicationRequestsToSettle } from './fixtures.mjs';
import { linkedBillingSql as sql, linkedBillingFixture } from '../../scripts/e2e/linked-billing-test-support.mjs';
import { localSupabaseRuntime } from '../../scripts/e2e/local-supabase-runtime.mjs';

const localRuntime = localSupabaseRuntime();

test.beforeEach(async ({ context }) => {
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) await route.continue();
    else await route.abort('blockedbyclient');
  });
});

function existingInvoice(state = 'submitted') {
  const suffix = randomUUID().slice(0, 8);
  const work = `E2E-CLOSE-DIAG-${suffix}`;
  const invoice = randomUUID();
  const number = `SYNTHETIC-EXISTING-${suffix}`;
  sql(`insert into public.work_orders(id,status,functional_status,store_number,store_state,summary)
    values('${work}','pending_invoice','Completed','E2E001','TX','Synthetic existing billing diagnosis');
    insert into public.invoices(id,work_order_id,num,invoice_type,document_kind,state,invoice_date,subtotal,total)
    values('${invoice}','${work}','${number}','staff','invoice','${state}',current_date,100,100);
    insert into public.invoice_lines(invoice_id,position,type,description,qty,rate,is_taxable)
    values('${invoice}',1,'Labor','Synthetic diagnostic labor',1,100,false);`);
  return { work, invoice, number };
}

async function chooser(page, work) {
  await openSidebarPage(page, 'Simplified');
  await page.getByPlaceholder('Search WO, store, city, keyword…').fill(work);
  await page.getByRole('button', { name: `Open ${work}`, exact: true }).click();
  await page.getByRole('button', { name: 'Close out', exact: true }).click();
  return page.getByRole('dialog', { name: 'Close out work order', exact: true });
}

for (const choice of ['Billed outside the portal', 'Billed under another work order', 'Review or finish P1 billing']) {
  test(`${choice}: invoice review link stays clickable even when alternate billing is blocked`, async ({ page }, testInfo) => {
    const f = existingInvoice(); await login(page, accounts.manager);
    const dialog = await chooser(page, f.work);
    const section = dialog.getByRole('region', { name: choice, exact: true });
    if (choice !== 'Review or finish P1 billing') {
      await expect(section.getByRole('button', { name: choice, exact: true })).toBeDisabled();
      await expect(section).toContainText('A P1 invoice already exists');
    }
    await section.getByRole('link', { name: 'Invoice on this WO', exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(page.locator('.invoice-detail-container')).toContainText(`#${f.number}`);
    await expect(page.getByRole('dialog', { name: 'Create P1 to 7-Eleven invoice', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Billed to 7-Eleven', exact: true })).toBeVisible();
    expect(sql(`select count(*) from public.invoices where work_order_id='${f.work}'`)).toBe('1');
    expect(sql(`select status from public.work_orders where id='${f.work}'`)).toBe('pending_invoice');
    await page.screenshot({ path: testInfo.outputPath('existing-invoice-review.png') });
    await waitForApplicationRequestsToSettle(page);
  });
}

test('an existing submitted invoice finishes through its own billing confirmation without creating another invoice', async ({ page }) => {
  const f = existingInvoice(); await login(page, accounts.backoffice);
  const dialog = await chooser(page, f.work);
  await dialog.getByRole('button', { name: 'Review or finish P1 billing', exact: true }).click();
  await page.getByRole('button', { name: 'Billed to 7-Eleven', exact: true }).click();
  const confirmation = page.getByRole('dialog', { name: 'Confirm 7-Eleven billing', exact: true });
  await confirmation.getByRole('button', { name: 'Billed to 7-Eleven', exact: true }).click();
  await expect(confirmation).toBeHidden();
  expect(sql(`select status from public.work_orders where id='${f.work}'`)).toBe('closed');
  expect(sql(`select count(*) from public.invoices where work_order_id='${f.work}'`)).toBe('1');
  expect(sql(`select state from public.invoices where id='${f.invoice}'`)).toBe('approved');
  await waitForApplicationRequestsToSettle(page);
});

for (const state of ['approved', 'paid']) {
  test(`diagnostic: an already ${state} invoice on a still-open WO is reviewable but has no normal mark-billed action`, async ({ page }, testInfo) => {
    const f = existingInvoice(state); await login(page, accounts.manager);
    const dialog = await chooser(page, f.work);
    await expect(dialog.getByRole('button', { name: 'Billed outside the portal', exact: true })).toBeDisabled();
    await expect(dialog.getByRole('button', { name: 'Billed under another work order', exact: true })).toBeDisabled();
    await dialog.getByRole('button', { name: 'Review or finish P1 billing', exact: true }).click();
    await expect(page.locator('.invoice-detail-container')).toContainText(`#${f.number}`);
    await expect(page.getByRole('button', { name: 'Billed to 7-Eleven', exact: true })).toHaveCount(0);
    expect(sql(`select status from public.work_orders where id='${f.work}'`)).toBe('pending_invoice');
    expect(sql(`select count(*) from public.invoices where work_order_id='${f.work}'`)).toBe('1');
    await page.screenshot({ path: testInfo.outputPath(`${state}-open-work-order-diagnostic.png`) });
    await waitForApplicationRequestsToSettle(page);
  });
}

test('coverage checkbox requires a selected invoice on a different WO, not just an entered invoice number', async ({ page }) => {
  const f = linkedBillingFixture(); await login(page, accounts.manager);
  const dialog = await chooser(page, f.source);
  await dialog.getByRole('button', { name: 'Billed under another work order', exact: true }).click();
  const form = page.getByRole('dialog', { name: 'Billed under another work order', exact: true });
  await expect(form.getByRole('checkbox')).toBeDisabled();
  await form.getByLabel('Exact invoice number (optional)').fill(f.number);
  await expect(form.getByRole('checkbox')).toBeDisabled();
  await form.getByRole('button', { name: 'Find submitted invoices', exact: true }).click();
  await expect(form.getByRole('alert')).toContainText('Enter a different work order number');
  await form.getByLabel('Billing work order number (required)').fill(f.source);
  await form.getByRole('button', { name: 'Find submitted invoices', exact: true }).click();
  await expect(form.getByRole('alert')).toContainText('Enter a different work order number');
  await form.getByLabel('Billing work order number (required)').fill(f.target);
  await form.getByRole('button', { name: 'Find submitted invoices', exact: true }).click();
  await expect(form.getByRole('radio', { name: new RegExp(f.number) })).toBeVisible();
  await expect(form.getByRole('checkbox')).toBeDisabled();
  await form.getByRole('radio', { name: new RegExp(f.number) }).check();
  await expect(form.getByRole('checkbox')).toBeEnabled();
  await form.getByRole('checkbox').check();
  await form.getByRole('button', { name: 'Link invoice and close', exact: true }).click();
  await expect(form.getByRole('status')).toContainText('This work order is closed');
  expect(sql(`select count(*) from public.invoices where work_order_id='${f.source}'`)).toBe('0');
  expect(sql(`select count(*) from public.work_order_billing_links where work_order_id='${f.source}'`)).toBe('1');
  await waitForApplicationRequestsToSettle(page);
});

function accessFixture() {
  const suffix = randomUUID().slice(0, 8);
  const base = `E2E-VIS-DIAG-${suffix}`;
  const assigned = `${base}-ASSIGNED`, unassigned = `${base}-UNASSIGNED`, other = `${base}-OTHER`;
  sql(`insert into public.work_orders(id,status,functional_status,is_capital,contractor_id,assigned_technician_profile_id,store_number,summary)
    select '${assigned}','pending_capital_completion','Pending Capital Completion',true,c.id,t.id,'E2E001','Synthetic visibility assigned capital'
      from public.profiles c,public.profiles t where c.email='e2e.company.admin@p1.invalid' and t.email='e2e.report.tech@p1.invalid';
    insert into public.work_orders(id,status,functional_status,is_capital,contractor_id,store_number,summary)
    select '${unassigned}','pending_capital_completion','Pending Capital Completion',true,id,'E2E001','Synthetic visibility unassigned capital'
      from public.profiles where email='e2e.company.admin@p1.invalid';
    insert into public.work_orders(id,status,functional_status,contractor_id,store_number,summary)
    select '${other}','assigned','Dispatched',id,'E2E001','Synthetic different contractor job'
      from public.profiles where email='e2e.direct@p1.invalid';`);
  return { assigned, unassigned, other };
}

async function headerForBrowserActor(page, id) {
  // Invoke the real header RPC with the browser session; never use owner reads
  // to establish contractor visibility. No token or storage value is returned.
  return page.evaluate(async ({ work, origin, publishableKey }) => {
    const entry = Object.entries(localStorage).find(([key]) => key.endsWith('-auth-token'));
    if (!entry) throw new Error('Synthetic browser session missing');
    const session = JSON.parse(entry[1]);
    const response = await fetch(`${origin}/rest/v1/rpc/get_portal_work_order`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', apikey: publishableKey, Authorization: `Bearer ${session.access_token}` },
      body: JSON.stringify({ p_work_order_id: work }),
    });
    if (!response.ok) return { httpStatus: response.status, found: false };
    const body = await response.json(); return { httpStatus: response.status, found: body?.id === work };
  }, { work: id, origin: localRuntime.NEXT_PUBLIC_SUPABASE_URL, publishableKey: localRuntime.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY });
}

for (const [actor, expected] of [[accounts.manager, [true, true, true]],
  [accounts.companyAdmin, [true, true, false]], [accounts.reportTech, [true, false, false]],
  [accounts.invoiceTech, [false, false, false]]]) {
  test(`${actor.name}: capital visibility respects company and individual technician assignment`, async ({ page }, testInfo) => {
    const f = accessFixture(); await login(page, actor);
    for (const [index, id] of [f.assigned, f.unassigned, f.other].entries()) {
      const result = await headerForBrowserActor(page, id);
      expect(result.httpStatus).toBe(200); expect(result.found).toBe(expected[index]);
    }
    if (actor === accounts.manager) await openSidebarPage(page, 'Work orders');
    const search = page.locator('input[placeholder^="Search WO#"], input[aria-label="Search my jobs"]').first();
    await search.fill(f.assigned);
    if (expected[0]) {
      await openWorkOrder(page, f.assigned);
      await expect(page.getByText(f.assigned, { exact: true }).first()).toBeVisible();
    } else await expect(page.getByText(f.assigned, { exact: true })).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath('role-visibility.png') });
    await waitForApplicationRequestsToSettle(page);
  });
}
