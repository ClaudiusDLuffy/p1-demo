import { accounts, test, expect, login, openSidebarPage, openWorkOrder } from "./fixtures.mjs";

const currency = value => new Intl.NumberFormat("en-US", {
  style: "currency", currency: "USD", minimumFractionDigits: 0, maximumFractionDigits: 2,
}).format(Number(value));

test("part type and contractor price changes immediately update P1 rates and quote total", async ({ page }) => {
  await login(page, accounts.manager);
  await openSidebarPage(page, "Work orders");
  await openWorkOrder(page, "WOTEST7");
  await page.getByRole("button", { name: "Open quote calculator" }).click();

  const dialog = page.getByRole("dialog", { name: "Quote calculator" });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator(".quote-footer-total strong")).toHaveText(currency("110"));

  await dialog.getByRole("button", { name: "Add lines", exact: true }).click();
  await dialog.getByRole("button", { name: "Add", exact: true }).click();
  await dialog.getByLabel("Quote line 2 type").click();
  await dialog.getByRole("option", { name: "Parts/Hardware", exact: true }).click();
  await dialog.getByLabel("Quote line 2 description").fill("Synthetic replacement part");
  await dialog.getByLabel("Quote line 2 contractor rate").fill("100");

  await expect(dialog.getByLabel("Quote line 2 P1 rate")).toHaveValue("125");
  await expect(dialog.locator(".quote-footer-total strong")).toHaveText(currency("235"));

  await dialog.getByLabel("Quote line 2 contractor rate").fill("200");
  await expect(dialog.getByLabel("Quote line 2 P1 rate")).toHaveValue("250");
  await expect(dialog.locator(".quote-footer-total strong")).toHaveText(currency("360"));

  await dialog.getByLabel("Quote line 2 P1 rate").fill("300");
  await expect(dialog.locator(".quote-footer-total strong")).toHaveText(currency("410"));
});

test("multiple parts, quantities, global pricing, and category changes keep totals synchronized", async ({ page }) => {
  await login(page, accounts.manager);
  await openSidebarPage(page, "Work orders");
  await openWorkOrder(page, "WOTEST7");
  await page.getByRole("button", { name: "Open quote calculator" }).click();
  const dialog = page.getByRole("dialog", { name: "Quote calculator" });

  const addPart = async (index, description, cost) => {
    await dialog.getByRole("button", { name: "Add lines", exact: true }).click();
    await dialog.getByRole("button", { name: "Add", exact: true }).click();
    const type = dialog.getByLabel(`Quote line ${index} type`);
    await type.click();
    await dialog.getByRole("option", { name: "Parts/Hardware", exact: true }).click();
    await dialog.getByLabel(`Quote line ${index} description`).fill(description);
    await dialog.getByLabel(`Quote line ${index} contractor rate`).fill(String(cost));
  };

  await addPart(2, "Synthetic compressor", 200);
  await dialog.getByLabel("Quote line 2 quantity").fill("2");
  await expect(dialog.getByLabel("Quote line 2 P1 rate")).toHaveValue("250");
  await expect(dialog.locator(".quote-footer-total strong")).toHaveText(currency("610"));

  await addPart(3, "Synthetic filter", 60);
  await dialog.getByLabel("Quote line 3 quantity").fill("3");
  await expect(dialog.getByLabel("Quote line 3 P1 rate")).toHaveValue("75");
  await expect(dialog.locator(".quote-footer-total strong")).toHaveText(currency("835"));

  await dialog.getByLabel("Parts markup percent").fill("40");
  await dialog.getByRole("button", { name: "Recalculate", exact: true }).click();
  await expect(dialog.getByLabel("Quote line 2 P1 rate")).toHaveValue("280");
  await expect(dialog.getByLabel("Quote line 3 P1 rate")).toHaveValue("84");
  await expect(dialog.locator(".quote-footer-total strong")).toHaveText(currency("922"));

  await dialog.getByLabel("Overall margin percent").fill("20");
  await dialog.getByRole("button", { name: "Recalculate", exact: true }).click();
  await expect(dialog.getByLabel("Quote line 1 P1 rate")).toHaveValue("137.5");
  await expect(dialog.getByLabel("Quote line 2 P1 rate")).toHaveValue("350");
  await expect(dialog.getByLabel("Quote line 3 P1 rate")).toHaveValue("105");
  await expect(dialog.locator(".quote-footer-total strong")).toHaveText(currency("1152.5"));

  await dialog.getByLabel("Quote line 2 contractor rate").fill("250");
  await expect(dialog.getByLabel("Quote line 2 P1 rate")).toHaveValue("437.5");
  await expect(dialog.locator(".quote-footer-total strong")).toHaveText(currency("1327.5"));

  const otherType = dialog.getByLabel("Quote line 3 type");
  await otherType.click();
  await dialog.getByRole("option", { name: "Other", exact: true }).click();
  await expect(dialog.getByLabel("Quote line 3 P1 rate")).toHaveValue("75");
  await expect(dialog.locator(".quote-footer-total strong")).toHaveText(currency("1237.5"));

  await dialog.getByLabel("Quote line 2 P1 rate").fill("400");
  await dialog.getByLabel("Quote line 2 quantity").fill("2.5");
  await expect(dialog.locator(".quote-footer-total strong")).toHaveText(currency("1362.5"));

  await addPart(4, "Synthetic part added with changed pricing", 80);
  await expect(dialog.getByLabel("Quote line 4 P1 rate")).toHaveValue("140");
  await expect(dialog.locator(".quote-footer-total strong")).toHaveText(currency("1502.5"));
  await expect(page.getByText("Draft saved", { exact: true })).toBeVisible();

  await dialog.getByRole("button", { name: "Close calculator" }).click();
  const keepDraft = page.getByRole("dialog", { name: "Unsaved changes" });
  await keepDraft.getByRole("button", { name: "Close and keep draft", exact: true }).click();
  await expect(dialog).toBeHidden();

  await page.reload();
  await expect(page.locator(".desktop-sidebar").getByText(accounts.manager.name, { exact: true })).toBeVisible();
  await openSidebarPage(page, "Work orders");
  await openWorkOrder(page, "WOTEST7");
  await page.getByRole("button", { name: "Open quote calculator" }).click();
  const restored = page.getByRole("dialog", { name: "Quote calculator" });
  await expect(restored.getByLabel("Quote line 2 P1 rate")).toHaveValue("400");
  await expect(restored.getByLabel("Quote line 2 quantity")).toHaveValue("2.5");
  await expect(restored.getByLabel("Quote line 4 P1 rate")).toHaveValue("140");
  await expect(restored.locator(".quote-footer-total strong")).toHaveText(currency("1502.5"));
});

