import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { accounts, expect, login, openSidebarPage, openWorkOrder, test, waitForApplicationRequestsToSettle } from "./fixtures.mjs";
import { linkedBillingSql as sql } from "../../scripts/e2e/linked-billing-test-support.mjs";

function fixture({quote=true,cost=60,sell=100}={}) {
  const suffix=randomUUID().slice(0,8); const id=`E2E-SELF-UI-${suffix}`; const invoice=randomUUID();
  const number=`SYNTHETIC-QUOTE-${suffix}`;
  sql(`insert into public.work_orders(id,status,functional_status,is_capital,store_number,store_state,city,address,
    store_timezone,business_service,line_of_service,summary,contractor_id,contractor_assignment_version,contractor_assignment_started_at)
    select '${id}','capital','Work in Progress',true,'E2E001','TX','Synthetic City','100 Synthetic Test Way',
      'America/Chicago','Fountain','Fountain','Synthetic self-service UI',id,1,now()-interval '3 days'
      from public.profiles where email='e2e.direct@p1.invalid';
    ${quote?`insert into public.invoices(id,num,work_order_id,invoice_type,state,invoice_date,service_date,due_date,
      store_number,store_address,terms,territory,equipment_tag,tax_state,subtotal,sales_tax,total)
      values('${invoice}','${number}','${id}','staff','submitted',current_date,current_date,current_date+60,
      'E2E001','100 Synthetic Test Way','Net 60','Texas','7-ELEVEN: Fountain','TX',${sell},0,${sell});
      insert into public.invoice_lines(invoice_id,position,type,description,qty,rate,is_taxable,source_unit_cost)
      values('${invoice}',1,'Labor','Synthetic quote labor',1,${sell},false,${cost});`:""}`);
  return {id,invoice,number,cost,sell};
}
test.beforeEach(async({page})=>{
  await page.context().route("**/*",async route=>{
    if(!["localhost","127.0.0.1","[::1]"].includes(new URL(route.request().url()).hostname)) {
      await route.abort("blockedbyclient"); throw new Error("Non-local browser request refused");
    } await route.continue();
  });
});
async function openDetail(page,id,simplified=false) {
  await openSidebarPage(page,simplified?"Simplified":"Work orders");
  if(simplified) {
    await page.getByPlaceholder("Search WO, store, city, keyword…").fill(id);
    await page.getByRole("button",{name:`Open ${id}`,exact:true}).click();
  } else await openWorkOrder(page,id);
}
async function closeEditor(page,dialog) {
  await dialog.getByRole("button",{name:"Close",exact:true}).click();
  const guard=page.getByRole("dialog",{name:"Unsaved changes",exact:true});
  if(await guard.isVisible()) await guard.getByRole("button",{name:"Discard changes",exact:true}).click();
  await expect(dialog).toBeHidden();
}
async function scratch(page,cost,sell) {
  const calculator=page.getByRole("complementary",{name:"Profit calculator",exact:true});
  const toggle=calculator.getByRole("button",{name:"Profit calculator",exact:true});
  if(await toggle.isVisible()) await toggle.click();
  await expect(calculator.getByLabel("Cost",{exact:true})).toHaveValue(cost.toFixed(2));
  await expect(calculator.getByLabel("Sell price",{exact:true})).toHaveValue(sell.toFixed(2));
  return calculator;
}
async function openQuote(page) {
  const button=page.getByRole("button",{name:"Open capital quote",exact:true,includeHidden:true});
  await expect(button).toBeAttached();
  if(!await button.isVisible()) await page.getByText("Dispatch and billing actions",{exact:true}).click();
  await button.click();
}

