import {accounts, expect, login, openSidebarPage, test} from './fixtures.mjs';
import {reportedInvoiceFixture, reportedInvoiceSnapshot} from '../../scripts/e2e/reported-invoice-fixtures.mjs';
import {linkedBillingFixture, linkedBillingSql as sql, linkedBillingCounts} from '../../scripts/e2e/linked-billing-test-support.mjs';

test.beforeEach(async({context})=>{
  await context.route('**/*',async route=>{
    const url=new URL(route.request().url());
    if(['127.0.0.1','localhost','[::1]'].includes(url.hostname))await route.continue();
    else await route.abort('blockedbyclient');
  });
});
test.afterEach(async({page})=>{await page.unrouteAll({behavior:'wait'});});

async function navigate(page,label) {
  if(await page.getByRole('button',{name:'Open menu',exact:true}).isVisible()) {
    await page.getByRole('button',{name:'Open menu',exact:true}).click();
    await page.getByRole('dialog',{name:'Navigation menu',exact:true}).getByRole('button',{name:label,exact:true}).click();
  } else await openSidebarPage(page,label);
}
async function chooser(page,work) {
  await navigate(page,'Simplified');
  await page.getByPlaceholder('Search WO, store, city, keyword…').fill(work);
  await page.getByRole('button',{name:`Open ${work}`,exact:true}).click();
  await page.getByRole('button',{name:'Close out',exact:true}).click();
}
function history(f,{submission=false,manyInvoices=false,unresolved=false}={}) {
  sql(`insert into public.activities(work_order_id,author_name,text,type,event_key,is_staff_only,created_at)
    select '${f.work}','Synthetic staff','Synthetic paged history '||n,'system','system',true,
      now()-interval '2 days'+n*interval '1 second' from generate_series(1,251) n;
    ${submission?`insert into public.activities(work_order_id,author_name,text,type,event_key,event_data,is_staff_only,
      workflow_cycle,contractor_assignment_version,created_at)
      values('${f.work}','Synthetic staff','Synthetic earlier quote submission','system','capital_quote_submitted',
        jsonb_build_object('invoiceId','${f.staffInvoice}'),true,0,1,now()-interval '3 days');`:''}
    ${manyInvoices?`insert into public.invoices(work_order_id,num,invoice_type,contractor_id,state,invoice_date,total,created_at)
      select '${f.work}','SYNTHETIC-EXTRA-${f.work}-'||n,'contractor',i.contractor_id,
        case when ${unresolved} and n=104 then 'draft'::public.invoice_state else 'paid'::public.invoice_state end,
        current_date,1,case when n=104 then '2026-08-12'::timestamptz else now()-interval '1 day' end
        from public.invoices i cross join generate_series(1,104) n where i.id='${f.contractorInvoice}';`:''}`);
}
async function fit(dialog,width) {
  const bounds=await dialog.locator('.modal-inner').evaluate(el=>({width:el.clientWidth,content:el.scrollWidth,right:el.getBoundingClientRect().right}));
  expect(bounds.content).toBeLessThanOrEqual(bounds.width+1);expect(bounds.right).toBeLessThanOrEqual(width+1);
}

