import { readFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { accounts, expect, login, openWorkOrder, test } from './fixtures.mjs';
import { invoiceConflictExportFixture, freshConflictTarget, conflictInvoiceSnapshot } from '../../scripts/e2e/invoice-conflict-export-fixtures.mjs';

let fixture;
test.beforeAll(() => { fixture = invoiceConflictExportFixture(); });
const evidence = process.env.P1_LIST_AUDIT_DIR;
function record(info, path, action, expected, actual='Verified', status='Pass') {
  if (evidence) appendFileSync(join(evidence,'coverage.jsonl'),JSON.stringify({Path:path,Role:info.annotations.find(a=>a.type==='role')?.description||'synthetic role',
    Browser:info.project.name,'Viewport/device':info.title.match(/\d+px/)?.[0]||info.project.name,Action:action,Expected:expected,Actual:actual,'Pass/Fail/Blocked':status})+'\n');
}
async function shot(page, info, name) { await page.screenshot({path:info.outputPath(`${name}.png`),fullPage:false}); }
async function navigate(page,label) {
  const desktop=page.locator('.desktop-sidebar');
  if(await desktop.isVisible()) await desktop.locator('button').filter({hasText:label}).first().click();
  else {
    await page.getByRole('button',{name:'Open menu',exact:true}).click();
    const menu=page.getByRole('dialog',{name:'Navigation menu',exact:true});
    await menu.locator('button').filter({hasText:label}).first().click();
    await expect(menu).toBeHidden();
  }
}
async function choose(page,label,value) {
  const control=page.getByRole('combobox',{name:label,exact:true});
  if(await control.locator('option').count()) await control.selectOption({label:value});
  else { await control.click(); await page.getByRole('option',{name:value,exact:true}).click(); }
}
function parseCsv(text) {
  const rows=[]; let row=[],cell='',quoted=false;
  text=text.replace(/^\ufeff/,'');
  for(let i=0;i<text.length;i++) {
    const ch=text[i];
    if(ch==='"') { if(quoted&&text[i+1]==='"'){cell+='"';i++;} else quoted=!quoted; }
    else if(ch===','&&!quoted){row.push(cell);cell='';}
    else if((ch==='\r'||ch==='\n')&&!quoted){if(ch==='\r'&&text[i+1]==='\n')i++;row.push(cell);rows.push(row);row=[];cell='';}
    else cell+=ch;
  }
  if(cell||row.length){row.push(cell);rows.push(row);}
  return rows;
}
async function download(page,info,label,name) {
  const button=page.getByRole('button',{name:label,exact:true}); await expect(button).toBeEnabled();
  const event=page.waitForEvent('download'); await button.click(); const item=await event;
  const file=info.outputPath(name); await item.saveAs(file);
  expect(await item.failure()).toBeNull();
  const raw=readFileSync(file,'utf8'); const rows=parseCsv(raw);
  expect(rows[0].length).toBeGreaterThan(3);
  return {raw,rows,headers:rows[0],records:rows.slice(1),name:item.suggestedFilename()};
}
async function newInvoice(page,width) {
  const target=freshConflictTarget(fixture);
  await page.setViewportSize({width,height:width<=390?740:1000});
  await login(page,accounts.direct);
  // My jobs supports exact search; it is a real assigned local work order.
  await openWorkOrder(page,target);
  await page.getByRole('button',{name:'Create or upload invoice',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'Create invoice',exact:true});
  await expect(dialog).toBeVisible();
  return {target,dialog};
}
async function addLabor(dialog) {
  await dialog.getByRole('button',{name:/^\+.*Labor$/}).click();
  await dialog.getByRole('textbox',{name:'Line 1 description',exact:true}).fill('Synthetic completed repair');
  await dialog.getByRole('spinbutton',{name:'Line 1 quantity',exact:true}).fill('1');
  await dialog.getByRole('spinbutton',{name:'Line 1 rate',exact:true}).fill('90');
}
for(const width of [1440,320]) {
  test(`contractor duplicate number > preserved form > corrected submit > reload at ${width}px`,async({page},info)=>{
    info.annotations.push({type:'role',description:'direct contractor; standalone, completed, assignment 1/cycle 0'});
    const {target,dialog}=await newInvoice(page,width);
    await dialog.getByLabel('Invoice #',{exact:true}).fill(fixture.taken);
    await addLabor(dialog);
    await dialog.getByRole('button',{name:'Submit',exact:true}).click();
    const feedback=dialog.locator('[data-invoice-action-feedback]');
    await expect(feedback).toContainText('That invoice number already exists for this contractor');
    await expect(feedback).toContainText('another work order');
    await expect(feedback).toBeInViewport();
    expect(conflictInvoiceSnapshot(target).invoices).toHaveLength(0);
    await expect(dialog.getByRole('textbox',{name:'Line 1 description',exact:true})).toHaveValue('Synthetic completed repair');
    await shot(page,info,'duplicate-number-visible');
    record(info,'A.1','Submit number reserved on another job','Specific inline number conflict, no invoice saved, entries preserved');
    await feedback.getByRole('button',{name:'Review invoice number',exact:true}).click();
    await expect(dialog.getByLabel('Invoice #',{exact:true})).toBeFocused();
    await expect(dialog.getByLabel('Invoice #',{exact:true})).toHaveAttribute('aria-invalid','true');
    const corrected=`SYNTH-CORRECTED-${target.slice(-8)}`;
    await dialog.getByLabel('Invoice #',{exact:true}).fill(corrected);
    await expect(feedback).toBeHidden();
    await dialog.getByRole('button',{name:'Submit',exact:true}).click();
    await expect(dialog).toBeHidden();
    await expect.poll(()=>conflictInvoiceSnapshot(target).invoices.length).toBe(1);
    const saved=conflictInvoiceSnapshot(target).invoices[0];
    expect(saved.number).toBe(corrected); expect(saved.state).toBe('submitted'); expect(saved.total).toBe(90);
    await page.reload(); await expect(page.locator('.app-root')).toBeVisible();
    await navigate(page,'Invoices');
    await page.getByRole('searchbox',{name:'Search contractor invoices'}).fill(corrected);
    await expect(page.getByText(`#${corrected}`,{exact:true}).filter({visible:true}).first()).toBeVisible();
    await shot(page,info,'corrected-invoice-after-reload');
    record(info,'A.1.1','Review number > correct > submit > reload > invoice list','One persisted submitted invoice with original line values');
  });
}

test('contractor duplicate draft > retry correct number at 768px',async({page},info)=>{
  info.annotations.push({type:'role',description:'direct contractor'});
  const {target,dialog}=await newInvoice(page,768);
  await dialog.getByLabel('Invoice #',{exact:true}).fill(fixture.taken);
  await dialog.getByRole('button',{name:/^Save as draft$/i}).click();
  await expect(dialog.locator('[data-invoice-action-feedback]')).toContainText('invoice number already exists');
  expect(conflictInvoiceSnapshot(target).invoices).toHaveLength(0);
  const number=`SYNTH-DRAFT-${target.slice(-8)}`;
  await dialog.getByLabel('Invoice #',{exact:true}).fill(number);
  await dialog.getByRole('button',{name:/^Save as draft$/i}).click();
  await expect(dialog).toBeHidden();
  await expect.poll(()=>conflictInvoiceSnapshot(target).invoices.length).toBe(1);
  expect(conflictInvoiceSnapshot(target).invoices[0].state).toBe('draft');
  record(info,'A.2','Duplicate draft > correct number > save','Specific error, no duplicate, valid draft persists');
});

test('contractor simulated stale failure keeps form and preserves version guards at 390px',async({page},info)=>{
  info.annotations.push({type:'role',description:'direct contractor'});
  const {target,dialog}=await newInvoice(page,390); await addLabor(dialog);
  await dialog.getByLabel('Invoice #',{exact:true}).fill(`SYNTH-STALE-${target.slice(-8)}`);
  await page.route('**/rest/v1/rpc/submit_contractor_invoice_v1',route=>route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({code:'PT409',message:'synthetic private guard detail'})}));
  await dialog.getByRole('button',{name:'Submit',exact:true}).click();
  await expect(dialog.locator('[data-invoice-action-feedback]')).toContainText('Invoice changed in another session');
  await expect(dialog.locator('[data-invoice-action-feedback]')).not.toContainText('synthetic private');
  expect(conflictInvoiceSnapshot(target).invoices).toHaveLength(0);
  await expect(dialog.getByRole('textbox',{name:'Line 1 description',exact:true})).toHaveValue('Synthetic completed repair');
  await shot(page,info,'stale-failure-preserves-form');
  record(info,'A.3','Simulate PT409 at the local transport boundary','Stale-specific safe feedback; no invoice or guard bypass');
});

