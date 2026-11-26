import {jsPDF} from 'jspdf';
import {randomUUID} from 'node:crypto';
import {accounts,expect,login,openSidebarPage,openWorkOrder,test,waitForApplicationRequestsToSettle} from './fixtures.mjs';
import {priorInvoiceFixture,quotePrior as q} from '../../scripts/e2e/prior-contractor-invoice-fixtures.mjs';
import {linkedBillingSql as sql} from '../../scripts/e2e/linked-billing-test-support.mjs';
const parent=f=>JSON.parse(sql(`select to_jsonb(w) from public.work_orders w where id=${q(f.work)}`));
const bill=f=>JSON.parse(sql(`select to_jsonb(i) from public.invoices i where work_order_id=${q(f.work)} and manual_contractor_bill and deleted_at is null order by created_at desc limit 1`));
const count=f=>sql(`select count(*) from public.invoices where work_order_id=${q(f.work)}`);
const history=f=>sql(`select count(*) from public.work_order_assignment_history where work_order_id=${q(f.work)}`);
async function openPanel(page,f){
  if(await page.locator('.desktop-sidebar').isVisible())await openSidebarPage(page,'Work orders');
  else{await page.getByRole('button',{name:'Open menu',exact:true}).click();
    await page.getByRole('dialog',{name:'Navigation menu',exact:true}).getByRole('button',{name:'Work orders',exact:true}).click();}
  if(page.viewportSize().width<=720){
    await page.getByPlaceholder('Search WO#, INC#, store, keyword...').fill(f.work);
    const hide=page.getByRole('checkbox',{name:'Hide closed calls'});if(await hide.isChecked())await hide.uncheck();
    const row=page.locator('.mobile-card:visible, .card-hover:visible, tr:visible').filter({has:page.getByText(f.work,{exact:true})}).first();
    await expect(row).toBeVisible();await row.click();
  }else await openWorkOrder(page,f.work);
  const disclosure=page.getByRole('button',{name:/Invoices, estimates and documents/});
  if(await disclosure.isVisible().catch(()=>false))await disclosure.click();
  const panel=page.getByRole('region',{name:'Previous contractor invoices',exact:true});await expect(panel).toBeVisible();return panel;
}
async function open(page,f,actor=accounts.manager){
  await login(page,actor);const panel=await openPanel(page,f);
  await expect(panel).toContainText('verify a genuine earlier contractor bill without creating assignment history');
  await panel.getByRole('button',{name:'Upload previous contractor invoice',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'Upload previous contractor invoice',exact:true});
  await expect(dialog).toContainText('not a portal reassignment');return dialog;
}
async function choose(dialog){
  const picker=dialog.getByRole('button',{name:'Earlier contractor shown on the original bill',exact:true});
  await picker.click();
  const list=dialog.page().getByRole('listbox',{name:'Earlier contractor shown on the original bill',exact:true});
  await expect(list.getByRole('option').filter({hasText:'Synthetic Direct Services'})).toBeDisabled();
  await list.getByRole('option').filter({hasText:'Synthetic Service Company'}).click();
  await expect(picker).toContainText('Synthetic Service Company');
}
async function fill(dialog,f,{file=true,number=`SYNTHETIC-MANUAL-${randomUUID().slice(0,8)}`}={}){
  await choose(dialog);
  await dialog.getByLabel('Contractor invoice number',{exact:true}).fill(number);
  await dialog.getByLabel('Invoice date',{exact:true}).fill(f.day);
  await dialog.getByLabel('Invoice total',{exact:true}).fill('125.50');
  await dialog.getByLabel('Sales tax included in total',{exact:true}).fill('5.50');
  await dialog.getByLabel('Audit note',{exact:true}).fill('Verified original contractor bill and WO reference for earlier work outside portal history.');
  if(file)await attach(dialog,number);return number;
}
async function attach(dialog,number){
  const pdf=new jsPDF();pdf.text(`Synthetic verified contractor bill ${number}`,15,20);pdf.text('125.50 total / 5.50 included tax',15,35);
  const pending=dialog.page().waitForEvent('filechooser');await dialog.getByLabel('Original invoice PDF',{exact:true}).click();
  await(await pending).setFiles({name:'synthetic-verified.pdf',mimeType:'application/pdf',buffer:Buffer.from(pdf.output('arraybuffer'))});
}
const confirm=dialog=>dialog.getByRole('checkbox',{name:/I verified the original invoice/}).check();
async function finish(dialog,action='Upload and send for review',state='submitted'){
  await confirm(dialog);await dialog.getByRole('button',{name:action,exact:true}).click();
  await expect(dialog.getByRole('status')).toHaveText(`Staff-verified manual contractor invoice ${state==='submitted'?'submitted for P1 review.':'draft saved.'}`);
  await dialog.getByRole('button',{name:'Done',exact:true}).click();
}
async function actions(page,row,num){if(page.viewportSize().width<=720)await row.getByRole('button',{name:`Invoice ${num} actions`,exact:true}).click();}
for(const source of ['manual','email_intake'])test.describe(`verified earlier-work intake: ${source}`,()=>{
const fixture=options=>priorInvoiceFixture({...options,source});
for(const [name,options,actor] of [['regular',{},accounts.manager],['capital',{capital:true},accounts.backoffice],['closed',{closed:true},accounts.dispatcher],['awaiting parts',{awaitingParts:true},accounts.backoffice]]){
  test(`manual ${name}: original PDF > submit > approve > download preserves full parent and no history`,async({page},info)=>{
    const f=fixture({...options,noPreviousAssignment:true}),before=parent(f);
    expect(before.source).toBe(source);expect(before.contractor_assignment_version).toBe(1);
    const dialog=await open(page,f,actor),number=await fill(dialog,f);await finish(dialog);
    expect(bill(f)).toMatchObject({num:number,manual_contractor_bill:true,prior_assignment_id:null,prior_assignment_note:null,
      state:'submitted',total:125.5,sales_tax:5.5,paid_at:null,qbo_synced_at:null});
    expect(parent(f)).toEqual(before);expect(history(f)).toBe('0');
    const row=page.locator('.wo-invoice-row').filter({hasText:`#${number}`});await expect(row).toContainText('Staff-verified manual bill');
    await actions(page,row,number);await row.getByRole('button',{name:'Approve',exact:true}).click();
    await expect.poll(()=>bill(f).state).toBe('approved');expect(parent(f)).toEqual(before);expect(history(f)).toBe('0');
    const download=page.waitForEvent('download');await row.getByRole('button',{name:'Download',exact:true}).filter({visible:true}).click();
    expect((await download).suggestedFilename()).toMatch(/\.pdf$/i);
    await page.screenshot({path:info.outputPath('verified-manual-approved.png')});
    expect(sql(`select count(*) from public.invoices where work_order_id=${q(f.work)} and invoice_type='staff'`)).toBe('0');
  });
}
test('manual draft requires verification, can resume without a PDF and submits the same invoice after attachment',async({page})=>{
  const f=fixture({noPreviousAssignment:true}),before=parent(f),dialog=await open(page,f);
  const number=await fill(dialog,f,{file:false});
  await dialog.getByRole('button',{name:'Save draft',exact:true}).click();await expect(dialog.getByRole('alert')).toContainText('Verify the original');expect(count(f)).toBe('0');
  await finish(dialog,'Save draft','draft');const id=bill(f).id;
  await page.reload();await expect(page.locator('.app-root')).toBeVisible();await openPanel(page,f);
  await page.getByRole('button',{name:`Resume prior invoice ${number}`,exact:true}).click();
  const resumed=page.getByRole('dialog',{name:'Upload previous contractor invoice',exact:true});
  await expect(resumed.getByRole('button',{name:'Earlier contractor shown on the original bill',exact:true})).toBeDisabled();
  await confirm(resumed);await resumed.getByRole('button',{name:'Upload and send for review',exact:true}).click();
  await expect(resumed.getByRole('alert')).toContainText('Attach the original invoice PDF');await attach(resumed,number);await finish(resumed);
  expect(bill(f).id).toBe(id);expect(count(f)).toBe('1');expect(parent(f)).toEqual(before);expect(history(f)).toBe('0');
});
test('manual rejection > retained correction > resubmit > approve preserves identity and current work',async({page})=>{
  const f=fixture({noPreviousAssignment:true}),before=parent(f),dialog=await open(page,f);
  const number=await fill(dialog,f);await finish(dialog);const id=bill(f).id;
  let row=page.locator('.wo-invoice-row').filter({hasText:`#${number}`});await row.getByRole('button',{name:'Reject',exact:true}).click();
  const reject=page.getByRole('dialog',{name:/Reject invoice/});await reject.getByRole('textbox').fill('Synthetic original total needs correction.');
  await reject.getByRole('button',{name:/Reject/,exact:true}).click();await expect.poll(()=>bill(f).state).toBe('rejected');
  await page.getByRole('button',{name:`Resume prior invoice ${number}`,exact:true}).click();
  const resumed=page.getByRole('dialog',{name:'Upload previous contractor invoice',exact:true});
  await resumed.getByLabel('Audit note',{exact:true}).fill('Original invoice re-verified and corrected by staff.');await finish(resumed);
  expect(bill(f).id).toBe(id);expect(bill(f).state).toBe('revised');expect(bill(f).review_revision).toBe(2);
  row=page.locator('.wo-invoice-row').filter({hasText:`#${number}`});await row.getByRole('button',{name:'Approve',exact:true}).click();
  await expect.poll(()=>bill(f).state).toBe('approved');expect(parent(f)).toEqual(before);expect(history(f)).toBe('0');
});
for(const command of ['save_verified_manual_contractor_invoice_v1','submit_prior_contractor_invoice_v1']){
  test(`manual lost ${command} response retries one frozen operation without duplicate invoice`,async({page})=>{
    const f=fixture({noPreviousAssignment:true}),before=parent(f),dialog=await open(page,f);await fill(dialog,f);
    let lost=false;const operations=[];
    await page.route(`**/rest/v1/rpc/${command}`,async route=>{
      operations.push(route.request().postDataJSON().p_operation_id);
      if(!lost){const response=await route.fetch();expect(response.status()).toBe(200);lost=true;await route.abort('failed');}
      else await route.continue();
    });
    await confirm(dialog);await dialog.getByRole('button',{name:'Upload and send for review',exact:true}).click();
    await expect(dialog.getByRole('alert')).toContainText('Retry');
    await dialog.getByRole('button',{name:'Retry same submission',exact:true}).click();
    await expect(dialog.getByRole('status')).toHaveText('Staff-verified manual contractor invoice submitted for P1 review.');
    expect(new Set(operations).size).toBe(1);expect(count(f)).toBe('1');expect(parent(f)).toEqual(before);expect(history(f)).toBe('0');
  });
}
test('manual duplicate rejection permits correction but does not duplicate the original bill',async({page})=>{
  const f=fixture({noPreviousAssignment:true}),before=parent(f);let dialog=await open(page,f);
  const number=await fill(dialog,f,{file:false});await finish(dialog,'Save draft','draft');
  await page.getByRole('region',{name:'Previous contractor invoices',exact:true}).getByRole('button',{name:'Upload previous contractor invoice',exact:true}).click();
  dialog=page.getByRole('dialog',{name:'Upload previous contractor invoice',exact:true});await fill(dialog,f,{number,file:false});await confirm(dialog);
  await dialog.getByRole('button',{name:'Save draft',exact:true}).click();await expect(dialog.getByRole('alert')).toContainText('already exists');
  await expect(dialog.getByLabel('Contractor invoice number',{exact:true})).toBeEnabled();expect(count(f)).toBe('1');
  await dialog.getByLabel('Contractor invoice number',{exact:true}).fill(`SYNTHETIC-OTHER-BILL-${randomUUID().slice(0,8)}`);
  await finish(dialog,'Save draft','draft');expect(count(f)).toBe('2');expect(parent(f)).toEqual(before);expect(history(f)).toBe('0');
});
test('manual selection > Escape > cancel unsaved changes > discard saves no invoice',async({page})=>{
  const f=fixture({noPreviousAssignment:true}),before=parent(f),dialog=await open(page,f);
  const picker=dialog.getByRole('button',{name:'Earlier contractor shown on the original bill',exact:true});await picker.click();
  await expect(page.getByRole('searchbox',{name:'Search Earlier contractor shown on the original bill'})).toBeFocused();
  await page.keyboard.press('Escape');await expect(page.getByRole('listbox',{name:'Earlier contractor shown on the original bill'})).toBeHidden();
  await expect(dialog).toBeVisible();await fill(dialog,f,{file:false});await dialog.getByRole('button',{name:'Cancel',exact:true}).click();
  const unsaved=page.getByRole('dialog',{name:'Unsaved changes',exact:true});await expect(unsaved).toBeVisible();
  await unsaved.getByRole('button',{name:'Keep editing',exact:true}).click();await expect(dialog).toBeVisible();
  await dialog.getByRole('button',{name:'Cancel',exact:true}).click();await unsaved.getByRole('button',{name:'Discard changes',exact:true}).click();
  await expect(dialog).toBeHidden();expect(count(f)).toBe('0');expect(parent(f)).toEqual(before);expect(history(f)).toBe('0');
});
test('manual stale parent is rejected without creating a bill or assignment history',async({page})=>{
  const f=fixture({noPreviousAssignment:true}),dialog=await open(page,f);await fill(dialog,f,{file:false});await confirm(dialog);
  sql(`update public.work_orders set workflow_cycle=workflow_cycle+1 where id=${q(f.work)}`);const before=parent(f);
  await dialog.getByRole('button',{name:'Save draft',exact:true}).click();await expect(dialog.getByRole('alert')).toContainText('changed');
  expect(count(f)).toBe('0');expect(parent(f)).toEqual(before);expect(history(f)).toBe('0');
});
for(const width of [390,320])test.describe(`manual touch-enabled narrow layout ${width}`,()=>{
  test.use({viewport:{width,height:664},hasTouch:true});
  test('verify > native PDF picker > submit > reload retains manual marker and original work',async({page})=>{
    const f=fixture({noPreviousAssignment:true}),before=parent(f),dialog=await open(page,f,accounts.backoffice);
    const number=await fill(dialog,f,{file:false});await confirm(dialog);await dialog.getByRole('button',{name:'Upload and send for review',exact:true}).click();
    await expect(dialog.getByRole('alert')).toContainText('Attach the original invoice PDF');await attach(dialog,number);await finish(dialog);
    await page.reload();await expect(page.locator('.app-root')).toBeVisible();await openPanel(page,f);
    await expect(page.locator('.wo-invoice-row').filter({hasText:`#${number}`})).toContainText('Staff-verified manual bill');
    expect(parent(f)).toEqual(before);expect(history(f)).toBe('0');expect(count(f)).toBe('1');
    const size=await page.evaluate(()=>({width:innerWidth,document:document.documentElement.scrollWidth}));expect(size.document).toBeLessThanOrEqual(width+1);
  });
});

test('manual contractor-bill detail > cancel approval > approve > reload preserves provenance and current work',async({page})=>{
  const f=fixture({noPreviousAssignment:true}),before=parent(f),dialog=await open(page,f);
  const number=await fill(dialog,f);await finish(dialog);
  async function detail(tab){
    await openSidebarPage(page,'Contractor bills');
    await page.getByRole('button',{name:tab,exact:true}).click();
    await page.getByRole('searchbox',{name:'Search contractor invoices'}).fill(number);
    await waitForApplicationRequestsToSettle(page);
    await page.getByText(`#${number}`,{exact:true}).filter({visible:true}).first().click();
    await expect(page.getByRole('button',{name:'Download PDF',exact:true})).toBeVisible();
  }
  await detail('Submitted');
  const download=page.waitForEvent('download');await page.getByRole('button',{name:'Download PDF',exact:true}).click();
  expect((await download).suggestedFilename()).toMatch(/\.pdf$/i);
  await page.getByRole('button',{name:'Approve',exact:true}).click();
  const approve=page.getByRole('dialog',{name:`Approve invoice #${number}`,exact:true});
  await expect(approve).toContainText('staff-verified manual contractor bill, not a recorded prior portal assignment');
  await expect(approve).toContainText('does not change the current contractor or work-order status');
  await approve.getByRole('button',{name:'Cancel',exact:true}).click();
  await expect(approve).toBeHidden();expect(bill(f).state).toBe('submitted');expect(parent(f)).toEqual(before);
  await page.getByRole('button',{name:'Approve',exact:true}).click();
  await approve.getByRole('button',{name:'Approve',exact:true}).click();
  await expect(approve).toBeHidden();await expect.poll(()=>bill(f).state).toBe('approved');
  await page.reload();await expect(page.locator('.app-root')).toBeVisible();await detail('Approved');
  await expect(page.getByRole('button',{name:'Hold / Do not pay',exact:true})).toBeVisible();
  expect(parent(f)).toEqual(before);expect(history(f)).toBe('0');expect(count(f)).toBe('1');
});

for(const [width,currentFirst] of [[1440,true],[390,false]])test.describe(`earlier plus current contractor bills at ${width}px`,()=>{
  test.use({viewport:{width,height:900},hasTouch:width===390});
  test('same invoice number on different contractors > both contractor bills > one customer draft > reload keeps both source links',async({page},info)=>{
    const f=fixture({noPreviousAssignment:true}),number=`SYNTHETIC-TWO-VENDORS-${randomUUID().slice(0,8)}`;
    const currentId=randomUUID();
    const current=()=>JSON.parse(sql(`select to_jsonb(i) from public.invoices i where id=${q(currentId)}`));
    const seedCurrent=()=>sql(`insert into public.invoices(id,num,work_order_id,contractor_id,invoice_type,document_kind,state,
      invoice_date,subtotal,sales_tax,total) select ${q(currentId)},${q(number)},id,contractor_id,'contractor','invoice','approved',
      current_date,200,0,200 from public.work_orders where id=${q(f.work)};
      insert into public.invoice_lines(invoice_id,position,type,description,qty,rate)
      values(${q(currentId)},1,'Other','Current contractor completion service',1,200);`);
    if(currentFirst)seedCurrent();
    const before=parent(f),existing=currentFirst?current():null;
    const upload=await open(page,f,accounts.backoffice);await fill(upload,f,{number});await finish(upload);
    expect(parent(f)).toEqual(before);expect(history(f)).toBe('0');
    if(existing)expect(current()).toEqual(existing);
    const earlierId=bill(f).id;
    const earlierRow=page.locator('.wo-invoice-row').filter({hasText:'Staff-verified manual bill'}).filter({hasText:`#${number}`});
    await expect(earlierRow).toContainText(/Synthetic (Company Admin|Service Company)/i);
    await actions(page,earlierRow,number);await earlierRow.getByRole('button',{name:'Approve',exact:true}).click();
    await expect.poll(()=>bill(f).state).toBe('approved');expect(parent(f)).toEqual(before);
    if(!currentFirst)seedCurrent();
    const beforeBilling=parent(f),currentBefore=current(),earlierBefore=bill(f);
    await page.reload();await expect(page.locator('.app-root')).toBeVisible();await openPanel(page,f);
    const rows=page.locator('.wo-invoice-row').filter({hasText:`#${number}`});await expect(rows).toHaveCount(2);
    await expect(rows.filter({hasText:/Synthetic Direct (Services|Contractor)/i})).toHaveCount(1);
    await expect(rows.filter({hasText:'Staff-verified manual bill'})).toHaveCount(1);
    await rows.first().scrollIntoViewIfNeeded();
    await page.screenshot({path:info.outputPath('two-contractor-bills-same-work-order.png')});

    await openSidebarPage(page,'7-Eleven billing');await page.getByRole('button',{name:'+ Create Invoice',exact:true}).click();
    const dialog=page.getByRole('dialog',{name:'Create P1 to 7-Eleven invoice',exact:true});
    await dialog.getByLabel('Search work order',{exact:true}).fill(f.work);
    await page.getByRole('listbox',{name:'Matching work orders'}).getByRole('option',{name:new RegExp(`^${f.work} `)}).click();
    const earlierSource=dialog.getByRole('checkbox',{name:/Synthetic (Company Admin|Service Company)/i});
    const currentSource=dialog.getByRole('checkbox',{name:/Synthetic Direct (Services|Contractor)/i});
    await expect(earlierSource).toBeVisible();await expect(currentSource).toBeVisible();
    await expect(earlierSource).toHaveAccessibleName(/Staff-verified earlier-work bill/);
    await earlierSource.check();await currentSource.check();
    await expect(earlierSource).toBeChecked();await expect(currentSource).toBeChecked();
    await page.screenshot({path:info.outputPath('two-distinguishable-selected-source-bills.png')});
    await dialog.getByRole('button',{name:'Pull lines + calculate',exact:true}).click();
    await expect(page.getByText('Pulled 2 line items',{exact:true})).toBeVisible();
    const customerNumber=`P1-SYNTHETIC-TWO-${randomUUID().slice(0,8)}`;
    await dialog.getByLabel('Invoice #',{exact:true}).fill(customerNumber);
    await dialog.getByLabel('Manual sales tax amount',{exact:true}).fill('0');
    await dialog.getByRole('button',{name:'Save as Draft',exact:true}).click();await expect(dialog).toBeHidden();
    const saved=()=>JSON.parse(sql(`select jsonb_build_object('id',i.id,'state',i.state,'total',i.total,
      'workOrderId',i.work_order_id,'sources',(select jsonb_agg(s.contractor_invoice_id order by s.contractor_invoice_id)
      from public.staff_invoice_sources s where s.staff_invoice_id=i.id),
      'lines',(select count(*) from public.invoice_lines l where l.invoice_id=i.id))
      from public.invoices i where i.num=${q(customerNumber)} and i.deleted_at is null`));
    expect(saved()).toMatchObject({state:'draft',total:320,workOrderId:f.work,lines:2,sources:[earlierId,currentId].sort()});
    expect(current()).toEqual(currentBefore);expect(bill(f)).toEqual(earlierBefore);expect(history(f)).toBe('0');
    expect(parent(f).contractor_id).toBe(beforeBilling.contractor_id);
    expect(parent(f).status).toBe(beforeBilling.status);
    await page.reload();await expect(page.locator('.app-root')).toBeVisible();await openSidebarPage(page,'7-Eleven billing');
    await page.getByRole('searchbox',{name:'Search billing invoices and work orders'}).fill(customerNumber);
    const drafts=page.getByRole('button',{name:/^Drafts /});
    if(await drafts.getAttribute('aria-expanded')!=='true')await drafts.click();
    const draftBucket=drafts.locator('xpath=ancestor::article[1]');
    await draftBucket.getByText(`#${customerNumber}`,{exact:true}).filter({visible:true}).first().click();
    await page.getByRole('button',{name:'Edit invoice',exact:true}).click();
    const reopened=page.getByRole('dialog',{name:`Edit invoice #${customerNumber}`,exact:true});
    await expect(reopened.getByRole('checkbox',{name:/Synthetic (Company Admin|Service Company)/i})).toBeChecked();
    await expect(reopened.getByRole('checkbox',{name:/Synthetic Direct (Services|Contractor)/i})).toBeChecked();
    expect(saved().sources).toEqual([earlierId,currentId].sort());
    await reopened.getByRole('checkbox',{name:/Synthetic (Company Admin|Service Company)/i}).scrollIntoViewIfNeeded();
    await page.screenshot({path:info.outputPath('reopened-draft-both-source-links-retained.png')});
    expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(width+1);
    await reopened.getByRole('button',{name:'Close',exact:true}).click();await expect(reopened).toBeHidden();
  });
});
});

