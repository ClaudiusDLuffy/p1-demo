import { accounts, expect, login, openSidebarPage, openWorkOrder, test } from "./fixtures.mjs";

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function syntheticWorkbook() {
  const entries = [
    ["[Content_Types].xml", Buffer.from("<Types/>")],
    ["xl/workbook.xml", Buffer.from("<workbook/>")],
  ];
  const locals = [];
  const central = [];
  let offset = 0;
  for (const [filename, contents] of entries) {
    const name = Buffer.from(filename);
    const checksum = crc32(contents);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(contents.length, 18);
    local.writeUInt32LE(contents.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, contents);

    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50, 0);
    directory.writeUInt16LE(20, 4);
    directory.writeUInt16LE(20, 6);
    directory.writeUInt32LE(checksum, 16);
    directory.writeUInt32LE(contents.length, 20);
    directory.writeUInt32LE(contents.length, 24);
    directory.writeUInt16LE(name.length, 28);
    directory.writeUInt32LE(offset, 42);
    central.push(directory, name);
    offset += local.length + name.length + contents.length;
  }
  const centralBytes = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBytes, end]);
}

async function openAs(page, account, navigation, workOrderId) {
  await login(page, account);
  await openSidebarPage(page, navigation);
  await openWorkOrder(page, workOrderId);
}

test("assigned technician can set ETA and cancel the start-work modal", async ({ page }) => {
  await openAs(page, accounts.invoiceTech, "My jobs", "E2E-ETA");
  await page.getByRole("button", { name: "Set ETA", exact: true }).click();
  let dialog = page.getByRole("dialog", { name: "Set ETA" });
  await expect(dialog.getByText(/When will you arrive/)).toBeVisible();
  await dialog.getByRole("button", { name: "Set ETA", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText("Not set", { exact: true })).toHaveCount(0);

  await page.getByRole("button", { name: "Start work", exact: true }).click();
  dialog = page.getByRole("dialog", { name: "Start work" });
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("button", { name: "Start work", exact: true })).toBeVisible();
});

test("staff can create, synchronize, and delete the supported activity channels", async ({ page }) => {
  await openAs(page, accounts.manager, "Work orders", "E2E-ACTIVITY");

  await page.getByPlaceholder("Enter the service or job update that must be copied to 7-Eleven...")
    .fill("Synthetic browser-created 7-Eleven update.");
  await page.getByRole("button", { name: "Post 7-Eleven update", exact: true }).click();
  await expect(page.getByText("Synthetic browser-created 7-Eleven update.", { exact: true })).toBeVisible();

  const pendingSync = page.getByText("Synthetic 7-Eleven update requiring confirmation.", { exact: true })
    .locator("xpath=ancestor::div[.//input[@type='checkbox']][1]");
  const syncCheckbox = pendingSync.getByRole("checkbox", { name: "Needs 7-Eleven update" });
  await syncCheckbox.click();
  await expect(pendingSync.getByText("Updated in 7-Eleven", { exact: true })).toBeVisible();

  await page.getByPlaceholder("Add an internal P1 note...").fill("Synthetic browser-created internal note.");
  await page.getByRole("button", { name: "Post internal note", exact: true }).click();
  await expect(page.getByText("Synthetic browser-created internal note.", { exact: true })).toBeVisible();

  const seededNote = page.getByText("Synthetic internal note for deletion.", { exact: true })
    .locator("xpath=ancestor::div[.//button[@aria-label='Activity actions']][1]");
  await seededNote.getByRole("button", { name: "Activity actions" }).click();
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Delete comment" });
  await dialog.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText("Synthetic internal note for deletion.", { exact: true })).toHaveCount(0);
});