test("keyboard-entered decimal part costs recalculate correctly while typing", async ({ page }) => {
  await login(page, accounts.manager);
  await openSidebarPage(page, "Work orders");
  await openWorkOrder(page, "WOTEST7");
  await page.getByRole("button", { name: "Open quote calculator" }).click();
  const dialog = page.getByRole("dialog", { name: "Quote calculator" });

  await dialog.getByRole("button", { name: "Add lines", exact: true }).click();
  await dialog.getByRole("button", { name: "Add", exact: true }).click();
  await dialog.getByLabel("Quote line 2 type").click();
  await dialog.getByRole("option", { name: "Parts/Hardware", exact: true }).click();
  await dialog.getByLabel("Quote line 2 description").fill("Synthetic decimal-priced part");

  const contractorRate = dialog.getByLabel("Quote line 2 contractor rate");
  await contractorRate.click();
  await contractorRate.press("ControlOrMeta+A");
  await contractorRate.pressSequentially("127.45");
  await expect(contractorRate).toHaveValue("127.45");
  await expect(dialog.getByLabel("Quote line 2 P1 rate")).toHaveValue("159.31");
  await expect(dialog.locator(".quote-footer-total strong")).toHaveText(currency("269.31"));

  await contractorRate.click();
  await contractorRate.press("ControlOrMeta+A");
  await contractorRate.pressSequentially("200.99");
  await expect(contractorRate).toHaveValue("200.99");
  await expect(dialog.getByLabel("Quote line 2 P1 rate")).toHaveValue("251.24");
  await expect(dialog.locator(".quote-footer-total strong")).toHaveText(currency("361.24"));

  const p1Rate = dialog.getByLabel("Quote line 2 P1 rate");
  await p1Rate.click();
  await p1Rate.press("ControlOrMeta+A");
  await p1Rate.pressSequentially("110.53");
  await expect(dialog.locator(".quote-footer-total strong")).toHaveText(currency("220.53"));
});

