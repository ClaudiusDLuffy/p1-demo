import { devices } from "@playwright/test";
import {
  accounts,
  expect,
  login,
  openSidebarPage,
  openWorkOrder,
  test,
  waitForApplicationRequestsToSettle,
} from "./fixtures.mjs";

const WORK_ORDER_ID = "WOTEST4";
const CAPITAL_QUOTE_NUMBER = "WOTEST4-CAP-Q";
const FINAL_INVOICE_NUMBER = "WOTEST4-CAP-FINAL";
const mobileDevice = { ...devices["iPhone 13"] };
delete mobileDevice.defaultBrowserType;

async function asAccount(browser, account, run, options = {}) {
  const context = await browser.newContext(options);
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
    // Detail queries can still be settling after the visible assertions pass.
    // Let those successful reads finish before closing this isolated context;
    // WebKit otherwise reports teardown cancellations as access-control errors.
    await waitForApplicationRequestsToSettle(page);
    expect(fatal, `${account.name} browser errors and HTTP 5xx responses`).toEqual([]);
  } finally {
    await context.close();
  }
}

async function openStaffWorkOrder(page) {
  await openSidebarPage(page, "Work orders");
  await openWorkOrder(page, WORK_ORDER_ID);
}

async function openContractorWorkOrder(page, navigation = "My jobs") {
  await openSidebarPage(page, navigation);
  await openWorkOrder(page, WORK_ORDER_ID);
}

async function expectContractorVisibility(browser, account, visible) {
  await asAccount(browser, account, async page => {
    await openSidebarPage(page, "My jobs");
    await page.getByRole("searchbox", { name: "Search my jobs" }).fill(WORK_ORDER_ID);
    if (visible) {
      await expect(page.getByText(WORK_ORDER_ID, { exact: true }).first()).toBeVisible();
    } else {
      await expect(page.getByText("No work orders match your search.", { exact: true })).toBeVisible();
    }
  });
}

async function expectContractorClosedVisibility(browser, account, visible) {
  await asAccount(browser, account, async page => {
    await openSidebarPage(page, "Closed jobs");
    await page.getByRole("textbox", { name: "Search closed jobs" }).fill(WORK_ORDER_ID);
    if (visible) {
      await expect(page.getByRole("button", { name: new RegExp(`^${WORK_ORDER_ID} Copy work order`) })).toBeVisible();
    } else {
      await expect(page.getByText("No closed work orders match the current filters.", { exact: true }).first()).toBeVisible();
    }
  });
}

async function fillKnownBillingCalculation(dialog, prefix, { includesPurchasedPart = false } = {}) {
  const invoiceNumber = dialog.getByLabel("Invoice #");
  await invoiceNumber.fill(prefix);
  await expect(invoiceNumber).toHaveValue(prefix);
  const territory = dialog.getByRole("combobox", { name: "Invoice territory" });
  await expect(territory).toContainText("Texas");

  await dialog.getByRole("button", { name: /^\+ Labor/ }).click();
  const laborLine = includesPurchasedPart ? 2 : 1;
  await dialog.getByLabel(`Line ${laborLine} description`).fill(`${prefix} synthetic labor`);
  await dialog.getByLabel(`Line ${laborLine} quantity`).fill("2.5");
  await dialog.getByLabel(`Line ${laborLine} rate`).fill("100");

  if (includesPurchasedPart) {
    await expect(dialog.getByLabel("Line 1 description")).toHaveValue(
      "P1 ordered part: WOTEST4 replacement compressor (WOT4-COMP-01)",
    );
    await expect(dialog.getByLabel("Line 1 description")).toHaveAttribute("readonly", "");
    await expect(dialog.getByLabel("Line 1 quantity")).toHaveValue("2");
    await expect(dialog.getByLabel("Line 1 rate")).toHaveValue("232.19");
    await expect(dialog.getByLabel("Line 1 markup percent")).toHaveValue("25");
  } else {
    await dialog.getByRole("button", { name: /^\+ Parts/ }).click();
    await dialog.getByLabel("Line 2 description").fill(`${prefix} synthetic compressor`);
    await dialog.getByLabel("Line 2 quantity").fill("2");
    await dialog.getByLabel("Line 2 rate").fill("80");
    await dialog.getByLabel("Line 2 markup percent").fill("25");
    await dialog.getByLabel("Line 2 taxable").check();
  }
  await dialog.getByLabel("Manual sales tax amount").fill("16.50");

  await expect(dialog.getByText(includesPurchasedPart ? /^\$714\.38$/ : /^\$450(?:\.00)?$/).first()).toBeVisible();
  await expect(dialog.getByText(/^\$16\.5(?:0)?$/).first()).toBeVisible();
  await expect(dialog.getByText(includesPurchasedPart ? /^\$730\.88$/ : /^\$466\.5(?:0)?$/).first()).toBeVisible();
}

