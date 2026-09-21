import { expect, openWorkOrder } from "./fixtures.mjs";

function storeDate(offsetDays) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Chicago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(Date.now() + offsetDays * 24 * 60 * 60 * 1_000));
  const part = type => parts.find(item => item.type === type)?.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

async function chooseDate(dialog, fieldLabel, date) {
  await dialog.getByRole("button", { name: fieldLabel, exact: true }).click();
  const picker = dialog.getByRole("dialog", { name: "Choose date" });
  await expect(picker).toBeVisible();
  await picker.locator(`[data-day="${date}"] button`).click();
  await expect(picker).toBeHidden();
}

function countLifecycleRequests(page, routine) {
  let count = 0;
  page.on("request", request => {
    if (new URL(request.url()).pathname.endsWith(`/rpc/${routine}`)) count += 1;
  });
  return () => count;
}

export async function exerciseFieldEventTimePolicy(page) {
  await openWorkOrder(page, "E2E-TIME-START");
  await page.getByRole("button", { name: "Start work", exact: true }).click();
  let dialog = page.getByRole("dialog", { name: "Start work" });
  await chooseDate(dialog, "Arrival date", storeDate(1));
  await dialog.getByPlaceholder("What are you seeing on site?").fill("Future arrival must remain local.");
  const startRequests = countLifecycleRequests(page, "start_work_order_visit_v1");
  await dialog.getByRole("button", { name: "Start work", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("Arrival time cannot be more than 5 minutes in the future.");
  await dialog.getByRole("button", { name: "Start work", exact: true }).click();
  expect(startRequests(), "unchanged invalid arrival must not reach PostgREST").toBe(0);
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  const discard = page.getByRole("button", { name: "Discard changes", exact: true });
  if (await discard.isVisible().catch(() => false)) await discard.click();

  await page.getByRole("button", { name: "Back to previous view", exact: true }).click();
  await openWorkOrder(page, "E2E-TIME-COMPLETE");

  await page.getByRole("button", { name: "Pause (parts)", exact: true }).click();
  dialog = page.getByRole("dialog", { name: "Pause work" });
  await dialog.getByRole("combobox", { name: "Reason" }).click();
  await page.getByRole("option", { name: "Temporary fix - equipment partially working", exact: true }).click();
  await chooseDate(dialog, "Stamp-out date", storeDate(1));
  await dialog.getByPlaceholder("Explain what was done so far...").fill("Future checkout must remain local.");
  const pauseRequests = countLifecycleRequests(page, "pause_work_order_for_parts_v1");
  await dialog.getByRole("button", { name: "Pause work", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("Checkout time cannot be more than 5 minutes in the future.");
  await dialog.getByRole("button", { name: "Pause work", exact: true }).click();
  expect(pauseRequests(), "unchanged invalid checkout must not reach PostgREST").toBe(0);
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  const pauseDiscard = page.getByRole("button", { name: "Discard changes", exact: true });
  if (await pauseDiscard.isVisible().catch(() => false)) await pauseDiscard.click();

  await page.getByRole("button", { name: "Mark work complete", exact: true }).click();
  dialog = page.getByRole("dialog", { name: "Mark work complete" });
  await dialog.getByLabel("Equipment make").fill("Synthetic Time Make");
  await dialog.getByLabel("Asset model").fill("TIME-1");
  await dialog.getByLabel("Serial number").fill("TIME-SERIAL-1");
  await dialog.getByLabel("Equipment year *").fill("2026");
  await chooseDate(dialog, "End date", storeDate(1));
  const completionRequests = countLifecycleRequests(page, "complete_work_order_field_v1");
  await dialog.getByRole("button", { name: "Mark work complete", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("Completion time cannot be more than 5 minutes in the future.");
  expect(completionRequests(), "invalid future completion must not reach PostgREST").toBe(0);

  await chooseDate(dialog, "End date", storeDate(-1));
  await dialog.getByRole("button", { name: "Mark work complete", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("Completion time cannot be before this visit's check-in time.");
  await dialog.getByRole("button", { name: "Mark work complete", exact: true }).click();
  expect(completionRequests(), "unchanged invalid chronology must not reach PostgREST").toBe(0);
}