test("parts markup and Other category survive invoice-draft conversion and save", async ({ page }) => {
  await login(page, accounts.manager);
  await openSidebarPage(page, "Work orders");
  await openWorkOrder(page, "WOTEST7");
  await page.getByRole("button", { name: "Open quote calculator" }).click();

  const calculator = page.getByRole("dialog", { name: "Quote calculator" });
  const otherType = calculator.getByLabel("Quote line 1 type");
  await otherType.click();
  await page.getByRole("option", { name: "Other", exact: true }).click();
  await calculator.getByLabel("Quote line 1 description").fill("Synthetic miscellaneous charge");
  await calculator.getByLabel("Quote line 1 contractor rate").fill("858.20");

  await calculator.getByRole("button", { name: "Add lines", exact: true }).click();
  await calculator.getByRole("button", { name: "Add", exact: true }).click();
  await calculator.getByLabel("Quote line 2 type").click();
  await page.getByRole("option", { name: "Parts/Hardware", exact: true }).click();
  await calculator.getByLabel("Quote line 2 description").fill("Synthetic marked-up part");
  await calculator.getByLabel("Quote line 2 contractor rate").fill("55.24");

  // Contractor costs total $913.44; the quote sell total includes 25% markup
  // on the $55.24 Parts line, adding $13.81 for a $927.25 total.
  await expect(calculator.getByLabel("Quote line 2 P1 rate")).toHaveValue("69.05");
  await expect(calculator.locator(".quote-footer-total strong")).toHaveText(currency("927.25"));
  await calculator.getByRole("button", { name: "Convert to invoice", exact: true }).click();

  const detail = page.locator(".invoice-detail-container");
  await expect(detail).toBeVisible();
  await expect(detail).toContainText("Synthetic miscellaneous charge");
  await expect(detail).toContainText("Synthetic marked-up part");
  await expect(detail).toContainText("Other");
  await expect(detail).toContainText("$858.2");
  await expect(detail).toContainText("$69.05");
  await expect(detail).toContainText("$927.25");

  await page.getByRole("button", { name: "Edit invoice", exact: true }).click();
  const editor = page.getByRole("dialog", { name: /Edit invoice #/ });
  await expect(editor).toBeVisible();
  await expect(editor.getByLabel("Line 1 type")).toContainText("Other");
  await expect(editor.getByLabel("Line 2 type")).toContainText("Parts/Hardware");
  await expect(editor.getByLabel("Line 2 rate")).toHaveValue("69.05");
  await editor.getByLabel("Manual sales tax amount").fill("0");
  await editor.getByRole("button", { name: "Save Draft", exact: true }).click();

  await expect(editor).toBeHidden();
  await expect(detail).toContainText("Other");
  await expect(detail).toContainText("$927.25");
});

test("mobile Focus view supports part entry, quantity edits, view switching, and removal", async ({ page }) => {
  await login(page, accounts.manager);
  await openSidebarPage(page, "Work orders");
  await openWorkOrder(page, "WOTEST7");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Open quote calculator" }).click();

  const dialog = page.getByRole("dialog", { name: "Quote calculator" });
  const viewSwitchButtons = dialog.locator(".quote-view-switch button");
  await expect(viewSwitchButtons.nth(1)).toHaveClass(/active/);
  await dialog.locator(".quote-bulk-wrap .quote-toolbar-button").click();
  await dialog.getByRole("button", { name: "Add", exact: true }).click();
  await dialog.getByLabel("Type").click();
  await dialog.getByRole("option", { name: "Parts/Hardware", exact: true }).click();
  await dialog.getByLabel("Description").fill("Synthetic mobile part");
  await dialog.getByLabel("Contractor rate").fill("80");
  await dialog.getByLabel("Quantity").fill("2.5");
  await expect(dialog.getByLabel("P1 rate")).toHaveValue("100");
  await expect(dialog.locator(".quote-footer-total strong")).toHaveText(currency("360"));

  await viewSwitchButtons.nth(0).click();
  await expect(dialog.getByLabel("Quote line 2 quantity")).toHaveValue("2.5");
  await expect(dialog.getByLabel("Quote line 2 P1 rate")).toHaveValue("100");
  await dialog.getByRole("button", { name: "Remove quote line 2", exact: true }).click();
  await expect(dialog.locator(".quote-footer-total strong")).toHaveText(currency("110"));
  await expect(dialog.getByLabel("Quote line 2 quantity")).toHaveCount(0);
});
