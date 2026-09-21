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

const mobileDevice = { ...devices["iPhone 13"] };
delete mobileDevice.defaultBrowserType;

async function createSession(browser, account, options = {}) {
  const context = await browser.newContext(options);
  const page = await context.newPage();
  const fatal = [];
  page.on("pageerror", error => {
    // Playwright WebKit surfaces cross-origin localhost reads canceled by an
    // explicit page.reload() as access-control page errors. The replacement
    // reads are awaited and asserted after every reload, so retain every real
    // page error while excluding only this local navigation-cancellation form.
    if (/^\/127\.0\.0\.1:54321\/.* due to access control checks\.$/.test(error.message)) return;
    fatal.push(`pageerror: ${error.message}`);
  });
  page.on("response", response => {
    if (response.status() >= 500) {
      fatal.push(`http ${response.status()}: ${response.url().replace(/\?.*$/, "")}`);
    }
  });
  await page.route("**/api/notifications/**", route => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ ok: true, synthetic: true }),
  }));
  await login(page, account);
  return { context, page, fatal };
}

async function closeSession(session) {
  try {
    await waitForApplicationRequestsToSettle(session.page).catch(() => undefined);
    expect(session.fatal, "browser page errors and HTTP 5xx responses").toEqual([]);
  } finally {
    await session.context.close();
  }
}

async function openStaffWorkOrder(page, workOrderId) {
  await openSidebarPage(page, "Work orders");
  await openWorkOrder(page, workOrderId);
}