for(const width of [1440,1024,768,390,320]) {
  test(`work-order export > all pages > filter > empty > reload at ${width}px`,async({page},info)=>{
    info.annotations.push({type:'role',description:'back office'});
    await page.setViewportSize({width,height:width<=390?740:900}); await login(page,accounts.backoffice);
    await navigate(page,'Work orders');
    const search=page.getByRole('textbox',{name:'Search work orders'});
    await search.fill(fixture.tag);
    await expect(page.getByText(new RegExp(`${fixture.tag}-[0-9]{3}$`)).filter({visible:true}).first()).toBeVisible();
    const all=await download(page,info,'Export work orders list','work-orders-all.csv');
    expect(all.records).toHaveLength(fixture.workCount);
    expect(new Set(all.records.map(row=>row[0])).size).toBe(fixture.workCount);
    expect(all.raw).toContain("'=SYNTHETIC"); expect(all.raw).toContain('Café');
    record(info,'B.1','Search > export work-order list across pages','All matching IDs exactly once; CSV quotes/formulas/Unicode safe');
    await choose(page,'Filter work orders by state','Texas');
    const filtered=await download(page,info,'Export work orders list','work-orders-tx.csv');
    expect(filtered.records).toHaveLength(fixture.txCount);
    expect(filtered.records.every(row=>row[5]==='TX')).toBe(true);
    await shot(page,info,'work-order-filtered-export');
    record(info,'B.1.1','State filter > export','Only matching Texas jobs, same list scope');
    await search.fill(`MISSING-${fixture.tag}`);
    await expect(page.getByText('No work orders match your filters.',{exact:true}).filter({visible:true}).first()).toBeVisible();
    const empty=page.getByRole('button',{name:'Export work orders list',exact:true}); await expect(empty).toBeEnabled();
    await empty.click(); await expect(page.getByRole('status').filter({hasText:'No records match these filters.'})).toBeVisible();
    record(info,'B.1.2','Empty filters > export','No partial or empty CSV download; explicit empty feedback');
    await page.reload(); await expect(page.locator('.app-root')).toBeVisible();
    await navigate(page,'Work orders'); await expect(page.getByRole('button',{name:'Export work orders list',exact:true})).toBeVisible();
  });
}

