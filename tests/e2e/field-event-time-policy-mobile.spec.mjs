import { devices } from "@playwright/test";
import { accounts, login, test } from "./fixtures.mjs";
import { exerciseFieldEventTimePolicy } from "./field-event-time-policy.helpers.mjs";

const mobileDevice = { ...devices["iPhone 13"] };
delete mobileDevice.defaultBrowserType;
test.use(mobileDevice);

test("mobile contractor sees field-time errors without failed lifecycle requests", async ({ page }) => {
  await login(page, accounts.reportTech);
  await exerciseFieldEventTimePolicy(page);
});
