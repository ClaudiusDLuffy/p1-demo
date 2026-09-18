import { accounts, expect, login, openSidebarPage, test } from "./fixtures.mjs";

async function openInvoice(page, account, invoiceNumber, tab = "All") {
  await login(page, account);
  await openSidebarPage(page, account === accounts.direct ? "Invoices" : "Contractor bills");
  if (tab !== "All") await page.getByRole("button", { name: tab, exact: true }).click();
  const search = page.getByRole("searchbox", { name: "Search contractor invoices" });
  await search.fill(invoiceNumber);
  const number = page.getByText(`#${invoiceNumber}`, { exact: true }).first();
  await expect(number).toBeVisible();
  await number.click();
  await expect(page.getByRole("button", { name: "Download PDF", exact: true })).toBeVisible();
}

async function listboxLabels(page, combobox) {
  const nativeOptions = combobox.locator("option");
  if (await nativeOptions.count()) return nativeOptions.allTextContents();
  await combobox.click();
  const listbox = page.getByRole("listbox");
  await expect(listbox).toBeVisible();
  const options = listbox.getByRole("option");
  await expect(options.first()).toBeVisible();
  const labels = (await options.allTextContents()).map(label => label.replace(/Selected$/, ""));
  await page.keyboard.press("Escape");
  return labels;
}

