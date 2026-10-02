import { syntheticPassword } from "../../scripts/e2e/local-supabase-runtime.mjs";
import { accounts, expect, login, openSidebarPage, test, waitForApplicationRequestsToSettle } from "./fixtures.mjs";

async function menuAction(page, label) {
  if (page.viewportSize().width <= 720) {
    await page.getByRole("button", { name: "Open menu", exact: true }).click();
    await page.getByRole("dialog", { name: "Navigation menu" }).getByRole("button", { name: label, exact: true }).click();
  } else {
    await page.locator(".desktop-sidebar").getByRole("button", { name: label, exact: true }).click();
  }
}

async function passwordForm(page) {
  await menuAction(page, "Manage Account");
  const dialog = page.getByRole("dialog", { name: "Manage Account", exact: true });
  await dialog.getByRole("button", { name: "Change Password", exact: true }).click();
  const form = page.getByRole("dialog").filter({ has: page.getByRole("heading", { name: "Manage Account", exact: true }) });
  await expect.soft(form, "Account dialog must retain its accessible name after changing content").toHaveAccessibleName("Manage Account");
  return form;
}

async function signOutCompletely(page) {
  const response = page.waitForResponse(value => new URL(value.url()).pathname === "/auth/v1/logout");
  await menuAction(page, "Sign out");
  expect((await response).ok()).toBe(true);
  await expect.poll(() => page.evaluate(() => [localStorage, sessionStorage].every(storage =>
    Object.keys(storage).every(key => !/^sb-.+-auth-token(?:\.\d+)?$/.test(key)),
  ))).toBe(true);
}

async function fitViewport(page, locator) {
  const size = await locator.evaluate(element => ({
    content: element.scrollWidth, visible: element.clientWidth,
    left: element.getBoundingClientRect().left, right: element.getBoundingClientRect().right,
  }));
  expect(size.content).toBeLessThanOrEqual(size.visible + 1);
  expect(size.left).toBeGreaterThanOrEqual(0);
  expect(size.right).toBeLessThanOrEqual(page.viewportSize().width + 1);
}

test("sign-in can be submitted from the password field with Enter", async ({ page }) => {
  await page.goto("/");
  await page.getByPlaceholder("you@p1pros.com").fill(accounts.manager.email);
  await page.locator('input[type="password"]').fill(syntheticPassword);
  await page.locator('input[type="password"]').press("Enter");
  await expect(page.locator(".desktop-sidebar").getByText(accounts.manager.name, { exact: true })).toBeVisible();
});

test("keyboard login validates, recovers from bad credentials, and prevents duplicate submission", async ({ page }) => {
  let requests = 0;
  page.on("request", request => { if (new URL(request.url()).pathname === "/auth/v1/token") requests++; });
  await page.goto("/");
  const password = page.locator('input[type="password"]');
  await password.press("Enter");
  await expect(page.getByText("Enter an email to sign in", { exact: true })).toBeVisible();
  expect(requests).toBe(0);
  await page.getByPlaceholder("you@p1pros.com").fill(accounts.manager.email);
  await password.fill("Synthetic-wrong-password");
  await password.press("Enter");
  await expect(page.getByText("Your sign-in could not be verified. Please sign in again.", { exact: true })).toBeVisible();
  let release;
  let intercepted = false;
  const held = new Promise(resolve => { release = resolve; });
  await page.route("**/auth/v1/token**", async route => {
    intercepted = true;
    await held;
    await route.continue();
  });
  try {
    await password.fill(syntheticPassword);
    await password.press("Enter");
    await expect.poll(() => intercepted).toBe(true);
    await password.press("Enter");
    await expect(page.getByRole("button", { name: "Signing in...", exact: true })).toBeDisabled();
    expect(requests).toBe(2);
    release();
    await expect(page.locator(".desktop-sidebar").getByText(accounts.manager.name, { exact: true })).toBeVisible();
  } finally { release(); }
});