for(const [role,width] of [[accounts.backoffice,1440],[accounts.direct,390]]) {
  test(`${role===accounts.direct?'contractor isolation':'staff'} invoice list export > all pages > state at ${width}px`,async({page},info)=>{
    info.annotations.push({type:'role',description:role.name});
    await page.setViewportSize({width,height:900}); await login(page,role);
    await navigate(page,role===accounts.direct?'Invoices':'Contractor bills');
    await page.getByRole('searchbox',{name:'Search contractor invoices'}).fill(fixture.tag);
    await expect(page.getByText(new RegExp(`#${fixture.tag}-(?:C-[0-9]{3}|OTHER-C)$`)).filter({visible:true}).first()).toBeVisible();
    const all=await download(page,info,'Export contractor invoices list','contractor-invoices.csv');
    expect(all.records).toHaveLength(role===accounts.direct?fixture.ownInvoiceCount:fixture.invoiceCount);
    expect(all.raw).toContain(fixture.taken);
    expect(all.raw.includes(`${fixture.tag}-OTHER-C`)).toBe(role!==accounts.direct);
    expect(all.raw).not.toMatch(/storage_path|submission_key|Bearer|sb_secret_/);
    record(info,'C.1','Search > export contractor bills beyond 100 rows','All permitted records; other contractor excluded for contractor actor');
    await page.getByRole('button',{name:'Approved',exact:true}).click();
    const approved=await download(page,info,'Export contractor invoices list','approved-invoices.csv');
    expect(approved.records).toHaveLength(40);
    expect(approved.records.every(row=>row[6]==='Approved')).toBe(true);
    await shot(page,info,'invoice-list-export-state-filter');
    record(info,'C.1.1','Approved tab > export','State filter preserved; no accounting handoff');
  });
}

test('billing queues expand > export > collapse > reopen at 1280px',async({page},info)=>{
  info.annotations.push({type:'role',description:'back office'});
  await page.setViewportSize({width:1280,height:900}); await login(page,accounts.backoffice);
  await navigate(page,'7-Eleven billing');
  const search=page.getByRole('searchbox',{name:'Search billing invoices and work orders'}); await search.fill(fixture.tag);
  for(const [id,label,expected] of [['all','All',108],['draft','Drafts',54],['submitted','Please send to 7-Eleven',54],['sent','Sent to 7-Eleven',53],['recently_approved','Recently Approved',40]]) {
    const toggle=page.locator(`button[aria-controls="billing-bucket-${id}"]`);
    if(await toggle.getAttribute('aria-expanded')==='false') await toggle.click();
    const result=await download(page,info,`Export ${label} billing list`,`billing-${id}.csv`);
    expect(result.records).toHaveLength(expected);
    await toggle.click(); await expect(page.getByRole('button',{name:`Export ${label} billing list`,exact:true})).toBeHidden();
    await toggle.click(); await expect(page.getByRole('button',{name:`Export ${label} billing list`,exact:true})).toBeVisible();
    record(info,`D.${id}`,'Expand queue > export > collapse > reopen',`${expected} matching rows, no queue crossover or duplicate entries`);
  }
  await search.fill(`${fixture.tag}-READY`);
  const ready=await download(page,info,'Export Ready to Bill work orders list','ready-to-bill.csv');
  expect(ready.records).toHaveLength(1); expect(ready.records[0][0]).toBe(`${fixture.tag}-READY`);
  await shot(page,info,'billing-export-ready-filter');
  record(info,'D.ready','Ready to Bill > search > export','Only matching ready-to-bill work order; no invoice creation');
});

