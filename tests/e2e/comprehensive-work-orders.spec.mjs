import { accounts, expect, login, openSidebarPage, openWorkOrder, test } from "./fixtures.mjs";

async function openStaffWorkOrder(page, id, account = accounts.manager) {
  await login(page, account);
  await openSidebarPage(page, "Work orders");
  await openWorkOrder(page, id);
}

async function cancelDialog(page, title) {
  const dialog = page.getByRole("dialog", { name: title });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).toBeHidden();
}

async function expectComboboxOptions(page, combobox, expected) {
  await combobox.click();
  const options = page.getByRole("listbox").getByRole("option");
  await expect(options).toHaveCount(expected.length);
  const labels = (await options.allTextContents()).map(label => label.replace(/Selected$/, ""));
  expect(labels).toEqual(expected);
  await page.keyboard.press("Escape");
}

test("work-order list filters and create-form dropdowns expose the complete supported values", async ({ page }) => {
  await login(page, accounts.manager);
  await openSidebarPage(page, "Work orders");

  await expect(page.getByLabel("Filter work orders by contractor")).toBeVisible();
  await expectComboboxOptions(page, page.getByRole("combobox", { name: "Filter unassigned work orders" }), [
    "All work orders", "Unassigned only",
  ]);
  await expectComboboxOptions(page, page.getByRole("combobox", { name: "Filter work orders by state" }), [
    "All states", "Virginia", "Texas", "Florida",
  ]);
  await expectComboboxOptions(page, page.getByRole("combobox", { name: "Sort work orders" }), [
    "SLA due soonest", "Newest to oldest", "Oldest to newest", "Priority",
  ]);

  await page.getByRole("button", { name: "+ Create Work Order", exact: true }).first().click();
  const dialog = page.getByRole("dialog", { name: "Create Work Order" });
  await expect(dialog).toBeVisible();
  await expectComboboxOptions(page, dialog.getByRole("button", { name: "Business Service" }), [
    "Not set",
    "Refrigeration equipment",
    "Frozen Beverage - Equipment",
    "Cold Beverage - Equipment",
    "HVAC",
    "EMS",
    "Plumbing",
    "Hot food",
    "Ice merchandiser",
    "Walk-in cooler/freezer",
    "Septic/Grease",
  ]);
  await expectComboboxOptions(page, dialog.getByRole("combobox", { name: "Priority" }), [
    "P4 Minor (default)", "P1 Critical", "P2 Emergency", "P3 Standard", "P4 Minor", "P5 Preventative",
  ]);
  const contractorPicker = dialog.getByRole("button", { name: "Assign to contractor" });
  await expect(contractorPicker).toContainText("Leave unassigned");
  await contractorPicker.click();
  await expect(page.getByRole("option", { name: "Leave unassigned", exact: true })).toBeVisible();
  await expect(page.getByRole("option", { name: /Synthetic Direct Contractor/ })).toBeVisible();
  await expect(page.getByRole("option", { name: /Synthetic Company Admin/ }).first()).toBeVisible();
  await page.keyboard.press("Escape");

  await dialog.getByPlaceholder("e.g. FWKD11400123").fill("E2E-CREATE-CANCEL");
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  const guard = page.getByRole("dialog", { name: "Unsaved changes" });
  await expect(guard).toBeVisible();
  await guard.getByRole("button", { name: "Keep editing", exact: true }).click();
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("dialog", { name: "Unsaved changes" }).getByRole("button", { name: "Discard changes", exact: true }).click();
  await expect(dialog).toBeHidden();
});

test("manager modal cancellation controls close without mutating the work order", async ({ page }) => {
  await openStaffWorkOrder(page, "WOT9000001");

  await page.getByRole("button", { name: "Edit work order", exact: true }).click();
  await cancelDialog(page, "Edit work order");

  await page.getByRole("button", { name: "Reassign", exact: true }).click();
  await cancelDialog(page, "Reassign work order");

  await page.getByRole("button", { name: "Unassign", exact: true }).click();
  await cancelDialog(page, "Unassign work order");

  await page.getByRole("button", { name: "Duplicate for reassignment", exact: true }).click();
  await cancelDialog(page, "Duplicate for reassignment?");

  await page.getByRole("button", { name: "Close — no invoice", exact: true }).click();
  await cancelDialog(page, "Close without an invoice");
  await expect(page.getByText("WOT9000001", { exact: true }).first()).toBeVisible();
});