for (const width of [1440, 320]) {
  test(`account validation and nested discard retain correct values at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: width === 320 ? 568 : 900 });
    await login(page, accounts.companyAdminTwo);
    const dialog = await passwordForm(page);
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    expect(await dialog.locator('input[name="password"]').evaluate(input => input.validity.valueMissing)).toBe(true);
    await dialog.getByLabel(/^New password/).fill("short");
    await dialog.getByLabel(/^Confirm new password/).fill("short");
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    await expect(dialog.getByText("Minimum 8 characters", { exact: true })).toHaveCount(2);
    await dialog.getByLabel(/^New password/).fill("Synthetic-only-password-a");
    await dialog.getByLabel(/^Confirm new password/).fill("Synthetic-only-password-b");
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    await expect(dialog.getByText("Passwords do not match", { exact: true })).toBeVisible();
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    const discard = page.getByRole("dialog", { name: "Unsaved changes", exact: true });
    await expect(discard).toBeVisible();
    await discard.getByRole("button", { name: "Keep editing", exact: true }).click();
    await expect(dialog.getByLabel(/^New password/)).toHaveValue("Synthetic-only-password-a");
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await discard.getByRole("button", { name: "Discard changes", exact: true }).click();
    await expect(dialog.getByRole("button", { name: "Change Password", exact: true })).toBeVisible();
    await fitViewport(page, dialog.locator(".modal-inner"));
    await page.screenshot({ path: testInfo.outputPath("account.png") });
  });

  test(`address book search, contact expansion and empty recovery at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: width === 320 ? 568 : 900 });
    await login(page, accounts.manager);
    await menuAction(page, "Address book");
    const dialog = page.getByRole("dialog", { name: "Address book", exact: true });
    const search = dialog.getByRole("searchbox", { name: "Search address book" });
    await search.fill("Synthetic Company Admin Two");
    await expect(dialog.getByText("Synthetic Company Admin Two", { exact: true })).toBeVisible();
    await dialog.getByRole("button", { name: "View contact", exact: true }).click();
    await expect(dialog.getByRole("link", { name: accounts.companyAdminTwo.email })).toBeVisible();
    await fitViewport(page, dialog.locator(".modal-inner"));
    await page.screenshot({ path: testInfo.outputPath("address-book.png") });
    await search.fill("no-such-synthetic-contact");
    await expect(dialog.getByText("No matching contacts on this page.", { exact: true })).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Next", exact: true })).toBeDisabled();
    await search.fill("Synthetic Company Admin Two");
    await expect(dialog.getByRole("button", { name: "View contact", exact: true })).toBeVisible();
  });

  test(`dropdown-selected invoice work order persists through draft save and reload at ${width}px`, async ({ page }) => {
    await login(page, accounts.backoffice);
    await openSidebarPage(page, "7-Eleven billing");
    await page.setViewportSize({ width, height: width === 320 ? 568 : 900 });
    await page.getByRole("button", { name: "+ Create Invoice", exact: true }).click();
    const create = page.getByRole("dialog", { name: "Create P1 to 7-Eleven invoice", exact: true });
    await expect(create.getByLabel("Invoice #")).not.toHaveValue("");
    const number = `P1-E2E-AUDIT-PICKER-${width}`;
    await create.getByLabel("Invoice #").fill(number);
    await create.locator('button[aria-label="Invoice work order"]').click();
    const option = page.getByRole("listbox").getByRole("option").nth(1);
    await expect(option).toBeVisible();
    const selectedId = (await option.innerText()).split(" - Store #")[0].trim();
    await option.click();
    await expect(create.locator('input[name="workOrderId"]')).toHaveValue(selectedId);
    await waitForApplicationRequestsToSettle(page);
    await create.getByRole("button", { name: /^\+ Labor/ }).click();
    await create.getByLabel("Line 1 description").fill("Synthetic audit persisted dropdown selection");
    await create.getByRole("button", { name: "Save as Draft", exact: true }).click();
    await expect(create).toBeHidden();
    // The saved summary renders before its lazy line-page read starts.
    // Confirm that read completed before exercising reload persistence.
    await expect(page.getByText("Synthetic audit persisted dropdown selection", { exact: true }).filter({ visible: true })).toBeVisible();
    await waitForApplicationRequestsToSettle(page);
    await page.reload();
    await menuAction(page, "7-Eleven billing");
    await page.getByRole("searchbox", { name: "Search billing invoices and work orders" }).fill(number);
    await page.getByText(`#${number}`, { exact: true }).filter({ visible: true }).click();
    await page.getByRole("button", { name: "Edit invoice", exact: true }).click();
    const edit = page.getByRole("dialog", { name: `Edit invoice #${number}`, exact: true });
    await expect(edit.locator('input[name="workOrderId"]')).toHaveValue(selectedId);
    await expect(edit.getByLabel("Line 1 description")).toHaveValue("Synthetic audit persisted dropdown selection");
    await waitForApplicationRequestsToSettle(page);
  });
}

test("My Work to-do persists after reload and completion removes it from the personal queue", async ({ page }) => {
  await login(page, accounts.manager);
  await openSidebarPage(page, "My Work");
  const add = page.getByRole("button", { name: "Add to my to-do", exact: true }).first();
  await expect(add).toBeEnabled();
  const id = (await add.locator("xpath=ancestor::article").locator("button.mono").innerText()).trim();
  const card = page.locator("article").filter({ has: page.getByRole("button", { name: id, exact: true }) });
  await add.click();
  await expect(card.getByRole("button", { name: "Complete to-do", exact: true })).toBeVisible();
  await waitForApplicationRequestsToSettle(page);
  await page.reload();
  await openSidebarPage(page, "My Work");
  await page.getByRole("tab", { name: /^My to-do/ }).click();
  const saved = page.locator("article").filter({ has: page.getByRole("button", { name: id, exact: true }) });
  await expect(saved).toBeVisible();
  await saved.getByRole("button", { name: "Complete to-do", exact: true }).click();
  await expect(saved).toHaveCount(0);
});

