import { randomUUID } from "node:crypto";
import { accounts, expect, login, openSidebarPage, test } from "./fixtures.mjs";
import { linkedBillingSql as sql } from "../../scripts/e2e/linked-billing-test-support.mjs";

function invoiceFixture(state = "draft") {
  const suffix = randomUUID().slice(0, 8);
  const workOrderId = `E2E-NTE-WO-${suffix}`;
  const invoiceId = randomUUID();
  const number = `P1-E2E-NTE-${suffix}`;
  sql(`insert into public.work_orders(id,status,functional_status,store_number,store_state,summary)
    values('${workOrderId}','pending_invoice','Completed','E2E001','TX','Synthetic NTE approval wait');
    insert into public.invoices(id,work_order_id,num,invoice_type,document_kind,state,invoice_date,subtotal,total)
    values('${invoiceId}','${workOrderId}','${number}','staff','invoice','${state}',current_date,100,100);
    insert into public.invoice_lines(invoice_id,position,type,description,qty,rate,is_taxable)
    values('${invoiceId}',1,'Labor','Synthetic NTE approval labor',1,100,false);`);
  return { workOrderId, invoiceId, number };
}

test("NTE wait is auditable, visible in the invoice list, and must be cleared before submission", async ({ page }) => {
  const fixture = invoiceFixture();
  await login(page, accounts.backoffice);
  await openSidebarPage(page, "7-Eleven billing");

  const search = page.getByRole("searchbox", { name: "Search billing invoices and work orders" });
  await search.fill(fixture.number);
  await page.getByText(`#${fixture.number}`, { exact: true }).filter({ visible: true }).first().click();
  const detail = page.locator(".invoice-detail-container");
  await expect(detail).toContainText(`#${fixture.number}`);

  await page.getByRole("button", { name: "Mark waiting on NTE approval", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Waiting on NTE approval" }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Ready for 7-Eleven", exact: true })).toBeDisabled();
  expect(sql(`select waiting_on_nte_approval from public.staff_invoice_nte_wait_flags where invoice_id='${fixture.invoiceId}'`)).toBe("t");
  expect(sql(`select profile.email from public.staff_invoice_nte_wait_flags flag
    join public.profiles profile on profile.id=flag.updated_by
    where flag.invoice_id='${fixture.invoiceId}'`)).toBe(accounts.backoffice.email);

  // Exercise the database guard separately from the disabled UI control.
  sql(`do $$ begin
    update public.invoices set state='submitted' where id='${fixture.invoiceId}';
    raise exception 'NTE wait must prevent submission';
  exception when sqlstate 'PT409' then null;
  end $$;`);
  expect(sql(`select state from public.invoices where id='${fixture.invoiceId}'`)).toBe("draft");

  await page.getByRole("button", { name: "Back to billing", exact: true }).click();
  await expect(page.getByText("Waiting on NTE approval", { exact: true }).first()).toBeVisible();
  await search.fill(fixture.number);
  await page.getByText(`#${fixture.number}`, { exact: true }).filter({ visible: true }).first().click();
  await page.getByRole("button", { name: "Clear NTE wait", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Waiting on NTE approval" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Ready for 7-Eleven", exact: true })).toBeEnabled();

  await page.getByRole("button", { name: "Ready for 7-Eleven", exact: true }).click();
  await expect(page.getByRole("button", { name: "Billed to 7-Eleven", exact: true })).toBeVisible();
  expect(sql(`select state from public.invoices where id='${fixture.invoiceId}'`)).toBe("submitted");
  expect(sql(`select waiting_on_nte_approval from public.staff_invoice_nte_wait_flags where invoice_id='${fixture.invoiceId}'`)).toBe("f");
  await page.getByRole("button", { name: "Back to billing", exact: true }).click();
  await search.fill(fixture.number);
  await expect(page.getByText("Waiting on NTE approval", { exact: true })).toHaveCount(0);
});

