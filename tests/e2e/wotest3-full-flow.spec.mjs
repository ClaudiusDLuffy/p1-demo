import { access } from "node:fs/promises";
import { jsPDF } from "jspdf";
import {
  accounts,
  expect,
  login,
  openSidebarPage,
  openWorkOrder,
  sidebar,
  test,
} from "./fixtures.mjs";

const WORK_ORDER_ID = "WOTEST3";
const INVOICE_NUMBER = "WOTEST3-PDF";

async function asAccount(browser, account, run) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const fatal = [];
  page.on("pageerror", error => fatal.push(`pageerror: ${error.message}`));
  page.on("response", response => {
    if (response.status() >= 500) fatal.push(`http ${response.status()}: ${response.url().replace(/\?.*$/, "")}`);
  });
  await page.route("**/api/notifications/**", route => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ ok: true, synthetic: true }),
  }));
  try {
    await login(page, account);
    await run(page);
    expect(fatal, `${account.name} browser errors and HTTP 5xx responses`).toEqual([]);
  } finally {
    await context.close();
  }
}

async function expectMyJob(browser, account, visible) {
  await asAccount(browser, account, async page => {
    await openSidebarPage(page, "My jobs");
    await page.getByRole("searchbox", { name: "Search my jobs" }).fill(WORK_ORDER_ID);
    if (visible) {
      await expect(page.getByText(WORK_ORDER_ID, { exact: true }).first()).toBeVisible();
    } else {
      await expect(page.getByText("No work orders match your search.", { exact: true })).toBeVisible();
      await expect(page.getByText(WORK_ORDER_ID, { exact: true })).toHaveCount(0);
    }
  });
}

async function openContractorInvoice(page, invoiceNumber, tab) {
  await openSidebarPage(page, "Contractor bills");
  if (tab) await page.getByRole("button", { name: tab, exact: true }).click();
  await page.getByRole("searchbox", { name: "Search contractor invoices" }).fill(invoiceNumber);
  const invoice = page.getByText(`#${invoiceNumber}`, { exact: true }).first();
  await expect(invoice).toBeVisible();
  await invoice.click();
}