test("Tag saves the real value; calculator follows each quote; sent quote revision preserves original",async({page},testInfo)=>{
  const a=fixture(); const b=fixture({cost:200,sell:300});
  await login(page,accounts.backoffice);
  for(const f of [a,b]) {
    await openDetail(page,f.id,true);
    await openQuote(page);
    await page.getByRole("button",{name:"Edit capital quote",exact:true}).click();
    const editor=page.getByRole("dialog",{name:`Edit capital quote #${f.number}`,exact:true});
    await expect(editor.getByRole("button",{name:"Tag",exact:true})).toContainText("7-ELEVEN: Fountain");
    const calculator=await scratch(page,f.cost,f.sell);
    await calculator.getByLabel("Cost",{exact:true}).fill("9999");
    if(f===a) {
      await editor.getByRole("button",{name:"Tag",exact:true}).click();
      await page.getByRole("option",{name:"7-ELEVEN: HVAC",exact:true}).click();
      await editor.getByRole("button",{name:"Update Quote",exact:true}).click();
      await expect(editor).toBeHidden();
      expect(sql(`select equipment_tag from public.invoices where id='${a.invoice}';`)).toBe("7-ELEVEN: HVAC");
    } else await closeEditor(page,editor);
  }
  await openDetail(page,a.id);
  await openQuote(page);
  await page.getByRole("button",{name:"Submit Quote to 7-Eleven",exact:true}).click();
  const submit=page.getByRole("dialog",{name:"Confirm capital quote",exact:true});
  await submit.getByRole("button",{name:"Submit Quote to 7-Eleven",exact:true}).click();
  await expect(submit).toBeHidden();
  await expect(page.getByRole("button",{name:"Create quote revision",exact:true})).toBeVisible();
  const original=sql(`select to_jsonb(i)::text from public.invoices i where id='${a.invoice}';`);
  await page.getByRole("button",{name:"Create quote revision",exact:true}).click();
  const revision=page.getByRole("dialog",{name:"Create capital quote revision",exact:true});
  await revision.getByLabel("Audit note (required)").fill("Synthetic revision updates labor scope without duplicate billing.");
  await revision.getByRole("checkbox").check();
  await revision.getByRole("button",{name:"Create capital quote revision",exact:true}).click();
  await expect(revision.getByRole("status")).toContainText("separate draft revision");
  const row=JSON.parse(sql(`select jsonb_build_object('id',id,'num',num) from public.invoices where revision_of_capital_quote_id='${a.invoice}';`));
  expect(sql(`select to_jsonb(i)::text from public.invoices i where id='${a.invoice}';`)).toBe(original);
  await revision.getByRole("button",{name:"Edit draft revision",exact:true}).click();
  const edit=page.getByRole("dialog",{name:`Edit capital quote #${row.num}`,exact:true});
  await expect(edit).toBeVisible();
  await scratch(page,a.cost,a.sell);
  await edit.getByLabel("Line 1 description").fill("Synthetic revised labor scope");
  await edit.getByRole("button",{name:"Update Quote",exact:true}).click();
  await expect(edit).toBeHidden();
  await page.getByRole("button",{name:"Submit Quote to 7-Eleven",exact:true}).click();
  await page.getByRole("dialog",{name:"Confirm capital quote",exact:true}).getByRole("button",{name:"Submit Quote to 7-Eleven",exact:true}).click();
  expect(sql(`select to_jsonb(i)::text from public.invoices i where id='${a.invoice}';`)).toBe(original);
  await page.screenshot({path:testInfo.outputPath("TAG-AND-QUOTE-REVISION.png")});
  await waitForApplicationRequestsToSettle(page);
});

