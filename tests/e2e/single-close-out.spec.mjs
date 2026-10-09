import { randomUUID } from "node:crypto";
import { accounts, expect, login, openSidebarPage, openWorkOrder, test, waitForApplicationRequestsToSettle } from "./fixtures.mjs";
import { linkedBillingSql as sql } from "../../scripts/e2e/linked-billing-test-support.mjs";

function fixture({ status = "pending_invoice", functional = "Completed", cycle = 0 } = {}) {
  const id = `E2E-SINGLE-CLOSE-${randomUUID().slice(0, 8)}`;
  sql(`insert into public.work_orders(id,status,functional_status,workflow_cycle,store_number,store_state,summary)
    values('${id}','${status}','${functional}',${cycle},'E2E001','TX','Synthetic guided close-out');`);
  return id;
}
test.beforeEach(async ({ page }) => {
  await page.context().route("**/*", async route => {
    if (!["localhost", "127.0.0.1", "[::1]"].includes(new URL(route.request().url()).hostname)) {
      await route.abort("blockedbyclient"); throw new Error("Non-local browser request refused");
    }
    await route.continue();
  });
});
async function openSimplified(page, id) {
  if (page.viewportSize().width <= 720) {
    await page.getByRole("button", { name: "Open menu", exact: true }).click();
    await page.getByRole("dialog", { name: "Navigation menu", exact: true }).getByRole("button", { name: "Simplified", exact: true }).click();
  } else await openSidebarPage(page, "Simplified");
  await page.getByPlaceholder("Search WO, store, city, keyword…").fill(id);
  await page.getByRole("button", { name: `Open ${id}`, exact: true }).click();
  await page.getByRole("button", { name: "Close out", exact: true }).click();
  return page.getByRole("dialog", { name: "Close out work order", exact: true });
}

test("guided no-billing closure confirms the outcome and does not create billing records", async ({ page }) => {
  const id = fixture(); await login(page, accounts.manager);
  const choices = await openSimplified(page, id);
  await choices.getByRole("button", { name: "No billing is required", exact: true }).click();
  const form = page.getByRole("dialog", { name: "Close without billing", exact: true });
  await form.getByRole("button", { name: "Confirm no billing and close", exact: true }).click();
  await expect(form.getByRole("alert")).toContainText("Confirm finished work");
  expect(sql(`select status::text from public.work_orders where id='${id}'`)).toBe("pending_invoice");
  await form.getByRole("checkbox").check();
  await form.getByRole("button", { name: "Confirm no billing and close", exact: true }).click();
  await expect(form).toBeHidden();
  expect(sql(`select status::text from public.work_orders where id='${id}'`)).toBe("closed");
  expect(Number(sql(`select count(*) from public.invoices where work_order_id='${id}'`))).toBe(0);
  await expect(page.getByRole("button", { name: "Close out", exact: true })).toHaveCount(0);
  await waitForApplicationRequestsToSettle(page);
});

test("pending updates and unfinished work are explained, not force-closed", async ({ page }) => {
  const pending = fixture(); const unfinished = fixture({ status: "parts", functional: "Awaiting Parts" });
  sql(`insert into public.activities(work_order_id,author_id,author_name,text,type,event_key,activity_channel)
    select '${pending}',id,name,'Synthetic pending field update','note','note','field_note'
    from public.profiles where email='e2e.manager@p1.invalid';`);
  await login(page, accounts.manager);
  let choices = await openSimplified(page, pending);
  await expect(choices.getByRole("button", { name: "Billed outside the portal", exact: true })).toBeDisabled();
  await expect(choices).toContainText("Resolve pending 7-Eleven updates");
  await choices.getByRole("button", { name: "Cancel", exact: true }).click();
  choices = await openSimplified(page, unfinished);
  await expect(choices.getByRole("button", { name: "Billed outside the portal", exact: true })).toHaveCount(0);
  await expect(choices).toContainText("Finish field work");
  expect(sql(`select status::text from public.work_orders where id='${unfinished}'`)).toBe("parts");
  await choices.getByRole("button", { name: "Cancel", exact: true }).click();
  await waitForApplicationRequestsToSettle(page);
});