test("parts support add, edit, status, P1 purchasing, and removal", async ({ page }) => {
  await openAs(page, accounts.manager, "Work orders", "E2E-PARTS");
  const originalPart = page.getByText("Synthetic condenser fan motor", { exact: true })
    .locator("xpath=ancestor::div[.//button[normalize-space()='Edit']][1]");
  await originalPart.getByRole("button", { name: "Edit", exact: true }).click();
  await page.getByLabel("Description", { exact: true }).fill("Synthetic edited fan motor");
  await page.getByLabel("Part #", { exact: true }).fill("SYN-FAN-EDITED");
  await page.getByLabel("Qty", { exact: true }).fill("2");
  await page.getByLabel("Tracking #", { exact: true }).fill("SYNTRACK-EDITED");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText(/Synthetic edited fan motor/).first()).toBeVisible();
  await expect(page.getByText("SYN-FAN-EDITED", { exact: true })).toBeVisible();

  const editedPart = page.getByRole("button", { name: "P1 to order", exact: true })
    .locator("xpath=ancestor::div[.//button[normalize-space()='Edit']][1]");
  await editedPart.getByRole("button", { name: "P1 to order", exact: true }).click();
  await expect(page.getByText("P1 to order", { exact: true })).toBeVisible();
  await page.getByLabel("P1 unit cost for Synthetic edited fan motor").fill("125.50");
  const status = page.getByRole("combobox", { name: "P1 purchasing status for Synthetic edited fan motor" });
  await status.click();
  await page.getByRole("option", { name: "Ordered", exact: true }).click();
  await expect(page.getByText("P1 ordered", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "+ Add part", exact: true }).first().click();
  await expect(page.getByText("New part", { exact: true })).toBeVisible();
  const addedPart = page.getByText("New part", { exact: true })
    .locator("xpath=ancestor::div[.//button[normalize-space()='Remove']][1]");
  await addedPart.getByRole("button", { name: "Remove", exact: true }).click();
  await expect(page.getByText("New part", { exact: true })).toHaveCount(0);
});

test("staff can correct a completed visit and persist the audit reason", async ({ page }) => {
  await openAs(page, accounts.manager, "Work orders", "E2E-VISIT-CORRECT");
  await page.getByRole("button", { name: "Correct actual time", exact: true }).click();
  const reason = page.getByPlaceholder("Explain why the recorded time was inaccurate");
  await reason.fill("Synthetic correction verified against dispatch notes.");
  const save = page.getByRole("button", { name: "Save correction", exact: true });
  await expect(save).toBeEnabled();
  await save.click();
  await expect(reason).toBeHidden();
  await expect(page.getByRole("button", { name: "Correct actual time", exact: true })).toBeVisible();
});

test("photo upload, preview, individual download, archive download, and removal work locally", async ({ page }) => {
  await openAs(page, accounts.direct, "My jobs", "E2E-PHOTO");
  await page.locator('input[type="file"][multiple]').setInputFiles("public/p1-icon-192.png");
  await expect(page.getByText("Photos (1)", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: /View photos/ }).click();
  await expect(page.getByRole("button", { name: "Download photo 1", exact: true })).toBeVisible();

  const individual = page.waitForEvent("download");
  await page.locator('button[aria-label="Download photo 1"]').click();
  expect((await individual).suggestedFilename()).toBe("E2E-PHOTO-photo-1.png");

  const archive = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download all", exact: true }).click();
  expect((await archive).suggestedFilename()).toMatch(/\.zip$/i);

  await page.getByRole("button", { name: "x", exact: true }).click();
  await expect(page.getByText("Photos (0)", { exact: true })).toBeVisible();
});

