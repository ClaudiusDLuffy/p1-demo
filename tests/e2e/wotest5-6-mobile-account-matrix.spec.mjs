import { devices } from "@playwright/test";
import { createCanvas } from "@napi-rs/canvas";
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

function imageFile(name, color, type = "image/jpeg") {
  const canvas = createCanvas(1_024, 1_024);
  const context = canvas.getContext("2d");
  context.fillStyle = color;
  context.fillRect(0, 0, 1_024, 1_024);
  context.fillStyle = "#fff";
  context.font = "96px sans-serif";
  context.fillText(name, 80, 540);
  return {
    name: `${name}.${type === "image/png" ? "png" : "jpg"}`,
    mimeType: type,
    buffer: canvas.toBuffer(type === "image/png" ? "image/png" : "image/jpeg"),
  };
}

async function createSession(browser, account, options = {}) {
  const context = await browser.newContext(options);
  const page = await context.newPage();
  const fatal = [];
  page.on("pageerror", error => fatal.push(`pageerror: ${error.message}`));
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

async function completeWork(page, prefix) {
  await page.getByRole("button", { name: "Mark work complete", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Mark work complete" });
  await dialog.getByLabel("Equipment make").fill("Synthetic Mobile Make");
  await dialog.getByLabel("Asset model").fill(`${prefix}-MODEL`);
  await dialog.getByLabel("Serial number").fill(`${prefix}-SERIAL`);
  await dialog.getByLabel("Equipment year *").fill("2025");
  await dialog.getByRole("combobox", { name: "Resolution code" }).click();
  await page.getByRole("option", { name: "Current Asset Repaired", exact: true }).click();
  await dialog.getByLabel("Closing notes").fill(`${prefix} mobile repair completed.`);
  await dialog.getByRole("button", { name: "Mark work complete", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText("7-Eleven FSM: Completed", { exact: true })).toBeVisible();
}

async function fillKnownInvoice(dialog, number) {
  await dialog.getByLabel("Invoice #").fill(number);
  await dialog.getByRole("button", { name: "+ Labor", exact: true }).click();
  await dialog.getByLabel("Line 1 description").fill(`${number} verified mobile labor`);
  await dialog.getByLabel("Line 1 quantity").fill("2.5");
  await dialog.getByLabel("Line 1 rate").fill("100");
  await dialog.getByRole("button", { name: "+ Parts", exact: true }).click();
  await dialog.getByLabel("Line 2 description").fill(`${number} verified mobile part`);
  await dialog.getByLabel("Line 2 quantity").fill("2");
  await dialog.getByLabel("Line 2 rate").fill("80");
  await dialog.getByLabel("Sales tax").fill("16.50");
  await expect(dialog.getByText(/^\$410(?:\.00)?$/).first()).toBeVisible();
  await expect(dialog.getByText(/^\$426\.5(?:0)?$/).first()).toBeVisible();
}

test("WOTEST5 keeps a legacy-linked invoice technician operational across pagination, parallel jobs, mobile photos, and billing", async ({ browser }) => {
  test.setTimeout(240_000);

  const desktop = await createSession(browser, accounts.legacyInvoiceTech);
  try {
    const activeCount = desktop.page.locator(".stats-grid .card").filter({ hasText: "Active" });
    await expect(activeCount.getByText("29", { exact: true })).toBeVisible();
    await expect(desktop.page.getByText("— jobs · page 1", { exact: true })).toBeVisible();
    await desktop.page.getByRole("button", { name: "Next", exact: true }).click();
    await expect(desktop.page.getByText("— jobs · page 2", { exact: true })).toBeVisible();
    await desktop.page.getByRole("searchbox", { name: "Search my jobs" }).fill("WOT9005005");
    await expect(desktop.page.getByText("1 exact assignment", { exact: true })).toBeVisible();
    await expect(desktop.page.getByText("WOT9005005", { exact: true }).first()).toBeVisible();
    await desktop.page.getByRole("searchbox", { name: "Search my jobs" }).fill("WOTEST5-OVERLAP");
    await expect(desktop.page.getByText("— jobs · page 1", { exact: true })).toBeVisible();
    await expect(desktop.page.getByText("WOTEST5-OVERLAP", { exact: true }).first()).toBeVisible();
    await openWorkOrder(desktop.page, "WOTEST5-OVERLAP");
    await expect(desktop.page.getByRole("button", { name: "Start work", exact: true })).toBeVisible();
    await expect(desktop.page.getByText("AFM email", { exact: true })).toHaveCount(0);
  } finally {
    await closeSession(desktop);
  }

  const primary = await createSession(browser, accounts.legacyInvoiceTech, mobileDevice);
  const parallel = await createSession(browser, accounts.legacyInvoiceTech, mobileDevice);
  try {
    await primary.page.getByRole("searchbox", { name: "Search my jobs" }).fill("Legacy-linked mobile field work");
    await expect(primary.page.getByText("WOTEST5", { exact: true }).first()).toBeVisible();
    await openWorkOrder(primary.page, "WOTEST5");
    await openWorkOrder(parallel.page, "WOTEST5-OVERLAP");

    // An open visit on one assigned work order must not prevent the same
    // technician from clocking into another legitimate assigned work order.
    await startWork(primary.page, "WOTEST5 primary mobile visit started.");
    await startWork(parallel.page, "WOTEST5 parallel mobile visit started.");
    await expect(primary.page.getByText("Visit 1", { exact: true })).toBeVisible();
    await expect(parallel.page.getByText("Visit 1", { exact: true })).toBeVisible();

    await Promise.all([
      primary.page.locator('input[type="file"][capture="environment"]').setInputFiles(
        imageFile("wotest5-camera", "#0f766e"),
      ),
      parallel.page.locator('input[type="file"][multiple]').setInputFiles([
        imageFile("wotest5-parallel-1", "#2563eb", "image/png"),
        imageFile("wotest5-parallel-2", "#9333ea", "image/png"),
        imageFile("wotest5-parallel-3", "#c2410c", "image/png"),
      ]),
    ]);
    await expect(primary.page.getByText("Photos (1)", { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(parallel.page.getByText("Photos (3)", { exact: true })).toBeVisible({ timeout: 30_000 });

    await pauseWork(parallel.page, "Parallel assigned visit clocked out successfully.");
    await pauseWork(primary.page, "Primary assigned visit clocked out successfully.");
    await expect(primary.page.getByRole("button", { name: "Resume work", exact: true })).toBeVisible();
    await expect(parallel.page.getByRole("button", { name: "Resume work", exact: true })).toBeVisible();

    await resumeWork(primary.page, "WOTEST5 second mobile visit resumed.");
    await expect(primary.page.getByText("Visit 2", { exact: true })).toBeVisible();
    await completeWork(primary.page, "WOTEST5");

    await primary.page.getByRole("button", { name: "Create or upload invoice", exact: true }).click();
    const invoice = primary.page.getByRole("dialog", { name: "Create invoice" });
    await fillKnownInvoice(invoice, "WOTEST5-MOBILE");
    await invoice.getByRole("button", { name: "Save as draft", exact: true }).click();
    await expect(invoice).toBeHidden();
    await expect(primary.page.getByText("#WOTEST5-MOBILE", { exact: true })).toBeVisible();

    await waitForApplicationRequestsToSettle(primary.page);
    await primary.page.reload();
    await expect(primary.page.locator(".app-root")).toBeVisible();
    await primary.page.getByRole("searchbox", { name: "Search my jobs" }).fill("Legacy-linked mobile field work");
    await expect(primary.page.getByText("WOTEST5", { exact: true }).first()).toBeVisible();
    await openWorkOrder(primary.page, "WOTEST5");
    await expect(primary.page.getByText("7-Eleven FSM: Completed", { exact: true })).toBeVisible();
    await expect(primary.page.getByText("Photos (1)", { exact: true })).toBeVisible();
    await expect(primary.page.getByText("#WOTEST5-MOBILE", { exact: true })).toBeVisible();
  } finally {
    await closeSession(parallel);
    await closeSession(primary);
  }

  const otherTechnician = await createSession(browser, accounts.invoiceTech);
  try {
    await otherTechnician.page.getByRole("searchbox", { name: "Search my jobs" }).fill("WOTEST5-OVERLAP");
    await expect(otherTechnician.page.getByText("No work orders match your search.", { exact: true })).toBeVisible();
  } finally {
    await closeSession(otherTechnician);
  }
});

test("WOTEST6 preserves an aged visit and parallel billing state through an installed-mobile return workflow", async ({ browser }) => {
  test.setTimeout(240_000);
  const session = await createSession(browser, accounts.invoiceTech, mobileDevice);
  const { page } = session;
  try {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "standalone", { configurable: true, value: true });
    });
    await page.reload();
    await expect(page.locator(".app-root")).toBeVisible();
    await openWorkOrder(page, "WOTEST6");
    await expect(page.getByText("Billing: Pending 7-Eleven Submission", { exact: true })).toBeVisible();
    await expect(page.getByText("7-Eleven FSM: Awaiting Parts", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Resume work", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Submit work report", exact: true })).toHaveCount(0);
    await expect(page.getByText("Visit 1", { exact: true })).toBeVisible();

    // The original visit is thirty days old. The contractor can still make an
    // audited correction, provided the replacement interval is valid.
    await page.getByRole("button", { name: "Correct actual time", exact: true }).click();
    const checkinDate = page.getByLabel("Actual check-in date");
    const checkinTime = page.getByLabel("Actual check-in time");
    const corrected = new Date(`${await checkinDate.inputValue()}T${await checkinTime.inputValue()}:00Z`);
    corrected.setUTCMinutes(corrected.getUTCMinutes() - 1);
    await checkinDate.fill(corrected.toISOString().slice(0, 10));
    await checkinTime.fill(corrected.toISOString().slice(11, 16));
    await page.getByPlaceholder("Explain why the recorded time was inaccurate")
      .fill("Aged technician timesheet verified against the service record.");
    await page.getByRole("button", { name: "Save correction", exact: true }).click();
    await expect(page.getByText(/corrected visit time: Aged technician timesheet verified/)).toBeVisible();

    await resumeWork(page, "WOTEST6 aged return visit resumed.");
    await expect(page.getByText("Billing: Pending 7-Eleven Submission", { exact: true })).toBeVisible();
    await expect(page.getByText("Visit 2", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "Submit work report", exact: true }).click();
    let dialog = page.getByRole("dialog", { name: "Submit work report" });
    await expect(dialog.getByText(/does not check in, check out, resume, or complete/i)).toBeVisible();
    await dialog.getByLabel("Technician name").fill("Synthetic Invoice Technician");
    await dialog.getByLabel("Arrival time *").fill("2026-09-20T08:00");
    await dialog.getByLabel("Departure time *").fill("2026-09-20T09:15");
    await dialog.getByLabel("Work performed *").fill("WOTEST6 diagnostic report without a lifecycle transition.");
    await dialog.getByRole("button", { name: "Submit report", exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText("Visit 3", { exact: true })).toHaveCount(0);
    await expect(page.getByText("7-Eleven FSM: Work in Progress", { exact: true })).toBeVisible();

    await page.locator('input[type="file"][capture="environment"]').setInputFiles(
      imageFile("wotest6-camera", "#be123c"),
    );
    await expect(page.getByText("Photos (1)", { exact: true })).toBeVisible({ timeout: 30_000 });
    await page.reload();
    await expect(page.locator(".app-root")).toBeVisible();
    await openWorkOrder(page, "WOTEST6");
    await expect(page.getByText("Photos (1)", { exact: true })).toBeVisible();
    await expect(page.getByText("Billing: Pending 7-Eleven Submission", { exact: true })).toBeVisible();
    await expect(page.getByText("Visit 2", { exact: true })).toBeVisible();

    await pauseWork(page, "WOTEST6 second visit paused with billing state retained.");
    await expect(page.getByText("Billing: Pending 7-Eleven Submission", { exact: true })).toBeVisible();
    await resumeWork(page, "WOTEST6 third visit resumed after parts arrival.");
    await expect(page.getByText("Visit 3", { exact: true })).toBeVisible();
    await completeWork(page, "WOTEST6");
    await expect(page.getByText("Portal: Pending 7-Eleven Submission", { exact: true })).toBeVisible();
    await expect(page.getByText("Visit 3", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "Create or upload invoice", exact: true }).click();
    dialog = page.getByRole("dialog", { name: "Create invoice" });
    await fillKnownInvoice(dialog, "WOTEST6-FINAL");
    await dialog.getByRole("button", { name: "Submit", exact: true }).click();
    await expect(dialog).toBeHidden();
    const submitted = page.getByRole("dialog", { name: "Invoice #WOTEST6-FINAL submitted" });
    await expect(submitted).toBeVisible();
    await submitted.getByRole("button", { name: "Done", exact: true }).click();
    await expect(page.getByText("#WOTEST6-FINAL", { exact: true })).toBeVisible();

    page.once("dialog", confirmation => confirmation.accept());
    await page.getByRole("button", { name: "Done invoicing — close contractor job", exact: true }).click();
    await expect(page.getByText("Contractor job closed — invoicing complete", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Done invoicing — close contractor job", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Create or upload another invoice", exact: true })).toBeVisible();
    await expect(page.getByText("#WOTEST6-FINAL", { exact: true })).toBeVisible();
  } finally {
    await closeSession(session);
  }

  for (const account of [accounts.legacyInvoiceTech, accounts.reportTech]) {
    const unauthorized = await createSession(browser, account);
    try {
      await unauthorized.page.getByRole("searchbox", { name: "Search my jobs" }).fill("WOTEST6");
      await expect(unauthorized.page.getByText("No work orders match your search.", { exact: true })).toBeVisible();
    } finally {
      await closeSession(unauthorized);
    }
  }

  const companyAdmin = await createSession(browser, accounts.companyAdmin);
  try {
    await openSidebarPage(companyAdmin.page, "My Team");
    await companyAdmin.page.getByRole("searchbox", { name: "Search team work orders" }).fill("WOTEST6");
    await expect(companyAdmin.page.getByText("WOTEST6", { exact: true }).first()).toBeVisible();
  } finally {
    await closeSession(companyAdmin);
  }
});
