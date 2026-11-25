import {appendFileSync, mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {accounts, expect, login as loginToPortal, openSidebarPage, test} from './fixtures.mjs';
import {reportedInvoiceFixture, reportedInvoiceSnapshot} from '../../scripts/e2e/reported-invoice-fixtures.mjs';
import {linkedBillingSql as sql} from '../../scripts/e2e/linked-billing-test-support.mjs';

const auditDir = process.env.P1_CAPITAL_AUDIT_DIR;
const login = (page,actor) => loginToPortal(page,actor,'/?portal=simplified');
// Wait on the actual rendered branch, command receipt and persisted records.
// Global network-idle failures from unrelated/cancelled dashboard reads are
// retained separately in the full audit report, not treated as a form outcome.
const dialogFor = page => page.getByRole('dialog', {name:'Close out capital',exact:true});
const quoteFor = dialog => dialog.getByLabel('Quote reference in 7-Eleven (required)', {exact:true});
const invoiceFor = dialog => dialog.getByLabel('Existing billed invoice reference (required)', {exact:true});
const dateFor = dialog => dialog.getByLabel('Actual billing date (required)', {exact:true});
const submitFor = dialog => dialog.getByRole('button', {name:'Close and send to History',exact:true});
function record(info, role, path, action, expected, actual, status='Pass') {
  if (!auditDir) return;
  appendFileSync(join(auditDir,'coverage.jsonl'),JSON.stringify({path,role,browser:info.project.name,
    viewport:info._viewport||'1440x1000 desktop',action,expected,actual,status})+'\n');
}
async function branch(info, actor, path, action, expected, run) {
  await test.step(path, async () => {
    try {const actual=await run();record(info,actor.name,path,action,expected,actual||'Expected outcome verified');}
    catch(error){record(info,actor.name,path,action,expected,String(error.message).split('\n')[0],'Fail');throw error;}
  });
}
async function screenshot(page,info,label,surface=dialogFor(page)) {
  if(!auditDir) return;
  const dir=join(auditDir,'screens');mkdirSync(dir,{recursive:true});
  const path=join(dir,`${info.project.name}-${info.testId.replace(/[^\w-]/g,'').slice(-28)}-${label}.png`);
  await surface.screenshot({path,animations:'disabled'});
  appendFileSync(join(auditDir,'screenshots.jsonl'),JSON.stringify({path,label,browser:info.project.name,
    viewport:page.viewportSize(),reviewed:false})+'\n');
}
test.beforeEach(async({context})=>{
  await context.route('**/*', async route => {
    const url=new URL(route.request().url());
    if(['127.0.0.1','localhost','[::1]'].includes(url.hostname)) await route.continue();
    else await route.abort('blockedbyclient');
  });
});
async function navigate(page,label) {
  if(await page.getByRole('button',{name:'Open menu',exact:true}).isVisible()) {
    await page.getByRole('button',{name:'Open menu',exact:true}).click();
    await page.getByRole('dialog',{name:'Navigation menu',exact:true}).getByRole('button',{name:label,exact:true}).click();
  } else await openSidebarPage(page,label);
}
async function openCloseOut(page, f) {
  await navigate(page,'Simplified');
  await page.getByPlaceholder('Search WO, store, city, keyword…').fill(f.work);
  await page.getByRole('button',{name:`Open ${f.work}`,exact:true}).click();
  await page.getByRole('button',{name:'Close out',exact:true}).click();
  await expect(dialogFor(page)).toBeVisible();
  return dialogFor(page);
}
async function fillValid(dialog) {
  await quoteFor(dialog).fill('SYNTHETIC-APPROVED-QUOTE');
  await dialog.getByRole('checkbox').check();
  await invoiceFor(dialog).fill('SYNTHETIC-EXISTING-BILL');
  await dateFor(dialog).fill('2026-10-27');
}
async function verifyHistoryAfterReload(page,f) {
  await expect(page.getByRole('heading',{name:'History',exact:true})).toBeVisible();
  // This freshly closed synthetic job must appear in the default newest-first
  // History page. Wait for that actual result before reloading, rather than
  // cancelling the initial History read with an immediate search request.
  await expect(page.getByText(f.work,{exact:true}).filter({visible:true}).first()).toBeVisible();
  await page.reload();
  await expect(page.locator('.app-root')).toBeVisible();
  await navigate(page,'History');
  await expect(page.getByText(f.work,{exact:true}).filter({visible:true}).first()).toBeVisible();
  expect(reportedInvoiceSnapshot(f).status).toBe('closed');
}

for(const actor of [accounts.manager,accounts.backoffice]) {
  for(const width of [1440,1280,1024,768,390,320]) test(`${actor.name} external quote recursive validation at ${width}px`,async({page},info)=>{
    info._viewport=`${width}x900 resized desktop`;
    await page.setViewportSize({width,height:900});
    const f=reportedInvoiceFixture('capital_external_quote_unrecorded'),before=reportedInvoiceSnapshot(f),requests=[];
    page.on('request',request=>{if(request.url().includes('/rpc/close_out_capital_v1'))requests.push(request.postDataJSON());});
    await login(page,actor);const dialog=await openCloseOut(page,f);
    await branch(info,actor,'A.billed.missing-quote','Fill invoice and date, check confirmation, submit twice',
      'Quote reference gets inline feedback/focus, no request and no saved changes',async()=>{
      await invoiceFor(dialog).fill('SYNTHETIC-EXISTING-BILL');await dateFor(dialog).fill('2026-10-27');
      await dialog.getByRole('checkbox').check();await quoteFor(dialog).fill('   ');
      await submitFor(dialog).click();await expect(dialog.getByRole('alert')).toContainText('Enter the approved quote reference from 7-Eleven');
      await expect(quoteFor(dialog)).toBeFocused();await expect(quoteFor(dialog)).toHaveAttribute('aria-invalid','true');
      await expect(dialog.getByRole('alert')).toBeInViewport({ratio:1});
      await submitFor(dialog).click();expect(requests).toHaveLength(0);expect(reportedInvoiceSnapshot(f)).toEqual(before);
      const dimensions=await quoteFor(dialog).evaluate(el=>{const r=el.getBoundingClientRect(),s=getComputedStyle(el);return{height:r.height,border:parseFloat(s.borderTopWidth),width:r.width};});
      expect(dimensions.height).toBeGreaterThanOrEqual(44);expect(dimensions.border).toBeGreaterThanOrEqual(1);expect(dimensions.width).toBeGreaterThan(100);
      if(actor===accounts.manager&&[1440,768,320].includes(width))await screenshot(page,info,'missing-quote');
      return 'Repeated invalid submission blocked; styled input, focus and field association verified';
    });
    await branch(info,actor,'A.billed.remaining-fields','Correct quote, uncheck/recheck confirmation, clear invoice and date',
      'Each missing field receives specific feedback and focus; corrected feedback disappears',async()=>{
      await quoteFor(dialog).fill('Q'.repeat(101));expect((await quoteFor(dialog).inputValue()).length).toBe(100);
      await quoteFor(dialog).fill(' SYNTHETIC-APPROVED-QUOTE / A&B #1 ');await expect(dialog.getByRole('alert')).toHaveCount(0);
      await dialog.getByRole('checkbox').uncheck();await submitFor(dialog).click();
      await expect(dialog.getByRole('alert')).toContainText('Confirm the actual quote submission using the checkbox');
      await expect(dialog.getByRole('checkbox')).toBeFocused();
      await expect(dialog.getByRole('alert')).toBeInViewport({ratio:1});
      if(actor===accounts.manager&&width===1440)await screenshot(page,info,'missing-attestation');
      await dialog.getByRole('checkbox').check();await invoiceFor(dialog).fill(' ');await submitFor(dialog).click();
      await expect(dialog.getByRole('alert')).toContainText('Enter the existing billed invoice reference');await expect(invoiceFor(dialog)).toBeFocused();
      await expect(dialog.getByRole('alert')).toBeInViewport({ratio:1});
      if(actor===accounts.manager&&width===1440)await screenshot(page,info,'missing-invoice');
      await invoiceFor(dialog).fill(' SYNTHETIC-EXISTING-BILL / A&B #1 ');await dateFor(dialog).fill('');await submitFor(dialog).click();
      await expect(dialog.getByRole('alert')).toContainText('Enter the actual billing date');await expect(dateFor(dialog)).toBeFocused();
      await expect(dialog.getByRole('alert')).toBeInViewport({ratio:1});
      if(actor===accounts.manager&&width===1440)await screenshot(page,info,'missing-date');
      await dateFor(dialog).fill('2026-10-27');await expect(dialog.getByRole('alert')).toHaveCount(0);
      expect(requests).toHaveLength(0);expect(reportedInvoiceSnapshot(f)).toEqual(before);
      const overflow=await dialog.evaluate(el=>{const inner=el.querySelector('.modal-inner');return inner.scrollWidth>inner.clientWidth+1;});
      expect(overflow).toBe(false);
    });
    await branch(info,actor,'A.billed.save-reload','Press Enter to confirm, inspect History, reload and reopen History',
      'One closeout, one external reference/billing record, original invoices unchanged, closure persists',async()=>{
      await submitFor(dialog).press('Enter');await expect(dialog).toBeHidden();
      const after=reportedInvoiceSnapshot(f);expect(after.status).toBe('closed');expect(after.invoices).toEqual(before.invoices);
      expect(after.externalQuoteHandoffs).toBe(1);expect(after.externalBillings).toBe(1);expect(after.capitalCloseOutEvents).toBe(1);
      expect(requests).toHaveLength(1);
      expect(requests[0].p_payload).toMatchObject({quoteReference:'SYNTHETIC-APPROVED-QUOTE / A&B #1',invoiceReference:'SYNTHETIC-EXISTING-BILL / A&B #1'});
      const saved=JSON.parse(sql(`select jsonb_build_object('quote',
        (select reference from public.external_capital_quote_handoffs where work_order_id='${f.work}'),
        'invoice',(select invoice_reference from public.work_order_external_billings where work_order_id='${f.work}'),
        'date',(select billed_on from public.work_order_external_billings where work_order_id='${f.work}'))`));
      expect(saved).toEqual({quote:'SYNTHETIC-APPROVED-QUOTE / A&B #1',invoice:'SYNTHETIC-EXISTING-BILL / A&B #1',date:'2026-10-27'});
      await verifyHistoryAfterReload(page,f);
    });
  });

  test(`${actor.name} cancel close Escape keep discard and reopen`,async({page},info)=>{
    const f=reportedInvoiceFixture('capital_external_quote_unrecorded'),before=reportedInvoiceSnapshot(f);
    await login(page,actor);let dialog=await openCloseOut(page,f);
    for(const action of ['Cancel','Close dialog','Escape']) await branch(info,actor,`B.dismiss.${action}`,
      `${action} with unsaved quote > Keep editing > dismiss again > Discard > reopen`,
      'Unsaved values retained on Keep editing, discarded only with confirmation; no data mutation',async()=>{
      await quoteFor(dialog).fill('SYNTHETIC-UNSAVED');
      const dismiss=async()=>action==='Escape'?page.keyboard.press('Escape'):dialog.getByRole('button',{name:action,exact:true}).click();
      await dismiss();const guard=page.getByRole('dialog',{name:'Unsaved changes',exact:true});await expect(guard).toBeVisible();
      if(actor===accounts.manager&&action==='Cancel')await screenshot(page,info,'unsaved-changes',guard);
      await guard.getByRole('button',{name:'Keep editing',exact:true}).click();await expect(quoteFor(dialog)).toHaveValue('SYNTHETIC-UNSAVED');
      await dismiss();await guard.getByRole('button',{name:'Discard changes',exact:true}).click();await expect(dialog).toBeHidden();
      await page.getByRole('button',{name:'Close out',exact:true}).click();dialog=dialogFor(page);await expect(quoteFor(dialog)).toHaveValue('');
      expect(reportedInvoiceSnapshot(f)).toEqual(before);
    });
    await dialog.getByRole('button',{name:'Cancel',exact:true}).click();await expect(dialog).toBeHidden();
    await page.getByRole('button',{name:'Back to previous view',exact:true}).click();
    await expect(page.getByPlaceholder('Search WO, store, city, keyword…')).toBeVisible();
    dialog=await openCloseOut(page,f);await expect(quoteFor(dialog)).toHaveValue('');
    await dialog.getByRole('button',{name:'Cancel',exact:true}).click();
  });

  test(`${actor.name} send to billing validates quote but not billing fields`,async({page},info)=>{
    const f=reportedInvoiceFixture('capital_external_quote_unrecorded'),before=reportedInvoiceSnapshot(f);
    await login(page,actor);const dialog=await openCloseOut(page,f);
    await branch(info,actor,'C.send-to-billing','Select unbilled outcome > missing quote > correct and confirm',
      'Quote still required; no invoice/date required; saved open billing state without a new invoice',async()=>{
      await dialog.getByRole('radio',{name:/Completed, send to billing/}).check();
      await expect(invoiceFor(dialog)).toHaveCount(0);await expect(dateFor(dialog)).toHaveCount(0);
      if(actor===accounts.manager)await screenshot(page,info,'send-to-billing');
      await dialog.getByRole('button',{name:'Confirm send to billing',exact:true}).click();
      await expect(dialog.getByRole('alert')).toContainText('Enter the approved quote reference');await expect(quoteFor(dialog)).toBeFocused();
      await quoteFor(dialog).fill('SYNTHETIC-QUOTE');await dialog.getByRole('checkbox').check();
      await dialog.getByRole('button',{name:'Confirm send to billing',exact:true}).click();await expect(dialog).toBeHidden();
      const after=reportedInvoiceSnapshot(f);expect(after.status).toBe('pending_invoice');expect(after.closedAt).toBeNull();
      expect(after.invoices).toEqual(before.invoices);expect(after.externalQuoteHandoffs).toBe(1);expect(after.externalBillings).toBe(0);
      await page.reload();await openCloseOut(page,f);await expect(quoteFor(dialogFor(page))).toBeVisible();
      expect(reportedInvoiceSnapshot(f).status).toBe('pending_invoice');
    });
    await dialogFor(page).getByRole('button',{name:'Cancel',exact:true}).click();await expect(dialogFor(page)).toBeHidden();
  });
}

test('existing P1 final invoice needs no external quote and closes without duplicate billing',async({page},info)=>{
  const actor=accounts.backoffice,f=reportedInvoiceFixture('capital_final_invoice');
  const before=reportedInvoiceSnapshot(f);await login(page,actor);const dialog=await openCloseOut(page,f);
  await branch(info,actor,'G.existing-final-invoice','Select consumed quote > reject duplicate billing > select final invoice > confirm > reload History',
    'Wrong quote selection cannot create a second bill; correct existing invoice closes once',async()=>{
    await expect(dialog).toContainText(`Using invoice #${f.staffNumber}`);await expect(quoteFor(dialog)).toHaveCount(0);
    await expect(dialog.getByRole('checkbox')).toHaveCount(0);await expect(invoiceFor(dialog)).toHaveValue(f.staffNumber);
    const selector=dialog.getByRole('combobox');
    await selector.selectOption(f.sourceQuote);await expect(dialog).toContainText(`Using quote #${f.sourceQuoteNumber}`);
    await expect(invoiceFor(dialog)).toHaveValue(f.sourceQuoteNumber);
    await dateFor(dialog).fill('2026-10-27');await submitFor(dialog).click();
    await expect(dialog.getByRole('alert')).toContainText('A final P1 invoice exists');
    expect(reportedInvoiceSnapshot(f)).toEqual(before);
    await selector.selectOption(f.staffInvoice);await expect(invoiceFor(dialog)).toHaveValue(f.staffNumber);
    expect(reportedInvoiceSnapshot(f)).toEqual(before);
    await dateFor(dialog).fill('2026-10-27');await screenshot(page,info,'existing-final-invoice');
    await submitFor(dialog).click();await expect(dialog).toBeHidden();
    const after=reportedInvoiceSnapshot(f);expect(after.status).toBe('closed');expect(after.invoices).toHaveLength(before.invoices.length);
    expect(after.invoices.find(i=>i.invoice_type==='contractor')).toEqual(before.invoices.find(i=>i.invoice_type==='contractor'));
    expect(after.externalQuoteHandoffs).toBe(0);expect(after.externalBillings).toBe(0);expect(after.billedEvents).toBe(1);
    await verifyHistoryAfterReload(page,f);
  });
});

test('active visit blocks both capital outcomes without manufacturing checkout',async({page},info)=>{
  const actor=accounts.backoffice,f=reportedInvoiceFixture('capital_external_quote_unrecorded');
  sql(`insert into public.work_order_visits(work_order_id,contractor_id,checked_in_by,check_in_at)
    select id,contractor_id,contractor_id,now()-interval '1 hour' from public.work_orders where id='${f.work}'`);
  const before=reportedInvoiceSnapshot(f);await login(page,actor);const dialog=await openCloseOut(page,f);
  await branch(info,actor,'H.active-visit','Open close-out > inspect both outcomes > Cancel',
    'Both confirmations blocked with explanation; real visit remains open and no data changes',async()=>{
    await expect(submitFor(dialog)).toBeDisabled();await expect(dialog).toContainText(/checkout|check.out/i);
    await dialog.getByRole('radio',{name:/Completed, send to billing/}).check();
    await expect(dialog.getByRole('button',{name:'Confirm send to billing',exact:true})).toBeDisabled();
    expect(reportedInvoiceSnapshot(f)).toEqual(before);await screenshot(page,info,'active-visit-blocked');
  });
  await dialog.getByRole('button',{name:'Cancel',exact:true}).click();
  await page.getByRole('dialog',{name:'Unsaved changes',exact:true}).getByRole('button',{name:'Discard changes',exact:true}).click();
});

test('recoverable capital server rejection preserves inputs and retries normally',async({page},info)=>{
  const actor=accounts.manager,f=reportedInvoiceFixture('capital_external_quote_unrecorded'),before=reportedInvoiceSnapshot(f);
  let requests=0;
  await login(page,actor);
  await page.route('**/rest/v1/rpc/close_out_capital_v1',async route=>{
    if(++requests===1)await route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({code:'PT409',message:'CAPITAL_CLOSE_STALE'})});
    else await route.continue();
  });
  const dialog=await openCloseOut(page,f);await fillValid(dialog);
  await branch(info,actor,'D.recoverable-error','Submit > simulated stale rejection > retry unchanged fields',
    'Recoverable message visible; initial state unchanged; fields editable and retry succeeds once',async()=>{
    await submitFor(dialog).click();await expect(dialog.getByRole('alert')).toContainText('This record changed');
    await expect(invoiceFor(dialog)).toHaveValue('SYNTHETIC-EXISTING-BILL');await expect(invoiceFor(dialog)).toBeEnabled();
    expect(reportedInvoiceSnapshot(f)).toEqual(before);await screenshot(page,info,'server-rejection');
    await submitFor(dialog).click();await expect(dialog).toBeHidden();expect(requests).toBe(2);
    expect(reportedInvoiceSnapshot(f).capitalCloseOutEvents).toBe(1);
  });
});

