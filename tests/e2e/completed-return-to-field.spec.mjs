import {
  accounts,
  expect,
  login,
  openSidebarPage,
  openWorkOrder,
  test,
  waitForApplicationRequestsToSettle,
} from "./fixtures.mjs";

async function reloadWorkOrder(page, workOrderId) {
  await waitForApplicationRequestsToSettle(page);
  await page.reload();
  await expect(page.locator(".app-root")).toBeVisible();
  await openWorkOrder(page, workOrderId);
}

test("an individual contractor cannot return completed work", async ({ page }) => {
  await login(page, accounts.direct);
  await openWorkOrder(page, "E2E-COMPLETED-RETURN-STAFF");
  await expect(page.getByRole("button", { name: "Return to field work", exact: true })).toHaveCount(0);
});

test("an assigned report-only technician cannot return completed company work", async ({ page }) => {
  await login(page, accounts.reportTech);
  await openWorkOrder(page, "E2E-COMPLETED-RETURN");
  await expect(page.getByRole("button", { name: "Return to field work", exact: true })).toHaveCount(0);
});

test("company admin preserves two submitted invoices through return, resume, and repeat completion", async ({ page }) => {
  await login(page, accounts.companyAdmin);
  await openWorkOrder(page, "E2E-COMPLETED-RETURN");

  await expect(page.getByText("2 invoices on this work order", { exact: true })).toBeVisible();
  await expect(page.getByText("Visit 1", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Return to field work", exact: true }).click();
  let dialog = page.getByRole("dialog", { name: "Return to field work" });
  await dialog.getByRole("button", { name: "Return to field work", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("at least 5 characters");
  await dialog.getByPlaceholder("Explain what field work still needs to be completed...")
    .fill("Compressor follow-up requires another field visit.");
  await dialog.getByRole("button", { name: "Return to field work", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText("7-Eleven FSM: Awaiting Parts", { exact: true })).toBeVisible();
  await expect(page.getByText("Billing: Pending Approval", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Resume work", exact: true })).toBeVisible();
  await expect(page.getByText("2 invoices on this work order", { exact: true })).toBeVisible();

  await reloadWorkOrder(page, "E2E-COMPLETED-RETURN");
  await page.getByRole("button", { name: "Resume work", exact: true }).click();
  dialog = page.getByRole("dialog", { name: "Resume work" });
  await dialog.getByPlaceholder("What are you seeing on site?").fill("Return visit for compressor follow-up.");
  await dialog.getByRole("button", { name: "Resume", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText("7-Eleven FSM: Work in Progress", { exact: true })).toBeVisible();
  await expect(page.getByText("Billing: Pending Approval", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Mark work complete", exact: true }).click();
  dialog = page.getByRole("dialog", { name: "Mark work complete" });
  await dialog.getByLabel("Equipment make").fill("Synthetic Return Make");
  await dialog.getByLabel("Asset model").fill("RETURN-MODEL-1");
  await dialog.getByLabel("Serial number").fill("RETURN-SERIAL-1");
  await dialog.getByLabel("Equipment year *").fill("2024");
  await dialog.getByRole("combobox", { name: "Resolution code" }).click();
  await page.getByRole("option", { name: "Current Asset Repaired", exact: true }).click();
  await dialog.getByLabel("Closing notes").fill("Return visit completed without changing prior invoices.");
  await dialog.getByRole("button", { name: "Mark work complete", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText("7-Eleven FSM: Completed", { exact: true })).toBeVisible();
  await expect(page.getByText("Portal: Pending Approval", { exact: true })).toBeVisible();

  await reloadWorkOrder(page, "E2E-COMPLETED-RETURN");
  await expect(page.getByText("Visit 1", { exact: true })).toBeVisible();
  await expect(page.getByText("Visit 2", { exact: true })).toBeVisible();
  await expect(page.getByText("2 invoices on this work order", { exact: true })).toBeVisible();
  await expect(page.getByText("Completed work returned for another field visit", { exact: false })).toBeVisible();
});

test("P1 operations staff can return completed work while preserving its billing status", async ({ page }) => {
  await login(page, accounts.manager);
  await openSidebarPage(page, "Work orders");
  await openWorkOrder(page, "E2E-COMPLETED-RETURN-STAFF");
  await page.getByRole("button", { name: "Return to field work", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Return to field work" });
  await dialog.getByPlaceholder("Explain what field work still needs to be completed...")
    .fill("P1 requested a verified follow-up visit.");
  await dialog.getByRole("button", { name: "Return to field work", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText("Billing: Pending Approval", { exact: true })).toBeVisible();
  await expect(page.getByText("7-Eleven FSM: Awaiting Parts", { exact: true })).toBeVisible();
  await expect(page.getByText("1 invoice on this work order", { exact: true })).toBeVisible();
});