test("external quote and completed capital are self-service without duplicate quote or force-close",async({page},testInfo)=>{
  const f=fixture({quote:false});
  await login(page,accounts.manager); await openDetail(page,f.id,true);
  await expect(page.getByRole("button",{name:"Capital Completed",exact:true})).toHaveCount(0);
  const external=page.getByRole("button",{name:"Record external capital quote",exact:true});
  if(!await external.isVisible()) await page.getByText("Capital actions",{exact:true}).click();
  await external.click();
  const handoff=page.getByRole("dialog",{name:"Record external capital quote",exact:true});
  await handoff.getByLabel("Approved external quote reference (required)").fill("SYNTHETIC-EXTERNAL-REF");
  await handoff.getByLabel("Audit note (required)").fill("Synthetic externally approved quote; installation is complete.");
  await handoff.getByRole("checkbox").check();
  await handoff.getByRole("button",{name:"Record external capital quote",exact:true}).click();
  await expect(handoff.getByRole("status")).toContainText("No invoice was created");
  await handoff.getByRole("button",{name:"Done",exact:true}).click();
  expect(Number(sql(`select count(*) from public.invoices where work_order_id='${f.id}';`))).toBe(0);
  await page.getByRole("button",{name:"Capital Completed",exact:true}).click();
  const completion=page.getByRole("dialog",{name:"Confirm capital installation",exact:true});
  await completion.getByLabel("Audit note (required)").fill("Synthetic installation confirmed and ready for final billing.");
  await completion.getByRole("button",{name:"Confirm capital installation",exact:true}).click();
  await expect(completion.getByRole("alert")).toContainText("Confirm the facts");
  await completion.getByRole("checkbox").check();
  await completion.getByRole("button",{name:"Confirm capital installation",exact:true}).click();
  await expect(completion.getByRole("status")).toContainText("not yet billed or closed");
  expect(sql(`select status::text||':'||functional_status::text||':'||capital_status||':'||(closed_at is null)::text from public.work_orders where id='${f.id}';`))
    .toBe("pending_invoice:Completed:Installed:true");
  await completion.getByRole("button",{name:"Continue to final billing",exact:true}).click();
  const final=page.getByRole("dialog",{name:"Create P1 to 7-Eleven invoice",exact:true});
  await expect(final).toBeVisible();
  await final.getByRole("button",{name:"+ Labor $110",exact:true}).click();
  await final.getByLabel("Line 1 description").fill("Synthetic final installation labor");
  await final.getByRole("spinbutton",{name:"Manual sales tax amount",exact:true}).fill("0");
  await final.getByRole("button",{name:"Submit Invoice",exact:true}).click();
  await expect(final).toBeHidden();
  const saved=JSON.parse(sql(`select jsonb_build_object('kind',document_kind,'state',state,
    'externalQuote',source_external_capital_quote_id,'internalQuote',source_capital_quote_id,'tag',equipment_tag)
    from public.invoices where work_order_id='${f.id}';`));
  expect(saved.kind).toBe("invoice"); expect(saved.state).toBe("submitted");
  expect(saved.externalQuote).toBeTruthy(); expect(saved.internalQuote).toBeNull();
  expect(saved.tag).toBe("7-ELEVEN: Fountain");
  const downloadPromise=page.waitForEvent("download");
  await page.getByRole("button",{name:"Download SaasAnt CSV",exact:true}).click();
  const download=await downloadPromise;
  const csv=readFileSync(await download.path(),"utf8");
  expect(csv.split("\r\n")[0]).toContain("Equipment Tag");
  expect(csv).toContain("7-ELEVEN: Fountain");
  await openSidebarPage(page,"Capital");
  await expect(page.getByText(f.id,{exact:true})).toHaveCount(0);
  await page.getByRole("combobox",{name:"Capital status",exact:true}).selectOption("capital_installed");
  await expect(page.getByText(f.id,{exact:true})).toBeVisible();
  await page.screenshot({path:testInfo.outputPath("CAPITAL-INSTALLED-FINAL-BILLING.png")});
  await waitForApplicationRequestsToSettle(page);
});