test("manager edits a work order and the persisted values render immediately", async ({ page }) => {
  await openStaffWorkOrder(page, "E2E-EDIT");
  await page.getByRole("button", { name: "Edit work order", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Edit work order" });
  await dialog.getByLabel("Short Description").fill("Synthetic edited work order");
  await dialog.getByLabel("Description", { exact: true }).fill("Synthetic edit persisted through the full browser form.");
  await dialog.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText("Synthetic edited work order", { exact: true })).toBeVisible();
  await expect(page.getByText("Synthetic edit persisted through the full browser form.", { exact: true })).toBeVisible();
});

test("dispatcher rejects an untouched unassigned work order with an audited reason", async ({ page }) => {
  await openStaffWorkOrder(page, "E2E-REJECT", accounts.dispatcher);
  await page.getByRole("button", { name: "Reject work order", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Reject work order?" });
  const confirm = dialog.getByRole("button", { name: "Reject work order", exact: true });
  await expect(confirm).toBeDisabled();
  await dialog.getByPlaceholder("Why is this call being rejected?").fill("Synthetic duplicate intake fixture.");
  await expect(confirm).toBeEnabled();
  await confirm.click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText("E2E-REJECT", { exact: true })).toHaveCount(0);
});

test("staff work-order lifecycle controls reach their intended queues", async ({ page }) => {
  await openStaffWorkOrder(page, "E2E-STRAIGHT-BILL");
  await page.getByRole("button", { name: "Straight to Billing", exact: true }).click();
  const billingDialog = page.getByRole("dialog", { name: "Create P1 to 7-Eleven invoice" });
  await expect(billingDialog).toBeVisible();
  await expect(billingDialog.getByRole("button", { name: "Invoice work order", exact: true }))
    .toContainText("E2E-STRAIGHT-BILL");
  await billingDialog.getByRole("button", { name: "Discard draft", exact: true }).click();
  await expect(billingDialog).toBeHidden();
  await expect(page.getByText("Billing only · do not dispatch", { exact: true })).toBeVisible();

  await openSidebarPage(page, "Work orders");
  await openWorkOrder(page, "E2E-CAPITAL-DECLINE");
  await page.getByRole("button", { name: /Capital declined - return to dispatched/ }).click();
  await expect(page.getByText("Portal: Assigned", { exact: true })).toBeVisible();

  await openSidebarPage(page, "Work orders");
  await openWorkOrder(page, "E2E-CAPITAL-COMPLETE");
  await page.getByRole("button", { name: "Capital Completed", exact: true }).click();
  await expect(page.getByText("7-Eleven FSM: Completed", { exact: true })).toBeVisible();

  await openSidebarPage(page, "Work orders");
  await openWorkOrder(page, "E2E-PORTAL-UPDATE");
  await page.getByRole("button", { name: "Portal updated - pending 7-Eleven submission", exact: true }).click();
  await expect(page.getByText("Portal: Pending 7-Eleven Submission", { exact: true })).toBeVisible();
});

test("manager can unassign, reassign, duplicate, and close isolated work orders", async ({ page }) => {
  await page.route("**/api/notifications/assignment-removal", route => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ ok: true, synthetic: true }),
  }));
  await openStaffWorkOrder(page, "E2E-UNASSIGN");
  await page.getByRole("button", { name: "Unassign", exact: true }).click();
  let dialog = page.getByRole("dialog", { name: "Unassign work order" });
  await dialog.getByRole("button", { name: "Unassign", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText("Portal: Unassigned", { exact: true })).toBeVisible();

  await openSidebarPage(page, "Work orders");
  await openWorkOrder(page, "E2E-REASSIGN");
  await page.getByRole("button", { name: "Reassign", exact: true }).click();
  dialog = page.getByRole("dialog", { name: "Reassign work order" });
  await dialog.getByRole("button", { name: "New contractor" }).click();
  await page.getByRole("option", { name: /Synthetic Company Admin/ }).first().click();
  await dialog.getByRole("button", { name: "Reassign", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText("Synthetic Company Admin", { exact: true }).first()).toBeVisible();

  await openSidebarPage(page, "Work orders");
  await openWorkOrder(page, "WOT9000001");
  await page.getByRole("button", { name: "Duplicate for reassignment", exact: true }).click();
  dialog = page.getByRole("dialog", { name: "Duplicate for reassignment?" });
  await dialog.getByRole("button", { name: "Create unassigned duplicate", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText("WOT9000001-1", { exact: true }).first()).toBeVisible();

  await openSidebarPage(page, "Work orders");
  await openWorkOrder(page, "E2E-CLOSE-NO-INVOICE");
  await page.getByRole("button", { name: "Close — no invoice", exact: true }).click();
  dialog = page.getByRole("dialog", { name: "Close without an invoice" });
  await dialog.getByRole("button", { name: "Close — no invoice", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText("This work order is closed", { exact: true })).toBeVisible();
});

test("an open visit blocks normal reassignment and the confirmed emergency transfer creates a fresh receiving visit", async ({ page }) => {
  await page.route("**/api/notifications/assignment-removal", route => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ ok: true, synthetic: true }),
  }));
  await page.route("**/api/notifications/dispatch", route => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ ok: true, synthetic: true }),
  }));

  await openStaffWorkOrder(page, "E2E-TRANSFER-OPEN");
  await page.getByRole("button", { name: "Reassign", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Reassign work order" });
  await dialog.getByRole("button", { name: "New contractor" }).click();
  await page.getByRole("option", { name: /Synthetic Company Admin/ }).first().click();

  // The ordinary path must fail without closing or silently borrowing the
  // outgoing contractor's visit.
  await dialog.getByRole("button", { name: "Reassign", exact: true }).click();
  await expect(page.locator(".app-toast")).toContainText(/open visit.*check out/i);
  await expect(dialog).toBeVisible();

  await dialog.getByRole("button", { name: "Emergency staff close-and-transfer", exact: true }).click();
  const reason = dialog.getByLabel("Emergency transfer reason");
  await reason.fill("Synthetic safety transfer after the outgoing technician could not check out.");
  const confirm = dialog.getByLabel(/I explicitly confirm this emergency administrative closure and transfer/);
  const transfer = dialog.getByRole("button", { name: "Confirm administrative close and transfer", exact: true });
  await expect(transfer).toBeDisabled();
  await confirm.check();
  await expect(transfer).toBeEnabled();
  await transfer.click();

  await expect(dialog).toBeHidden();
  await expect(page.locator(".app-toast")).toContainText(/Visit administratively closed and work transferred/i);
  await expect(page.getByText("Synthetic Company Admin", { exact: true }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Start new visit after transfer", exact: true })).toBeVisible();

  // Re-enter as the receiving company and prove that it starts a new visit;
  // it never inherits the administratively closed visit.
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page.getByPlaceholder("you@p1pros.com")).toBeVisible();
  await page.waitForFunction(() => !Object.keys(window.localStorage).some(key => key.endsWith("-auth-token")));
  await login(page, accounts.companyAdmin);
  await openSidebarPage(page, "My jobs");
  await openWorkOrder(page, "E2E-TRANSFER-OPEN");
  await page.getByRole("button", { name: "Start new visit after transfer", exact: true }).click();
  const startDialog = page.getByRole("dialog", { name: "Start work" });
  await expect(startDialog.getByText(/previous administratively closed visit is not inherited/i)).toBeVisible();
  await startDialog.getByPlaceholder("What are you seeing on site?").fill("Synthetic receiving technician began a distinct visit.");
  await startDialog.getByRole("button", { name: "Start new visit now", exact: true }).click();
  await expect(startDialog).toBeHidden();
  await expect(page.getByRole("button", { name: "Pause (parts)", exact: true })).toBeVisible();
});

test("manager can reopen a closed work order for field follow-up", async ({ page }) => {
  await openStaffWorkOrder(page, "E2E-CLOSED-REOPEN");
  await page.getByRole("button", { name: "Reopen work order", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Reopen work order" });
  await dialog.getByRole("radio").first().click();
  await dialog.getByPlaceholder("Explain what needs to continue or be corrected...").fill("Synthetic field follow-up is required.");
  await dialog.getByRole("button", { name: "Reopen work order", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText("This work order is closed", { exact: true })).toHaveCount(0);
});