async function uploadInvoice(page) {
  await page.getByRole("button", { name: "Create or upload invoice", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Create invoice" });
  const suppliedPdfPath = process.env.P1_E2E_INVOICE_PDF_PATH;

  if (suppliedPdfPath) {
    await access(suppliedPdfPath);
    await dialog.locator('input[type="file"][accept*="pdf"]').setInputFiles(suppliedPdfPath);
  } else {
    const pdf = new jsPDF();
    pdf.text("Synthetic WOTEST3 Invoice", 20, 25);
    pdf.text(`Invoice Number: ${INVOICE_NUMBER}`, 20, 40);
    pdf.text("Synthetic service total: $225.00", 20, 55);
    await dialog.locator('input[type="file"][accept*="pdf"]').setInputFiles({
      name: "wotest3-synthetic-invoice.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.from(pdf.output("arraybuffer")),
    });
  }

  await expect(dialog.getByText("Uploaded invoice amount", { exact: true })).toBeVisible();
  await dialog.getByLabel("Invoice #").fill(INVOICE_NUMBER);
  const total = dialog.getByLabel("Invoice total");
  await expect(total).toBeVisible();

  if (suppliedPdfPath) {
    const descriptions = dialog.getByLabel(/^Line \d+ description$/);
    await expect(descriptions).toHaveCount(5);
    expect(Number(await total.inputValue())).toBeCloseTo(1242.50, 2);
    let calculatedTotal = 0;
    for (let line = 1; line <= 5; line += 1) {
      const quantity = Number(await dialog.getByLabel(`Line ${line} quantity`).inputValue());
      const rate = Number(await dialog.getByLabel(`Line ${line} rate`).inputValue());
      calculatedTotal += quantity * rate;
    }
    expect(calculatedTotal).toBeCloseTo(Number(await total.inputValue()), 2);
    await dialog.getByRole("checkbox", {
      name: "I reviewed these line items against the uploaded invoice.",
      exact: true,
    }).check();
  } else {
    await total.fill("225.00");
    const totalOnly = dialog.getByRole("button", { name: "Use invoice total only", exact: true });
    if (await totalOnly.isVisible()) await totalOnly.click();
  }

  await dialog.getByRole("button", { name: "Submit", exact: true }).click();
  await expect(dialog).toBeHidden();
  const submitted = page.getByRole("dialog", { name: `Invoice #${INVOICE_NUMBER} submitted` });
  await expect(submitted).toBeVisible();
  await submitted.getByRole("button", { name: "Done", exact: true }).click();
  await expect(submitted).toBeHidden();
  await expect(page.getByText(`#${INVOICE_NUMBER}`, { exact: true })).toBeVisible();
}

test("WOTEST3 crosses every synthetic role boundary and completes the field-to-payables flow", async ({ browser }) => {
  test.setTimeout(240_000);

  // Operational staff can read the same unassigned record. Manager editing and
  // back-office internal notes prove writes persist before dispatch.
  await asAccount(browser, accounts.manager, async page => {
    await openSidebarPage(page, "Work orders");
    await openWorkOrder(page, WORK_ORDER_ID);
    await page.getByRole("button", { name: "Edit work order", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Edit work order" });
    await dialog.getByLabel("Short Description").fill("WOTEST3 full synthetic workflow");
    await dialog.getByLabel("Description", { exact: true }).fill(
      "Synthetic end-to-end work order used to verify assignment, transfer, field work, files, invoicing, review, and payables.",
    );
    await dialog.getByRole("button", { name: "Save changes", exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText("WOTEST3 full synthetic workflow", { exact: true })).toBeVisible();
  });

  await asAccount(browser, accounts.backoffice, async page => {
    await openSidebarPage(page, "Work orders");
    await openWorkOrder(page, WORK_ORDER_ID);
    await page.getByPlaceholder("Add an internal P1 note...").fill("WOTEST3 internal staff-only dispatch note.");
    await page.getByRole("button", { name: "Post internal note", exact: true }).click();
    await expect(page.getByText("WOTEST3 internal staff-only dispatch note.", { exact: true })).toBeVisible();
  });

  await asAccount(browser, accounts.accounting, async page => {
    await openSidebarPage(page, "Work orders");
    await openWorkOrder(page, WORK_ORDER_ID);
    await expect(page.getByText("WOTEST3 full synthetic workflow", { exact: true })).toBeVisible();
  });

  await asAccount(browser, accounts.controller, async page => {
    await expect(sidebar(page).locator("button").filter({ hasText: "Work orders" })).toHaveCount(0);
    await expect(sidebar(page).locator("button").filter({ hasText: "Controller" }).first()).toBeVisible();
    await expect(sidebar(page).locator("button").filter({ hasText: "Contractor bills" }).first()).toBeVisible();
  });

  // No contractor identity can see an unassigned operational work order.
  for (const account of [
    accounts.direct,
    accounts.companyAdmin,
    accounts.companyAdminTwo,
    accounts.invoiceTech,
    accounts.reportTech,
    accounts.revocationTech,
    accounts.teamLead,
    accounts.teamMember,
  ]) {
    await expectMyJob(browser, account, false);
  }

  await asAccount(browser, accounts.dispatcher, async page => {
    await openSidebarPage(page, "Work orders");
    await openWorkOrder(page, WORK_ORDER_ID);
    await page.getByRole("button", { name: "Assign to contractor…", exact: true }).click();
    await page.getByRole("option", { name: /Synthetic Direct Contractor/ }).click();
    await expect(page.getByText("Synthetic Direct Contractor", { exact: true }).first()).toBeVisible();
  });

  // The direct contractor runs visit one, including the complete photo CRUD and
  // download surface, then pauses for parts.
  await asAccount(browser, accounts.direct, async page => {
    await openSidebarPage(page, "My jobs");
    await openWorkOrder(page, WORK_ORDER_ID);
    await expect(page.getByText("WOTEST3 internal staff-only dispatch note.", { exact: true })).toHaveCount(0);
    await expect(page.getByText("AFM email", { exact: true })).toHaveCount(0);

    await page.getByRole("button", { name: "Set ETA", exact: true }).click();
    let dialog = page.getByRole("dialog", { name: "Set ETA" });
    await dialog.getByRole("button", { name: "Set ETA", exact: true }).click();
    await expect(dialog).toBeHidden();

    await page.getByRole("button", { name: "Start work", exact: true }).click();
    dialog = page.getByRole("dialog", { name: "Start work" });
    await dialog.getByPlaceholder("What are you seeing on site?").fill("WOTEST3 first synthetic visit started.");
    await dialog.getByRole("button", { name: "Start work", exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText("7-Eleven FSM: Work in Progress", { exact: true })).toBeVisible();

    await page.locator('input[type="file"][multiple]').setInputFiles("public/p1-icon-192.png");
    await expect(page.getByText("Photos (1)", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: /View photos/ }).click();
    const individual = page.waitForEvent("download");
    await page.getByRole("button", { name: "Download photo 1", exact: true }).click();
    expect((await individual).suggestedFilename()).toBe("WOTEST3-photo-1.png");
    const archive = page.waitForEvent("download");
    await page.getByRole("button", { name: "Download all", exact: true }).click();
    expect((await archive).suggestedFilename()).toMatch(/\.zip$/i);
    await page.getByRole("button", { name: "x", exact: true }).click();
    await expect(page.getByText("Photos (0)", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "Pause (parts)", exact: true }).click();
    dialog = page.getByRole("dialog", { name: "Pause work" });
    await dialog.getByRole("combobox", { name: "Reason" }).click();
    await page.getByRole("option", { name: "Temporary fix - equipment partially working", exact: true }).click();
    await dialog.getByPlaceholder("Explain what was done so far...").fill("WOTEST3 temporary repair; transfer for the second visit.");
    await dialog.getByRole("button", { name: "Pause work", exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText("7-Eleven FSM: Awaiting Parts", { exact: true })).toBeVisible();
    await expect(page.getByText("Visit 1", { exact: true })).toBeVisible();
  });

  // A paused record can be transferred without borrowing the outgoing
  // contractor's identity or exposing the archived assignment to contractors.
  await asAccount(browser, accounts.manager, async page => {
    await openSidebarPage(page, "Work orders");
    await openWorkOrder(page, WORK_ORDER_ID);
    await page.getByRole("button", { name: "Reassign", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Reassign work order" });
    await dialog.getByRole("button", { name: "New contractor" }).click();
    await page.getByRole("option", { name: /Synthetic Company Admin/ }).first().click();
    await dialog.getByRole("button", { name: "Reassign", exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText("Synthetic Company Admin", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("Prior assignment history", { exact: true })).toBeVisible();
  });

  await expectMyJob(browser, accounts.direct, false);
  await expectMyJob(browser, accounts.companyAdminTwo, true);
  for (const account of [accounts.invoiceTech, accounts.reportTech, accounts.revocationTech]) {
    await expectMyJob(browser, account, false);
  }

  await asAccount(browser, accounts.companyAdmin, async page => {
    await openSidebarPage(page, "My jobs");
    await openWorkOrder(page, WORK_ORDER_ID);
    await expect(page.getByText("Prior assignment history", { exact: true })).toHaveCount(0);
    const technicianCard = page.locator(".card").filter({
      has: page.getByText("Technician on Job", { exact: true }),
    }).filter({ has: page.locator('button[aria-haspopup="listbox"]') }).first();
    const picker = technicianCard.locator('button[aria-haspopup="listbox"]');
    await picker.click();
    const assigned = page.waitForResponse(response =>
      response.url().includes("/rest/v1/rpc/assign_contractor_technician") && response.status() < 400,
    );
    await page.getByRole("option", { name: "Synthetic Invoice Technician", exact: true }).click();
    await assigned;
    await expect(picker).toContainText("Synthetic Invoice Technician");
  });

  await expectMyJob(browser, accounts.invoiceTech, true);
  for (const account of [accounts.reportTech, accounts.revocationTech, accounts.teamLead, accounts.teamMember]) {
    await expectMyJob(browser, account, false);
  }

  // Reassignment archives the outgoing contractor's visit and deliberately
  // starts a clean receiving assignment. The assigned invoice technician
  // starts its own visit one, pauses/resumes into visit two, completes field
  // work, verifies persistence after reload, and submits a PDF.
  await asAccount(browser, accounts.invoiceTech, async page => {
    await openSidebarPage(page, "My jobs");
    await openWorkOrder(page, WORK_ORDER_ID);
    await expect(page.getByRole("button", { name: "Start work", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Start work", exact: true }).click();
    let dialog = page.getByRole("dialog", { name: "Start work" });
    await dialog.getByPlaceholder("What are you seeing on site?").fill("WOTEST3 receiving assignment visit started.");
    await dialog.getByRole("button", { name: "Start work", exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText("Visit 1", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "Pause (parts)", exact: true }).click();
    dialog = page.getByRole("dialog", { name: "Pause work" });
    await dialog.getByRole("combobox", { name: "Reason" }).click();
    await page.getByRole("option", { name: "Temporary fix - equipment partially working", exact: true }).click();
    await dialog.getByPlaceholder("Explain what was done so far...").fill("WOTEST3 receiving assignment paused before its return visit.");
    await dialog.getByRole("button", { name: "Pause work", exact: true }).click();
    await expect(dialog).toBeHidden();

    await page.getByRole("button", { name: "Resume work", exact: true }).click();
    dialog = page.getByRole("dialog", { name: "Resume work" });
    await dialog.getByPlaceholder("What are you seeing on site?").fill("WOTEST3 receiving assignment return visit resumed.");
    await dialog.getByRole("button", { name: "Resume", exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText("Visit 2", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "Mark work complete", exact: true }).click();
    dialog = page.getByRole("dialog", { name: "Mark work complete" });
    await dialog.getByLabel("Equipment make").fill("Synthetic Make");
    await dialog.getByLabel("Asset model").fill("WOTEST3-MODEL");
    await dialog.getByLabel("Serial number").fill("WOTEST3-SERIAL");
    await dialog.getByLabel("Equipment year *").fill("2025");
    await dialog.getByRole("combobox", { name: "Resolution code" }).click();
    await page.getByRole("option", { name: "Current Asset Repaired", exact: true }).click();
    await dialog.getByLabel("Closing notes").fill("WOTEST3 second visit completed and calculation inputs verified.");
    await dialog.getByRole("button", { name: "Mark work complete", exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText("7-Eleven FSM: Completed", { exact: true })).toBeVisible();
    await expect(page.getByText("Portal: Completed", { exact: true })).toBeVisible();
    await expect(page.getByText("Portal: Pending 7-Eleven Submission", { exact: true })).toHaveCount(0);
    const progressCard = page.getByText("Progress", { exact: true }).locator("xpath=..");
    const completedStep = progressCard.getByText("Completed", { exact: true }).locator("xpath=../..");
    await expect(completedStep.locator("svg")).toHaveCount(1);
    await expect(page.getByText("Visit 1", { exact: true })).toBeVisible();
    await expect(page.getByText("Visit 2", { exact: true })).toBeVisible();

    await page.reload();
    await openSidebarPage(page, "My jobs");
    await openWorkOrder(page, WORK_ORDER_ID);
    await expect(page.getByText("7-Eleven FSM: Completed", { exact: true })).toBeVisible();
    await expect(page.getByText("Visit 1", { exact: true })).toBeVisible();
    await expect(page.getByText("Visit 2", { exact: true })).toBeVisible();
    await expect(page.getByText("WOTEST3-MODEL", { exact: true }).first()).toBeVisible();

    await uploadInvoice(page);
    page.once("dialog", confirmation => confirmation.accept());
    await page.getByRole("button", { name: "Done invoicing — close contractor job", exact: true }).click();
    await expect(page.getByText("Contractor job closed — invoicing complete", { exact: true })).toBeVisible();
  });

  // The second company administrator shares only the organization's submitted
  // invoice; no prior-assignment archive or staff-only note crosses the wall.
  await asAccount(browser, accounts.companyAdminTwo, async page => {
    await openSidebarPage(page, "Invoices");
    await page.getByRole("searchbox", { name: "Search contractor invoices" }).fill(INVOICE_NUMBER);
    await expect(page.getByText(`#${INVOICE_NUMBER}`, { exact: true }).first()).toBeVisible();
    await expect(page.getByText("WOTEST3 internal staff-only dispatch note.", { exact: true })).toHaveCount(0);
  });

  await asAccount(browser, accounts.manager, async page => {
    await openContractorInvoice(page, INVOICE_NUMBER, "Submitted");
    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: "Download PDF", exact: true }).click();
    expect((await download).suggestedFilename()).toMatch(/(?:test-invoice-7eleven|WOTEST3-PDF).*\.pdf/i);
    await page.getByRole("button", { name: "Approve", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: `Approve invoice #${INVOICE_NUMBER}` });
    await dialog.getByRole("button", { name: "Approve", exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText("Approved", { exact: true }).first()).toBeVisible();
  });

  await asAccount(browser, accounts.controller, async page => {
    await openContractorInvoice(page, INVOICE_NUMBER, "Approved");
    await expect(page.getByText("Approved", { exact: true }).first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Approve", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Reject", exact: true })).toHaveCount(0);
    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: "Download PDF", exact: true }).click();
    expect((await download).suggestedFilename()).toMatch(/(?:test-invoice-7eleven|WOTEST3-PDF).*\.pdf/i);
  });

  await asAccount(browser, accounts.accounting, async page => {
    await openSidebarPage(page, "Contractor bills");
    await page.getByRole("button", { name: "Approved", exact: true }).click();
    await page.getByRole("searchbox", { name: "Search contractor invoices" }).fill(INVOICE_NUMBER);
    await page.getByRole("checkbox", {
      name: `Select contractor bill ${INVOICE_NUMBER} for payables handoff`,
    }).check();
    const zip = page.waitForEvent("download");
    await page.getByRole("button", { name: "Download selected bills (1)", exact: true }).click();
    expect((await zip).suggestedFilename()).toMatch(/^Contractor-Bills-.*\.zip$/i);
    const batch = page.locator("article").filter({ hasText: INVOICE_NUMBER }).first();
    await expect(batch).toBeVisible();
    await batch.getByRole("button", { name: "Confirm entered", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: /confirmed as entered in QuickBooks/i })).toBeVisible();
    await expect(batch.getByText("Entered in QuickBooks", { exact: true })).toBeVisible();
  });
});
