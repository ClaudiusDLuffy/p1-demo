import { randomUUID } from "node:crypto";
import { accounts, expect, login, openSidebarPage, test } from "./fixtures.mjs";
import { linkedBillingSql as sql } from "../../scripts/e2e/linked-billing-test-support.mjs";

function draftInvoiceFixture() {
  const suffix = randomUUID().slice(0, 8);
  const workOrderId = `E2E-NTE-WO-${suffix}`;
  const invoiceId = randomUUID();
  const number = `P1-E2E-NTE-${suffix}`;
  sql(`insert into public.work_orders(id,status,functional_status,store_number,store_state,summary)
    values('${workOrderId}','pending_invoice','Completed','E2E001','TX','Synthetic NTE approval wait');
    insert into public.invoices(id,work_order_id,num,invoice_type,document_kind,state,invoice_date,subtotal,total)
    values('${invoiceId}','${workOrderId}','${number}','staff','invoice','draft',current_date,100,100);
    insert into public.invoice_lines(invoice_id,position,type,description,qty,rate,is_taxable)
    values('${invoiceId}',1,'Labor','Synthetic NTE approval labor',1,100,false);`);
  return { invoiceId, number };
}

test("NTE wait is auditable, visible in the invoice list, and must be cleared before submission", async ({ page }) => {
  const fixture = draftInvoiceFixture();
  await login(page, accounts.backoffice);
  await openSidebarPage(page, "7-Eleven billing");

  const search = page.getByRole("searchbox", { name: "Search billing invoices and work orders" });
  await search.fill(fixture.number);
  await page.getByText(`#${fixture.number}`, { exact: true }).first().click();
  const detail = page.locator(".invoice-detail-container");
  await expect(detail).toContainText(`#${fixture.number}`);

  await page.getByRole("button", { name: "Mark waiting on NTE approval", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Waiting on NTE approval" }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Ready for 7-Eleven", exact: true })).toBeDisabled();
  expect(sql(`select waiting_on_nte_approval from public.staff_invoice_nte_wait_flags where invoice_id='${fixture.invoiceId}'`)).toBe("t");

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
  await page.getByText(`#${fixture.number}`, { exact: true }).first().click();
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
