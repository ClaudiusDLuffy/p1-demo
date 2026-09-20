import { devices } from "@playwright/test";
import { accounts, expect, login, openWorkOrder, test } from "./fixtures.mjs";

const mobileDevice = { ...devices["iPhone 13"] };
delete mobileDevice.defaultBrowserType;
test.use(mobileDevice);

test("mobile company admin can return completed work and start visit two", async ({ page }) => {
  await login(page, accounts.companyAdmin);
  await openWorkOrder(page, "E2E-COMPLETED-RETURN-MOBILE");
  await expect(page.getByText("Visit 1", { exact: true })).toBeVisible();
  await expect(page.getByText("1 invoice on this work order", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Return to field work", exact: true }).click();
  let dialog = page.getByRole("dialog", { name: "Return to field work" });
  await dialog.getByPlaceholder("Explain what field work still needs to be completed...")
    .fill("Mobile follow-up visit requested by the store.");
  await dialog.getByRole("button", { name: "Return to field work", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText("7-Eleven FSM: Awaiting Parts", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Resume work", exact: true }).click();
  dialog = page.getByRole("dialog", { name: "Resume work" });
  await dialog.getByPlaceholder("What are you seeing on site?").fill("Mobile return visit started.");
  await dialog.getByRole("button", { name: "Resume", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText("7-Eleven FSM: Work in Progress", { exact: true })).toBeVisible();
  await expect(page.getByText("Billing: Pending Approval", { exact: true })).toBeVisible();
  await expect(page.getByText("1 invoice on this work order", { exact: true })).toBeVisible();
  await expect(page.getByText("Visit 2", { exact: true })).toBeVisible();
});
