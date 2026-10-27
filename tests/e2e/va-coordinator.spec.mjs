import { accounts, test, expect, login } from "./fixtures.mjs";
import { readFileSync } from "node:fs";

const WORK_ORDER_ID = "E2E-REPORT-START";
const syntheticPhoto = readFileSync("public/p1-icon-192.png");

test("VA coordinator uses the standard portal with scoped read access and confirmed note transfer", async ({ page }, testInfo) => {
  // A VA must land on the ordinary portal work-order page even if a stale or
  // crafted URL requests billing. All data still comes from the VA RPCs.
  await login(page, accounts.vaCoordinator, "/?portal=billing");

  const sidebar = page.locator(".desktop-sidebar");
  await expect(sidebar).toBeVisible();
  await expect(sidebar.getByText(accounts.vaCoordinator.name, { exact: true })).toBeVisible();
  const portalNavigation = page.getByRole("navigation", { name: "Portal pages" });
  await expect(portalNavigation.getByRole("button")).toHaveCount(1);
  await expect(portalNavigation.getByRole("button", { name: "Work orders", exact: true })).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("heading", { name: "All work orders" })).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "Search work orders" })).toBeVisible();

  // Exercise the same keyset pagination controls used in the regular portal.
  await expect(page.getByRole("button", { name: "Next", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await expect(page.getByText(/^Page 2/)).toBeVisible();
  await page.getByRole("button", { name: "Previous", exact: true }).click();
  await expect(page.getByText(/^Page 1/)).toBeVisible();

  // This synthetic WO is assigned outside the retired team mapping. Its
  // presence confirms VA access is global to non-deleted work orders.
  await page.getByRole("textbox", { name: "Search work orders" }).fill(WORK_ORDER_ID);
  const row = page.getByRole("row").filter({ hasText: WORK_ORDER_ID });
  await expect(row).toBeVisible();
  await row.click();
  await expect(page.locator(".work-order-reference").filter({ hasText: WORK_ORDER_ID })).toBeVisible();
  await expect(page.getByText("Assigned specifically to the report-only technician.", { exact: true })).toBeVisible();
  await expect(page.locator(".detail-fields").getByText("Synthetic Report Technician", { exact: true })).toBeVisible();

  // The shared detail view is read-only: no normal staff or billing actions,
  // no note editor, and no internal note payload.
  await expect(page.getByRole("button", { name: /Edit work order|Reassign|Close work order|Invoice/i })).toHaveCount(0);
  await expect(page.locator("textarea")).toHaveCount(0);
  await expect(page.getByText("Synthetic VA hidden internal note.", { exact: true })).toHaveCount(0);
  await expect(page.getByText(/Invoice \/ estimate documents|Contractor bill/i)).toHaveCount(0);

  const transferNoteText = testInfo.project.name === "desktop-webkit"
    ? "Synthetic VA WebKit note to transfer."
    : "Synthetic VA Chrome note to transfer.";
  const transferNote = page.getByText(transferNoteText, { exact: true });
  await expect(transferNote).toBeVisible();
  const transferNoteCard = transferNote.locator("..");

  // Photos render through the normal gallery, but paths are obtained from the
  // narrowly scoped VA attachment RPC.
  await page.route("**/storage/v1/object/**/photos/wo/E2E-REPORT-START/va-coordinator-out-of-scope.png**", route =>
    route.fulfill({ status: 200, contentType: "image/png", body: syntheticPhoto }));
  await page.getByRole("button", { name: /View photos \(1 loaded/ }).click();
  await expect(page.getByRole("button", { name: "View photo 1" })).toBeVisible();
  await page.getByRole("button", { name: "View photo 1" }).click();
  const photoDialog = page.getByRole("dialog", { name: "Work-order photo" });
  await expect(photoDialog.getByRole("img", { name: "Work-order photo" })).toBeVisible();
  await photoDialog.getByRole("button", { name: "Close dialog" }).click();

  // The only supported write is a positively confirmed note-copy audit event.
  await transferNoteCard.getByRole("button", { name: "Mark copied to 7-Eleven", exact: true }).click();
  const transferDialog = page.getByRole("dialog", { name: "Confirm 7-Eleven update" });
  await expect(transferDialog.getByRole("button", { name: "Confirm copied", exact: true })).toBeDisabled();
  await transferDialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(transferNoteCard.getByRole("button", { name: "Mark copied to 7-Eleven", exact: true })).toBeVisible();

  await transferNoteCard.getByRole("button", { name: "Mark copied to 7-Eleven", exact: true }).click();
  const confirmedDialog = page.getByRole("dialog", { name: "Confirm 7-Eleven update" });
  await confirmedDialog.getByRole("checkbox", { name: "I confirm I successfully copied this note into 7-Eleven." }).check();
  await confirmedDialog.getByRole("button", { name: "Confirm copied", exact: true }).click();
  await expect(transferNoteCard.getByRole("status")).toContainText(`Updated in 7-Eleven by ${accounts.vaCoordinator.name}`);

  // The same work-order page also uses the portal's normal mobile shell.
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator(".desktop-sidebar")).toBeHidden();
  await expect(page.locator(".mobile-bottom-nav")).toBeVisible();
  const horizontalOverflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  expect(horizontalOverflow, "VA work-order detail should not overflow horizontally on a phone-sized viewport").toBe(false);

  await testInfo.attach("va-standard-portal-work-order.png", {
    body: await page.screenshot({ fullPage: true }),
    contentType: "image/png",
  });
});
