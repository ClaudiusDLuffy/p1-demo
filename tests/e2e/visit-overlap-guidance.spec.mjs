import {
  accounts,
  expect,
  login,
  openWorkOrder,
  test,
} from "./fixtures.mjs";

test.use({
  viewport: { width: 320, height: 568 },
  screen: { width: 320, height: 568 },
  deviceScaleFactor: 2,
  hasTouch: true,
  isMobile: true,
});

function addLocalMinutes(date, time, minutes) {
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute] = time.split(":").map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day, hour, minute + minutes));
  return {
    date: shifted.toISOString().slice(0, 10),
    time: shifted.toISOString().slice(11, 16),
  };
}

test("mobile visit correction names the accessible conflicting work order", async ({ page }) => {
  await login(page, accounts.direct);
  await openWorkOrder(page, "E2E-VISIT-OVERLAP-TARGET");

  await page.getByRole("button", { name: "Correct actual time", exact: true }).click();
  const checkoutDate = page.getByLabel("Actual check-out date");
  const checkoutTime = page.getByLabel("Actual check-out time");
  const expanded = addLocalMinutes(
    await checkoutDate.inputValue(),
    await checkoutTime.inputValue(),
    90,
  );
  await checkoutDate.fill(expanded.date);
  await checkoutTime.fill(expanded.time);
  await page.getByLabel("Correction reason").fill("Corrected from the technician service record.");
  await page.getByRole("button", { name: "Save correction", exact: true }).click();

  const guidance = page.getByText(/These times overlap another visit on/);
  await expect(guidance).toContainText("E2E-VISIT-OVERLAP-SOURCE");
  await expect(guidance).toContainText("Review the conflicting visit before saving");
  await expect(page.getByRole("button", { name: "Save correction", exact: true })).toBeDisabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
});
