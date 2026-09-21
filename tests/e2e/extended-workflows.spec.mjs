import { jsPDF } from "jspdf";
import { access } from "node:fs/promises";
import { accounts, expect, login, openSidebarPage, openWorkOrder, test } from "./fixtures.mjs";

test("report-only technician can complete the full field-work lifecycle without invoice access", async ({ page }) => {
  await login(page, accounts.reportTech);
  await openSidebarPage(page, "My jobs");
  await openWorkOrder(page, "E2E-REPORT-START");
  await expect(page.getByRole("button", { name: /Create or upload invoice/ })).toHaveCount(0);

  await page.getByRole("button", { name: "Start work", exact: true }).click();
  let dialog = page.getByRole("dialog", { name: "Start work" });
  await dialog.getByPlaceholder("What are you seeing on site?").fill("Synthetic diagnostic visit started.");
  await dialog.getByRole("button", { name: "Start work", exact: true }).click();
  await expect(dialog).toBeHidden();

  await page.getByRole("button", { name: "Pause (parts)", exact: true }).click();
  dialog = page.getByRole("dialog", { name: "Pause work" });
  await dialog.getByRole("combobox", { name: "Reason" }).click();
  await page.getByRole("option", { name: "Temporary fix - equipment partially working", exact: true }).click();
  await dialog.getByPlaceholder("Explain what was done so far...").fill("Synthetic temporary repair completed.");
  await dialog.getByRole("button", { name: "Pause work", exact: true }).click();
  await expect(dialog).toBeHidden();

  await page.getByRole("button", { name: "Resume work", exact: true }).click();
  dialog = page.getByRole("dialog", { name: "Resume work" });
  await dialog.getByPlaceholder("What are you seeing on site?").fill("Synthetic return visit resumed.");
  await dialog.getByRole("button", { name: "Resume", exact: true }).click();
  await expect(dialog).toBeHidden();

  await page.getByRole("button", { name: "Mark work complete", exact: true }).click();
  dialog = page.getByRole("dialog", { name: "Mark work complete" });
  await dialog.getByLabel("Equipment make").fill("Synthetic Make");
  await dialog.getByLabel("Asset model").fill("SYN-MODEL-1");
  await dialog.getByLabel("Serial number").fill("SYN-SERIAL-1");
  await dialog.getByLabel("Equipment year *").fill("2024");
  await dialog.getByRole("combobox", { name: "Resolution code" }).click();
  await page.getByRole("option", { name: "Current Asset Repaired", exact: true }).click();
  await dialog.getByLabel("Closing notes").fill("Synthetic repair verified operational.");
  await dialog.getByRole("button", { name: "Mark work complete", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText("7-Eleven FSM: Completed", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /Create or upload invoice/ })).toHaveCount(0);
});

test("contractor organization and technician scopes stay isolated", async ({ page }) => {
  await login(page, accounts.companyAdmin);
  await openSidebarPage(page, "My jobs");
  const search = page.getByRole("searchbox", { name: "Search my jobs" });
  for (const workOrderId of ["E2E-ADMIN-WORKFLOW", "E2E-NEW-START", "E2E-REPORT-START"]) {
    await search.fill(workOrderId);
    await expect(page.getByText(workOrderId, { exact: true })).toBeVisible();
  }
  await search.fill("E2E-DIRECT-INVOICE");
  await expect(page.getByText("E2E-DIRECT-INVOICE", { exact: true })).toHaveCount(0);
  await expect(page.getByText("No work orders match your search.", { exact: true })).toBeVisible();
});

