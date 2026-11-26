import {randomUUID} from 'node:crypto';
import {jsPDF} from 'jspdf';
import {accounts,expect,login,openSidebarPage,openWorkOrder,test} from './fixtures.mjs';
import {priorInvoiceFixture,quotePrior as q} from '../../scripts/e2e/prior-contractor-invoice-fixtures.mjs';
import {linkedBillingSql as sql} from '../../scripts/e2e/linked-billing-test-support.mjs';
const parent=f=>JSON.parse(sql(`select to_jsonb(w) from public.work_orders w where id=${q(f.work)}`));
const bills=f=>JSON.parse(sql(`select coalesce(jsonb_agg(to_jsonb(i)),'[]') from public.invoices i where work_order_id=${q(f.work)} and deleted_at is null`));
async function open(page,f){
 await login(page,accounts.backoffice);await openSidebarPage(page,'Work orders');await openWorkOrder(page,f.work);
 const more=page.getByRole('button',{name:/Invoices, estimates and documents/});if(await more.isVisible().catch(()=>false))await more.click();
 const panel=page.getByRole('region',{name:'Previous contractor invoices',exact:true});
 await panel.getByRole('button',{name:'Upload previous contractor invoice',exact:true}).click();
 return page.getByRole('dialog',{name:'Upload previous contractor invoice',exact:true});
}
async function fields(d,f){
 const pick=d.getByRole('button',{name:'Earlier contractor shown on the original bill',exact:true});await pick.click();
 const list=d.page().getByRole('listbox',{name:'Earlier contractor shown on the original bill',exact:true});
 await d.page().getByRole('searchbox',{name:'Search Earlier contractor shown on the original bill'}).fill('');
 await expect(list.getByRole('option').filter({hasText:'Synthetic Direct Services'})).toBeDisabled();
 await list.getByRole('option').filter({hasText:'Synthetic Service Company'}).click();
 const number=`SYNTHETIC-EXTRA-${randomUUID().slice(0,8)}`;
 await d.getByLabel('Contractor invoice number',{exact:true}).fill(number);await d.getByLabel('Invoice date',{exact:true}).fill(f.day);
 await d.getByLabel('Invoice total',{exact:true}).fill('125.50');await d.getByLabel('Sales tax included in total',{exact:true}).fill('5.50');
 await d.getByLabel('Audit note',{exact:true}).fill('Verified original vendor and work-order reference for earlier work before current contractor.');
 await d.getByRole('checkbox',{name:/I verified the original invoice/}).check();return number;
}
async function attach(d,name='synthetic-original.pdf',buffer){
 if(!buffer){const pdf=new jsPDF();pdf.text('Synthetic earlier-work invoice; no customer content',15,20);buffer=Buffer.from(pdf.output('arraybuffer'));}
 const chooser=d.page().waitForEvent('filechooser');await d.getByLabel('Original invoice PDF',{exact:true}).click();
 await(await chooser).setFiles({name,mimeType:name.endsWith('.pdf')?'application/pdf':'text/plain',buffer});
}
async function shot(page,info,name){await page.screenshot({path:info.outputPath(name+'.png'),animations:'disabled'});}
for(const source of ['manual','email_intake'])test.describe(`verified upload recovery: ${source}`,()=>{
const fixture=()=>priorInvoiceFixture({source,noPreviousAssignment:true});
test('reported upload negatives > unknown/current vendor > invalid amounts/note > invalid PDF > corrected verified draft',async({page},info)=>{
 const f=fixture(),before=parent(f),d=await open(page,f);
 const pick=d.getByRole('button',{name:'Earlier contractor shown on the original bill',exact:true});await pick.click();
 const search=page.getByRole('searchbox',{name:'Search Earlier contractor shown on the original bill'});await search.fill('SYNTHETIC-VENDOR-NOT-REGISTERED-999');
 const empty=page.getByRole('listbox',{name:'Earlier contractor shown on the original bill'});
 await expect(empty.getByRole('status')).toHaveText('No matching choices.');
 await expect(empty.getByRole('option')).toHaveCount(1);
 await expect(empty.getByRole('option')).toHaveText('Choose the verified earlier contractor');
 await shot(page,info,'unknown-vendor-empty-search');await page.keyboard.press('Escape');await fields(d,f);
 const save=d.getByRole('button',{name:'Save draft',exact:true}),total=d.getByLabel('Invoice total',{exact:true}),tax=d.getByLabel('Sales tax included in total',{exact:true});
 for(const value of ['0','-1','100000000','1.001']){await total.fill(value);await save.click();await expect(d.getByRole('alert')).toContainText('valid date, actual total and tax');expect(bills(f)).toHaveLength(0);}
 await total.fill('125.50');await tax.fill('125.51');await save.click();await expect(d.getByRole('alert')).toContainText('valid date, actual total and tax');expect(bills(f)).toHaveLength(0);
 await tax.fill('5.50');await d.getByLabel('Audit note',{exact:true}).fill('four');await save.click();await expect(d.getByRole('alert')).toContainText('5–1,000');
 await d.getByLabel('Audit note',{exact:true}).fill('Verified original bill, contractor and earlier work.');
 for(const [name,bytes] of [['not-an-invoice.txt',Buffer.from('synthetic only')],['empty.pdf',Buffer.alloc(0)],['too-large.pdf',Buffer.alloc(5*1024*1024+1,32)]]){
  await attach(d,name,bytes);await save.click();await expect(d.getByRole('alert')).toContainText('non-empty PDF no larger than 5 MB');expect(bills(f)).toHaveLength(0);
 }
 await shot(page,info,'invalid-original-pdf-feedback');await attach(d);await save.click();await expect(d.getByRole('status')).toContainText('draft saved');
 expect(bills(f)).toHaveLength(1);expect(bills(f)[0]).toMatchObject({state:'draft',manual_contractor_bill:true});expect(parent(f)).toEqual(before);
 expect(sql(`select count(*) from public.work_order_assignment_history where work_order_id=${q(f.work)}`)).toBe('0');
});
test('reported upload pending save > repeat Enter/Escape/dismissal > one retained invoice and one submission',async({page},info)=>{
 const f=fixture(),before=parent(f),d=await open(page,f);await fields(d,f);await attach(d);
 let release,calls=0;const held=new Promise(resolve=>{release=resolve;});
 await page.route('**/rest/v1/rpc/save_verified_manual_contractor_invoice_v1',async route=>{calls++;await held;await route.fallback();});
 try{
  await d.getByRole('button',{name:'Upload and send for review',exact:true}).click();await expect.poll(()=>calls).toBe(1);
  await expect(d.getByRole('button',{name:'Saving…'})).toHaveCount(1);
  await expect(d.getByRole('button',{name:'Save draft',exact:true})).toHaveCount(0);
  for(const button of await d.getByRole('button',{name:'Saving…'}).all())await expect(button).toBeDisabled();
  await expect(d.getByRole('button',{name:'Cancel',exact:true})).toBeDisabled();await expect(d.getByRole('button',{name:'Close dialog',exact:true})).toBeDisabled();
  await page.keyboard.press('Enter');await page.keyboard.press('Escape');await expect(d).toBeVisible();expect(calls).toBe(1);expect(bills(f)).toHaveLength(0);
  await shot(page,info,'pending-upload-controls-locked');
 }finally{release();}
 await expect(d.getByRole('status')).toContainText('submitted for P1 review');expect(calls).toBe(1);expect(bills(f)).toHaveLength(1);
 expect(bills(f)[0].state).toBe('submitted');expect(parent(f)).toEqual(before);
});
test('reported original PDF attach failure > retained draft > retry same submission > original identity retained',async({page,diagnostics},info)=>{
 const f=fixture(),before=parent(f),d=await open(page,f);await fields(d,f);await attach(d);let calls=0;
 await page.route('**/rest/v1/rpc/attach_contractor_invoice_pdf',async route=>{
  if(++calls===1)await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({code:'P0001',message:'Synthetic recoverable original attachment failure'})});
  else await route.fallback();
 });
 await d.getByRole('button',{name:'Upload and send for review',exact:true}).click();await expect(d.getByRole('alert')).toContainText('Your draft is retained');
 const retained=bills(f);expect(retained).toHaveLength(1);expect(retained[0].state).toBe('draft');expect(retained[0].pdf_storage_path).toBeNull();
 await shot(page,info,'attachment-failure-retained-draft');await d.getByRole('button',{name:'Retry same submission',exact:true}).click();
 await expect(d.getByRole('status')).toContainText('submitted for P1 review');expect(bills(f)).toHaveLength(1);expect(bills(f)[0].id).toBe(retained[0].id);
 expect(bills(f)[0].pdf_storage_path).toBeTruthy();expect(parent(f)).toEqual(before);expect(calls).toBe(2);
 const injected=diagnostics.filter(event=>event.kind==='http'&&event.status===503&&event.url==='http://127.0.0.1:54331/rest/v1/rpc/attach_contractor_invoice_pdf');
 expect(injected).toHaveLength(1);diagnostics.splice(diagnostics.indexOf(injected[0]),1);
});
});
