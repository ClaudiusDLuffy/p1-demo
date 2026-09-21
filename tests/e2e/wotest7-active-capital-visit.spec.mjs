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

const WORK_ORDER_ID = "WOTEST7";
const CAPITAL_QUOTE_NUMBER = "WOTEST7-CAP-Q";
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

async function openMobileContractorWorkOrder(page) {
  await openWorkOrder(page, WORK_ORDER_ID);
}

test("WOTEST7 preserves an open visit through capital review and resumes as Visit 2", async ({ browser }) => {
  test.setTimeout(180_000);

  // Reproduce the field-first sequence: the assigned technician starts Visit 1
  // before P1 later reclassifies the same work order as capital.
  await asAccount(browser, accounts.invoiceTech, async page => {
    await openMobileContractorWorkOrder(page);
    await page.getByRole("button", { name: "Start work", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Start work" });
    await dialog.getByPlaceholder("What are you seeing on site?").fill(
      "WOTEST7 first visit found equipment requiring capital replacement.",
    );
    await dialog.getByRole("button", { name: "Start work", exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText("Visit 1", { exact: true })).toBeVisible();
    await expect(page.getByText("7-Eleven FSM: Work in Progress", { exact: true })).toBeVisible();
  }, mobileDevice);

  await asAccount(browser, accounts.manager, async page => {
    await openStaffWorkOrder(page);
    await page.getByRole("button", { name: "Flag capital", exact: true }).click();
    await expect(page.getByText("Portal: Capital Replacement", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Clock out for capital review", exact: true })).toBeVisible();
  });

  // Submitting the quote advances the capital track without silently closing
  // the technician's real Visit 1.
  await asAccount(browser, accounts.backoffice, async page => {
    await openStaffWorkOrder(page);
    await page.getByRole("button", { name: "Create capital quote", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Create capital quote for 7-Eleven" });
    await dialog.getByLabel("Invoice #").fill(CAPITAL_QUOTE_NUMBER);
    await dialog.getByRole("button", { name: /^\+ Labor/ }).click();
    await dialog.getByLabel("Line 1 description").fill("WOTEST7 synthetic capital replacement labor");
    await dialog.getByLabel("Line 1 quantity").fill("2");
    await dialog.getByLabel("Line 1 rate").fill("125");
    await dialog.getByRole("button", { name: "Prepare Quote", exact: true }).click();
    await expect(dialog).toBeHidden();
    await page.getByRole("button", { name: "Submit Quote to 7-Eleven", exact: true }).click();
    const confirm = page.getByRole("dialog", { name: "Confirm capital quote" });
    await confirm.getByRole("button", { name: "Submit Quote to 7-Eleven", exact: true }).click();
    await expect(confirm).toBeHidden();
    await page.getByRole("button", { name: `Back to ${WORK_ORDER_ID}`, exact: true }).click();
    await expect(page.getByText("Portal: Pending Capital Completion", { exact: true })).toBeVisible();
    await expect(page.getByText("Visit 1", { exact: true })).toBeVisible();
  });

  // Staff cannot authorize a second visit or complete capital work while the
  // first field visit still lacks a real checkout.
  await asAccount(browser, accounts.manager, async page => {
    await openStaffWorkOrder(page);
    await expect(page.getByRole("button", { name: "Waiting for active visit checkout", exact: true })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Checkout required before completion", exact: true })).toBeDisabled();
  });

  // On an iPhone-sized viewport, the assigned technician records the original
  // checkout. The capital stage survives and no fake Visit 2 is created yet.
  await asAccount(browser, accounts.invoiceTech, async page => {
    await openMobileContractorWorkOrder(page);
    await expect(page.getByRole("button", { name: "Clock out for capital review", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Clock out for capital review", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Clock out for capital review" });
    await expect(dialog.getByText(/capital quote and authorization stage will remain unchanged/i)).toBeVisible();
    await expect(dialog.getByText("Reason: Capital review. P1 must authorize the next field visit before Resume becomes available.", { exact: true })).toBeVisible();
    await dialog.getByLabel("Notes").fill("WOTEST7 Visit 1 ended while the capital quote awaits authorization.");
    await dialog.getByRole("button", { name: "Clock out visit", exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText("Portal: Pending Capital Completion", { exact: true })).toBeVisible();
    await expect(page.getByText("Visit 1", { exact: true })).toBeVisible();
    await expect(page.getByText("Visit 2", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Resume work", exact: true })).toHaveCount(0);
  }, mobileDevice);

  await asAccount(browser, accounts.manager, async page => {
    await openStaffWorkOrder(page);
    await expect(page.getByRole("button", { name: "Authorize & resume capital work", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "Authorize & resume capital work", exact: true }).click();
    await expect(page.getByText("7-Eleven FSM: Awaiting Parts", { exact: true })).toBeVisible();
  });

  // Authorization now exposes Resume rather than Start. The check-in creates
  // a separate Visit 2 and completion closes only that return visit.
  await asAccount(browser, accounts.invoiceTech, async page => {
    await openMobileContractorWorkOrder(page);
    await expect(page.getByRole("button", { name: "Resume work", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Start work", exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "Resume work", exact: true }).click();
    let dialog = page.getByRole("dialog", { name: "Resume work" });
    await dialog.getByPlaceholder("What are you seeing on site?").fill(
      "WOTEST7 replacement authorized; starting the second trip.",
    );
    await dialog.getByRole("button", { name: "Resume", exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText("Visit 2", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "Mark work complete", exact: true }).click();
    dialog = page.getByRole("dialog", { name: "Mark work complete" });
    await dialog.getByLabel("Equipment make").fill("Synthetic Capital Make");
    await dialog.getByLabel("Asset model").fill("WOTEST7-MODEL");
    await dialog.getByLabel("Serial number").fill("WOTEST7-SERIAL");
    await dialog.getByLabel("Equipment year *").fill("2026");
    await dialog.getByRole("combobox", { name: "Resolution code" }).click();
    await page.getByRole("option", { name: "Current Asset Repaired", exact: true }).click();
    await dialog.getByLabel("Closing notes").fill("WOTEST7 capital replacement completed on Visit 2.");
    await dialog.getByRole("button", { name: "Mark work complete", exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText("7-Eleven FSM: Completed", { exact: true })).toBeVisible();
    await expect(page.getByText("Visit 1", { exact: true })).toBeVisible();
    await expect(page.getByText("Visit 2", { exact: true })).toBeVisible();
  }, mobileDevice);
});
