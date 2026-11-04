import { accounts, expect, login, openSidebarPage, test } from "./fixtures.mjs";
import { linkedBillingSql as sql } from "../../scripts/e2e/linked-billing-test-support.mjs";

test("staff can pull submitted contractor invoice lines into a new P1 invoice", async ({ page }) => {
  await login(page, accounts.backoffice);
  await openSidebarPage(page, "7-Eleven billing");
  await page.getByRole("button", { name: "+ Create Invoice", exact: true }).click();

  const dialog = page.getByRole("dialog", { name: "Create P1 to 7-Eleven invoice", exact: true });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Search work order", { exact: true }).fill("E2E-REVIEW-APPROVE");
  await page.getByRole("listbox", { name: "Matching work orders" })
    .getByRole("option", { name: /^E2E-REVIEW-APPROVE / }).click();

  await expect(dialog.getByText("Contractor invoices on E2E-REVIEW-APPROVE", { exact: true })).toBeVisible();
  const source = dialog.getByRole("checkbox", { name: /E2E-SUBMITTED-APPROVE/ });
  await expect(source).toBeVisible();
  await source.check();

  await dialog.getByRole("button", { name: "Pull lines + calculate", exact: true }).click();
  await expect(page.getByText("Pulled 1 line item", { exact: true })).toBeVisible();
  await expect(dialog.getByLabel("Line 1 description", { exact: true })).toHaveValue("Synthetic approval labor");
  await expect(dialog.getByLabel("Line 1 quantity", { exact: true })).toHaveValue("1");
  await expect(dialog.getByLabel("Line 1 rate", { exact: true })).not.toHaveValue("");
});

test("confirms copied lines are manual before changing work orders and saves the replacement draft", async ({ page }) => {
  await login(page, accounts.backoffice);
  await openSidebarPage(page, "7-Eleven billing");
  await page.getByRole("button", { name: "+ Create Invoice", exact: true }).click();

  const dialog = page.getByRole("dialog", { name: "Create P1 to 7-Eleven invoice", exact: true });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Search work order", { exact: true }).fill("E2E-REVIEW-APPROVE");
  await page.getByRole("listbox", { name: "Matching work orders" })
    .getByRole("option", { name: /^E2E-REVIEW-APPROVE / }).click();

  const originalSource = dialog.getByRole("checkbox", { name: /E2E-SUBMITTED-APPROVE/ });
  await expect(originalSource).toBeVisible();
  await originalSource.check();
  await dialog.getByRole("button", { name: "Pull lines + calculate", exact: true }).click();
  await expect(page.getByText("Pulled 1 line item", { exact: true })).toBeVisible();

  await dialog.getByLabel("Search work order", { exact: true }).fill("E2E-STAFF-BILLING");
  await dialog.getByLabel("Invoice work order", { exact: true }).click();
  await page.getByRole("listbox").last()
    .getByRole("option", { name: /^E2E-STAFF-BILLING / }).click();

  const confirmMove = page.getByRole("dialog", { name: "Move imported lines to another work order?", exact: true });
  await expect(confirmMove).toBeVisible();
  await expect(confirmMove).toContainText("#E2E-SUBMITTED-APPROVE");
  await confirmMove.getByRole("button", { name: "Keep current work order", exact: true }).click();
  await expect(dialog.getByLabel("Invoice work order", { exact: true })).toContainText("E2E-REVIEW-APPROVE");
  await expect(dialog.getByLabel("Line 1 description", { exact: true })).toHaveValue("Synthetic approval labor");

  await dialog.getByLabel("Search work order", { exact: true }).fill("E2E-STAFF-BILLING");
  await page.getByRole("listbox", { name: "Matching work orders" })
    .getByRole("option", { name: /^E2E-STAFF-BILLING / }).click();
  await expect(confirmMove).toBeVisible();
  await expect(confirmMove).toContainText("does not move or close the original work order");
  await confirmMove.getByRole("button", { name: "Continue with manual lines", exact: true }).click();

  await expect(dialog.getByText("Contractor invoices on E2E-STAFF-BILLING", { exact: true })).toBeVisible();
  await expect(dialog.getByText("No submitted contractor invoices are available on this work order.", { exact: true })).toBeVisible();
  await expect(dialog.getByRole("checkbox", { name: /E2E-SUBMITTED-APPROVE/ })).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "Pull lines + calculate", exact: true })).toHaveCount(0);
  await expect(dialog.getByRole("status").filter({ hasText: "kept as manual line items" })).toContainText("not linked to this invoice");
  await expect(dialog.getByLabel("Line 1 description", { exact: true })).toHaveValue("Synthetic approval labor");
  await expect(dialog.getByLabel("Line 1 quantity", { exact: true })).toHaveValue("1");
  await expect(dialog.getByLabel("Line 1 rate", { exact: true })).toHaveValue("110");
  await dialog.getByLabel("Invoice #", { exact: true }).fill("P1-E2E-CROSS-WO-MANUAL");
  let savedCommand;
  page.on("request", request => {
    if (new URL(request.url()).pathname === "/api/billing-invoices" && request.method() === "POST") {
      savedCommand = request.postDataJSON();
    }
  });
  await dialog.getByRole("button", { name: "Save as Draft", exact: true }).click();
  await expect(dialog).toBeHidden();
  expect(savedCommand.sourceInvoiceIds).toEqual([]);
  expect(savedCommand.lines[0].sourceInvoiceLineId).toBeNull();
  expect(savedCommand.lines[0].sourceUnitCost).toBeNull();
  expect(savedCommand.lines[0].markupPercent).toBeNull();
  const saved = JSON.parse(sql(`select jsonb_build_object(
    'workOrderId', i.work_order_id, 'state', i.state, 'total', i.total,
    'lineCount', (select count(*) from public.invoice_lines l where l.invoice_id=i.id),
    'sourceCount', (select count(*) from public.staff_invoice_sources s where s.staff_invoice_id=i.id),
    'lineSourceId', (select source_invoice_line_id from public.invoice_lines l where l.invoice_id=i.id limit 1),
    'lineSourceCost', (select source_unit_cost from public.invoice_lines l where l.invoice_id=i.id limit 1)
  ) from public.invoices i where i.num='P1-E2E-CROSS-WO-MANUAL' and i.deleted_at is null`));
  expect(saved).toEqual({ workOrderId: "E2E-STAFF-BILLING", state: "draft", total: 110,
    lineCount: 1, sourceCount: 0, lineSourceId: null, lineSourceCost: null });
  const originalSourceState = JSON.parse(sql(`select jsonb_build_object(
    'workOrderId', source.work_order_id, 'state', source.state,
    'activeP1Links', (select count(*) from public.staff_invoice_sources link
      join public.invoices staff on staff.id=link.staff_invoice_id
      where link.contractor_invoice_id=source.id and staff.deleted_at is null)
  ) from public.invoices source where source.num='E2E-SUBMITTED-APPROVE' and source.deleted_at is null`));
  expect(originalSourceState).toEqual({ workOrderId: "E2E-REVIEW-APPROVE", state: "submitted", activeP1Links: 0 });
});

