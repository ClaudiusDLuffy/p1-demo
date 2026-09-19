import { test as base, expect } from "@playwright/test";
import { syntheticPassword } from "../../scripts/e2e/local-supabase-runtime.mjs";

export const accounts = {
  manager: { email: "e2e.manager@p1.invalid", name: "Synthetic Manager" },
  dispatcher: { email: "e2e.dispatcher@p1.invalid", name: "Synthetic Dispatcher" },
  backoffice: { email: "e2e.backoffice@p1.invalid", name: "Synthetic Back Office" },
  controller: { email: "e2e.controller@p1.invalid", name: "Synthetic Controller" },
  accounting: { email: "e2e.accounting@p1.invalid", name: "Synthetic Accounting" },
  direct: { email: "e2e.direct@p1.invalid", name: "Synthetic Direct Contractor" },
  companyAdmin: { email: "e2e.company.admin@p1.invalid", name: "Synthetic Company Admin" },
  companyAdminTwo: { email: "e2e.company.admin2@p1.invalid", name: "Synthetic Company Admin Two" },
  invoiceTech: { email: "e2e.invoice.tech@p1.invalid", name: "Synthetic Invoice Technician" },
  revocationTech: { email: "e2e.revocation.tech@p1.invalid", name: "Synthetic Revocation Technician" },
  reportTech: { email: "e2e.report.tech@p1.invalid", name: "Synthetic Report Technician" },
  teamLead: { email: "e2e.team.lead@p1.invalid", name: "Synthetic Team Lead" },
  teamMember: { email: "e2e.team.member@p1.invalid", name: "Synthetic Team Member" },
};

export const test = base.extend({
  diagnostics: [async ({ page }, use, testInfo) => {
    const events = [];
    page.on("pageerror", error => events.push({ kind: "pageerror", message: error.message }));
    page.on("console", message => {
      if (["error", "warning"].includes(message.type())) events.push({ kind: `console:${message.type()}`, message: message.text() });
    });
    page.on("requestfailed", request => events.push({
      kind: "requestfailed",
      method: request.method(),
      url: request.url().replace(/\?.*$/, ""),
      message: request.failure()?.errorText || "request failed",
    }));
    page.on("response", response => {
      if (response.status() >= 500) events.push({ kind: "http", status: response.status(), url: response.url().replace(/\?.*$/, "") });
    });
    await use(events);
    await testInfo.attach("browser-diagnostics.json", {
      body: Buffer.from(JSON.stringify(events, null, 2)),
      contentType: "application/json",
    });
    const fatal = events.filter(event => event.kind === "pageerror" || event.kind === "http");
    expect.soft(fatal, "Browser page errors and HTTP 5xx responses").toEqual([]);
  }, { auto: true }],
});

export { expect };

export async function login(page, account) {
  // The disposable local GoTrue/PostgREST pair can briefly disagree at the JWT
  // issue second. Retry only that local PGRST303 response so the test observes
  // application behavior instead of a container-clock race. Hosted
  // environments are never involved in this harness.
  const localJwtClockRetry = async route => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      let status;
      let headers;
      let body;
      try {
        const response = await route.fetch();
        // Materialize the local response before fulfilling the intercepted
        // request. Long serial browser batches can otherwise outlive
        // Playwright's response handle even though the bytes already arrived.
        status = response.status();
        headers = response.headers();
        body = await response.body();
      } catch (error) {
        // A query invalidation can cancel a stale read while the local retry
        // handler is materializing it. Do not replay that request: writes may
        // be non-repeatable, and the browser has already abandoned this one.
        if (!/response has been disposed|fetch response has been disposed/i.test(String(error))) throw error;
        await route.abort("aborted").catch(() => undefined);
        return;
      }
      if (status !== 401) {
        await route.fulfill({ status, headers, body });
        return;
      }

      const text = body.toString("utf8");
      const isLocalClockRace = text.includes("PGRST303") && text.includes("JWT issued at future");
      if (!isLocalClockRace || attempt === 4) {
        await route.fulfill({ status, headers, body });
        return;
      }

      await new Promise(resolve => setTimeout(resolve, 1_000));
    }
  };
  await page.route("**/rest/v1/**", localJwtClockRetry);
  await page.goto("/");
  await page.getByPlaceholder("you@p1pros.com").fill(account.email);
  await page.locator('input[type="password"]').fill(process.env.P1_E2E_PASSWORD || syntheticPassword);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  if ((page.viewportSize()?.width || 0) <= 720) {
    await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeHidden();
    await expect(page.locator(".app-root")).toBeVisible();
  } else {
    await expect(page.locator(".desktop-sidebar").getByText(account.name, { exact: true })).toBeVisible();
  }
}

export function sidebar(page) {
  return page.locator(".desktop-sidebar");
}

export async function openSidebarPage(page, label) {
  await sidebar(page).locator("button").filter({ hasText: label }).first().click();
}

export async function openWorkOrder(page, id) {
  let target = page.getByText(id, { exact: true }).first();
  if (!await target.isVisible().catch(() => false)) {
    const search = page.locator('input[placeholder^="Search WO#"], input[aria-label="Search my jobs"]').first();
    if (await search.isVisible().catch(() => false)) {
      await search.fill(id);
      target = page.getByText(id, { exact: true }).first();
    }
  }
  if (!await target.isVisible().catch(() => false)) {
    const hideClosed = page.getByRole("checkbox", { name: "Hide closed calls" });
    if (await hideClosed.isVisible().catch(() => false) && await hideClosed.isChecked()) {
      await hideClosed.uncheck();
      target = page.getByText(id, { exact: true }).first();
    }
  }
  await expect(target).toBeVisible();
  const listItem = page.locator("tr:visible, .card-hover:visible, .mobile-card:visible")
    .filter({ has: page.getByText(id, { exact: true }) }).first();
  await expect(listItem, `${id} list row or card should be visible`).toBeVisible();
  await listItem.click();
  await expect(page.locator(".work-order-reference").filter({ hasText: id }).first(),
    `${id} detail view should be visible`).toBeVisible();
}