test("guided external billing generates the note and reconciles a lost successful response", async ({ page }) => {
  const id = fixture(); await login(page, accounts.backoffice);
  const choices = await openSimplified(page, id);
  await choices.getByRole("button", { name: "Billed outside the portal", exact: true }).click();
  const form = page.getByRole("dialog", { name: "Billed outside the portal", exact: true });
  await form.getByLabel("Invoice reference (required)").fill("SYNTHETIC-EXTERNAL-10000");
  await form.getByLabel("Billing date (required)").fill("2026-01-01");
  await expect(form.getByLabel("Additional details (optional)")).toHaveValue("");
  await form.getByRole("button", { name: "Record external billing and close", exact: true }).click();
  await expect(form.getByRole("alert")).toContainText("Confirm that field work");
  const calls = [];
  await page.route("**/rest/v1/rpc/record_work_order_external_billing_v1", async route => {
    calls.push(route.request().postDataJSON());
    const response = await route.fetch(); expect(response.ok()).toBe(true);
    if (calls.length === 1) await route.fulfill({ status: 200, contentType: "application/json", body: "null" });
    else await route.fulfill({ response });
  });
  await form.getByRole("checkbox").check();
  await form.getByRole("button", { name: "Record external billing and close", exact: true }).click();
  await expect(form.getByRole("alert")).toContainText("could not be confirmed");
  await expect(form.getByLabel("Invoice reference (required)")).toBeDisabled();
  await form.getByRole("button", { name: "Retry same request", exact: true }).click();
  await expect(form.getByRole("status")).toContainText("work order is closed");
  expect(calls).toHaveLength(2); expect(calls[1]).toEqual(calls[0]);
  expect(sql(`select note from public.work_order_external_billings where work_order_id='${id}'`)).toContain("Staff confirmed this work was billed externally");
  expect(Number(sql(`select count(*) from public.invoices where work_order_id='${id}'`))).toBe(0);
  await form.getByRole("button", { name: "Done", exact: true }).click();
  await waitForApplicationRequestsToSettle(page);
});