test('work-order export recoverable failure > retry; cancel > retry; filter change at 1440px',async({page},info)=>{
  info.annotations.push({type:'role',description:'back office'});
  await login(page,accounts.backoffice); await navigate(page,'Work orders');
  await page.getByRole('textbox',{name:'Search work orders'}).fill(fixture.tag);
  const button=page.getByRole('button',{name:'Export work orders list',exact:true}); await expect(button).toBeEnabled();
  let failed=false;
  await page.route('**/rest/v1/rpc/list_work_orders*',async route=>{
    const data=route.request().postDataJSON();
    if(data?.p_limit===100&&!failed){failed=true;await route.fulfill({status:400,contentType:'application/json',body:JSON.stringify({code:'57014',message:'synthetic private query detail'})});}
    else await route.fallback();
  });
  await button.click(); await expect(page.getByRole('alert').filter({hasText:'No partial file was downloaded'})).toBeVisible();
  await expect(page.getByRole('alert').filter({hasText:'No partial file was downloaded'})).not.toContainText('synthetic private');
  await shot(page,info,'export-failure-actionable');
  const retried=await download(page,info,'Export work orders list','recovered.csv'); expect(retried.records).toHaveLength(fixture.workCount);
  record(info,'E.1','Synthetic export read failure > retry','No partial file or private error text; retry exports full set');
  await page.unroute('**/rest/v1/rpc/list_work_orders*');
  let release; const held=new Promise(resolve=>{release=resolve;}); let once=false; let entered=false;
  await page.route('**/rest/v1/rpc/list_work_orders*',async route=>{
    if(route.request().postDataJSON()?.p_limit===100&&!once){once=true;entered=true;await held;await route.fallback().catch(()=>undefined);}
    else await route.fallback();
  });
  await button.click(); await expect.poll(()=>entered).toBe(true);
  await page.getByRole('button',{name:'Cancel Export work orders list',exact:true}).click();
  await expect(page.getByRole('status').filter({hasText:'Export cancelled'})).toBeVisible();
  release(); const recovered=await download(page,info,'Export work orders list','cancel-retry.csv'); expect(recovered.records).toHaveLength(fixture.workCount);
  record(info,'E.2','Cancel pending export > retry','Old response never downloads; retry exports all matching rows');
  await page.unroute('**/rest/v1/rpc/list_work_orders*');
  let downloads=0; page.on('download',()=>{downloads++;});
  for(const action of ['filter','navigation']) {
    let resume,entered=false,settle;
    const gate=new Promise(resolve=>{resume=resolve;});
    const settled=new Promise(resolve=>{settle=resolve;});
    await page.route('**/rest/v1/rpc/list_work_orders*',async route=>{
      if(route.request().postDataJSON()?.p_limit===100&&!entered) {
        entered=true; await gate;
        try { await route.fallback(); } catch { /* The user cancelled this read. */ }
        finally { settle(); }
      } else await route.fallback();
    });
    await button.click(); await expect.poll(()=>entered).toBe(true);
    if(action==='filter') {
      await page.getByRole('textbox',{name:'Search work orders'}).fill(`MISSING-${fixture.tag}`);
      await expect(page.getByRole('button',{name:'Cancel Export work orders list',exact:true})).toBeHidden();
    } else await navigate(page,'Contractor bills');
    resume(); await settled;
    await page.unroute('**/rest/v1/rpc/list_work_orders*');
    if(action==='navigation') await navigate(page,'Work orders');
    await page.getByRole('textbox',{name:'Search work orders'}).fill(fixture.tag);
    const retry=await download(page,info,'Export work orders list',`${action}-retry.csv`);
    expect(retry.records).toHaveLength(fixture.workCount);
    expect(downloads).toBe(action==='filter'?1:2);
    record(info,`E.3.${action}`,'Start export > change scope > retry','No old-scope download; new explicit export succeeds');
  }
});