test('lost capital receipt freezes fields and retries the same operation without duplication',async({page},info)=>{
  const actor=accounts.manager,f=reportedInvoiceFixture('capital_external_quote_unrecorded'),requests=[];
  await login(page,actor);
  await page.route('**/rest/v1/rpc/close_out_capital_v1',async route=>{
    requests.push(route.request().postDataJSON());const response=await route.fetch();expect(response.ok()).toBe(true);
    if(requests.length===1)await route.fulfill({status:200,contentType:'application/json',body:'null'});
    else await route.fulfill({response});
  });
  const dialog=await openCloseOut(page,f);await fillValid(dialog);
  await branch(info,actor,'E.uncertain-retry','Submit > lose successful receipt > Retry same request',
    'Inputs frozen; identical request replay; exactly one billing/audit record',async()=>{
    await submitFor(dialog).click();await expect(dialog.getByRole('alert')).toContainText('could not be verified');
    await expect(quoteFor(dialog)).toBeDisabled();await expect(invoiceFor(dialog)).toBeDisabled();await screenshot(page,info,'uncertain-retry');
    await dialog.getByRole('button',{name:'Retry same request',exact:true}).click();await expect(dialog).toBeHidden();
    expect(requests).toHaveLength(2);expect(requests[1]).toEqual(requests[0]);
    const after=reportedInvoiceSnapshot(f);expect(after.externalBillings).toBe(1);expect(after.capitalCloseOutEvents).toBe(1);
    await verifyHistoryAfterReload(page,f);
  });
});