test("staff dispatcher can assign an unassigned work order", async ({ page }) => {
  await login(page, accounts.dispatcher);
  await openSidebarPage(page, "Work orders");
  await openWorkOrder(page, "E2E-STAFF-ASSIGN");
  await page.getByRole("button", { name: "Assign to contractor…", exact: true }).click();
  await page.getByRole("option", { name: /Synthetic Direct Contractor/ }).click();
  await expect(page.getByText("Synthetic Direct Contractor", { exact: true }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Reassign", exact: true })).toBeVisible();
});

test("invoice-capable technician can upload and submit a synthetic PDF invoice", async ({ page }) => {
  await login(page, accounts.invoiceTech);
  await openSidebarPage(page, "My jobs");
  await openWorkOrder(page, "E2E-TECH-INVOICE");
  await page.getByRole("button", { name: "Create or upload invoice", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Create invoice" });
  await expect(dialog.getByLabel("Invoice #")).toHaveValue(/^\d+$/);

  const suppliedPdfPath = process.env.P1_E2E_INVOICE_PDF_PATH;
  if (suppliedPdfPath) {
    await access(suppliedPdfPath);
    await dialog.locator('input[type="file"][accept*="pdf"]').setInputFiles(suppliedPdfPath);
  } else {
    const pdf = new jsPDF();
    pdf.text("Synthetic Test Invoice", 20, 25);
    pdf.text("Invoice Number: E2E-PDF-001", 20, 40);
    pdf.text("Synthetic service total: $225.00", 20, 55);
    const buffer = Buffer.from(pdf.output("arraybuffer"));
    await dialog.locator('input[type="file"][accept*="pdf"]').setInputFiles({
      name: "synthetic-e2e-invoice.pdf",
      mimeType: "application/pdf",
      buffer,
    });
  }

  await expect(dialog.getByText("Uploaded invoice amount", { exact: true })).toBeVisible();
  await dialog.getByLabel("Invoice #").fill("E2E-PDF-001");
  const total = dialog.getByLabel("Invoice total");
  await expect(total).toBeVisible();
  if (suppliedPdfPath) {
    const reviewed = dialog.getByRole("checkbox", {
      name: "I reviewed these line items against the uploaded invoice.",
      exact: true,
    });
    await expect(reviewed).toBeVisible();
    await reviewed.check();
  } else {
    await total.fill("225.00");
    const totalOnly = dialog.getByRole("button", { name: "Use invoice total only", exact: true });
    if (await totalOnly.isVisible()) await totalOnly.click();
  }
  await dialog.getByRole("button", { name: "Submit", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText("#E2E-PDF-001", { exact: true })).toBeVisible();
});

test("invoice dropdown and actions remain visible on a narrow viewport", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page, accounts.direct);
  await openWorkOrder(page, "E2E-MOBILE-INVOICE");
  await page.getByRole("button", { name: "Create or upload invoice", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Create invoice" });
  const invoiceNumber = dialog.getByLabel("Invoice #");
  await expect(invoiceNumber).toHaveValue(/^\d+$/);
  const assignedNumber = await invoiceNumber.inputValue();
  await dialog.getByRole("button", { name: "+ Labor", exact: true }).click();

  const lineType = dialog.getByRole("combobox", { name: "Line 1 type" });
  await lineType.scrollIntoViewIfNeeded();
  const triggerBox = await lineType.boundingBox();
  expect(triggerBox).not.toBeNull();
  expect(triggerBox.x).toBeGreaterThanOrEqual(0);
  expect(triggerBox.x + triggerBox.width).toBeLessThanOrEqual(390);
  await lineType.click();
  const option = page.getByRole("option", { name: "Parts/Hardware", exact: true });
  await expect(option).toBeVisible();
  const optionBox = await option.boundingBox();
  expect(optionBox).not.toBeNull();
  expect(optionBox.x).toBeGreaterThanOrEqual(0);
  expect(optionBox.x + optionBox.width).toBeLessThanOrEqual(390);
  await option.click();

  const saveDraft = dialog.getByRole("button", { name: "Save as draft", exact: true });
  await saveDraft.scrollIntoViewIfNeeded();
  await expect(saveDraft).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Submit", exact: true })).toBeVisible();
  const actionBox = await saveDraft.boundingBox();
  expect(actionBox).not.toBeNull();
  expect(actionBox.x).toBeGreaterThanOrEqual(0);
  expect(actionBox.x + actionBox.width).toBeLessThanOrEqual(390);
  await saveDraft.click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText(`#${assignedNumber}`, { exact: true })).toBeVisible();
});

test("focused staff invoice number still hydrates after a delayed preview", async ({ page }) => {
  let releasePreview;
  const previewMayContinue = new Promise(resolve => { releasePreview = resolve; });
  await page.route(url => url.pathname.endsWith("/api/billing-invoices")
    && url.searchParams.get("nextNumber") === "1", async route => {
    await previewMayContinue;
    await route.continue();
  });

  await login(page, accounts.backoffice);
  await openSidebarPage(page, "Work orders");
  await openWorkOrder(page, "E2E-STAFF-BILLING");
  await page.getByRole("button", { name: "Create P1 to 7-Eleven invoice", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Create P1 to 7-Eleven invoice" });
  const invoiceNumber = dialog.getByLabel("Invoice #");
  await expect(invoiceNumber).toHaveAttribute("placeholder", "Loading…");
  await invoiceNumber.focus();
  await expect(invoiceNumber).toBeFocused();
  releasePreview();
  await expect(invoiceNumber).toHaveValue(/^P1-/);
  await expect(invoiceNumber).toBeFocused();
});

test("back-office staff can select territory and save a linked billing draft", async ({ page }) => {
  await login(page, accounts.backoffice);
  await openSidebarPage(page, "Work orders");
  await openWorkOrder(page, "E2E-STAFF-BILLING");
  await page.getByRole("button", { name: "Create P1 to 7-Eleven invoice", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Create P1 to 7-Eleven invoice" });
  await expect(dialog).toBeVisible();

  const territory = dialog.getByRole("combobox", { name: "Invoice territory" });
  await territory.click();
  await page.getByRole("option", { name: "Florida", exact: true }).click();
  await expect(territory).toContainText("Florida");
  await territory.click();
  await page.getByRole("option", { name: "Texas", exact: true }).click();
  await expect(territory).toContainText("Texas");

  await dialog.getByLabel("Invoice #").fill("P1-E2E-STAFF-001");
  await dialog.getByRole("button", { name: /^\+ Labor/ }).first().click();
  await dialog.getByLabel("Line 1 description").fill("Synthetic staff billing labor");
  const saveDraft = dialog.getByRole("button", { name: "Save as Draft", exact: true });
  await expect(saveDraft).toBeEnabled();
  await saveDraft.click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText("#P1-E2E-STAFF-001", { exact: true })).toBeVisible();
  await expect(page.getByText("Draft", { exact: true }).first()).toBeVisible();
});

for (const [label, account] of [
  ["back-office", accounts.backoffice],
  ["invoice controller", accounts.controller],
  ["accounting handoff", accounts.accounting],
]) {
  test(`${label} can load contractor bills without a permission failure`, async ({ page }) => {
    await login(page, account);
    await openSidebarPage(page, "Contractor bills");
    await expect(page.getByRole("columnheader", { name: "Invoice#" })).toBeVisible();
    if (label === "invoice controller") {
      await expect(page.getByText("#E2E-PDF-001", { exact: true })).toHaveCount(0);
    } else {
      await expect(page.getByText("#E2E-PDF-001", { exact: true }).first()).toBeVisible();
    }
    await expect(page.getByText("You do not have permission to perform this action.", { exact: true })).toHaveCount(0);
  });
}