test("same-work-order source pull saves and links the P1 draft to its contractor invoice", async ({ page }) => {
  await login(page, accounts.backoffice);
  await openSidebarPage(page, "7-Eleven billing");
  await page.getByRole("button", { name: "+ Create Invoice", exact: true }).click();

  const dialog = page.getByRole("dialog", { name: "Create P1 to 7-Eleven invoice", exact: true });
  await dialog.getByLabel("Search work order", { exact: true }).fill("E2E-REVIEW-APPROVE");
  await page.getByRole("listbox", { name: "Matching work orders" })
    .getByRole("option", { name: /^E2E-REVIEW-APPROVE / }).click();
  await dialog.getByRole("checkbox", { name: /E2E-SUBMITTED-APPROVE/ }).check();
  await dialog.getByRole("button", { name: "Pull lines + calculate", exact: true }).click();
  await expect(page.getByText("Pulled 1 line item", { exact: true })).toBeVisible();
  await dialog.getByLabel("Invoice #", { exact: true }).fill("P1-E2E-SAME-WO-SOURCE");
  await dialog.getByRole("button", { name: "Save as Draft", exact: true }).click();
  await expect(dialog).toBeHidden();

  const saved = JSON.parse(sql(`select jsonb_build_object(
    'workOrderId', i.work_order_id, 'state', i.state, 'total', i.total,
    'sourceCount', (select count(*) from public.staff_invoice_sources s where s.staff_invoice_id=i.id),
    'sourceNum', (select source.num from public.staff_invoice_sources s
      join public.invoices source on source.id=s.contractor_invoice_id where s.staff_invoice_id=i.id limit 1)
  ) from public.invoices i where i.num='P1-E2E-SAME-WO-SOURCE' and i.deleted_at is null`));
  expect(saved).toEqual({ workOrderId: "E2E-REVIEW-APPROVE", state: "draft", total: 110,
    sourceCount: 1, sourceNum: "E2E-SUBMITTED-APPROVE" });
});

