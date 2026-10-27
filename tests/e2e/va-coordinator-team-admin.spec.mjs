import { accounts, test, expect, login, sidebar } from "./fixtures.mjs";

for (const account of [accounts.manager, accounts.backoffice, accounts.controller, accounts.dispatcher]) {
  test(`${account.name} does not see the archived VA Teams screen`, async ({ page }) => {
    await login(page, account);
    await expect(sidebar(page).getByRole("button", { name: "VA Teams", exact: true })).toHaveCount(0);
  });
}