test("contractor work-report controls validate, guard unsaved changes, and persist a complete report", async ({ page }) => {
  await openAs(page, accounts.direct, "My jobs", "E2E-WORK-REPORT");
  await page.getByRole("button", { name: "Submit work report", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Submit work report" });

  await dialog.getByRole("button", { name: "Submit report", exact: true }).click();
  for (const label of ["Arrival time *", "Departure time *", "Work performed *"]) {
    const requiredField = dialog.getByLabel(label);
    await expect(requiredField).toHaveAttribute("required", "");
    expect(await requiredField.evaluate(element => element.validity.valueMissing)).toBe(true);
  }

  await dialog.getByLabel("Technician name").fill("Synthetic Field Technician");
  await dialog.getByLabel("Arrival time *").fill("2026-09-19T08:00");
  await dialog.getByLabel("Departure time *").fill("2026-09-19T09:30");
  await dialog.getByLabel("Work performed *").fill("Synthetic compressor inspection and verified operational repair.");
  await dialog.getByRole("button", { name: "+ Add part", exact: true }).click();
  await dialog.getByLabel("Part 1 name").fill("Synthetic relay");
  await dialog.getByLabel("Part 1 number").fill("SYN-RELAY-01");
  await dialog.getByLabel("Part 1 quantity").fill("2");
  await dialog.getByLabel("Resolution code").click();
  await page.getByRole("option", { name: "Repaired", exact: true }).click();
  await dialog.getByLabel("Resolution notes").fill("Synthetic browser report completed successfully.");

  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  const unsaved = page.getByRole("dialog", { name: "Unsaved changes" });
  await unsaved.getByRole("button", { name: "Keep editing", exact: true }).click();
  await expect(dialog).toBeVisible();

  await dialog.getByRole("button", { name: "Submit report", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator(".app-toast")).toContainText("Work report submitted");
});

test("a contractor can still download its private photo from read-only closed history", async ({ page, browser }) => {
  await openAs(page, accounts.direct, "My jobs", "E2E-HISTORY-FILES");
  await page.locator('input[type="file"][multiple]').setInputFiles("public/p1-icon-192.png");
  await expect(page.getByText("Photos (1)", { exact: true })).toBeVisible();

  const staffContext = await browser.newContext();
  try {
    const staffPage = await staffContext.newPage();
    await login(staffPage, accounts.manager);
    await openSidebarPage(staffPage, "Work orders");
    await openWorkOrder(staffPage, "E2E-HISTORY-FILES");
    await staffPage.getByRole("button", { name: "Close — no invoice", exact: true }).click();
    const closeDialog = staffPage.getByRole("dialog", { name: "Close without an invoice" });
    await closeDialog.getByRole("button", { name: "Close — no invoice", exact: true }).click();
    await expect(closeDialog).toBeHidden();
    await expect(staffPage.getByText("This work order is closed", { exact: true })).toBeVisible();
  } finally {
    await staffContext.close();
  }

  await openSidebarPage(page, "Closed jobs");
  await page.getByRole("textbox", { name: "Search closed jobs" }).fill("E2E-HISTORY-FILES");
  const historyCard = page.locator('[role="button"]').filter({
    has: page.getByText("E2E-HISTORY-FILES", { exact: true }),
  }).first();
  await expect(historyCard).toBeVisible();
  await historyCard.click();
  await expect(page.locator(".work-order-reference").filter({ hasText: "E2E-HISTORY-FILES" }).first()).toBeVisible();
  await expect(page.getByText("Photos (1)", { exact: true })).toBeVisible();
  await expect(page.getByText("Choose photos", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: /View photos/ }).click();
  const download = page.waitForEvent("download");
  await page.locator('button[aria-label="Download photo 1"]').click();
  expect((await download).suggestedFilename()).toBe("E2E-HISTORY-FILES-photo-1.png");
  await expect(page.getByRole("button", { name: "x", exact: true })).toHaveCount(0);
});

test("contractor estimates cover draft editing, private equipment forms, submission, conversion, and invoice opening", async ({ page }) => {
  await openAs(page, accounts.direct, "My jobs", "E2E-ESTIMATE");
  await page.getByRole("button", { name: "+ New estimate", exact: true }).click();
  let dialog = page.getByRole("dialog", { name: "Create estimate" });
  await dialog.getByRole("button", { name: "+ Add line", exact: true }).click();
  await dialog.getByRole("combobox", { name: "Estimate line 1 type" }).click();
  await page.getByRole("option", { name: "Parts/Hardware", exact: true }).click();
  await dialog.getByLabel("Estimate line 1 description").fill("Synthetic replacement compressor");
  await dialog.getByLabel("Estimate line 1 quantity").fill("1");
  await dialog.getByLabel("Estimate line 1 rate").fill("875.50");
  await dialog.getByLabel("Estimate sales tax").fill("72.23");
  await dialog.getByPlaceholder("Scope, exclusions, or estimate notes…").fill("Synthetic estimate scope for local browser verification.");
  await dialog.getByRole("button", { name: "+ Add line", exact: true }).click();
  await expect(dialog.getByLabel("Estimate line 2 description")).toBeVisible();
  await dialog.getByRole("button", { name: "Remove line 2" }).click();
  await expect(dialog.getByLabel("Estimate line 2 description")).toHaveCount(0);

  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  const unsaved = page.getByRole("dialog", { name: "Unsaved changes" });
  await unsaved.getByRole("button", { name: "Keep editing", exact: true }).click();
  await dialog.getByRole("button", { name: "Save draft", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText("Draft", { exact: true }).first()).toBeVisible();

  await page.getByRole("button", { name: "Edit", exact: true }).click();
  dialog = page.getByRole("dialog", { name: /Estimate #/ });
  const workbook = syntheticWorkbook();
  await dialog.locator('input[type="file"][accept*=".xlsx"]').setInputFiles({
    name: "synthetic-equipment-form.xlsx",
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    buffer: workbook,
  });
  await expect(dialog.getByText("synthetic-equipment-form.xlsx", { exact: true })).toBeVisible();
  const equipmentDownload = page.waitForEvent("download");
  await dialog.getByRole("button", { name: "Download", exact: true }).click();
  expect((await equipmentDownload).suggestedFilename()).toBe("synthetic-equipment-form.xlsx");

  page.once("dialog", confirmation => confirmation.accept());
  await dialog.getByRole("button", { name: "Remove", exact: true }).click();
  await expect(dialog.getByText("synthetic-equipment-form.xlsx", { exact: true })).toHaveCount(0);

  await dialog.getByRole("button", { name: "Submit estimate", exact: true }).click();
  await expect(dialog.getByText(/Submit and lock this estimate/)).toBeVisible();
  await dialog.getByRole("button", { name: "Submit estimate", exact: true }).first().click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText("Submitted estimate", { exact: true }).first()).toBeVisible();

  await page.getByRole("button", { name: "Convert", exact: true }).click();
  dialog = page.getByRole("dialog", { name: /Estimate #/ });
  await expect(dialog.getByText(/This estimate is locked/)).toBeVisible();
  await dialog.getByRole("button", { name: "Convert to invoice", exact: true }).click();
  await expect(dialog.getByText(/Create one editable invoice draft/)).toBeVisible();
  await dialog.getByRole("button", { name: "Create invoice draft", exact: true }).click();

  const invoice = page.getByRole("dialog", { name: "Create invoice" });
  await expect(invoice).toBeVisible();
  await expect(invoice.getByLabel("Invoice #")).not.toHaveValue("");
  await expect(invoice.getByLabel("Line 1 description")).toHaveValue("Synthetic replacement compressor");
  await invoice.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(invoice).toBeHidden();

  const convertedState = page.getByText("Converted to invoice", { exact: true }).first();
  await expect(convertedState).toBeVisible();
  const convertedRow = convertedState.locator("xpath=ancestor::div[.//button[normalize-space()='Open invoice']][1]");
  await convertedRow.getByRole("button", { name: "View", exact: true }).click();
  dialog = page.getByRole("dialog", { name: /Estimate #/ });
  await expect(dialog.getByText("No equipment forms attached.", { exact: true })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Remove", exact: true })).toHaveCount(0);
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await convertedRow.getByRole("button", { name: "Open invoice", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Create invoice" })).toBeVisible();
});
