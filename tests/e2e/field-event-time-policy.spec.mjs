import { accounts, login, test } from "./fixtures.mjs";
import { exerciseFieldEventTimePolicy } from "./field-event-time-policy.helpers.mjs";

test("contractor field-time policy blocks invalid lifecycle writes with inline guidance", async ({ page }) => {
  await login(page, accounts.reportTech);
  await exerciseFieldEventTimePolicy(page);
});