for(const width of [1440,320]) {
  test(`capital automatically checks all history and invoice pages, then closes once at ${width}px`,async({page},info)=>{
    const f=reportedInvoiceFixture('capital_different_company');history(f,{submission:true,manyInvoices:true});
    const before=reportedInvoiceSnapshot(f),reads=[],writes=[];
    page.on('request',request=>{
      if(request.url().includes('/rpc/close_out_capital_v1'))writes.push(request.postDataJSON());
      if(request.url().includes('/rpc/list_work_order_activities_rows_v1')||request.url().includes('/rpc/list_contractor_invoices_rows_v2')) {
        const body=request.postDataJSON();if(body?.p_work_order_id===f.work&&body.p_limit===100)reads.push({path:new URL(request.url()).pathname,cursor:body.p_cursor});
      }
    });
    await page.setViewportSize({width,height:900});await login(page,accounts.backoffice);await chooser(page,f.work);
    const dialog=page.getByRole('dialog',{name:'Close out capital',exact:true});
    await expect(dialog.getByRole('button',{name:'Close and send to History',exact:true})).toBeEnabled();
    await expect(dialog.getByText(/Checking invoice, activity and visit history/)).toHaveCount(0);
    await expect(dialog.getByRole('button',{name:'Load more close-out history',exact:true})).toHaveCount(0);
    await expect(dialog.getByRole('checkbox',{name:/Mark this quote submitted now/})).toHaveCount(0);
    expect(reads.filter(read=>read.path.endsWith('list_work_order_activities_rows_v1')&&read.cursor)).toHaveLength(2);
    expect(reads.some(read=>read.path.endsWith('list_contractor_invoices_rows_v2')&&read.cursor)).toBe(true);
    expect(writes).toHaveLength(0);expect(reportedInvoiceSnapshot(f)).toEqual(before);
    await dialog.getByLabel('Existing billed invoice reference (required)',{exact:true}).fill(`SYNTHETIC-BILLED-${f.work}`);
    await dialog.getByLabel('Actual billing date (required)',{exact:true}).fill('2026-10-27');
    await fit(dialog,width);await dialog.screenshot({path:info.outputPath('capital-ready.png')});
    await dialog.getByRole('button',{name:'Close and send to History',exact:true}).click();await expect(dialog).toBeHidden();
    const after=reportedInvoiceSnapshot(f);expect(after.status).toBe('closed');expect(after.invoices).toEqual(before.invoices);
    expect(writes).toHaveLength(1);expect(after.capitalCloseOutEvents).toBe(1);
    await page.reload();await expect(page.locator('.app-root')).toBeVisible();
    expect(reportedInvoiceSnapshot(f).status).toBe('closed');
  });

  test(`capital failed history retries safely and unbilled completion stays in billing at ${width}px`,async({page})=>{
    const f=reportedInvoiceFixture('capital_different_company');history(f);const before=reportedInvoiceSnapshot(f);
    let fail=true;
    await page.setViewportSize({width,height:900});await login(page,accounts.manager);
    await page.route('**/rest/v1/rpc/list_work_order_activities_rows_v1',async route=>{
      const body=route.request().postDataJSON();
      if(fail&&body.p_work_order_id===f.work&&body.p_limit===100)await route.fulfill({status:200,contentType:'application/json',body:'{"syntheticUnreadableHistory":true}'});
      else await route.fallback();
    });
    await chooser(page,f.work);
    const dialog=page.getByRole('dialog',{name:'Close out capital',exact:true});
    await expect(dialog.getByRole('alert')).toContainText('The complete history could not be checked');
    await expect(dialog.getByRole('button',{name:'Close and send to History',exact:true})).toBeDisabled();
    expect(reportedInvoiceSnapshot(f)).toEqual(before);
    fail=false;await dialog.getByRole('button',{name:'Retry history check',exact:true}).click();
    await expect(dialog.getByRole('button',{name:'Close and send to History',exact:true})).toBeEnabled();
    await dialog.getByRole('radio',{name:/Completed, send to billing/}).check();
    await dialog.getByRole('checkbox',{name:/Mark this quote submitted now/}).check();
    await dialog.getByRole('button',{name:'Confirm send to billing',exact:true}).click();await expect(dialog).toBeHidden();
    const after=reportedInvoiceSnapshot(f);expect(after.status).toBe('pending_invoice');expect(after.closedAt).toBeNull();
    expect(after.invoices).toHaveLength(before.invoices.length);expect(after.externalBillings).toBe(0);
  });

  test(`an unresolved contractor invoice on a later page still blocks capital closure at ${width}px`,async({page})=>{
    const f=reportedInvoiceFixture('capital_different_company');history(f,{submission:true,manyInvoices:true,unresolved:true});
    const before=reportedInvoiceSnapshot(f);
    await page.setViewportSize({width,height:900});await login(page,accounts.manager);await chooser(page,f.work);
    const dialog=page.getByRole('dialog',{name:'Close out capital',exact:true});
    await expect(dialog.getByText('Resolve outstanding contractor invoice reviews first.',{exact:true})).toBeVisible();
    await expect(dialog.getByRole('button',{name:'Close and send to History',exact:true})).toBeDisabled();
    expect(reportedInvoiceSnapshot(f)).toEqual(before);
  });

  test(`linked billing explains the disabled box and recovers an NA filter without auto-selection at ${width}px`,async({page},info)=>{
    const f=linkedBillingFixture();await page.setViewportSize({width,height:900});await login(page,accounts.backoffice);await chooser(page,f.source);
    await page.getByRole('dialog',{name:'Close out work order',exact:true}).getByRole('button',{name:'Billed under another work order',exact:true}).click();
    const dialog=page.getByRole('dialog',{name:'Billed under another work order',exact:true});
    await expect(dialog.getByRole('checkbox')).toBeDisabled();await expect(dialog).toContainText('First find and select an invoice above');
    await dialog.getByLabel('Billing work order number (required)').fill(f.target);
    await dialog.getByLabel('Exact invoice number (optional)').fill('NA');
    await dialog.getByRole('button',{name:'Find submitted invoices',exact:true}).click();
    await expect(dialog.getByText(/No eligible submitted P1 invoices found/)).toBeVisible();
    await dialog.getByRole('button',{name:'Search all invoices on this WO',exact:true}).click();
    await expect(dialog.getByLabel('Exact invoice number (optional)')).toHaveValue('');
    await expect(dialog.getByRole('radio',{name:new RegExp(f.number)})).toBeVisible();
    await expect(dialog.getByRole('checkbox')).toBeDisabled();expect(linkedBillingCounts(f.source).links).toBe(0);
    await dialog.getByRole('radio',{name:new RegExp(f.number)}).check();await expect(dialog.getByRole('checkbox')).toBeEnabled();
    await expect(dialog).toContainText(`Selected invoice: #${f.number}`);
    await dialog.getByRole('button',{name:'Link invoice and close',exact:true}).click();
    await expect(dialog.getByRole('alert')).toContainText('Confirm that the selected invoice covers');
    await expect(dialog.getByRole('checkbox')).toBeFocused();expect(linkedBillingCounts(f.source).links).toBe(0);
    await fit(dialog,width);await dialog.screenshot({path:info.outputPath('linked-selection.png')});
    await dialog.getByRole('checkbox').check();await dialog.getByRole('button',{name:'Link invoice and close',exact:true}).click();
    await expect(dialog.getByRole('status')).toContainText('This work order is closed');
    expect(linkedBillingCounts(f.source)).toEqual({status:'closed',functionalStatus:'Completed',links:1,invoices:0,events:2});
    await page.reload();await expect(page.locator('.app-root')).toBeVisible();expect(linkedBillingCounts(f.source).links).toBe(1);
  });
}
