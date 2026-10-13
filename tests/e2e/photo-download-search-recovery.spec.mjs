import { readFileSync } from "node:fs";
import { accounts, expect, login, openSidebarPage, openWorkOrder, test } from "./fixtures.mjs";
import { linkedBillingSql as sql } from "../../scripts/e2e/linked-billing-test-support.mjs";
import { localSupabaseRuntime } from "../../scripts/e2e/local-supabase-runtime.mjs";
import { createClient } from "@supabase/supabase-js";

// Real local authenticated metadata/RLS reads. Photo bytes are synthetic and
// stubbed only at the exact localhost Storage GET boundary for this stress suite.
// The separate interactive walkthrough covers actual 42-file private uploads.
const fixtures = [["WOT9900042", 42], ["WOT9900101", 101]];
const png = readFileSync("public/p1-icon-192.png");
async function cleanup() {
  sql(`do $scope$begin
    if exists(select 1 from public.work_orders where id in ('WOT9900042','WOT9900101')
      and summary is distinct from 'Synthetic bulk photo/search regression') then
      raise exception 'Refusing to remove a fixture identity owned by another task';
    end if;end;$scope$;`);
  const runtime = localSupabaseRuntime();
  const client = createClient(runtime.NEXT_PUBLIC_SUPABASE_URL, runtime.SUPABASE_SECRET_KEY,
    { auth: { persistSession: false, autoRefreshToken: false } });
  const paths = fixtures.flatMap(([id, count]) => Array.from({ length: count }, (_, index) => `wo/${id}/synthetic-${index + 1}.png`));
  const { error } = await client.storage.from("photos").remove(paths);
  if (error) throw new Error("Local synthetic photo fixture cleanup failed");
  sql(`begin;
    delete from public.private_object_bindings
    where work_order_id in ('WOT9900042','WOT9900101') and review_reference='SYNTHETIC-BULK-PHOTO-READ';
    delete from public.work_orders where id in ('WOT9900042','WOT9900101') and summary='Synthetic bulk photo/search regression';
    commit;`);
}
test.beforeAll(async () => {
  await cleanup();
  sql(`begin;
    ${fixtures.map(([id, count]) => `
      insert into public.work_orders(id,status,functional_status,contractor_id,store_number,summary,contractor_assignment_started_at)
      values('${id}','wip','Work in Progress',(select id from public.profiles where email='e2e.direct@p1.invalid'),
        'E2E001','Synthetic bulk photo/search regression',clock_timestamp()-interval '1 hour');
      insert into public.photos(work_order_id,storage_path,created_at)
      select '${id}','wo/${id}/synthetic-'||n||'.png',clock_timestamp()-make_interval(secs=>n)
      from generate_series(1,${count})n;
      insert into storage.objects(bucket_id,name,owner,metadata)
      select 'photos',p.storage_path,(select id from public.profiles where email='e2e.direct@p1.invalid'),'{}'::jsonb
      from public.photos p where p.work_order_id='${id}';
      insert into public.private_object_bindings(bucket,object_path,storage_object_id,purpose,work_order_id,
        photo_id,actor_id,assignment_version,workflow_cycle,validation,review_reference,state)
      select 'photos',p.storage_path,o.id,'photo',p.work_order_id,p.id,
        (select id from public.profiles where email='e2e.direct@p1.invalid'),0,0,
        'legacy_reviewed','SYNTHETIC-BULK-PHOTO-READ','finalized'
      from public.photos p join storage.objects o on o.bucket_id='photos' and o.name=p.storage_path
      where p.work_order_id='${id}';`).join("\n")}
    commit;`);
});
test.afterAll(cleanup);

async function stubPhotos(page, missing = false) {
  await page.route("**/storage/v1/object/**/photos/wo/WOT990*/**", route => route.fulfill(missing
    ? { status: 404, contentType: "application/json", body: JSON.stringify({ statusCode: "404", message: "Synthetic object unavailable" }) }
    : { status: 200, contentType: "image/png", body: png }));
}
async function zipCount(download) {
  const chunks = [];
  const stream = await download.createReadStream();
  for await (const chunk of stream) chunks.push(chunk);
  const zip = Buffer.concat(chunks);
  expect(zip.readUInt32LE(zip.length - 22)).toBe(0x06054b50);
  return zip.readUInt16LE(zip.length - 12);
}