test('touch emulation capital validation and mobile navigation',async({page},info)=>{
  const actor=accounts.backoffice,f=reportedInvoiceFixture('capital_external_quote_unrecorded');
  info._viewport=`${page.viewportSize().width}x${page.viewportSize().height} touch emulation (not physical device)`;
  await login(page,actor);const dialog=await openCloseOut(page,f);
  await branch(info,actor,'F.touch','Tap submit > tap/type missing quote > change outcome > confirm',
    'Focused visible error, mobile controls usable, unbilled completion saved',async()=>{
    await submitFor(dialog).tap();await expect(quoteFor(dialog)).toBeFocused();await screenshot(page,info,'touch-missing-quote');
    const portrait=page.viewportSize();await page.setViewportSize({width:844,height:390});
    await submitFor(dialog).tap();await expect(dialog.getByRole('alert')).toBeInViewport({ratio:1});
    await expect(quoteFor(dialog)).toBeVisible();await screenshot(page,info,'touch-landscape');
    await page.setViewportSize(portrait);
    await quoteFor(dialog).tap();await quoteFor(dialog).fill('SYNTHETIC-TOUCH-QUOTE');
    await dialog.getByRole('checkbox').tap();await dialog.getByRole('radio',{name:/Completed, send to billing/}).tap();
    await dialog.getByRole('button',{name:'Confirm send to billing',exact:true}).tap();await expect(dialog).toBeHidden();
    expect(reportedInvoiceSnapshot(f).status).toBe('pending_invoice');
  });
});