test("a submitted invoice cannot be marked billed while waiting on NTE approval", async ({ page }) => {
  const fixture = invoiceFixture("submitted");
  await login(page, accounts.manager);
  await openSidebarPage(page, "7-Eleven billing");
  const search = page.getByRole("searchbox", { name: "Search billing invoices and work orders" });
  await search.fill(fixture.number);
  await page.getByText(`#${fixture.number}`, { exact: true }).filter({ visible: true }).first().click();

  await page.getByRole("button", { name: "Mark waiting on NTE approval", exact: true }).click();
  await expect(page.getByRole("button", { name: "Billed to 7-Eleven", exact: true })).toBeDisabled();
  expect(sql(`select state from public.invoices where id='${fixture.invoiceId}'`)).toBe("submitted");
  expect(sql(`select total from public.invoices where id='${fixture.invoiceId}'`)).toBe("100.00");
  expect(sql(`select profile.email from public.staff_invoice_nte_wait_flags flag
    join public.profiles profile on profile.id=flag.updated_by
    where flag.invoice_id='${fixture.invoiceId}'`)).toBe(accounts.manager.email);

  sql(`do $$ begin
    update public.invoices set state='approved' where id='${fixture.invoiceId}';
    raise exception 'NTE wait must prevent billing';
  exception when sqlstate 'PT409' then null;
  end $$;`);
  expect(sql(`select state from public.invoices where id='${fixture.invoiceId}'`)).toBe("submitted");

  await page.getByRole("button", { name: "Back to billing", exact: true }).click();
  await search.fill(fixture.number);
  await expect(page.getByText("Waiting on NTE approval", { exact: true }).first()).toBeVisible();
  const invoiceRow = page.getByRole("row").filter({ hasText: fixture.number }).last();
  await expect(invoiceRow).toBeVisible();
  await invoiceRow.click();
  await page.getByRole("button", { name: "Clear NTE wait", exact: true }).click();
  await expect(page.getByRole("button", { name: "Billed to 7-Eleven", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Billed to 7-Eleven", exact: true }).click();
  const confirmation = page.getByRole("dialog", { name: "Confirm 7-Eleven billing", exact: true });
  await confirmation.getByRole("button", { name: "Billed to 7-Eleven", exact: true }).click();
  await expect(confirmation).toBeHidden();

  expect(sql(`select state from public.invoices where id='${fixture.invoiceId}'`)).toBe("approved");
  expect(sql(`select status from public.work_orders where id='${fixture.workOrderId}'`)).toBe("closed");
  expect(sql(`select count(*) from public.invoices where id='${fixture.invoiceId}'`)).toBe("1");
  expect(sql(`select waiting_on_nte_approval from public.staff_invoice_nte_wait_flags where invoice_id='${fixture.invoiceId}'`)).toBe("f");
});

test("Work orders shows and clears the NTE wait dot with the invoice marker", async ({ page }) => {
  const fixture = invoiceFixture();
  await login(page, accounts.backoffice);
  await openSidebarPage(page, "7-Eleven billing");

  const billingSearch = page.getByRole("searchbox", { name: "Search billing invoices and work orders" });
  await billingSearch.fill(fixture.number);
  await page.getByText(`#${fixture.number}`, { exact: true }).filter({ visible: true }).first().click();
  await page.getByRole("button", { name: "Mark waiting on NTE approval", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Waiting on NTE approval" }).first()).toBeVisible();

  await page.getByRole("button", { name: "Back to billing", exact: true }).click();
  await openSidebarPage(page, "Work orders");
  const workOrderSearch = page.getByRole("textbox", { name: "Search work orders" });
  await workOrderSearch.fill(fixture.workOrderId);
  const workOrderRow = page.locator(".desktop-only-table").getByRole("row").filter({ hasText: fixture.workOrderId });
  await expect(workOrderRow).toBeVisible();
  await expect(workOrderRow.getByRole("img", { name: "NTE request submitted — awaiting approval" })).toBeVisible();

  for (const width of [1024, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    const workOrderCard = page.locator(".mobile-only-cards .mobile-card").filter({ hasText: fixture.workOrderId });
    await expect(workOrderCard).toBeVisible();
    const layout = await workOrderCard.evaluate(card => {
      const cardRect = card.getBoundingClientRect();
      const dotRect = card.querySelector('[aria-label="NTE request submitted — awaiting approval"]')?.getBoundingClientRect();
      return {
        cardClientWidth: card.clientWidth,
        cardScrollWidth: card.scrollWidth,
        cardLeft: cardRect.left,
        cardRight: cardRect.right,
        dotLeft: dotRect?.left,
        dotRight: dotRect?.right,
        documentWidth: document.documentElement.scrollWidth,
        viewportWidth: window.innerWidth,
      };
    });
    expect(layout.dotLeft).toBeGreaterThanOrEqual(layout.cardLeft);
    expect(layout.dotRight).toBeLessThanOrEqual(layout.cardRight);
    expect(layout.cardScrollWidth).toBeLessThanOrEqual(layout.cardClientWidth + 1);
    expect(layout.documentWidth).toBeLessThanOrEqual(layout.viewportWidth + 1);
  }
  await page.setViewportSize({ width: 1440, height: 1000 });

  await openSidebarPage(page, "7-Eleven billing");
  await billingSearch.fill(fixture.number);
  await page.getByText(`#${fixture.number}`, { exact: true }).filter({ visible: true }).first().click();
  await page.getByRole("button", { name: "Clear NTE wait", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Waiting on NTE approval" })).toHaveCount(0);
  await page.getByRole("button", { name: "Back to billing", exact: true }).click();
  await openSidebarPage(page, "Work orders");
  await workOrderSearch.fill(fixture.workOrderId);
  const clearedRow = page.locator(".desktop-only-table").getByRole("row").filter({ hasText: fixture.workOrderId });
  await expect(clearedRow).toBeVisible();
  await expect(clearedRow.getByRole("img", { name: "NTE request submitted — awaiting approval" })).toHaveCount(0);
});