for (const [id, count] of fixtures) {
  test(`download all includes ${count} photos with only 24 thumbnails initially loaded`, async ({ page }) => {
    await login(page, accounts.manager);
    await openSidebarPage(page, "Work orders");
    await stubPhotos(page);
    await openWorkOrder(page, id);
    await expect(page.getByText(`Photos (${count})`, { exact: true })).toBeVisible();
    await page.getByRole("button", { name: /View photos/ }).click();
    await expect(page.getByRole("button", { name: "View photo 24", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "View photo 25", exact: true })).toHaveCount(0);
    const pending = page.waitForEvent("download");
    await page.getByRole("button", { name: "Download all", exact: true }).click();
    const download = await pending;
    expect(await zipCount(download)).toBe(count);
    await expect(page.getByRole("button", { name: "Download all", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: /Load more photos/ }).click();
    await expect(page.getByRole("button", { name: "View photo 25", exact: true })).toBeVisible();
  });
}

test("selected download spans thumbnail pages and does not expose delete controls", async ({ page }) => {
  await login(page, accounts.manager);
  await openSidebarPage(page, "Work orders"); await stubPhotos(page); await openWorkOrder(page, "WOT9900042");
  await page.getByRole("button", { name: /View photos/ }).click();
  await page.getByRole("button", { name: "View photo 1", exact: true }).waitFor();
  await page.getByRole("button", { name: "Select", exact: true }).click();
  await page.getByRole("button", { name: "Select photo 1", exact: true }).click();
  await page.getByRole("button", { name: /Load more photos/ }).click();
  await page.getByRole("button", { name: "Select photo 42", exact: true }).click();
  await expect(page.getByRole("button", { name: "Select photo 1", exact: true })).toHaveAttribute("aria-pressed", "true");
  const pending = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download selected (2)", exact: true }).click();
  expect(await zipCount(await pending)).toBe(2);
});

test("unavailable photos show actionable recovery and release the download button", async ({ page }) => {
  await login(page, accounts.manager);
  await openSidebarPage(page, "Work orders"); await stubPhotos(page, true); await openWorkOrder(page, "WOT9900042");
  await page.getByRole("button", { name: "Download all", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "None of the selected photos could be downloaded" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Download all", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Back to previous view", exact: true }).click();
  await page.getByPlaceholder("Search WO#, INC#, store, keyword...").fill("WOT9000001");
  await openWorkOrder(page, "WOT9000001");
});

for (const [account, navigation] of [
  [accounts.manager, "Work orders"],
  [accounts.direct, "My jobs"],
]) {
  test(`${account.name} can repeatedly search, open, cancel a dialog and search another WOT`, async ({ page }) => {
    await login(page, account); await openSidebarPage(page, navigation);
    const search = page.locator('input[placeholder^="Search WO#"], input[aria-label="Search my jobs"]').first();
    for (const id of ["WOT9000001", "WOT9900042", "WOT9000001"]) {
      await search.fill(id); await openWorkOrder(page, id);
      if (account === accounts.manager) {
        await page.getByRole("button", { name: "Edit work order", exact: true }).click();
        await page.getByRole("dialog", { name: "Edit work order" }).getByRole("button", { name: "Cancel", exact: true }).click();
      }
      await page.getByRole("button", { name: "Back to previous view", exact: true }).click();
      await expect(search).toBeEditable();
      await expect(page.locator(".main-wrap")).not.toHaveAttribute("inert");
    }
    await search.fill("WOT9999999");
    await expect(page.getByText(/No accessible work order found for WOT9999999/).filter({ visible: true })).toBeVisible();
    await search.fill(""); await expect(search).toBeEditable();
  });
}

test("a delayed exact WOT request can be replaced without blocking the next search", async ({ page }) => {
  await login(page, accounts.manager); await openSidebarPage(page, "Work orders");
  let release; const held = new Promise(resolve => { release = resolve; });
  let intercepted = false; let cancelled = false;
  page.on("requestfailed", request => {
    const url = new URL(request.url());
    if (url.pathname === "/rest/v1/work_orders" && url.searchParams.get("or")?.includes("WOT9000001")) cancelled = true;
  });
  await page.route("**/rest/v1/work_orders?**", async route => {
    if (!new URL(route.request().url()).searchParams.get("or")?.includes("WOT9000001")) return route.fallback();
    intercepted = true; await held; await route.abort("aborted").catch(() => undefined);
  });
  try {
    const search = page.getByPlaceholder("Search WO#, INC#, store, keyword...");
    await search.fill("WOT9000001"); await expect.poll(() => intercepted).toBe(true);
    await expect(search).toBeEditable(); await search.fill("WOT9900042");
    await openWorkOrder(page, "WOT9900042"); await expect.poll(() => cancelled).toBe(true);
  } finally { release(); }
});

test("an offline metadata request shows a connection message and a normal retry downloads all photos", async ({ page }) => {
  await login(page, accounts.manager); await openSidebarPage(page, "Work orders");
  await stubPhotos(page); await openWorkOrder(page, "WOT9900042");
  await expect(page.getByText("Photos (42)", { exact: true })).toBeVisible();
  const pattern = "**/rest/v1/rpc/list_work_order_photos_rows_v1";
  const offline = route => route.abort("internetdisconnected");
  await page.route(pattern, offline);
  try {
    await page.getByRole("button", { name: "Download all", exact: true }).click();
    await expect(page.getByRole("alert").filter({ hasText: "The connection is unavailable" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Download all", exact: true })).toBeEnabled();
  } finally { await page.unroute(pattern, offline); }
  const pending = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download all", exact: true }).click();
  expect(await zipCount(await pending)).toBe(42);
});
