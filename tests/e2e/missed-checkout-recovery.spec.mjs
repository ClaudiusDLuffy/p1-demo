import { accounts, expect, login, openWorkOrder, test } from "./fixtures.mjs";

test.use({ viewport: { width: 320, height: 568 } });

function storeTimeParts(value, timeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(value);
  const part = type => parts.find(candidate => candidate.type === type)?.value || "";
  return {
    date: `${part("year")}-${part("month")}-${part("day")}`,
    time: `${part("hour")}:${part("minute")}`,
  };
}

test("mobile technician can repair a legacy missed checkout without changing Awaiting Parts", async ({ page }) => {
  await login(page, accounts.teamMember);
  await openWorkOrder(page, "E2E-MISSED-CHECKOUT");

  await expect(page.getByText("7-Eleven FSM: Awaiting Parts", { exact: true })).toBeVisible();
  await expect(page.getByText(/In progress/).first()).toBeVisible();
  await page.getByRole("button", { name: "Record missed checkout", exact: true }).click();

  for (const label of ["Actual check-out date", "Actual check-out time"]) {
    await expect.poll(() => page.getByLabel(label).evaluate(element => {
      const bounds = element.getBoundingClientRect();
      return bounds.left >= 0 && bounds.right <= window.innerWidth;
    })).toBe(true);
  }

  const actualCheckout = storeTimeParts(new Date(Date.now() - 60 * 60 * 1_000), "America/Chicago");
  await page.getByLabel("Actual check-out date").fill(actualCheckout.date);
  await page.getByLabel("Actual check-out time").fill(actualCheckout.time);
  await page.getByLabel("Missed-checkout reason").fill("Technician left after diagnosing the failed component.");
  await page.getByRole("button", { name: "Record checkout", exact: true }).click();

  await expect(page.getByRole("button", { name: "Record missed checkout", exact: true })).toHaveCount(0);
  await expect(page.getByText("7-Eleven FSM: Awaiting Parts", { exact: true })).toBeVisible();
  await expect(page.getByText(/recorded a missed checkout/i).first()).toBeVisible();
});