test("contractors cannot see the new entry point", async ({ page }) => {
  await login(page, accounts.direct); await openWorkOrder(page, "E2E-DIRECT-INVOICE");
  await expect(page.getByRole("region", { name: "Work order close out", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Close out", exact: true })).toHaveCount(0);
  await waitForApplicationRequestsToSettle(page);
});

test("a changed WO cannot be closed through a captured no-billing form", async ({ page }) => {
  const id = fixture(); await login(page, accounts.manager);
  const choices = await openSimplified(page, id);
  await choices.getByRole("button", { name: "No billing is required", exact: true }).click();
  const form = page.getByRole("dialog", { name: "Close without billing", exact: true });
  await form.getByRole("checkbox").check();
  sql(`update public.work_orders set status='parts',functional_status='Awaiting Parts' where id='${id}';`);
  await form.getByRole("button", { name: "Confirm no billing and close", exact: true }).click();
  await expect(form.getByRole("alert")).toContainText("Closure was not confirmed");
  expect(sql(`select status::text from public.work_orders where id='${id}'`)).toBe("parts");
  expect(Number(sql(`select count(*) from public.activities where work_order_id='${id}' and event_key='work_order_closed_without_invoice'`))).toBe(0);
  await waitForApplicationRequestsToSettle(page);
});

test("capital completion explains an open visit and cannot bypass a missing approved quote", async ({ page }) => {
  const active = fixture({ status: "pending_capital_completion", functional: "Pending Capital Completion" });
  const missing = fixture({ status: "pending_capital_completion", functional: "Pending Capital Completion" });
  sql(`update public.work_orders set is_capital=true where id in ('${active}','${missing}');
    update public.work_orders set contractor_id=(select id from public.profiles where email='e2e.direct@p1.invalid') where id='${active}';
    insert into public.work_order_visits(work_order_id,contractor_id,checked_in_by,check_in_at)
      select '${active}',id,id,now()-interval '1 hour' from public.profiles where email='e2e.direct@p1.invalid';`);
  await login(page, accounts.manager);
  let choices = await openSimplified(page, active);
  await expect(choices.getByRole("button", { name: "Installation is complete", exact: true })).toBeDisabled();
  await expect(choices).toContainText("actual checkout");
  await choices.getByRole("button", { name: "Cancel", exact: true }).click();
  choices = await openSimplified(page, missing);
  await choices.getByRole("button", { name: "Installation is complete", exact: true }).click();
  const form = page.getByRole("dialog", { name: "Confirm capital installation", exact: true });
  await form.getByRole("checkbox").check();
  await form.getByRole("button", { name: "Confirm capital installation", exact: true }).click();
  await expect(form.getByRole("alert")).toContainText("approved capital quote is required");
  expect(sql(`select status::text from public.work_orders where id='${missing}'`)).toBe("pending_capital_completion");
  expect(Number(sql(`select count(*) from public.work_order_visits where work_order_id='${active}' and check_out_at is null`))).toBe(1);
  await waitForApplicationRequestsToSettle(page);
});

test("Simplified resolves a legacy follow-up with confirmation and an automatic audit reason", async ({ page }) => {
  const id = fixture(); const invoice = randomUUID();
  sql(`insert into public.invoices(id,work_order_id,num,invoice_type,state,invoice_date,total,created_at)
    values('${invoice}','${id}','SYNTHETIC-PRIOR-${id}','staff','approved',current_date-2,100,now()-interval '2 days');
    insert into public.activities(work_order_id,author_name,text,type,event_key,event_data,created_at,is_staff_only)
    values('${id}','Synthetic Staff','Synthetic previous billing','system','staff_billing',
      jsonb_build_object('action','billed_to_7_eleven','invoiceId','${invoice}'),now()-interval '2 days',true),
      ('${id}','Synthetic Staff','Synthetic legacy reopen','system','work_order_reopened','{}',now()-interval '1 day',true);
    update public.work_orders set status='wip',functional_status='Work in Progress' where id='${id}';`);
  const original = sql(`select to_jsonb(i)::text from public.invoices i where id='${invoice}'`);
  await login(page, accounts.manager);
  const choices = await openSimplified(page, id);
  await choices.getByRole("button", { name: "Follow-up resolved, prior billing covers it", exact: true }).click();
  const form = page.getByRole("dialog", { name: "Close reopened follow-up", exact: true });
  await expect(form.getByLabel("Additional details (optional)")).toHaveValue("");
  await form.getByRole("checkbox").check();
  await form.getByRole("button", { name: "Close follow-up — no additional billing", exact: true }).click();
  await expect(form).toBeHidden();
  expect(sql(`select status::text from public.work_orders where id='${id}'`)).toBe("closed");
  expect(sql(`select to_jsonb(i)::text from public.invoices i where id='${invoice}'`)).toBe(original);
  expect(sql(`select event_data->>'reason' from public.activities where work_order_id='${id}' and event_key='work_order_follow_up_closed_without_additional_billing'`)).toContain("Staff confirmed the follow-up is resolved");
  await waitForApplicationRequestsToSettle(page);
});

test("paged history can be loaded inside Close out before choosing an unbilled outcome", async ({ page }) => {
  const id = fixture();
  sql(`insert into public.activities(work_order_id,author_name,text,type,event_key,is_staff_only,created_at)
    select '${id}','Synthetic Staff','Synthetic historical event '||n,'system','system',true,
      now()-interval '2 days'+n*interval '1 minute' from generate_series(1,35) n;`);
  await login(page, accounts.manager);
  const choices = await openSimplified(page, id);
  await expect(choices.getByRole("button", { name: "Billed outside the portal", exact: true })).toBeDisabled();
  await choices.getByRole("button", { name: "Load more close-out history", exact: true }).click();
  await expect(choices.getByRole("button", { name: "No billing is required", exact: true })).toBeEnabled();
  await expect(choices.getByRole("button", { name: "Billed outside the portal", exact: true })).toBeEnabled();
  expect(sql(`select status::text from public.work_orders where id='${id}'`)).toBe("pending_invoice");
  await choices.getByRole("button", { name: "Cancel", exact: true }).click();
  await waitForApplicationRequestsToSettle(page);
});

test("one Close out entry and guided form fit a 320px screen", async ({ page }, testInfo) => {
  const id = fixture(); await page.setViewportSize({ width: 320, height: 720 });
  await login(page, accounts.manager);
  const choices = await openSimplified(page, id);
  let bounds = await choices.locator(".modal-inner").evaluate(el => ({ width: el.clientWidth, content: el.scrollWidth, right: el.getBoundingClientRect().right }));
  expect(bounds.content).toBeLessThanOrEqual(bounds.width + 1); expect(bounds.right).toBeLessThanOrEqual(321);
  await choices.getByRole("button", { name: "Billed outside the portal", exact: true }).click();
  const form = page.getByRole("dialog", { name: "Billed outside the portal", exact: true });
  await expect(form.getByLabel("Additional details (optional)")).toBeVisible();
  bounds = await form.locator(".modal-inner").evaluate(el => ({ width: el.clientWidth, content: el.scrollWidth, right: el.getBoundingClientRect().right }));
  expect(bounds.content).toBeLessThanOrEqual(bounds.width + 1); expect(bounds.right).toBeLessThanOrEqual(321);
  await page.screenshot({ path: testInfo.outputPath("single-close-out-320.png") });
  await form.getByRole("button", { name: "Cancel", exact: true }).click();
  await waitForApplicationRequestsToSettle(page);
});
