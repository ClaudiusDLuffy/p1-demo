import { devices } from "@playwright/test";
import { createCanvas } from "@napi-rs/canvas";
import {
  accounts,
  expect,
  login,
  openWorkOrder,
  test,
  waitForApplicationRequestsToSettle,
} from "./fixtures.mjs";

const mobileDevice = { ...devices["iPhone 13"] };
delete mobileDevice.defaultBrowserType;
test.use(mobileDevice);
const mobileFieldWorkOrderId = "E2E-MOBILE-FIELD";

async function reloadWorkOrder(page, workOrderId) {
  // Let mutation-triggered reads settle before navigating. WebKit reports
  // cross-origin fetches aborted by an immediate reload as CORS page errors,
  // which would hide whether the persisted workflow itself reloaded cleanly.
  await waitForApplicationRequestsToSettle(page);
  await page.reload();
  await expect(page.locator(".app-root")).toBeVisible();
  await openWorkOrder(page, workOrderId);
}

async function refreshWorkOrder(page, workOrderId) {
  await page.getByRole("button", { name: "Refresh portal", exact: true }).click();
  await waitForApplicationRequestsToSettle(page);
  await page.getByRole("button", { name: "Back to previous view", exact: true }).click();
  await openWorkOrder(page, workOrderId);
}

test("mobile contractor can upload an eight-photo batch and retain every confirmed photo", async ({ page }) => {
  const finalizeStatuses = [];
  page.on("response", response => {
    if (new URL(response.url()).pathname === "/api/private-objects/finalize") {
      finalizeStatuses.push(response.status());
    }
  });

  await login(page, accounts.direct);
  await openWorkOrder(page, "E2E-PHOTO");

  const batch = Array.from({ length: 8 }, (_, index) => {
    const canvas = createCanvas(64, 64);
    const context = canvas.getContext("2d");
    context.fillStyle = `hsl(${index * 40} 80% 50%)`;
    context.fillRect(0, 0, 64, 64);
    context.fillStyle = "#fff";
    context.fillText(String(index + 1), 28, 36);
    return { name: `mobile-batch-${index + 1}.png`, mimeType: "image/png", buffer: canvas.toBuffer("image/png") };
  });
  await page.locator('input[type="file"][multiple]').setInputFiles(batch);

  const progress = page.getByRole("region", { name: "Photo upload progress" });
  await expect(progress.getByRole("status")).toHaveText("8 of 8 photos confirmed.", { timeout: 30_000 });
  await expect(progress.getByRole("button", { name: "Retry photo" })).toHaveCount(0);
  await expect(page.getByText("Photos (8)", { exact: true })).toBeVisible();
  expect(finalizeStatuses).toHaveLength(8);
  expect(finalizeStatuses.every(status => status === 200)).toBe(true);

  await reloadWorkOrder(page, "E2E-PHOTO");
  await expect(page.getByText("Photos (8)", { exact: true })).toBeVisible();
});

test("mobile technician can clock in, clock out, resume, and complete across refreshes", async ({ page }) => {
  await login(page, accounts.reportTech);
  await openWorkOrder(page, mobileFieldWorkOrderId);

  await page.getByRole("button", { name: "Start work", exact: true }).click();
  let dialog = page.getByRole("dialog", { name: "Start work" });
  await dialog.getByPlaceholder("What are you seeing on site?").fill("Mobile field visit started.");
  await dialog.getByRole("button", { name: "Start work", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText("7-Eleven FSM: Work in Progress", { exact: true })).toBeVisible();

  await refreshWorkOrder(page, mobileFieldWorkOrderId);
  await page.getByRole("button", { name: "Pause (parts)", exact: true }).click();
  dialog = page.getByRole("dialog", { name: "Pause work" });
  await dialog.getByRole("combobox", { name: "Reason" }).click();
  await page.getByRole("option", { name: "Temporary fix - equipment partially working", exact: true }).click();
  await dialog.getByPlaceholder("Explain what was done so far...").fill("Mobile visit clocked out while awaiting parts.");
  await dialog.getByRole("button", { name: "Pause work", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText("7-Eleven FSM: Awaiting Parts", { exact: true })).toBeVisible();

  await refreshWorkOrder(page, mobileFieldWorkOrderId);
  await page.getByRole("button", { name: "Resume work", exact: true }).click();
  dialog = page.getByRole("dialog", { name: "Resume work" });
  await dialog.getByPlaceholder("What are you seeing on site?").fill("Mobile return visit resumed.");
  await dialog.getByRole("button", { name: "Resume", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText("7-Eleven FSM: Work in Progress", { exact: true })).toBeVisible();

  await refreshWorkOrder(page, mobileFieldWorkOrderId);
  await page.getByRole("button", { name: "Mark work complete", exact: true }).click();
  dialog = page.getByRole("dialog", { name: "Mark work complete" });
  await dialog.getByLabel("Equipment make").fill("Synthetic Mobile Make");
  await dialog.getByLabel("Asset model").fill("MOBILE-MODEL-1");
  await dialog.getByLabel("Serial number").fill("MOBILE-SERIAL-1");
  await dialog.getByLabel("Equipment year *").fill("2024");
  await dialog.getByRole("combobox", { name: "Resolution code" }).click();
  await page.getByRole("option", { name: "Current Asset Repaired", exact: true }).click();
  await dialog.getByLabel("Closing notes").fill("Mobile repair completed and clocked out.");
  await dialog.getByRole("button", { name: "Mark work complete", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText("7-Eleven FSM: Completed", { exact: true })).toBeVisible();

  await refreshWorkOrder(page, mobileFieldWorkOrderId);
  await expect(page.getByText("7-Eleven FSM: Completed", { exact: true })).toBeVisible();
  await expect(page.getByText("Visit 1", { exact: true })).toBeVisible();
  await expect(page.getByText("Visit 2", { exact: true })).toBeVisible();
});
