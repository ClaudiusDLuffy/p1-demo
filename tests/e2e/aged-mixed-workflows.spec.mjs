import { accounts, expect, login, openSidebarPage, openWorkOrder, test } from "./fixtures.mjs";

async function openDirectJob(page, workOrderId) {
  await openSidebarPage(page, "My jobs");
  await openWorkOrder(page, workOrderId);
}

async function resumeJob(page, workOrderId) {
  await openDirectJob(page, workOrderId);
  await expect(page.getByRole("button", { name: "Resume work", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Submit work report", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Mark work complete", exact: true })).toHaveCount(0);

  await expect(page.getByText(/^Visit \d+$/)).toHaveCount(1);
  await page.getByRole("button", { name: "Resume work", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Resume work" });
  await dialog.getByPlaceholder("What are you seeing on site?")
    .fill("Synthetic aged-state return visit.");
  await dialog.getByRole("button", { name: "Resume", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText("7-Eleven FSM: Work in Progress", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Pause (parts)", exact: true })).toBeVisible();
  await expect(page.getByText(/^Visit \d+$/)).toHaveCount(2);

  await page.reload();
  await openSidebarPage(page, "My jobs");
  await openWorkOrder(page, workOrderId);
  await expect(page.getByText("7-Eleven FSM: Work in Progress", { exact: true })).toBeVisible();
  await expect(page.getByText(/^Visit \d+$/)).toHaveCount(2);
}

test("aged ordinary and capital-tagged paused jobs can resume a second visit", async ({ page }) => {
  await login(page, accounts.direct);
  await resumeJob(page, "E2E-AGED-PARTS");
  await resumeJob(page, "E2E-AGED-CAPITAL-PARTS");
});

test("an invoicing-track job paused for parts resumes without losing billing state", async ({ page }) => {
  await login(page, accounts.direct);
  await resumeJob(page, "E2E-AGED-INVOICE-PARTS");
  await expect(page.getByText("Billing: Pending 7-Eleven Submission", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Pause (parts)", exact: true }).click();
  let dialog = page.getByRole("dialog", { name: "Pause work" });
  await dialog.getByRole("combobox", { name: "Reason" }).click();
  await page.getByRole("option", { name: "Temporary fix - equipment partially working", exact: true }).click();
  await dialog.getByPlaceholder("Explain what was done so far...")
    .fill("Synthetic mixed-state pause after the second visit.");
  await dialog.getByRole("button", { name: "Pause work", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText("Billing: Pending 7-Eleven Submission", { exact: true })).toBeVisible();
  await expect(page.getByText("7-Eleven FSM: Awaiting Parts", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Resume work", exact: true })).toBeVisible();
  await expect(page.getByText(/^Visit \d+$/)).toHaveCount(2);

  await page.getByRole("button", { name: "Resume work", exact: true }).click();
  dialog = page.getByRole("dialog", { name: "Resume work" });
  await dialog.getByPlaceholder("What are you seeing on site?")
    .fill("Synthetic third visit after parts became available.");
  await dialog.getByRole("button", { name: "Resume", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText(/^Visit \d+$/)).toHaveCount(3);

  await page.getByRole("button", { name: "Mark work complete", exact: true }).click();
  dialog = page.getByRole("dialog", { name: "Mark work complete" });
  await dialog.getByLabel("Equipment make").fill("Synthetic Make");
  await dialog.getByLabel("Asset model").fill("SYN-AGED-MODEL");
  await dialog.getByLabel("Serial number").fill("SYN-AGED-SERIAL");
  await dialog.getByLabel("Equipment year *").fill("2022");
  await dialog.getByRole("combobox", { name: "Resolution code" }).click();
  await page.getByRole("option", { name: "Current Asset Repaired", exact: true }).click();
  await dialog.getByLabel("Closing notes").fill("Synthetic aged repair completed and verified.");
  await dialog.getByRole("button", { name: "Mark work complete", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText("Portal: Pending 7-Eleven Submission", { exact: true })).toBeVisible();
  await expect(page.getByText("7-Eleven FSM: Completed", { exact: true })).toBeVisible();
  await expect(page.getByText("Completed", { exact: true }).last()).toBeVisible();

  await page.reload();
  await openDirectJob(page, "E2E-AGED-INVOICE-PARTS");
  await expect(page.getByText("Portal: Pending 7-Eleven Submission", { exact: true })).toBeVisible();
  await expect(page.getByText("7-Eleven FSM: Completed", { exact: true })).toBeVisible();
  await expect(page.getByText(/^Visit \d+$/)).toHaveCount(3);
});

test("capital authorization wait is explicit and staff can release the next field visit", async ({ page, browser }) => {
  await login(page, accounts.direct);
  await openDirectJob(page, "E2E-AGED-CAPITAL-WAIT");
  await expect(page.getByRole("button", { name: "Resume work", exact: true })).toHaveCount(0);
  await expect(page.getByText(/capital work.*authorization/i)).toBeVisible();

  const staffContext = await browser.newContext();
  try {
    const staffPage = await staffContext.newPage();
    await login(staffPage, accounts.manager);
    await openSidebarPage(staffPage, "Work orders");
    await openWorkOrder(staffPage, "E2E-AGED-CAPITAL-WAIT");
    await staffPage.getByRole("button", { name: "Authorize & resume capital work", exact: true }).click();
    await expect(staffPage.getByText("7-Eleven FSM: Dispatched", { exact: true })).toBeVisible();
  } finally {
    await staffContext.close();
  }

  await page.reload();
  await openDirectJob(page, "E2E-AGED-CAPITAL-WAIT");
  await expect(page.getByRole("button", { name: "Start work", exact: true })).toBeVisible();
});
