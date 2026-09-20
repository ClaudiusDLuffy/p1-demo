import { devices } from "@playwright/test";
import {
  accounts,
  expect,
  login,
  openWorkOrder,
  test,
  waitForApplicationRequestsToSettle,
} from "./fixtures.mjs";

const mobileDevice = { ...devices["iPhone 13"] };
delete mobileDevice.defaultBrowserType;
test.use(mobileDevice);

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "standalone", { configurable: true, value: true });
    const nativeMatchMedia = window.matchMedia.bind(window);
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: query => {
        if (query !== "(display-mode: standalone)") return nativeMatchMedia(query);
        return {
          matches: true,
          media: query,
          onchange: null,
          addListener: () => undefined,
          removeListener: () => undefined,
          addEventListener: () => undefined,
          removeEventListener: () => undefined,
          dispatchEvent: () => true,
        };
      },
    });
  });
});

test("installed iPhone mode loads the manifest and preserves field state across a relaunch", async ({ page }) => {
  const manifestResponse = await page.request.get("/manifest.webmanifest");
  expect(manifestResponse.ok()).toBe(true);
  const manifest = await manifestResponse.json();
  expect(manifest).toMatchObject({
    name: "P1 Service Portal",
    short_name: "P1 Portal",
    start_url: "/",
    display: "standalone",
  });
  expect(manifest.icons).toEqual(expect.arrayContaining([
    expect.objectContaining({ src: "/p1-icon-192.png", sizes: "192x192" }),
    expect.objectContaining({ src: "/p1-icon-512.png", sizes: "512x512" }),
  ]));

  await login(page, accounts.reportTech);
  expect(await page.evaluate(() => navigator.standalone === true)).toBe(true);
  expect(await page.evaluate(() => window.matchMedia("(display-mode: standalone)").matches)).toBe(true);
  await openWorkOrder(page, "E2E-MOBILE-STANDALONE");

  await page.getByRole("button", { name: "Start work", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Start work" });
  await dialog.getByPlaceholder("What are you seeing on site?")
    .fill("Installed-mode field visit started.");
  await dialog.getByRole("button", { name: "Start work", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText("7-Eleven FSM: Work in Progress", { exact: true })).toBeVisible();

  await waitForApplicationRequestsToSettle(page);
  await page.reload();
  await expect(page.locator(".app-root")).toBeVisible();
  await openWorkOrder(page, "E2E-MOBILE-STANDALONE");
  await expect(page.getByText("7-Eleven FSM: Work in Progress", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => navigator.standalone === true)).toBe(true);
});