test("an immediate reload after sign-out cannot restore the previous staff session", async ({ page }) => {
  await login(page, accounts.manager);
  await openSidebarPage(page, "7-Eleven billing");
  await menuAction(page, "Sign out");
  await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeVisible();
  await page.reload();
  await page.waitForLoadState("networkidle");
  await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeVisible();
  await expect(page.locator(".desktop-sidebar").getByText(accounts.manager.name, { exact: true })).toHaveCount(0);
});

test("completed sign-out permits a different role without retaining staff navigation", async ({ page }) => {
  await login(page, accounts.manager);
  await openSidebarPage(page, "7-Eleven billing");
  await signOutCompletely(page);
  await login(page, accounts.reportTech);
  await expect(page.locator(".desktop-sidebar").getByText(accounts.reportTech.name, { exact: true })).toBeVisible();
  await expect(page.locator(".desktop-sidebar").getByRole("button", { name: "7-Eleven billing", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "+ Create Invoice", exact: true })).toHaveCount(0);
});

test("reload during a held server sign-out cannot restore persisted credentials", async ({ page }) => {
  await login(page, accounts.manager);
  let release;
  let intercepted = false;
  const held = new Promise(resolve => { release = resolve; });
  await page.route("**/auth/v1/logout**", async route => {
    intercepted = true;
    await held;
    await route.continue().catch(() => undefined); // Reload cancels this old request.
  });
  try {
    await menuAction(page, "Sign out");
    await expect.poll(() => intercepted).toBe(true);
    await expect(page.getByRole("button", { name: "Signing out...", exact: true })).toBeDisabled();
    expect(await page.evaluate(() => [localStorage, sessionStorage].every(storage =>
      Object.keys(storage).every(key => !/^sb-.+-auth-token(?:\.\d+)?$/.test(key)),
    ))).toBe(true);
    await page.reload();
    await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeVisible();
    await expect(page.locator(".desktop-sidebar")).toHaveCount(0);
  } finally { release(); }
});

test("a denied server logout leaves the browser signed out and permits fresh login", async ({ page }) => {
  await login(page, accounts.manager);
  await page.route("**/auth/v1/logout**", route => route.fulfill({ status: 400,
    contentType: "application/json", body: JSON.stringify({ message: "Synthetic logout denial" }) }));
  await menuAction(page, "Sign out");
  await expect(page.getByText("Signed out on this device. Server sign-out could not be confirmed.", { exact: true })).toBeVisible();
  await page.unroute("**/auth/v1/logout**");
  await login(page, accounts.reportTech);
  await expect(page.locator(".desktop-sidebar").getByText(accounts.reportTech.name, { exact: true })).toBeVisible();
});

test("fresh sign-in in another tab restores only the newly authenticated role", async ({ page, context }) => {
  await login(page, accounts.manager);
  await signOutCompletely(page);
  const other = await context.newPage();
  try {
    await login(other, accounts.reportTech);
    await expect(page.locator(".desktop-sidebar").getByText(accounts.reportTech.name, { exact: true })).toBeVisible();
    await expect(page.locator(".desktop-sidebar").getByRole("button", { name: "7-Eleven billing", exact: true })).toHaveCount(0);
  } finally { await other.close(); }
});

test("password change survives sign-out and fresh authentication", async ({ page }) => {
  await login(page, accounts.companyAdminTwo);
  const nextPassword = "Synthetic-Audit-Only-Changed-2026";
  let dialog = await passwordForm(page);
  await dialog.getByLabel(/^New password/).fill(nextPassword);
  await dialog.getByLabel(/^Confirm new password/).fill(nextPassword);
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.locator(".app-toast")).toContainText("Password updated");
  await dialog.getByRole("button", { name: "Close dialog", exact: true }).click();
  await signOutCompletely(page);
  await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeVisible();
  await page.getByPlaceholder("you@p1pros.com").fill(accounts.companyAdminTwo.email);
  await page.locator('input[type="password"]').fill(nextPassword);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.locator(".desktop-sidebar").getByText(accounts.companyAdminTwo.name, { exact: true })).toBeVisible();
  dialog = await passwordForm(page);
  await dialog.getByLabel(/^New password/).fill(syntheticPassword);
  await dialog.getByLabel(/^Confirm new password/).fill(syntheticPassword);
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.locator(".app-toast")).toContainText("Password updated");
});