function followUpFixture(cycle) {
  const suffix=randomUUID().slice(0,8); const id=`E2E-SELF-UI-FOLLOW-${suffix}`; const target=`E2E-SELF-UI-COVER-${suffix}`;
  const old=randomUUID(); const invoice=randomUUID(); const number=`SYNTHETIC-COVER-${suffix}`;
  sql(`insert into public.work_orders(id,status,functional_status,workflow_cycle,lifecycle_version,store_number,summary,
      contractor_id,contractor_assignment_version,contractor_assignment_started_at)
    values('${id}','pending_invoice','Completed',0,${cycle?6:7},'E2E001','Synthetic reopened UI',
      (select id from public.profiles where email='e2e.direct@p1.invalid'),1,now()-interval '3 days'),
      ('${target}','pending_invoice','Completed',0,0,'E2E001','Synthetic covering destination',null,0,null);
    insert into public.invoices(id,num,work_order_id,invoice_type,state,invoice_date,total,created_at)
      values('${old}','SYNTHETIC-OLD-${suffix}','${id}','staff','approved',current_date-2,111,now()-interval '2 days'),
        ('${invoice}','${number}','${target}','staff','submitted',current_date,222,now());
    insert into public.activities(work_order_id,author_name,text,type,event_key,event_data,created_at,is_staff_only)
      values('${id}','Synthetic Staff','Synthetic earlier billing','system','staff_billing',
        jsonb_build_object('action','billed_to_7_eleven','invoiceId','${old}'),now()-interval '2 days',true);
    ${cycle?`update public.work_orders set workflow_cycle=1 where id='${id}';`:""}
    insert into public.activities(work_order_id,author_name,text,type,event_key,event_data,created_at,is_staff_only)
      values('${id}','Synthetic Staff','Synthetic follow-up reopen','system','work_order_reopened',
        '${cycle?' {"mode":"billing_follow_up"}':'{}'}'::jsonb,now()-interval '1 day',true);
    ${cycle?`insert into public.invoices(work_order_id,num,contractor_id,created_by,invoice_type,state,invoice_date,total)
      select '${id}','SYNTHETIC-NEW-${suffix}',id,id,'contractor','paid',current_date,222
        from public.profiles where email='e2e.direct@p1.invalid';`:""}`);
  return {id,target,old,invoice,number};
}
test("reopened billing links only the follow-up and leaves the original invoice unchanged",async({page},testInfo)=>{
  const f=followUpFixture(1); const before=sql(`select to_jsonb(i)::text from public.invoices i where id='${f.old}';`);
  await login(page,accounts.backoffice); await openDetail(page,f.id,true);
  await expect(page.getByRole("button",{name:"Close follow-up — no additional billing",exact:true})).toHaveCount(0);
  await page.getByRole("button",{name:"Billed under another work order",exact:true}).click();
  const dialog=page.getByRole("dialog",{name:"Billed under another work order",exact:true});
  await dialog.getByLabel("Billing work order number (required)").fill(f.target);
  await dialog.getByRole("button",{name:"Find submitted invoices",exact:true}).click();
  await dialog.getByRole("radio",{name:new RegExp(f.number)}).check();
  await dialog.getByLabel("Audit note (required)").fill("Synthetic covering invoice includes only the reopened work.");
  await dialog.getByRole("checkbox").check();
  await dialog.getByRole("button",{name:"Link invoice and close",exact:true}).click();
  await expect(dialog.getByRole("status")).toContainText("This work order is closed");
  expect(sql(`select to_jsonb(i)::text from public.invoices i where id='${f.old}';`)).toBe(before);
  expect(Number(sql(`select count(*) from public.work_order_billing_links where work_order_id='${f.id}';`))).toBe(1);
  await dialog.getByRole("button",{name:"Done",exact:true}).click();
  await openSidebarPage(page,"7-Eleven billing");
  await expect(page.getByRole("searchbox",{name:"Search billing invoices and work orders"})).toBeVisible();
  await page.screenshot({path:testInfo.outputPath("FOLLOW-UP-COVERAGE-PRESERVED-ORIGINAL.png")});
  await waitForApplicationRequestsToSettle(page);
});
test("legacy cycle-zero follow-up requires confirmation and closes without another invoice",async({page},testInfo)=>{
  const f=followUpFixture(0); const before=sql(`select to_jsonb(i)::text from public.invoices i where id='${f.old}';`);
  await login(page,accounts.manager); await openDetail(page,f.id);
  await page.getByRole("button",{name:"Close follow-up — no additional billing",exact:true}).click();
  const dialog=page.getByRole("dialog",{name:"Close reopened follow-up",exact:true});
  await dialog.getByRole("textbox").fill("Synthetic freezer follow-up resolved and covered by prior billing.");
  await dialog.getByRole("button",{name:"Close follow-up — no additional billing",exact:true}).click();
  await expect(dialog.getByText("Confirm that the follow-up is resolved and no additional billing is needed.",{exact:true})).toBeVisible();
  await dialog.getByRole("checkbox").check();
  await dialog.getByRole("button",{name:"Close follow-up — no additional billing",exact:true}).click();
  await expect(dialog).toBeHidden();
  expect(sql(`select status::text from public.work_orders where id='${f.id}';`)).toBe("closed");
  expect(sql(`select to_jsonb(i)::text from public.invoices i where id='${f.old}';`)).toBe(before);
  expect(Number(sql(`select count(*) from public.invoices where work_order_id='${f.id}';`))).toBe(1);
  await page.screenshot({path:testInfo.outputPath("LEGACY-REOPEN-RESOLVED-NO-REBILLING.png")});
  await waitForApplicationRequestsToSettle(page);
});
