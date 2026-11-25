import { createCanvas } from "@napi-rs/canvas";
import {
  accounts,
  expect,
  login,
  openWorkOrder,
  test,
  waitForApplicationRequestsToSettle,
} from "./fixtures.mjs";

test.use({
  viewport: { width: 320, height: 568 },
  screen: { width: 320, height: 568 },
  deviceScaleFactor: 2,
  hasTouch: true,
  isMobile: true,
});

const workOrderId = "E2E-MOBILE-FIELD";

function mobilePhoto() {
  const canvas = createCanvas(320, 568);
  const context = canvas.getContext("2d");
  context.fillStyle = "#0f766e";
  context.fillRect(0, 0, 320, 568);
  context.fillStyle = "#fff";
  context.font = "32px sans-serif";
  context.fillText("320x568 field photo", 18, 284);
  return { name: "mobile-320-field-photo.png", mimeType: "image/png", buffer: canvas.toBuffer("image/png") };
}

async function scrollContent(page, deltaY, webkit) {
  if (webkit) {
    // Playwright does not expose wheel or swipe input for mobile WebKit. Move
    // only the bounded portal scroller; the assertions still prove that the
    // document itself stays fixed and every control enters the viewport.
    await page.locator(".content-pad").evaluate((element, delta) => element.scrollBy(0, delta), deltaY);
  } else {
    await page.mouse.move(160, 284);
    await page.mouse.wheel(0, deltaY);
  }
  // Firefox's wheel scrolling can continue after the input call resolves.
  // Observe the real scroller settling before deciding whether to reverse or
  // stop; otherwise inertia can move a just-reached control behind the header.
  const content=page.locator(".content-pad");
  const deadline=Date.now()+2000;let previous=null,quietSince=null;
  while(Date.now()<deadline){
    const position=await content.evaluate(element=>element.scrollTop);
    if(position===previous){quietSince??=Date.now();if(Date.now()-quietSince>=150)return;}
    else{previous=position;quietSince=null;}
    await page.waitForTimeout(30);
  }
  throw new Error("The portal scroller did not settle after the real scrolling input.");
}

async function reachByNormalScroll(page, locator, direction = 1, webkit = false) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const box = await locator.boundingBox();
    const content = await page.locator('.content-pad').boundingBox();
    if (!content) throw new Error('Missing visible portal scroller.');
    const top = Math.max(0, content.y), bottom = Math.min(568, content.y + content.height);
    // Window coordinates alone include the fixed header and bottom navigation.
    // A control behind either is still clipped by the real content scroller.
    if (box && box.y >= top && box.y + Math.min(box.height, 44) <= bottom) return;
    const delta = box ? box.y < top
      ? -Math.min(420, top - box.y + 60)
      : Math.min(420, box.y + box.height - bottom + 60) : direction * 420;
    await scrollContent(page, delta, webkit);
  }
  throw new Error(`Control was not reachable by normal ${direction > 0 ? "down" : "up"} scrolling.`);
}

async function assertNarrowLayout(page) {
  const measurements = await page.evaluate(() => {
    const content = document.querySelector(".content-pad");
    if (!(content instanceof HTMLElement)) throw new Error("Missing portal content scroller.");
    return {
      viewportWidth: window.innerWidth,
      documentWidth: document.documentElement.scrollWidth,
      contentClientWidth: content.clientWidth,
      contentScrollWidth: content.scrollWidth,
      contentClientHeight: content.clientHeight,
      contentScrollHeight: content.scrollHeight,
      touchAction: getComputedStyle(content).touchAction,
      overflowingElements: Array.from(content.querySelectorAll("*"))
        .filter(element => {
          if (!(element instanceof HTMLElement) || element.offsetParent === null) return false;
          const rect = element.getBoundingClientRect();
          // Firefox reports clientWidth=0 on normal inline text while giving
          // it a nonzero scrollWidth. Its bounding rect still detects actual
          // viewport overflow; scroll-box overflow applies to measurable boxes.
          return rect.left < -1 || rect.right > window.innerWidth + 1
            || (element.clientWidth > 0 && element.scrollWidth > element.clientWidth + 1);
        })
        .slice(0, 12)
        .map(element => ({
          tag: element.tagName.toLowerCase(),
          className: element.className,
          clientWidth: element.clientWidth,
          scrollWidth: element.scrollWidth,
          rect: element.getBoundingClientRect().toJSON(),
        })),
    };
  });
  expect(measurements.viewportWidth).toBe(320);
  expect(measurements.documentWidth).toBeLessThanOrEqual(320);
  // Desktop WebKit reserves the six-pixel test scrollbar inside clientWidth;
  // real mobile Safari overlays it. Neither the document nor a descendant may
  // extend beyond the 320px layout viewport.
  expect(measurements.contentScrollWidth).toBeLessThanOrEqual(320);
  expect(measurements.overflowingElements).toEqual([]);
  expect(measurements.contentScrollHeight).toBeGreaterThan(measurements.contentClientHeight);
  expect(measurements.touchAction).toMatch(/pan-y/);
}

test("320x568 field controls remain reachable and operable without zoom", async ({ page, browserName }) => {
  test.setTimeout(120_000);
  const webkit = browserName === "webkit";
  await login(page, accounts.reportTech);
  await openWorkOrder(page, workOrderId);
  await assertNarrowLayout(page);

  const content = page.locator(".content-pad");
  await expect(content).toBeVisible();
  await expect.poll(() => content.evaluate(element => element.scrollTop)).toBe(0);
  await scrollContent(page, 520, webkit);
  await expect.poll(() => content.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);

  const choosePhotos = page.getByText("Choose photos", { exact: true });
  await reachByNormalScroll(page, choosePhotos, 1, webkit);
  await expect(choosePhotos).toBeInViewport();
  const fileChooserPromise = page.waitForEvent("filechooser");
  await choosePhotos.click();
  const fileChooser = await fileChooserPromise;
  await fileChooser.setFiles(mobilePhoto());
  await expect(page.getByText("Photos (1)", { exact: true })).toBeVisible({ timeout: 30_000 });

  const start = page.getByRole("button", { name: "Start work", exact: true });
  await reachByNormalScroll(page, start, -1, webkit);
  await expect(start).toBeInViewport();
  await start.click();
  let dialog = page.getByRole("dialog", { name: "Start work" });
  await expect(dialog).toBeInViewport();
  await dialog.getByPlaceholder("What are you seeing on site?").fill("320x568 mobile field visit started.");
  await dialog.getByRole("button", { name: "Start work", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText("7-Eleven FSM: Work in Progress", { exact: true })).toBeVisible();

  const pause = page.getByRole("button", { name: "Pause (parts)", exact: true });
  await reachByNormalScroll(page, pause, -1, webkit);
  await expect(pause).toBeInViewport();
  await pause.click();
  dialog = page.getByRole("dialog", { name: "Pause work" });
  await expect(dialog).toBeInViewport();
  await dialog.getByRole("combobox", { name: "Reason" }).click();
  await page.getByRole("option", { name: "Temporary fix - equipment partially working", exact: true }).click();
  await dialog.getByPlaceholder("Explain what was done so far...").fill("320x568 mobile checkout.");
  await dialog.getByRole("button", { name: "Pause work", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText("7-Eleven FSM: Awaiting Parts", { exact: true })).toBeVisible();

  await waitForApplicationRequestsToSettle(page);
  await assertNarrowLayout(page);
});