test("paid QuickBooks-synced contractor source remains unchanged when used on its own work order", async ({ page }) => {
  const sourceBefore = JSON.parse(sql(`select jsonb_build_object(
    'state', state, 'qboInvoiceId', qbo_invoice_id, 'qboSyncedAt', qbo_synced_at, 'paidAt', paid_at
  ) from public.invoices where num='E2E-PAID' and deleted_at is null`));
  await login(page, accounts.backoffice);
  await openSidebarPage(page, "7-Eleven billing");
  await page.getByRole("button", { name: "+ Create Invoice", exact: true }).click();

  const dialog = page.getByRole("dialog", { name: "Create P1 to 7-Eleven invoice", exact: true });
  await dialog.getByLabel("Search work order", { exact: true }).fill("E2E-PAID");
  await page.getByRole("listbox", { name: "Matching work orders" })
    .getByRole("option", { name: /^E2E-PAID / }).click();
  const source = dialog.getByRole("checkbox", { name: /E2E-PAID/ });
  await expect(source).toBeVisible();
  await source.check();
  await dialog.getByRole("button", { name: "Pull lines + calculate", exact: true }).click();
  await expect(page.getByText("Pulled 1 line item", { exact: true })).toBeVisible();
  await dialog.getByLabel("Invoice #", { exact: true }).fill("P1-E2E-PAID-SOURCE");
  await dialog.getByRole("button", { name: "Save as Draft", exact: true }).click();
  await expect(dialog).toBeHidden();

  const sourceAfter = JSON.parse(sql(`select jsonb_build_object(
    'state', state, 'qboInvoiceId', qbo_invoice_id, 'qboSyncedAt', qbo_synced_at, 'paidAt', paid_at
  ) from public.invoices where num='E2E-PAID' and deleted_at is null`));
  expect(sourceAfter).toEqual(sourceBefore);
  const linkedDraft = JSON.parse(sql(`select jsonb_build_object(
    'workOrderId', i.work_order_id, 'state', i.state,
    'sourceNum', (select source.num from public.staff_invoice_sources s
      join public.invoices source on source.id=s.contractor_invoice_id where s.staff_invoice_id=i.id limit 1)
  ) from public.invoices i where i.num='P1-E2E-PAID-SOURCE' and i.deleted_at is null`));
  expect(linkedDraft).toEqual({ workOrderId: "E2E-PAID", state: "draft", sourceNum: "E2E-PAID" });
});

test("manual five-line replacement draft matches the reported $1,711 total without an old-WO source link", async ({ page }) => {
  await login(page, accounts.backoffice);
  await openSidebarPage(page, "7-Eleven billing");
  await page.getByRole("button", { name: "+ Create Invoice", exact: true }).click();

  const dialog = page.getByRole("dialog", { name: "Create P1 to 7-Eleven invoice", exact: true });
  await dialog.getByLabel("Search work order", { exact: true }).fill("E2E-STAFF-BILLING");
  await page.getByRole("listbox", { name: "Matching work orders" })
    .getByRole("option", { name: /^E2E-STAFF-BILLING / }).click();
  await expect(dialog.getByText("No submitted contractor invoices are available on this work order.", { exact: true })).toBeVisible();
  await dialog.getByLabel("Invoice #", { exact: true }).fill("P1-E2E-REPLACEMENT-1711");

  await dialog.getByRole("button", { name: /^\+ Travel/ }).click();
  await dialog.getByLabel("Line 1 description", { exact: true }).fill("Synthetic travel");
  await dialog.getByLabel("Line 1 quantity", { exact: true }).fill("1");
  await dialog.getByLabel("Line 1 rate", { exact: true }).fill("110");
  await dialog.getByRole("button", { name: /^\+ Labor/ }).click();
  await dialog.getByLabel("Line 2 description", { exact: true }).fill("Synthetic labor");
  await dialog.getByLabel("Line 2 quantity", { exact: true }).fill("5.5");
  await dialog.getByLabel("Line 2 rate", { exact: true }).fill("110");
  await dialog.getByRole("button", { name: /^\+ OT Labor/ }).click();
  await dialog.getByLabel("Line 3 description", { exact: true }).fill("Synthetic overtime");
  await dialog.getByLabel("Line 3 quantity", { exact: true }).fill("1");
  await dialog.getByLabel("Line 3 rate", { exact: true }).fill("165");
  await dialog.getByRole("button", { name: /^\+ Refrigerant/ }).click();
  await dialog.getByLabel("Line 4 quantity", { exact: true }).fill("17");
  await dialog.getByLabel("Line 4 rate", { exact: true }).fill("35");
  await dialog.getByLabel("Line 4 taxable", { exact: true }).uncheck();
  await dialog.getByRole("button", { name: /^\+ TVRN/ }).click();
  await dialog.getByLabel("Line 5 taxable", { exact: true }).uncheck();
  await dialog.getByLabel("Manual sales tax amount", { exact: true }).fill("0");

  await expect(dialog.getByText(/^\$1,711(?:\.00)?$/).filter({ visible: true }).first()).toBeVisible();
  await dialog.getByRole("button", { name: "Save as Draft", exact: true }).click();
  await expect(dialog).toBeHidden();
  const saved = JSON.parse(sql(`select jsonb_build_object(
    'workOrderId', i.work_order_id, 'state', i.state, 'total', i.total,
    'lineCount', (select count(*) from public.invoice_lines l where l.invoice_id=i.id),
    'sourceCount', (select count(*) from public.staff_invoice_sources s where s.staff_invoice_id=i.id)
  ) from public.invoices i where i.num='P1-E2E-REPLACEMENT-1711' and i.deleted_at is null`));
  expect(saved).toEqual({ workOrderId: "E2E-STAFF-BILLING", state: "draft", total: 1711,
    lineCount: 5, sourceCount: 0 });
});