async function startWork(page, notes) {
  await page.getByRole("button", { name: "Start work", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Start work" });
  await dialog.getByPlaceholder("What are you seeing on site?").fill(notes);
  await dialog.getByRole("button", { name: "Start work", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText("7-Eleven FSM: Work in Progress", { exact: true })).toBeVisible();
}

async function pauseWork(page, notes) {
  await page.getByRole("button", { name: "Pause (parts)", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Pause work" });
  await dialog.getByRole("combobox", { name: "Reason" }).click();
  await page.getByRole("option", { name: "Temporary fix - equipment partially working", exact: true }).click();
  await dialog.getByPlaceholder("Explain what was done so far...").fill(notes);
  await dialog.getByRole("button", { name: "Pause work", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText("7-Eleven FSM: Awaiting Parts", { exact: true })).toBeVisible();
}

async function resumeWork(page, notes) {
  await page.getByRole("button", { name: "Resume work", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Resume work" });
  await dialog.getByPlaceholder("What are you seeing on site?").fill(notes);
  await dialog.getByRole("button", { name: "Resume", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText("7-Eleven FSM: Work in Progress", { exact: true })).toBeVisible();
}

async function submitCapitalQuote(page, workOrderId, quoteNumber, description) {
  await page.getByRole("button", { name: "Create capital quote", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Create capital quote for 7-Eleven" });
  await dialog.getByLabel("Invoice #").fill(quoteNumber);
  await dialog.getByRole("button", { name: /^\+ Labor/ }).click();
  await dialog.getByLabel("Line 1 description").fill(description);
  await dialog.getByLabel("Line 1 quantity").fill("2");
  await dialog.getByLabel("Line 1 rate").fill("175");
  await dialog.getByRole("button", { name: "Prepare Quote", exact: true }).click();
  await expect(dialog).toBeHidden();
  await page.getByRole("button", { name: "Submit Quote to 7-Eleven", exact: true }).click();
  const confirm = page.getByRole("dialog", { name: "Confirm capital quote" });
  await confirm.getByRole("button", { name: "Submit Quote to 7-Eleven", exact: true }).click();
  await expect(confirm).toBeHidden();
  await page.getByRole("button", { name: `Back to ${workOrderId}`, exact: true }).click();
  await expect(page.getByText("Portal: Pending Capital Completion", { exact: true })).toBeVisible();
}

async function completeWork(page, prefix) {
  await page.getByRole("button", { name: "Mark work complete", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Mark work complete" });
  await dialog.getByLabel("Equipment make").fill("Synthetic Sequence Make");
  await dialog.getByLabel("Asset model").fill(`${prefix}-MODEL`);
  await dialog.getByLabel("Serial number").fill(`${prefix}-SERIAL`);
  await dialog.getByLabel("Equipment year *").fill("2026");
  await dialog.getByRole("combobox", { name: "Resolution code" }).click();
  await page.getByRole("option", { name: "Current Asset Repaired", exact: true }).click();
  await dialog.getByLabel("Closing notes").fill(`${prefix} field completion recorded.`);
  await dialog.getByRole("button", { name: "Mark work complete", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText("7-Eleven FSM: Completed", { exact: true })).toBeVisible();
}

async function fillInvoice(dialog, number) {
  await dialog.getByLabel("Invoice #").fill(number);
  await dialog.getByRole("button", { name: "+ Labor", exact: true }).click();
  await dialog.getByLabel("Line 1 description").fill(`${number} sequence labor`);
  await dialog.getByLabel("Line 1 quantity").fill("2");
  await dialog.getByLabel("Line 1 rate").fill("125");
}

test("an active visit remains operable when capital review is declined", async ({ browser }) => {
  test.setTimeout(120_000);
  const workOrderId = "WOTEST8-DECLINE";
  const technician = await createSession(browser, accounts.invoiceTech, mobileDevice);
  const manager = await createSession(browser, accounts.manager);
  try {
    await openWorkOrder(technician.page, workOrderId);
    await startWork(technician.page, "Active visit started before capital review and decline.");

    await openStaffWorkOrder(manager.page, workOrderId);
    await manager.page.getByRole("button", { name: "Flag capital", exact: true }).click();
    await expect(manager.page.getByText("Portal: Capital Replacement", { exact: true })).toBeVisible();
    await manager.page.getByRole("button", { name: "Capital declined - restore field workflow", exact: true }).click();

    // Declining a parallel capital review must restore the real field state,
    // not erase the still-open visit by pretending the job is merely dispatched.
    await expect(manager.page.getByText("Portal: In Progress", { exact: true })).toBeVisible();
    await expect(manager.page.getByText("7-Eleven FSM: Work in Progress", { exact: true })).toBeVisible();

    await waitForApplicationRequestsToSettle(technician.page);
    await technician.page.reload();
    await expect(technician.page.locator(".app-root")).toBeVisible();
    await openWorkOrder(technician.page, workOrderId);
    await expect(technician.page.getByRole("button", { name: "Pause (parts)", exact: true })).toBeVisible();
    await expect(technician.page.getByRole("button", { name: "Start work", exact: true })).toHaveCount(0);
    await pauseWork(technician.page, "The original visit checked out after capital was declined.");
  } finally {
    await closeSession(manager);
    await closeSession(technician);
  }
});

test("field work remains available when a contractor invoice is submitted first", async ({ browser }) => {
  test.setTimeout(120_000);
  const workOrderId = "WOTEST8-INVOICE-FIRST";
  const contractor = await createSession(browser, accounts.direct, mobileDevice);
  try {
    await openWorkOrder(contractor.page, workOrderId);
    await contractor.page.getByRole("button", { name: "Create or upload invoice", exact: true }).click();
    const dialog = contractor.page.getByRole("dialog", { name: "Create invoice" });
    await fillInvoice(dialog, "WOT8-INVOICE-FIRST");
    await dialog.getByRole("button", { name: "Submit", exact: true }).click();
    await expect(dialog).toBeHidden();
    const submitted = contractor.page.getByRole("dialog", { name: "Invoice #WOT8-INVOICE-FIRST submitted" });
    await submitted.getByRole("button", { name: "Done", exact: true }).click();
    await expect(contractor.page.getByText("#WOT8-INVOICE-FIRST", { exact: true })).toBeVisible();

    // Observe the committed parent state rather than relying on the form's
    // optimistic cache. This is the sequence a user reaches after a refresh or
    // after returning to the call later.
    await waitForApplicationRequestsToSettle(contractor.page);
    await contractor.page.reload();
    await expect(contractor.page.locator(".app-root")).toBeVisible();
    await openWorkOrder(contractor.page, workOrderId);
    await expect(contractor.page.getByText("Portal: Assigned", { exact: true })).toBeVisible();
    await expect(contractor.page.getByText("#WOT8-INVOICE-FIRST", { exact: true })).toBeVisible();
    await expect(contractor.page.getByText("Submitted", { exact: true }).first()).toBeVisible();

    // Billing can advance independently, but must not strand an untouched
    // field assignment with no way to create its first visit.
    await expect(contractor.page.getByRole("button", { name: "Start work", exact: true })).toBeVisible();
    await startWork(contractor.page, "Field visit started after early invoice submission.");
    await expect(contractor.page.getByText("#WOT8-INVOICE-FIRST", { exact: true })).toBeVisible();
    await pauseWork(contractor.page, "Invoice-first field visit paused normally.");
    await expect(contractor.page.getByText("#WOT8-INVOICE-FIRST", { exact: true })).toBeVisible();
  } finally {
    await closeSession(contractor);
  }
});

test("a stale Start action fails closed after staff moves the job into capital review", async ({ browser }) => {
  test.setTimeout(120_000);
  const workOrderId = "WOTEST8-STALE-CAPITAL";
  const contractor = await createSession(browser, accounts.direct, mobileDevice);
  const manager = await createSession(browser, accounts.manager);
  try {
    await openWorkOrder(contractor.page, workOrderId);
    await expect(contractor.page.getByRole("button", { name: "Start work", exact: true })).toBeVisible();

    await openStaffWorkOrder(manager.page, workOrderId);
    await manager.page.getByRole("button", { name: "Flag capital", exact: true }).click();
    await expect(manager.page.getByText("Portal: Capital Replacement", { exact: true })).toBeVisible();

    // The contractor tab is intentionally stale. The database command must
    // reject the obsolete field action even though the old button still exists.
    await contractor.page.getByRole("button", { name: "Start work", exact: true }).click();
    const dialog = contractor.page.getByRole("dialog", { name: "Start work" });
    await dialog.getByPlaceholder("What are you seeing on site?").fill("This stale action must not open a visit.");
    await dialog.getByRole("button", { name: "Start work", exact: true }).click();
    await expect(dialog).toBeVisible();
    await expect(contractor.page.locator(".app-toast")).toContainText(/refresh|changed|capital/i);

    await contractor.page.reload();
    await expect(contractor.page.locator(".app-root")).toBeVisible();
    await openWorkOrder(contractor.page, workOrderId);
    await expect(contractor.page.getByRole("button", { name: "Start work", exact: true })).toHaveCount(0);
    await expect(contractor.page.getByText("Portal: Capital Replacement", { exact: true })).toBeVisible();
    await expect(contractor.page.getByText("Visit 1", { exact: true })).toHaveCount(0);
  } finally {
    await closeSession(manager);
    await closeSession(contractor);
  }
});

test("concurrent Start and Pause commands produce one visit and one checkout", async ({ browser }) => {
  test.setTimeout(150_000);
  const workOrderId = "WOTEST8-CONCURRENT";
  const first = await createSession(browser, accounts.direct, mobileDevice);
  const second = await createSession(browser, accounts.direct, mobileDevice);
  try {
    await Promise.all([
      openWorkOrder(first.page, workOrderId),
      openWorkOrder(second.page, workOrderId),
    ]);
    await Promise.all([
      first.page.getByRole("button", { name: "Start work", exact: true }).click(),
      second.page.getByRole("button", { name: "Start work", exact: true }).click(),
    ]);
    const firstStart = first.page.getByRole("dialog", { name: "Start work" });
    const secondStart = second.page.getByRole("dialog", { name: "Start work" });
    await firstStart.getByPlaceholder("What are you seeing on site?").fill("Concurrent start from session one.");
    await secondStart.getByPlaceholder("What are you seeing on site?").fill("Concurrent start from session two.");
    await Promise.all([
      firstStart.getByRole("button", { name: "Start work", exact: true }).click(),
      secondStart.getByRole("button", { name: "Start work", exact: true }).click(),
    ]);

    await Promise.all([first.page.reload(), second.page.reload()]);
    await Promise.all([
      expect(first.page.locator(".app-root")).toBeVisible(),
      expect(second.page.locator(".app-root")).toBeVisible(),
    ]);
    await Promise.all([
      openWorkOrder(first.page, workOrderId),
      openWorkOrder(second.page, workOrderId),
    ]);
    await expect(first.page.getByText("Visit 1", { exact: true })).toHaveCount(1);
    await expect(first.page.getByText("Visit 2", { exact: true })).toHaveCount(0);

    await Promise.all([
      first.page.getByRole("button", { name: "Pause (parts)", exact: true }).click(),
      second.page.getByRole("button", { name: "Pause (parts)", exact: true }).click(),
    ]);
    const firstPause = first.page.getByRole("dialog", { name: "Pause work" });
    const secondPause = second.page.getByRole("dialog", { name: "Pause work" });
    for (const [page, dialog, notes] of [
      [first.page, firstPause, "Concurrent pause from session one."],
      [second.page, secondPause, "Concurrent pause from session two."],
    ]) {
      await dialog.getByRole("combobox", { name: "Reason" }).click();
      await page.getByRole("option", { name: "Temporary fix - equipment partially working", exact: true }).click();
      await dialog.getByPlaceholder("Explain what was done so far...").fill(notes);
    }
    await Promise.all([
      firstPause.getByRole("button", { name: "Pause work", exact: true }).click(),
      secondPause.getByRole("button", { name: "Pause work", exact: true }).click(),
    ]);

    await first.page.reload();
    await expect(first.page.locator(".app-root")).toBeVisible();
    await openWorkOrder(first.page, workOrderId);
    await expect(first.page.getByText("Visit 1", { exact: true })).toHaveCount(1);
    await expect(first.page.getByText("Visit 2", { exact: true })).toHaveCount(0);
    await expect(first.page.getByRole("button", { name: "Resume work", exact: true })).toBeVisible();
  } finally {
    await closeSession(second);
    await closeSession(first);
  }
});

test("a stale former contractor cannot start after reassignment and the receiving contractor can", async ({ browser }) => {
  test.setTimeout(150_000);
  const workOrderId = "WOTEST8-STALE-TRANSFER";
  const outgoing = await createSession(browser, accounts.direct, mobileDevice);
  const manager = await createSession(browser, accounts.manager);
  const receiving = await createSession(browser, accounts.companyAdmin, mobileDevice);
  try {
    await openWorkOrder(outgoing.page, workOrderId);
    await expect(outgoing.page.getByRole("button", { name: "Start work", exact: true })).toBeVisible();

    await openStaffWorkOrder(manager.page, workOrderId);
    await manager.page.getByRole("button", { name: "Reassign", exact: true }).click();
    const reassign = manager.page.getByRole("dialog", { name: "Reassign work order" });
    await reassign.getByRole("button", { name: "New contractor" }).click();
    await manager.page.getByRole("option", { name: /Synthetic Company Admin/ }).first().click();
    await reassign.getByRole("button", { name: "Reassign", exact: true }).click();
    await expect(reassign).toBeHidden();

    await outgoing.page.getByRole("button", { name: "Start work", exact: true }).click();
    const staleStart = outgoing.page.getByRole("dialog", { name: "Start work" });
    await staleStart.getByPlaceholder("What are you seeing on site?").fill("Former assignment must fail closed.");
    await staleStart.getByRole("button", { name: "Start work", exact: true }).click();
    await expect(staleStart).toBeVisible();
    await expect(outgoing.page.locator(".app-toast")).toContainText(/assignment changed|refresh/i);

    await outgoing.page.reload();
    await expect(outgoing.page.locator(".app-root")).toBeVisible();
    const outgoingSearch = outgoing.page.getByRole("searchbox", { name: "Search my jobs" });
    await outgoingSearch.fill(workOrderId);
    await expect(outgoing.page.getByText("No work orders match your search.", { exact: true })).toBeVisible();

    await openWorkOrder(receiving.page, workOrderId);
    await expect(receiving.page.getByRole("button", { name: "Start work", exact: true })).toBeVisible();
    await startWork(receiving.page, "Receiving contractor started after the reassignment boundary.");
  } finally {
    await closeSession(receiving);
    await closeSession(manager);
    await closeSession(outgoing);
  }
});

test("capital classification survives an emergency transfer of an open visit", async ({ browser }) => {
  test.setTimeout(180_000);
  const workOrderId = "WOTEST8-CAP-TRANSFER";
  const outgoing = await createSession(browser, accounts.direct, mobileDevice);
  const manager = await createSession(browser, accounts.manager);
  const receiving = await createSession(browser, accounts.companyAdmin, mobileDevice);
  try {
    await openWorkOrder(outgoing.page, workOrderId);
    await startWork(outgoing.page, "Outgoing visit began before capital transfer.");
    await outgoing.page.locator('input[type="file"][multiple]').setInputFiles("public/p1-icon-192.png");
    await expect(outgoing.page.getByText("Photos (1)", { exact: true })).toBeVisible();

    await openStaffWorkOrder(manager.page, workOrderId);
    await manager.page.getByRole("button", { name: "Flag capital", exact: true }).click();
    await expect(manager.page.getByText("Portal: Capital Replacement", { exact: true })).toBeVisible();
    await manager.page.getByRole("button", { name: "Reassign", exact: true }).click();
    const reassign = manager.page.getByRole("dialog", { name: "Reassign work order" });
    await reassign.getByRole("button", { name: "New contractor" }).click();
    await manager.page.getByRole("option", { name: /Synthetic Company Admin/ }).first().click();

    await reassign.getByRole("button", { name: "Reassign", exact: true }).click();
    await expect(manager.page.locator(".app-toast")).toContainText(/open visit.*check out/i);
    await expect(reassign).toBeVisible();

    await reassign.getByRole("button", { name: "Emergency staff close-and-transfer", exact: true }).click();
    await reassign.getByLabel("Emergency transfer reason")
      .fill("Sequence test: active capital visit transferred after outgoing technician became unavailable.");
    await reassign.getByLabel(/I explicitly confirm this emergency administrative closure and transfer/).check();
    await reassign.getByRole("button", { name: "Confirm administrative close and transfer", exact: true }).click();
    await expect(reassign).toBeHidden();
    await expect(manager.page.getByText("Portal: Capital Replacement", { exact: true })).toBeVisible();
    await expect(manager.page.getByText("Synthetic Company Admin", { exact: true }).first()).toBeVisible();

    await outgoing.page.reload();
    await expect(outgoing.page.locator(".app-root")).toBeVisible();
    await outgoing.page.getByRole("searchbox", { name: "Search my jobs" }).fill(workOrderId);
    await expect(outgoing.page.getByText("No work orders match your search.", { exact: true })).toBeVisible();

    await openWorkOrder(receiving.page, workOrderId);
    await expect(receiving.page.getByText("Portal: Capital Replacement", { exact: true })).toBeVisible();
    await expect(receiving.page.getByText("Photos (0)", { exact: true })).toBeVisible();
    await expect(receiving.page.getByRole("button", { name: /Start work|Resume work/ })).toHaveCount(0);
  } finally {
    await closeSession(receiving);
    await closeSession(manager);
    await closeSession(outgoing);
  }
});

test("completed field work and a submitted invoice can enter capital and return for Visit 2", async ({ browser }) => {
  test.setTimeout(240_000);
  const workOrderId = "WOTEST8-BILLED-CAPITAL";
  const invoiceNumber = "WOT8-BILLED-FIRST";
  const quoteNumber = "WOT8-CAPITAL-QUOTE";
  const contractor = await createSession(browser, accounts.direct, mobileDevice);
  const manager = await createSession(browser, accounts.manager);
  const backoffice = await createSession(browser, accounts.backoffice);
  try {
    await openWorkOrder(contractor.page, workOrderId);
    await startWork(contractor.page, "Initial repair completed before later capital reclassification.");
    await completeWork(contractor.page, "WOT8-BILLED-CAPITAL-V1");
    await contractor.page.getByRole("button", { name: "Create or upload invoice", exact: true }).click();
    let dialog = contractor.page.getByRole("dialog", { name: "Create invoice" });
    await fillInvoice(dialog, invoiceNumber);
    await dialog.getByRole("button", { name: "Submit", exact: true }).click();
    await expect(dialog).toBeHidden();
    const submitted = contractor.page.getByRole("dialog", { name: `Invoice #${invoiceNumber} submitted` });
    await submitted.getByRole("button", { name: "Done", exact: true }).click();
    await expect(contractor.page.getByText(`#${invoiceNumber}`, { exact: true })).toBeVisible();

    await openStaffWorkOrder(manager.page, workOrderId);
    // Invoice review exists on its own row while the parent remains in the
    // completed field state until contractor invoicing is explicitly finished.
    await expect(manager.page.getByText("Portal: Completed", { exact: true })).toBeVisible();
    await expect(manager.page.getByText(`#${invoiceNumber}`, { exact: true })).toBeVisible();
    await expect(manager.page.getByText("Submitted", { exact: true }).first()).toBeVisible();
    await manager.page.getByRole("button", { name: "Flag capital", exact: true }).click();
    await expect(manager.page.getByText("Portal: Capital Replacement", { exact: true })).toBeVisible();
    await expect(manager.page.getByText(`#${invoiceNumber}`, { exact: true })).toBeVisible();

    await openStaffWorkOrder(backoffice.page, workOrderId);
    await backoffice.page.getByRole("button", { name: "Create capital quote", exact: true }).click();
    dialog = backoffice.page.getByRole("dialog", { name: "Create capital quote for 7-Eleven" });
    await dialog.getByLabel("Invoice #").fill(quoteNumber);
    await dialog.getByRole("button", { name: /^\+ Labor/ }).click();
    await dialog.getByLabel("Line 1 description").fill("Capital replacement after completed initial repair");
    await dialog.getByLabel("Line 1 quantity").fill("3");
    await dialog.getByLabel("Line 1 rate").fill("200");
    await dialog.getByRole("button", { name: "Prepare Quote", exact: true }).click();
    await expect(dialog).toBeHidden();
    await backoffice.page.getByRole("button", { name: "Submit Quote to 7-Eleven", exact: true }).click();
    const confirm = backoffice.page.getByRole("dialog", { name: "Confirm capital quote" });
    await confirm.getByRole("button", { name: "Submit Quote to 7-Eleven", exact: true }).click();
    await expect(confirm).toBeHidden();
    await backoffice.page.getByRole("button", { name: `Back to ${workOrderId}`, exact: true }).click();
    await expect(backoffice.page.getByText("Portal: Pending Capital Completion", { exact: true })).toBeVisible();

    await manager.page.reload();
    await expect(manager.page.locator(".app-root")).toBeVisible();
    await openStaffWorkOrder(manager.page, workOrderId);
    await manager.page.getByRole("button", { name: "Authorize & resume capital work", exact: true }).click();
    await expect(manager.page.getByText("7-Eleven FSM: Awaiting Parts", { exact: true })).toBeVisible();

    await contractor.page.reload();
    await expect(contractor.page.locator(".app-root")).toBeVisible();
    await openWorkOrder(contractor.page, workOrderId);
    await expect(contractor.page.getByRole("button", { name: "Resume work", exact: true })).toBeVisible();
    await contractor.page.getByRole("button", { name: "Resume work", exact: true }).click();
    dialog = contractor.page.getByRole("dialog", { name: "Resume work" });
    await dialog.getByPlaceholder("What are you seeing on site?").fill("Authorized capital return visit started.");
    await dialog.getByRole("button", { name: "Resume", exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(contractor.page.getByText("Visit 2", { exact: true })).toBeVisible();
    await expect(contractor.page.getByText(`#${invoiceNumber}`, { exact: true })).toBeVisible();
    await completeWork(contractor.page, "WOT8-BILLED-CAPITAL-V2");
    await expect(contractor.page.getByText(`#${invoiceNumber}`, { exact: true })).toBeVisible();
  } finally {
    await closeSession(backoffice);
    await closeSession(manager);
    await closeSession(contractor);
  }
});

test("a paused visit returns to Awaiting Parts when capital review is declined", async ({ browser }) => {
  test.setTimeout(150_000);
  const workOrderId = "WOTEST8-DECLINE-PAUSED";
  const technician = await createSession(browser, accounts.invoiceTech, mobileDevice);
  const manager = await createSession(browser, accounts.manager);
  try {
    await openWorkOrder(technician.page, workOrderId);
    await startWork(technician.page, "Visit started before a temporary repair pause.");
    await pauseWork(technician.page, "Waiting for parts before capital review began.");

    await openStaffWorkOrder(manager.page, workOrderId);
    await manager.page.getByRole("button", { name: "Flag capital", exact: true }).click();
    await expect(manager.page.getByText("Portal: Capital Replacement", { exact: true })).toBeVisible();
    await manager.page.getByRole("button", { name: "Capital declined - restore field workflow", exact: true }).click();

    // Visit history, rather than contractor presence alone, determines the
    // field state restored after the parallel capital review ends.
    await expect(manager.page.getByText("Portal: Awaiting Parts", { exact: true })).toBeVisible();
    await expect(manager.page.getByText("7-Eleven FSM: Awaiting Parts", { exact: true })).toBeVisible();

    await technician.page.reload();
    await expect(technician.page.locator(".app-root")).toBeVisible();
    await openWorkOrder(technician.page, workOrderId);
    await expect(technician.page.getByRole("button", { name: "Resume work", exact: true })).toBeVisible();
    await expect(technician.page.getByRole("button", { name: "Start work", exact: true })).toHaveCount(0);
    await resumeWork(technician.page, "Parts arrived after the declined capital review.");
    await expect(technician.page.getByText("Visit 2", { exact: true })).toBeVisible();
  } finally {
    await closeSession(manager);
    await closeSession(technician);
  }
});

test("invoice approval during an active visit does not interrupt pause and resume", async ({ browser }) => {
  test.setTimeout(180_000);
  const workOrderId = "WOTEST8-INVOICE-ACTIVE";
  const invoiceNumber = "WOT8-ACTIVE-INVOICE";
  const contractor = await createSession(browser, accounts.direct, mobileDevice);
  const manager = await createSession(browser, accounts.manager);
  try {
    await openWorkOrder(contractor.page, workOrderId);
    await startWork(contractor.page, "Active field work continues while billing is reviewed.");
    await contractor.page.getByRole("button", { name: "Create or upload invoice", exact: true }).click();
    let dialog = contractor.page.getByRole("dialog", { name: "Create invoice" });
    await fillInvoice(dialog, invoiceNumber);
    await dialog.getByRole("button", { name: "Submit", exact: true }).click();
    await expect(dialog).toBeHidden();
    const submitted = contractor.page.getByRole("dialog", { name: `Invoice #${invoiceNumber} submitted` });
    await submitted.getByRole("button", { name: "Done", exact: true }).click();

    // The invoice form briefly projects its billing status into the current
    // detail cache. Reload before evaluating the committed parallel field and
    // billing states, as a returning mobile user would.
    await waitForApplicationRequestsToSettle(contractor.page);
    await contractor.page.reload();
    await expect(contractor.page.locator(".app-root")).toBeVisible();
    await openWorkOrder(contractor.page, workOrderId);
    await expect(contractor.page.getByText("Portal: In Progress", { exact: true })).toBeVisible();
    await expect(contractor.page.getByText(`#${invoiceNumber}`, { exact: true })).toBeVisible();

    await openStaffWorkOrder(manager.page, workOrderId);
    await expect(manager.page.getByText("Portal: In Progress", { exact: true })).toBeVisible();
    await manager.page.getByRole("button", { name: "Approve", exact: true }).click();
    await expect(manager.page.getByText("Approved", { exact: true }).first()).toBeVisible();
    await expect(manager.page.getByText("Portal: In Progress", { exact: true })).toBeVisible();

    await contractor.page.reload();
    await expect(contractor.page.locator(".app-root")).toBeVisible();
    await openWorkOrder(contractor.page, workOrderId);
    await expect(contractor.page.getByText("Approved", { exact: true }).first()).toBeVisible();
    await pauseWork(contractor.page, "Active work paused after invoice approval.");
    await expect(contractor.page.getByText("Approved", { exact: true }).first()).toBeVisible();
    await resumeWork(contractor.page, "Approved invoice remained attached during Visit 2.");
    await expect(contractor.page.getByText("Visit 2", { exact: true })).toBeVisible();
  } finally {
    await closeSession(manager);
    await closeSession(contractor);
  }
});

test("a paused ordinary job can enter capital review and resume as Visit 2", async ({ browser }) => {
  test.setTimeout(210_000);
  const workOrderId = "WOTEST8-PAUSED-CAPITAL";
  const contractor = await createSession(browser, accounts.direct, mobileDevice);
  const manager = await createSession(browser, accounts.manager);
  const backoffice = await createSession(browser, accounts.backoffice);
  try {
    await openWorkOrder(contractor.page, workOrderId);
    await startWork(contractor.page, "Initial ordinary repair visit started.");
    await pauseWork(contractor.page, "Temporary repair completed; replacement review requested.");

    await openStaffWorkOrder(manager.page, workOrderId);
    await manager.page.getByRole("button", { name: "Flag capital", exact: true }).click();
    await expect(manager.page.getByText("Portal: Capital Replacement", { exact: true })).toBeVisible();

    await openStaffWorkOrder(backoffice.page, workOrderId);
    await submitCapitalQuote(
      backoffice.page,
      workOrderId,
      "WOT8-PAUSED-CAPITAL-QUOTE",
      "Replacement after an ordinary paused first visit",
    );

    await manager.page.reload();
    await expect(manager.page.locator(".app-root")).toBeVisible();
    await openStaffWorkOrder(manager.page, workOrderId);
    await manager.page.getByRole("button", { name: "Authorize & resume capital work", exact: true }).click();
    await expect(manager.page.getByText("7-Eleven FSM: Awaiting Parts", { exact: true })).toBeVisible();

    await contractor.page.reload();
    await expect(contractor.page.locator(".app-root")).toBeVisible();
    await openWorkOrder(contractor.page, workOrderId);
    await expect(contractor.page.getByRole("button", { name: "Resume work", exact: true })).toBeVisible();
    await resumeWork(contractor.page, "Authorized replacement visit started after the earlier pause.");
    await expect(contractor.page.getByText("Visit 1", { exact: true })).toBeVisible();
    await expect(contractor.page.getByText("Visit 2", { exact: true })).toBeVisible();
    await completeWork(contractor.page, "WOT8-PAUSED-CAPITAL-V2");
  } finally {
    await closeSession(backoffice);
    await closeSession(manager);
    await closeSession(contractor);
  }
});

test("a paused job can transfer contractors without exposing the prior assignment", async ({ browser }) => {
  test.setTimeout(180_000);
  const workOrderId = "WOTEST8-PAUSED-TRANSFER";
  const outgoing = await createSession(browser, accounts.direct, mobileDevice);
  const manager = await createSession(browser, accounts.manager);
  const receiving = await createSession(browser, accounts.companyAdmin, mobileDevice);
  try {
    await openWorkOrder(outgoing.page, workOrderId);
    await startWork(outgoing.page, "Outgoing contractor began the original assignment.");
    await outgoing.page.locator('input[type="file"][multiple]').setInputFiles("public/p1-icon-192.png");
    await expect(outgoing.page.getByText("Photos (1)", { exact: true })).toBeVisible();
    await pauseWork(outgoing.page, "Outgoing assignment paused before reassignment.");

    await openStaffWorkOrder(manager.page, workOrderId);
    await manager.page.getByRole("button", { name: "Reassign", exact: true }).click();
    const reassign = manager.page.getByRole("dialog", { name: "Reassign work order" });
    await reassign.getByRole("button", { name: "New contractor" }).click();
    await manager.page.getByRole("option", { name: /Synthetic Company Admin/ }).first().click();
    await reassign.getByRole("button", { name: "Reassign", exact: true }).click();
    await expect(reassign).toBeHidden();

    await outgoing.page.reload();
    await expect(outgoing.page.locator(".app-root")).toBeVisible();
    await outgoing.page.getByRole("searchbox", { name: "Search my jobs" }).fill(workOrderId);
    await expect(outgoing.page.getByText("No work orders match your search.", { exact: true })).toBeVisible();

    await openWorkOrder(receiving.page, workOrderId);
    await expect(receiving.page.getByRole("button", { name: "Start work", exact: true })).toBeVisible();
    await expect(receiving.page.getByRole("button", { name: "Resume work", exact: true })).toHaveCount(0);
    await expect(receiving.page.getByText("Photos (0)", { exact: true })).toBeVisible();
    await startWork(receiving.page, "Receiving contractor started a private new assignment visit.");
    await expect(receiving.page.getByText("Visit 1", { exact: true })).toBeVisible();
    await expect(receiving.page.getByText("Visit 2", { exact: true })).toHaveCount(0);
  } finally {
    await closeSession(receiving);
    await closeSession(manager);
    await closeSession(outgoing);
  }
});

test("staff close without invoice checks out an open visit and makes the job read only", async ({ browser }) => {
  test.setTimeout(150_000);
  const workOrderId = "WOTEST8-OPEN-CLOSE";
  const contractor = await createSession(browser, accounts.direct, mobileDevice);
  const manager = await createSession(browser, accounts.manager);
  try {
    await openWorkOrder(contractor.page, workOrderId);
    await startWork(contractor.page, "Open visit will be administratively checked out by staff close.");

    await openStaffWorkOrder(manager.page, workOrderId);
    await manager.page.getByRole("button", { name: "Close — no invoice", exact: true }).click();
    const close = manager.page.getByRole("dialog", { name: "Close without an invoice" });
    await close.getByRole("button", { name: "Close — no invoice", exact: true }).click();
    await expect(close).toBeHidden();
    await expect(manager.page.locator(".app-toast")).toContainText("Work order closed without an invoice");

    await manager.page.reload();
    await expect(manager.page.locator(".app-root")).toBeVisible();
    await openStaffWorkOrder(manager.page, workOrderId);
    await expect(manager.page.getByText("This work order is closed", { exact: true })).toBeVisible();
    await expect(manager.page.getByText(/→ In progress/, { exact: true })).toHaveCount(0);
    await expect(manager.page.getByRole("button", { name: "Close — no invoice", exact: true })).toHaveCount(0);

    await contractor.page.reload();
    await expect(contractor.page.locator(".app-root")).toBeVisible();
    await contractor.page.getByRole("searchbox", { name: "Search my jobs" }).fill(workOrderId);
    await expect(contractor.page.getByText("No work orders match your search.", { exact: true })).toBeVisible();
    await contractor.page.getByRole("button", { name: "Open menu", exact: true }).click();
    const navigation = contractor.page.getByRole("dialog", { name: "Navigation menu" });
    await navigation.getByRole("button", { name: /Closed jobs/ }).click();
    await contractor.page.getByRole("textbox", { name: "Search closed jobs" }).fill(workOrderId);
    await expect(contractor.page.getByText(workOrderId, { exact: true }).last()).toBeVisible();
  } finally {
    await closeSession(manager);
    await closeSession(contractor);
  }
});
