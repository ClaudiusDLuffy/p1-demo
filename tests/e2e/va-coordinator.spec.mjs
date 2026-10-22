import { accounts, test, expect, login } from "./fixtures.mjs";
import { readFileSync } from "node:fs";

const TEAM_WORK_ORDER_ID = "E2E-SUB-TEAM";
const OUT_OF_TEAM_WORK_ORDER_ID = "E2E-REPORT-START";
const syntheticPhoto = readFileSync("public/p1-icon-192.png");

test("VA coordinator searches only team work orders and attributes confirmed note transfer", async ({ page }, testInfo) => {
  await login(page, accounts.vaCoordinator);
  await expect(page.getByRole("heading", { name: "Team work orders" })).toBeVisible();
  await expect(page.locator(".desktop-sidebar")).toHaveCount(0);

  const search = page.getByRole("textbox", { name: "Search team work orders" });
  await search.fill(OUT_OF_TEAM_WORK_ORDER_ID);
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.getByText("No work orders are assigned to your team.", { exact: true })).toBeVisible();
  await expect(page.getByText(OUT_OF_TEAM_WORK_ORDER_ID, { exact: true })).toHaveCount(0);

  await search.fill(TEAM_WORK_ORDER_ID);
  await page.getByRole("button", { name: "Search", exact: true }).click();
  const workOrder = page.getByRole("button", { name: new RegExp(TEAM_WORK_ORDER_ID) });
  await expect(workOrder).toBeVisible();
  await workOrder.click();

  await expect(page.getByRole("heading", { name: TEAM_WORK_ORDER_ID })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Equipment" })).toBeVisible();
  await expect(page.getByText("Synthetic VA coordinator note to transfer.", { exact: true })).toBeVisible();
  await expect(page.getByText("Synthetic VA hidden internal note.", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Synthetic VA team attachment", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /Invoice|Close work order|Reassign/ })).toHaveCount(0);

  await testInfo.attach("va-coordinator-work-order-view.png", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });

  await page.route("**/storage/v1/object/**/photos/wo/E2E-SUB-TEAM/va-coordinator-synthetic.png", route =>
    route.fulfill({ status: 200, contentType: "image/png", body: syntheticPhoto }));
  await page.getByRole("button", { name: "View photo", exact: true }).click();
  await expect(page.getByRole("img", { name: "Synthetic VA team attachment" })).toBeVisible();

  await page.getByRole("button", { name: "Mark copied to 7-Eleven", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Confirm transfer to 7-Eleven" });
  await expect(dialog.getByRole("button", { name: "Record transfer", exact: true })).toBeDisabled();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByRole("button", { name: "Mark copied to 7-Eleven", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Mark copied to 7-Eleven", exact: true }).click();
  const confirmedDialog = page.getByRole("dialog", { name: "Confirm transfer to 7-Eleven" });
  await confirmedDialog.getByRole("checkbox", { name: "I confirm I successfully copied this note into 7-Eleven." }).check();
  await confirmedDialog.getByRole("button", { name: "Record transfer", exact: true }).click();
  await expect(page.getByText("Transferred by Synthetic VA Coordinator", { exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: "Mark copied to 7-Eleven", exact: true })).toHaveCount(0);
});