test('invoice dirty form > cancel/escape/close > keep/discard > reopen at 320px',async({page},info)=>{
  info.annotations.push({type:'role',description:'direct contractor'});
  const {target,dialog}=await newInvoice(page,320);
  await dialog.getByLabel('Invoice #',{exact:true}).fill(`SYNTH-UNSAVED-${target.slice(-8)}`);
  await addLabor(dialog);
  const prompt=page.getByRole('dialog',{name:'Unsaved changes',exact:true});
  for(const action of ['cancel','escape','close']) {
    if(action==='cancel') await dialog.getByRole('button',{name:'Cancel',exact:true}).click();
    else if(action==='escape') await page.keyboard.press('Escape');
    else await dialog.getByRole('button',{name:'Close dialog',exact:true}).click();
    await expect(prompt).toBeVisible();
    if(action!=='close') {
      await prompt.getByRole('button',{name:'Keep editing',exact:true}).click();
      await expect(dialog.getByRole('textbox',{name:'Line 1 description',exact:true})).toHaveValue('Synthetic completed repair');
    } else await prompt.getByRole('button',{name:'Discard changes',exact:true}).click();
  }
  await expect(dialog).toBeHidden(); expect(conflictInvoiceSnapshot(target).invoices).toHaveLength(0);
  await page.getByRole('button',{name:'Create or upload invoice',exact:true}).click();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('textbox',{name:'Line 1 description',exact:true})).toHaveCount(0);
  await shot(page,info,'discarded-form-reopened');
  record(info,'A.4','Cancel/Escape/Close > keep or discard > reopen','No silent loss on dismiss; deliberate discard clears form and saves no invoice');
});

test('restricted reporting role cannot submit contractor invoices or enter accounting exports',async({page},info)=>{
  info.annotations.push({type:'role',description:'report-only contractor technician'});
  await login(page,accounts.reportTech);
  await openWorkOrder(page,fixture.reportWork);
  await expect(page.getByRole('button',{name:'Create or upload invoice',exact:true})).toHaveCount(0);
  await expect(page.getByRole('button',{name:'Export contractor invoices list',exact:true})).toHaveCount(0);
  await expect(page.getByRole('button',{name:'Export Ready to Bill work orders list',exact:true})).toHaveCount(0);
  await shot(page,info,'report-only-role');
  record(info,'F.1','Report-only technician > assigned completed work order','No invoice submission or accounting list export controls');
});

test('controller retains contractor-bill list exports without Ready to Bill access at 1024px',async({page},info)=>{
  info.annotations.push({type:'role',description:'invoice controller'});
  await page.setViewportSize({width:1024,height:800}); await login(page,accounts.controller);
  await navigate(page,'Contractor bills');
  await page.getByRole('searchbox',{name:'Search contractor invoices'}).fill(fixture.tag);
  await expect(page.getByRole('button',{name:'Export Ready to Bill work orders list',exact:true})).toHaveCount(0);
  await expect(page.getByRole('button',{name:'+ Create Invoice',exact:true})).toHaveCount(0);
  const result=await download(page,info,'Export contractor invoices list','controller-list.csv');
  // The existing controller read policy permits approved/paid contractor
  // bills only. An export must not broaden that to drafts/submissions.
  const permitted=new Set(Array.from({length:fixture.ownCount},(_,index)=>index)
    .filter(index=>index%4===2||index%4===3).map(index=>`${fixture.tag}-C-${String(index).padStart(3,'0')}`));
  expect(result.records).toHaveLength(permitted.size);
  expect(result.records.every(row=>permitted.has(row[0])&&['Approved','Entered in QuickBooks'].includes(row[6]))).toBe(true);
  await shot(page,info,'controller-read-only-list-export');
  record(info,'F.2','Controller > filtered contractor-bill list export','Permitted list rows only; no Ready to Bill or invoice creation authority added');
});

test('touch export navigation and short-screen controls',async({page},info)=>{
  info.annotations.push({type:'role',description:'back office'});
  await login(page,accounts.backoffice); await navigate(page,'Contractor bills');
  await page.getByRole('searchbox',{name:'Search contractor invoices'}).fill(fixture.tag);
  const result=await download(page,info,'Export contractor invoices list','touch-export.csv');
  expect(result.records).toHaveLength(fixture.invoiceCount);
  await shot(page,info,'touch-export');
  record(info,'G.touch','Mobile navigation > invoice filters > CSV export','Touch/mobile-emulated navigation and download succeed');
});
