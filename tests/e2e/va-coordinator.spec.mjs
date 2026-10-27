import { accounts, test, expect, login } from "./fixtures.mjs";
import { readFileSync } from "node:fs";

const WORK_ORDER_WITH_TECHNICIAN_NOTES_ID = "E2E-SUB-TEAM";
const PREVIOUSLY_OUT_OF_TEAM_WORK_ORDER_ID = "E2E-REPORT-START";
const syntheticPhoto = readFileSync("public/p1-icon-192.png");

test("VA coordinator searches all work orders and attributes confirmed note transfer", async ({ page }, testInfo) => {
  await login(page, accounts.vaCoordinator);
  await expect(page.getByRole("heading", { name: "All work orders" })).toBeVisible();
  await expect(page.locator(".desktop-sidebar")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Next", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await expect(page.getByText("Page 2", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Previous", exact: true }).click();
  await expect(page.getByText("Page 1", { exact: true })).toBeVisible();

  const search = page.getByRole("textbox", { name: "Search work orders" });
  await search.fill(PREVIOUSLY_OUT_OF_TEAM_WORK_ORDER_ID);
  await page.getByRole("button", { name: "Search", exact: true }).click();
  const globalWorkOrder = page.getByRole("button", { name: new RegExp(PREVIOUSLY_OUT_OF_TEAM_WORK_ORDER_ID) });
  await expect(globalWorkOrder).toBeVisible();
  await globalWorkOrder.click();
  await expect(page.getByRole("heading", { name: PREVIOUSLY_OUT_OF_TEAM_WORK_ORDER_ID })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Equipment" })).toBeVisible();
  await expect(page.getByText("Synthetic out-of-team attachment", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /Invoice|Close work order|Reassign/ })).toHaveCount(0);

  const transferNoteText = testInfo.project.name === "desktop-webkit"
    ? "Synthetic VA WebKit note to transfer."
    : "Synthetic VA Chrome note to transfer.";
  const transferNote = page.getByRole("article").filter({ hasText: transferNoteText });
  await expect(transferNote).toBeVisible();

  await page.route("**/storage/v1/object/**/photos/wo/E2E-REPORT-START/va-coordinator-out-of-scope.png", route =>
    route.fulfill({ status: 200, contentType: "image/png", body: syntheticPhoto }));
  await page.getByRole("button", { name: "View photo", exact: true }).click();
  await expect(page.getByRole("img", { name: "Synthetic out-of-team attachment" })).toBeVisible();

  await transferNote.getByRole("button", { name: "Mark copied to 7-Eleven", exact: true }).click();
  const globalTransferDialog = page.getByRole("dialog", { name: "Confirm transfer to 7-Eleven" });
  await expect(globalTransferDialog.getByRole("button", { name: "Record transfer", exact: true })).toBeDisabled();
  await globalTransferDialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(transferNote.getByRole("button", { name: "Mark copied to 7-Eleven", exact: true })).toBeVisible();
  await transferNote.getByRole("button", { name: "Mark copied to 7-Eleven", exact: true }).click();
  const confirmedDialog = page.getByRole("dialog", { name: "Confirm transfer to 7-Eleven" });
  await confirmedDialog.getByRole("checkbox", { name: "I confirm I successfully copied this note into 7-Eleven." }).check();
  await confirmedDialog.getByRole("button", { name: "Record transfer", exact: true }).click();
  await expect(transferNote.getByText("Transferred by Synthetic VA Coordinator", { exact: false })).toBeVisible();

  await search.fill(WORK_ORDER_WITH_TECHNICIAN_NOTES_ID);
  await page.getByRole("button", { name: "Search", exact: true }).click();
  const workOrder = page.getByRole("button", { name: new RegExp(WORK_ORDER_WITH_TECHNICIAN_NOTES_ID) });
  await expect(workOrder).toBeVisible();
  await workOrder.click();

  await expect(page.getByRole("heading", { name: WORK_ORDER_WITH_TECHNICIAN_NOTES_ID })).toBeVisible();
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
});