test("WOTEST4 combines team dispatch, capital approval, field return visits, files, parts, and final billing", async ({ browser }) => {
  test.setTimeout(300_000);

  // Start from an unassigned P1 emergency record. Confirm that operational
  // edits and staff-only context persist before any contractor gains access.
  await asAccount(browser, accounts.manager, async page => {
    await openStaffWorkOrder(page);
    await expect(page.getByText("Portal: Unassigned", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Edit work order", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Edit work order" });
    await dialog.getByLabel("Short Description").fill("WOTEST4 capital team return-visit workflow");
    await dialog.getByLabel("Description", { exact: true }).fill(
      "Synthetic capital workflow combining legacy team dispatch, quote authorization, work reporting, parts, photos, return visits, and final billing.",
    );
    await dialog.getByRole("button", { name: "Save changes", exact: true }).click();
    await expect(dialog).toBeHidden();
    await page.getByPlaceholder("Add an internal P1 note...").fill("WOTEST4 staff-only capital planning note.");
    await page.getByRole("button", { name: "Post internal note", exact: true }).click();
    await expect(page.getByText("WOTEST4 staff-only capital planning note.", { exact: true })).toBeVisible();
  });

  for (const account of [accounts.teamLead, accounts.teamMember, accounts.direct, accounts.companyAdmin]) {
    await expectContractorVisibility(browser, account, false);
  }

  // Dispatch to the canonical company, then let its administrator assign the
  // work to the team lead. Contractor ownership never moves to a child login.
  await asAccount(browser, accounts.dispatcher, async page => {
    await openStaffWorkOrder(page);
    await page.getByRole("button", { name: "Assign to contractor…", exact: true }).click();
    await page.getByRole("option", { name: /Synthetic Company Admin/ }).first().click();
    await expect(page.getByText("Synthetic Company Admin", { exact: true }).first()).toBeVisible();
  });

  await asAccount(browser, accounts.companyAdmin, async page => {
    await openContractorWorkOrder(page);
    const technicianCard = page.locator(".card").filter({
      has: page.getByText("Technician on Job", { exact: true }),
    }).filter({ has: page.locator('button[aria-haspopup="listbox"]') }).first();
    const picker = technicianCard.locator('button[aria-haspopup="listbox"]');
    await picker.click();
    await page.getByRole("option", { name: "Synthetic Team Lead", exact: true }).click();
    await expect(picker).toContainText("Synthetic Team Lead");
  });

  await expectContractorVisibility(browser, accounts.teamLead, true);
  await expectContractorVisibility(browser, accounts.teamMember, false);

  await asAccount(browser, accounts.teamLead, async page => {
    await openSidebarPage(page, "My Team");
    await page.getByRole("searchbox", { name: "Search team work orders" }).fill(WORK_ORDER_ID);
    const row = page.getByRole("row").filter({ has: page.getByText(WORK_ORDER_ID, { exact: true }) });
    await expect(row).toBeVisible();
    const picker = row.locator('button[aria-haspopup="listbox"]');
    await picker.click();
    await expect(page.getByRole("option", { name: "Synthetic Team Lead", exact: true })).toBeVisible();
    await expect(page.getByRole("option", { name: "Synthetic Team Member", exact: true })).toBeVisible();
    await expect(page.getByRole("option", { name: "Synthetic Direct Contractor", exact: true })).toHaveCount(0);
    await expect(page.getByRole("option", { name: "Synthetic Report Technician", exact: true })).toHaveCount(0);
    await page.getByRole("option", { name: "Synthetic Team Member", exact: true }).click();
    await row.getByRole("button", { name: "Save", exact: true }).click();
    await expect(row).toContainText("Synthetic Team Member");
  });

  await expectContractorVisibility(browser, accounts.teamMember, true);
  await expectContractorVisibility(browser, accounts.teamLead, true);
  await expectContractorVisibility(browser, accounts.direct, false);
  await expectContractorVisibility(browser, accounts.companyAdmin, true);

  // A capital flag must place the job behind the quote/authorization hold and
  // retain the child assignment without exposing the internal planning note.
  await asAccount(browser, accounts.manager, async page => {
    await openStaffWorkOrder(page);
    await page.getByRole("button", { name: "Flag capital", exact: true }).click();
    await expect(page.getByText("Portal: Capital Replacement", { exact: true }).first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Create capital quote", exact: true })).toBeVisible();
  });

  await asAccount(browser, accounts.teamLead, async page => {
    await openContractorWorkOrder(page);
    await expect(page.getByText("WOTEST4 staff-only capital planning note.", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Start work", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Resume work", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Create or upload invoice/ })).toHaveCount(0);
  });

  // Prepare the complete capital quote, verify calculations, PDF access, and
  // the rule that capital quotes cannot be exported as customer-invoice CSV.
  await asAccount(browser, accounts.backoffice, async page => {
    await openStaffWorkOrder(page);
    await page.getByRole("button", { name: "Create capital quote", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Create capital quote for 7-Eleven" });
    await expect(dialog.getByText(/separate from the final invoice/i)).toBeVisible();
    await fillKnownBillingCalculation(dialog, CAPITAL_QUOTE_NUMBER);
    await dialog.getByRole("button", { name: "Prepare Quote", exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText(`#${CAPITAL_QUOTE_NUMBER}`, { exact: true })).toBeVisible();
    const quotePdf = page.waitForEvent("download");
    await page.getByRole("button", { name: "Download PDF", exact: true }).click();
    expect((await quotePdf).suggestedFilename()).toMatch(/WOTEST4-CAP-Q.*\.pdf/i);
    await expect(page.getByRole("button", { name: "Download SaasAnt CSV", exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "Submit Quote to 7-Eleven", exact: true }).click();
    const confirm = page.getByRole("dialog", { name: "Confirm capital quote" });
    await confirm.getByRole("button", { name: "Submit Quote to 7-Eleven", exact: true }).click();
    await expect(confirm).toBeHidden();
  });

  await asAccount(browser, accounts.teamMember, async page => {
    await openContractorWorkOrder(page);
    await expect(page.getByText(/capital work is waiting for P1 authorization/i)).toBeVisible();
    await expect(page.getByRole("button", { name: "Start work", exact: true })).toHaveCount(0);
  });

  await asAccount(browser, accounts.manager, async page => {
    await openStaffWorkOrder(page);
    await expect(page.getByText("Portal: Pending Capital Completion", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Authorize & resume capital work", exact: true }).click();
    await expect(page.getByText("7-Eleven FSM: Dispatched", { exact: true })).toBeVisible();
  });

  // At a narrow mobile viewport, the team lead runs visit one on behalf of the
  // assigned child, sends both activity channels, uploads evidence, creates a
  // part, and submits a work report. The report must document work without
  // replacing the active visit or falsely completing progress.
  await asAccount(browser, accounts.teamLead, async page => {
    // Contractor login already lands on My jobs. At this deliberately narrow
    // viewport the desktop sidebar is hidden, so open the assigned record from
    // the mobile list instead of asking the desktop-only navigation helper to
    // click an invisible control.
    await openWorkOrder(page, WORK_ORDER_ID);
    await page.getByRole("button", { name: "Set ETA", exact: true }).click();
    let dialog = page.getByRole("dialog", { name: "Set ETA" });
    await dialog.getByRole("button", { name: "Set ETA", exact: true }).click();
    await expect(dialog).toBeHidden();

    await page.getByRole("button", { name: "Start work", exact: true }).click();
    dialog = page.getByRole("dialog", { name: "Start work" });
    await dialog.getByPlaceholder("What are you seeing on site?").fill("WOTEST4 capital equipment removal started.");
    await dialog.getByRole("button", { name: "Start work", exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText("Visit 1", { exact: true })).toBeVisible();

    await page.getByPlaceholder("Enter the service or job update that must be copied to 7-Eleven...")
      .fill("WOTEST4 old equipment removed; replacement preparation started.");
    await page.getByRole("button", { name: "Post 7-Eleven update", exact: true }).click();
    await page.getByPlaceholder("Write a message to P1 and the assigned contractor...")
      .fill("WOTEST4 contractor message visible to current assignment only.");
    await page.getByRole("button", { name: "Send message", exact: true }).click();

    await page.locator('input[type="file"][multiple]').setInputFiles("public/p1-icon-192.png");
    await expect(page.getByText("Photos (1)", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "+ Add part", exact: true }).first().click();
    await expect(page.getByText("New part", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "Submit work report", exact: true }).click();
    dialog = page.getByRole("dialog", { name: "Submit work report" });
    await expect(dialog.getByText(/does not check in, check out, resume, or complete/i)).toBeVisible();
    await dialog.getByLabel("Technician name").fill("Synthetic Team Member");
    await dialog.getByLabel("Arrival time *").fill("2026-09-19T08:00");
    await dialog.getByLabel("Departure time *").fill("2026-09-19T09:00");
    await dialog.getByLabel("Work performed *").fill("WOTEST4 documented capital preparation without changing visit state.");
    await dialog.getByRole("button", { name: "Submit report", exact: true }).click();
    await expect(dialog).toBeHidden();
    await waitForApplicationRequestsToSettle(page);
    await page.reload();
    await expect(page.locator(".app-root")).toBeVisible();
    await openWorkOrder(page, WORK_ORDER_ID);
    await expect(page.getByText("Work report submitted for Synthetic Team Member.", { exact: true })).toBeVisible();
    await expect(page.getByText("7-Eleven FSM: Work in Progress", { exact: true })).toBeVisible();
    await expect(page.getByText("Visit 1", { exact: true })).toBeVisible();
    await expect(page.getByText("Visit 2", { exact: true })).toHaveCount(0);

    await page.getByRole("button", { name: "Pause (parts)", exact: true }).click();
    dialog = page.getByRole("dialog", { name: "Pause work" });
    await dialog.getByRole("combobox", { name: "Reason" }).click();
    await page.getByRole("option", { name: "Temporary fix - equipment partially working", exact: true }).click();
    await dialog.getByPlaceholder("Explain what was done so far...").fill("WOTEST4 paused while replacement components are ordered.");
    await dialog.getByRole("button", { name: "Pause work", exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole("button", { name: "Resume work", exact: true })).toBeVisible();

    // The lead may correct the completed visit on behalf of the assigned team
    // member; the visible activity author remains the lead for accountability.
    await page.getByRole("button", { name: "Correct actual time", exact: true }).click();
    const checkinDate = page.getByLabel("Actual check-in date");
    const checkinTime = page.getByLabel("Actual check-in time");
    const corrected = new Date(`${await checkinDate.inputValue()}T${await checkinTime.inputValue()}:00Z`);
    corrected.setUTCMinutes(corrected.getUTCMinutes() - 1);
    await checkinDate.fill(corrected.toISOString().slice(0, 10));
    await checkinTime.fill(corrected.toISOString().slice(11, 16));
    const correctionReason = "Team lead verified the crew timesheet.";
    await page.getByPlaceholder("Explain why the recorded time was inaccurate").fill(correctionReason);
    await page.getByRole("button", { name: "Save correction", exact: true }).click();
    await expect(page.getByText(`Synthetic Team Lead corrected visit time: ${correctionReason}`, { exact: true })).toBeVisible();
  }, mobileDevice);

  // Staff can see both contractor channels, but only staff can add procurement
  // cost/status. Refresh proves the combined state is not merely optimistic.
  await asAccount(browser, accounts.manager, async page => {
    await openStaffWorkOrder(page);
    await expect(page.getByText("WOTEST4 old equipment removed; replacement preparation started.", { exact: true })).toBeVisible();
    await expect(page.getByText("WOTEST4 contractor message visible to current assignment only.", { exact: true })).toBeVisible();
    const part = page.getByText("New part", { exact: true })
      .locator("xpath=ancestor::div[.//button[normalize-space()='Edit']][1]");
    await part.getByRole("button", { name: "Edit", exact: true }).click();
    await page.getByLabel("Description", { exact: true }).fill("WOTEST4 replacement compressor");
    await page.getByLabel("Part #", { exact: true }).fill("WOT4-COMP-01");
    await page.getByLabel("Qty", { exact: true }).fill("2");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await page.getByRole("button", { name: "P1 to order", exact: true }).click();
    await page.getByLabel("P1 unit cost for WOTEST4 replacement compressor").fill("185.75");
    await page.getByRole("combobox", { name: "P1 purchasing status for WOTEST4 replacement compressor" }).click();
    await page.getByRole("option", { name: "Ordered", exact: true }).click();
    await expect(page.getByText("P1 ordered", { exact: true })).toBeVisible();
    // Persisted UI is already visible, but the mutation's invalidation reads
    // must settle before a deliberate hard reload. Safari/WebKit surfaces
    // canceled cross-origin reads as page errors if reload interrupts them.
    await waitForApplicationRequestsToSettle(page);
    await page.reload();
    await openStaffWorkOrder(page);
    await expect(page.getByText("WOTEST4 replacement compressor", { exact: false }).first()).toBeVisible();
    await expect(page.getByLabel("P1 unit cost for WOTEST4 replacement compressor")).toHaveValue("185.75");
    await expect(page.getByText("P1 ordered", { exact: true })).toBeVisible();
  });

  // The return visit is a genuine second visit performed by the lead on behalf
  // of the same assigned technician. Completion must update the timeline and
  // progress immediately while preserving both identities and capital state.
  await asAccount(browser, accounts.teamLead, async page => {
    await openContractorWorkOrder(page);
    await page.getByRole("button", { name: "Resume work", exact: true }).click();
    let dialog = page.getByRole("dialog", { name: "Resume work" });
    await dialog.getByPlaceholder("What are you seeing on site?").fill("WOTEST4 replacement components arrived for return visit.");
    await dialog.getByRole("button", { name: "Resume", exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText("Visit 2", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "Mark work complete", exact: true }).click();
    dialog = page.getByRole("dialog", { name: "Mark work complete" });
    await dialog.getByLabel("Equipment make").fill("Synthetic Capital Make");
    await dialog.getByLabel("Asset model").fill("WOTEST4-CAP-MODEL");
    await dialog.getByLabel("Serial number").fill("WOTEST4-CAP-SERIAL");
    await dialog.getByLabel("Equipment year *").fill("2026");
    await dialog.getByRole("combobox", { name: "Resolution code" }).click();
    await page.getByRole("option", { name: "Current Asset Repaired", exact: true }).click();
    await dialog.getByLabel("Closing notes").fill("WOTEST4 capital installation completed on the return visit.");
    await dialog.getByRole("button", { name: "Mark work complete", exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText("7-Eleven FSM: Completed", { exact: true })).toBeVisible();
    await expect(page.getByText("Visit 1", { exact: true })).toBeVisible();
    await expect(page.getByText("Visit 2", { exact: true })).toBeVisible();
    await expect(page.getByText(
      "Recorded by an authorized team lead on behalf of the assigned technician",
      { exact: true },
    )).toHaveCount(2);
    await expect(page.getByText("Capital", { exact: true }).first()).toBeVisible();
    await expect(page.getByRole("button", { name: /Create or upload invoice/ })).toHaveCount(0);
  });

  // Capital field completion is not yet permission to bill the customer. Staff
  // must first confirm the completion update in the 7-Eleven portal; only then
  // may the final, quote-linked capital invoice be created.
  await asAccount(browser, accounts.manager, async page => {
    await openStaffWorkOrder(page);
    await expect(page.getByText("Portal: Completed", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Create P1 to 7-Eleven invoice", exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "Portal updated - pending 7-Eleven submission", exact: true }).click();
    await expect(page.getByText("Portal: Pending 7-Eleven Submission", { exact: true })).toBeVisible();
  });

  // Build and submit the final capital invoice. It must identify itself as a
  // final invoice linked to the quote, expose CSV, and close the work order
  // only after the explicit billed-to-7-Eleven confirmation.
  await asAccount(browser, accounts.backoffice, async page => {
    await openStaffWorkOrder(page);
    await page.getByRole("button", { name: "Create P1 to 7-Eleven invoice", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Create P1 to 7-Eleven invoice" });
    await expect(dialog.getByText(/final capital invoice linked to the previously submitted quote/i)).toBeVisible();
    await fillKnownBillingCalculation(dialog, FINAL_INVOICE_NUMBER, { includesPurchasedPart: true });
    await dialog.getByRole("button", { name: "Submit Invoice", exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText(`#${FINAL_INVOICE_NUMBER}`, { exact: true })).toBeVisible();
    await expect(page.getByText("Capital final invoice", { exact: true })).toBeVisible();
    const csv = page.waitForEvent("download");
    await page.getByRole("button", { name: "Download SaasAnt CSV", exact: true }).click();
    expect((await csv).suggestedFilename()).toMatch(/\.csv$/i);
    await page.getByRole("button", { name: "Billed to 7-Eleven", exact: true }).click();
    const confirm = page.getByRole("dialog", { name: "Confirm 7-Eleven billing" });
    await confirm.getByRole("button", { name: "Billed to 7-Eleven", exact: true }).click();
    await expect(confirm).toBeHidden();
  });

  // Closed history remains scoped and read only. The former child retains its
  // own evidence; unrelated contractors still cannot see it.
  await asAccount(browser, accounts.teamMember, async page => {
    await openSidebarPage(page, "Closed jobs");
    await page.getByRole("textbox", { name: "Search closed jobs" }).fill(WORK_ORDER_ID);
    await page.getByRole("button", { name: /^WOTEST4 Copy work order/ }).click();
    await expect(page.locator(".work-order-reference").filter({ hasText: WORK_ORDER_ID }).first()).toBeVisible();
    await expect(page.getByText("Closed job · read only", { exact: true })).toBeVisible();
    await expect(page.getByText("Photos (1)", { exact: true })).toBeVisible();
    await expect(page.getByText("Choose photos", { exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: /View photos/ }).click();
    const download = page.waitForEvent("download");
    await page.locator('button[aria-label="Download photo 1"]').click();
    expect((await download).suggestedFilename()).toBe("WOTEST4-photo-1.png");
    await expect(page.getByRole("button", { name: "x", exact: true })).toHaveCount(0);
  });
  await expectContractorClosedVisibility(browser, accounts.direct, false);
  await expectContractorClosedVisibility(browser, accounts.companyAdmin, true);
});