test("contractor-bill tabs, sorting, searching, and column sorting remain interactive", async ({ page }) => {
  await login(page, accounts.manager);
  await openSidebarPage(page, "Contractor bills");
  for (const tab of ["All", "Draft", "Submitted", "Revised", "Rejected", "Approved", "Entered in QuickBooks"]) {
    await expect(page.getByRole("button", { name: tab, exact: true })).toBeVisible();
  }
  expect(await listboxLabels(page, page.getByRole("combobox", { name: "Sort invoices by" }))).toEqual([
    "Recently added", "Invoice #", "WO #", "Contractor", "Status", "Invoice date", "Store", "Lines", "Total",
  ]);
  await page.getByRole("button", { name: "Invoice#", exact: true }).click();
  await expect(page.getByRole("columnheader", { name: /Invoice#/ })).toHaveAttribute("aria-sort", "ascending");
  await page.getByRole("button", { name: "Invoice#", exact: true }).click();
  await expect(page.getByRole("columnheader", { name: /Invoice#/ })).toHaveAttribute("aria-sort", "descending");
  const search = page.getByRole("searchbox", { name: "Search contractor invoices" });
  await search.fill("E2E-SUBMITTED-APPROVE");
  await expect(page.getByText("#E2E-SUBMITTED-APPROVE", { exact: true }).first()).toBeVisible();
  await search.fill("does-not-exist");
  await expect(page.getByText("No invoices match your search.", { exact: true }).first()).toBeVisible();
});

test("manager downloads and approves one submitted invoice", async ({ page }) => {
  await openInvoice(page, accounts.manager, "E2E-SUBMITTED-APPROVE", "Submitted");
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download PDF", exact: true }).click();
  expect((await download).suggestedFilename()).toMatch(/E2E-SUBMITTED-APPROVE.*\.pdf/i);

  await page.getByRole("button", { name: "Approve", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Approve invoice #E2E-SUBMITTED-APPROVE" });
  await dialog.getByRole("button", { name: "Approve", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText("Approved", { exact: true }).first()).toBeVisible();
});

test("manager rejects one submitted invoice with a contractor-visible reason", async ({ page }) => {
  await openInvoice(page, accounts.manager, "E2E-SUBMITTED-REJECT", "Submitted");
  await page.getByRole("button", { name: "Reject", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Reject invoice #E2E-SUBMITTED-REJECT" });
  const confirm = dialog.getByRole("button", { name: "Reject", exact: true });
  await expect(confirm).toBeDisabled();
  await dialog.getByPlaceholder("e.g. Missing parts receipt, labor hours unclear…")
    .fill("Synthetic rejection requires a clearer labor description.");
  await confirm.click();
  await expect(dialog).toBeHidden();
  await page.getByRole("button", { name: "Rejected", exact: true }).click();
  const rejectedInvoice = page.getByText("#E2E-SUBMITTED-REJECT", { exact: true }).first();
  await expect(rejectedInvoice).toBeVisible();
  await expect(page.getByText("Rejected", { exact: true }).first()).toBeVisible();
  await rejectedInvoice.click();
  await page.getByRole("button", { name: "Undo rejection and approve", exact: true }).click();
  const retract = page.getByRole("dialog", { name: "Undo rejection for #E2E-SUBMITTED-REJECT" });
  await retract.getByRole("button", { name: "Undo and approve", exact: true }).click();
  await expect(retract).toBeHidden();
  await expect(page.getByText("Approved", { exact: true }).first()).toBeVisible();
});

test("contractor corrects a rejected invoice, verifies dropdown contents, and resubmits", async ({ page }) => {
  await login(page, accounts.direct);
  await openSidebarPage(page, "Invoices");
  await page.getByRole("button", { name: "Rejected", exact: true }).click();
  await page.getByRole("searchbox", { name: "Search contractor invoices" }).fill("E2E-REJECTED");
  await page.getByRole("button", { name: "Edit and resubmit", exact: true }).first().click();
  const dialog = page.getByRole("dialog", { name: "Correct invoice #E2E-REJECTED" });
  await expect(dialog).toBeVisible();

  expect(await listboxLabels(page, dialog.getByRole("combobox", { name: "Terms" }))).toEqual([
    "Net 30", "Net 15", "Due on receipt",
  ]);
  expect(await listboxLabels(page, dialog.getByRole("combobox", { name: "Line 1 type" }))).toEqual([
    "Truck Charge", "Labor", "Parts/Hardware", "Shipping", "Other",
  ]);
  for (const button of ["+ Labor", "+ Truck Charge", "+ Parts", "+ Shipping", "+ Other"]) {
    await expect(dialog.getByRole("button", { name: button, exact: true })).toBeVisible();
  }

  await dialog.getByLabel("Line 1 description").fill("Synthetic corrected labor description");
  await dialog.getByRole("button", { name: "+ Other", exact: true }).click();
  await expect(dialog.getByLabel("Line 2 description")).toBeVisible();
  await dialog.getByRole("button", { name: "Remove line 2" }).click();
  await expect(dialog.getByLabel("Line 2 description")).toHaveCount(0);
  await dialog.getByRole("button", { name: "Resubmit invoice", exact: true }).click();
  await expect(dialog).toBeHidden();
  const submitted = page.getByRole("dialog", { name: "Invoice #E2E-REJECTED submitted" });
  await submitted.getByRole("button", { name: "Done", exact: true }).click();
  await expect(submitted).toBeHidden();
  await page.getByRole("button", { name: "All", exact: true }).click();
  await expect(page.getByText("#E2E-REJECTED", { exact: true }).first()).toBeVisible();
  await expect(page.getByText(/Submitted|Revised/, { exact: true }).first()).toBeVisible();
});

test("contractor deletes an owned draft through the confirmation boundary", async ({ page }) => {
  await openInvoice(page, accounts.direct, "E2E-DRAFT-DELETE", "Draft");
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Delete invoice" });
  await dialog.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText("#E2E-DRAFT-DELETE", { exact: true })).toHaveCount(0);
});

test("staff can delete a contractor draft through the same audited confirmation boundary", async ({ page }) => {
  await openInvoice(page, accounts.manager, "E2E-STAFF-DELETE", "Draft");
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Delete invoice" });
  await dialog.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText("#E2E-STAFF-DELETE", { exact: true })).toHaveCount(0);
});

test("manager batch-approves two submitted contractor invoices atomically", async ({ page }) => {
  await login(page, accounts.manager);
  await openSidebarPage(page, "Contractor bills");
  await page.getByRole("searchbox", { name: "Search contractor invoices" }).fill("E2E-BATCH-APPROVE");
  for (const invoiceNumber of ["E2E-BATCH-APPROVE-A", "E2E-BATCH-APPROVE-B"]) {
    await page.getByRole("checkbox", { name: `Select invoice ${invoiceNumber} for batch review` }).check();
  }
  await page.getByRole("button", { name: "Approve selected", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Approve 2 invoices" });
  await dialog.getByRole("button", { name: "Approve 2", exact: true }).click();
  await expect(page.locator(".app-toast")).toContainText("2 invoices approved");
  await expect(dialog).toBeHidden();
  for (const invoiceNumber of ["E2E-BATCH-APPROVE-A", "E2E-BATCH-APPROVE-B"]) {
    const row = page.getByRole("row").filter({ hasText: `#${invoiceNumber}` });
    await expect(row.getByText("Approved", { exact: true })).toBeVisible();
  }
});

test("manager batch-rejects two submitted contractor invoices with one shared reason", async ({ page }) => {
  await login(page, accounts.manager);
  await openSidebarPage(page, "Contractor bills");
  await page.getByRole("searchbox", { name: "Search contractor invoices" }).fill("E2E-BATCH-REJECT");
  for (const invoiceNumber of ["E2E-BATCH-REJECT-A", "E2E-BATCH-REJECT-B"]) {
    await page.getByRole("checkbox", { name: `Select invoice ${invoiceNumber} for batch review` }).check();
  }
  await page.getByRole("button", { name: "Reject selected", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Reject 2 invoices" });
  const reject = dialog.getByRole("button", { name: "Reject 2", exact: true });
  await expect(reject).toBeDisabled();
  await dialog.getByLabel("Shared rejection reason").fill("Synthetic batch rejection requires supporting receipts.");
  await expect(reject).toBeEnabled();
  await reject.click();
  await expect(page.locator(".app-toast")).toContainText(/2 invoices rejected/);
  await expect(dialog).toBeHidden();
  for (const invoiceNumber of ["E2E-BATCH-REJECT-A", "E2E-BATCH-REJECT-B"]) {
    const row = page.getByRole("row").filter({ hasText: `#${invoiceNumber}` });
    await expect(row.getByText("Rejected", { exact: true })).toBeVisible();
  }
});

test("accounting can place and release a payment hold with required audit reasons", async ({ page }) => {
  await openInvoice(page, accounts.accounting, "E2E-APPROVED-HOLD", "Approved");

  await page.getByRole("button", { name: "Hold / Do not pay", exact: true }).click();
  let dialog = page.getByRole("dialog", { name: "Hold invoice #E2E-APPROVED-HOLD" });
  const placeHold = dialog.getByRole("button", { name: "Place hold", exact: true });
  await expect(placeHold).toBeDisabled();
  await dialog.getByLabel("Required reason").fill("Synthetic duplicate-payment review required.");
  await expect(placeHold).toBeEnabled();
  await placeHold.click();
  await expect(dialog).toBeHidden();
  await expect(page.locator(".app-toast")).toContainText(/placed on hold/i);
  await expect(page.getByRole("button", { name: "Release payment hold", exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Back to invoices", exact: true }).click();
  const holds = page.locator('[aria-label="Current payment holds"]');
  await expect(holds.getByText("#E2E-APPROVED-HOLD", { exact: true })).toBeVisible();
  await expect(page.getByRole("checkbox", {
    name: "Select contractor bill E2E-APPROVED-HOLD for payables handoff",
  })).toHaveCount(0);
  await page.getByRole("table").getByText("#E2E-APPROVED-HOLD", { exact: true }).click();

  await page.getByRole("button", { name: "Release payment hold", exact: true }).click();
  dialog = page.getByRole("dialog", { name: "Release hold for #E2E-APPROVED-HOLD" });
  const release = dialog.getByRole("button", { name: "Release hold", exact: true });
  await expect(release).toBeDisabled();
  await dialog.getByLabel("Required reason").fill("Synthetic review completed and the contractor bill is cleared.");
  await expect(release).toBeEnabled();
  await release.click();
  await expect(dialog).toBeHidden();
  await expect(page.locator(".app-toast")).toContainText(/Payment hold released/i);
  await expect(page.getByRole("button", { name: "Hold / Do not pay", exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Correct total", exact: true }).click();
  dialog = page.getByRole("dialog", { name: "Correct invoice #E2E-APPROVED-HOLD total" });
  await dialog.getByLabel("Corrected total").fill("245.75");
  await dialog.getByLabel("Reason (optional)").fill("Synthetic correction matched the contractor document.");
  await dialog.getByRole("button", { name: "Save correction", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator(".app-toast")).toContainText(/total corrected to \$245\.75/i);
});

test("accounting stages one selected contractor bill, downloads its evidence, and explicitly confirms QuickBooks entry", async ({ page }) => {
  await login(page, accounts.accounting);
  await openSidebarPage(page, "Contractor bills");
  await page.getByRole("button", { name: "Approved", exact: true }).click();
  await page.getByRole("searchbox", { name: "Search contractor invoices" }).fill("E2E-APPROVED-HANDOFF");
  await expect(page.getByText("#E2E-APPROVED-HANDOFF", { exact: true }).first()).toBeVisible();

  const select = page.getByRole("checkbox", {
    name: "Select contractor bill E2E-APPROVED-HANDOFF for payables handoff",
  }).first();
  await select.check();
  const stage = page.getByRole("button", { name: "Download selected bills (1)", exact: true });
  await expect(stage).toBeEnabled();
  const initialDownload = page.waitForEvent("download");
  await stage.click();
  expect((await initialDownload).suggestedFilename()).toMatch(/^Contractor-Bills-.*\.zip$/i);
  await expect(page.getByRole("status").filter({ hasText: /staged.*remain Approved/i })).toBeVisible();

  const batch = page.locator("article").filter({ hasText: "E2E-APPROVED-HANDOFF" }).first();
  await expect(batch).toBeVisible();
  const redownload = page.waitForEvent("download");
  await batch.getByRole("button", { name: "Re-download ZIP", exact: true }).click();
  expect((await redownload).suggestedFilename()).toMatch(/^Contractor-Bills-.*\.zip$/i);

  const auditDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export audit CSV", exact: true }).click();
  expect((await auditDownload).suggestedFilename()).toMatch(/^Contractor-Bill-Handoff-Audit-.*\.csv$/i);

  await batch.getByRole("button", { name: "Confirm entered", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: /confirmed as entered in QuickBooks/i })).toBeVisible();
  await expect(batch.getByText("Entered in QuickBooks", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Entered in QuickBooks", exact: true }).click();
  await expect(page.getByText("#E2E-APPROVED-HANDOFF", { exact: true }).first()).toBeVisible();
});

test("accounting can manually cancel a handoff and a later payment hold automatically cancels its replacement batch", async ({ page }) => {
  await login(page, accounts.accounting);
  await openSidebarPage(page, "Contractor bills");
  await page.getByRole("button", { name: "Approved", exact: true }).click();
  await page.getByRole("searchbox", { name: "Search contractor invoices" }).fill("E2E-APPROVED-CANCEL");

  const select = page.getByRole("checkbox", {
    name: "Select contractor bill E2E-APPROVED-CANCEL for payables handoff",
  });
  await select.check();
  let download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download selected bills (1)", exact: true }).click();
  expect((await download).suggestedFilename()).toMatch(/^Contractor-Bills-.*\.zip$/i);

  let pendingBatch = page.locator("article")
    .filter({ hasText: "E2E-APPROVED-CANCEL" })
    .filter({ hasText: "Awaiting QuickBooks entry confirmation" });
  await expect(pendingBatch).toHaveCount(1);
  page.once("dialog", prompt => prompt.accept("Synthetic manual cancellation before accounting entry."));
  await pendingBatch.getByRole("button", { name: "Cancel batch", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: /cancelled; its approved contractor bills are available/i })).toBeVisible();
  const manuallyCancelled = page.locator("article")
    .filter({ hasText: "E2E-APPROVED-CANCEL" })
    .filter({ hasText: "Synthetic manual cancellation before accounting entry." });
  await expect(manuallyCancelled.getByText("Cancelled", { exact: true })).toBeVisible();

  await expect(select).toBeVisible();
  await select.check();
  download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download selected bills (1)", exact: true }).click();
  expect((await download).suggestedFilename()).toMatch(/^Contractor-Bills-.*\.zip$/i);
  pendingBatch = page.locator("article")
    .filter({ hasText: "E2E-APPROVED-CANCEL" })
    .filter({ hasText: "Awaiting QuickBooks entry confirmation" });
  await expect(pendingBatch).toHaveCount(1);

  await page.getByRole("table").getByText("#E2E-APPROVED-CANCEL", { exact: true }).click();
  await page.getByRole("button", { name: "Hold / Do not pay", exact: true }).click();
  const holdDialog = page.getByRole("dialog", { name: "Hold invoice #E2E-APPROVED-CANCEL" });
  await holdDialog.getByLabel("Required reason").fill("Synthetic hold must invalidate the staged package.");
  await holdDialog.getByRole("button", { name: "Place hold", exact: true }).click();
  await expect(holdDialog).toBeHidden();
  await page.getByRole("button", { name: "Back to invoices", exact: true }).click();
  await page.getByRole("button", { name: "View audit log", exact: true }).click();

  const automaticallyCancelled = page.locator("article")
    .filter({ hasText: "E2E-APPROVED-CANCEL" })
    .filter({ hasText: "Automatically cancelled because invoice #E2E-APPROVED-CANCEL was placed on hold" });
  await expect(automaticallyCancelled).toHaveCount(1);
  await expect(automaticallyCancelled.getByText("Cancelled", { exact: true })).toBeVisible();

  const holds = page.locator('[aria-label="Current payment holds"]');
  const heldInvoice = holds.locator("div").filter({ hasText: "#E2E-APPROVED-CANCEL" }).last();
  page.once("dialog", prompt => prompt.accept("Synthetic cancellation evidence verified."));
  await heldInvoice.getByRole("button", { name: "Release", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: /Payment hold released for invoice #E2E-APPROVED-CANCEL/i })).toBeVisible();
});