for(const width of [1440,1280,1024,768,390,320])test(`reported email-intake Awaiting Parts replica: full and simplified upload discovery at ${width}px`,async({page},info)=>{
  await page.setViewportSize({width,height:width<=390?568:900});
  const f=priorInvoiceFixture({source:'email_intake',noPreviousAssignment:true,awaitingParts:true}),before=parent(f);
  expect(before).toMatchObject({source:'email_intake',status:'parts',contractor_assignment_version:1});
  await login(page,accounts.backoffice);await openPanel(page,f);
  const panel=page.getByRole('region',{name:'Previous contractor invoices',exact:true});
  const upload=panel.getByRole('button',{name:'Upload previous contractor invoice',exact:true});
  await expect(upload).toBeEnabled();await upload.scrollIntoViewIfNeeded();
  await page.screenshot({path:info.outputPath('email-intake-full-view-upload-visible.png')});
  await upload.click();const dialog=page.getByRole('dialog',{name:'Upload previous contractor invoice',exact:true});
  await expect(dialog.getByRole('button',{name:'Earlier contractor shown on the original bill',exact:true})).toBeVisible();
  await expect(dialog).not.toContainText('This manually entered work order');
  await expect(dialog.getByLabel('Previous contractor assignment',{exact:true})).toHaveCount(0);
  await page.keyboard.press('Escape');await expect(dialog).toBeHidden();
  await page.getByRole('button',{name:'Show simplified details',exact:true}).click();
  const disclosure=page.locator('summary').filter({hasText:'Invoices, estimates and documents'});
  await disclosure.click();await expect(upload).toBeVisible();await upload.scrollIntoViewIfNeeded();
  await page.screenshot({path:info.outputPath('email-intake-simplified-upload-visible.png')});
  await upload.click();await expect(dialog).toBeVisible();await dialog.getByRole('button',{name:'Cancel',exact:true}).click();
  await expect(dialog).toBeHidden();await page.reload();await expect(page.locator('.app-root')).toBeVisible();
  expect(parent(f)).toEqual(before);expect(history(f)).toBe('0');expect(count(f)).toBe('0');
  expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(width+1);
});
