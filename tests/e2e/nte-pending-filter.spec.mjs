import assert from 'node:assert/strict';
import {test,expect} from '@playwright/test';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {accounts} from './fixtures.mjs';
import {syntheticPassword} from '../../scripts/e2e/local-supabase-runtime.mjs';
import {ntePendingFilterFixture,nteFixtureFingerprint} from '../../scripts/e2e/nte-pending-filter-fixtures.mjs';
import {linkedBillingSql as sql} from '../../scripts/e2e/linked-billing-test-support.mjs';

test.describe.configure({mode:'serial'});
let fixture,before;
const coverage=[];
const record=(path,action,expected,actual)=>coverage.push({path,action,expected,actual,status:'Pass'});
const appOrigin='https://portal.example.invalid',databaseOrigin='https://synthetic.supabase.co';
const evidence=process.env.P1_NTE_EVIDENCE_DIR;
test.beforeAll(()=>{
  fixture=process.env.P1_NTE_FIXTURE_FILE?JSON.parse(readFileSync(process.env.P1_NTE_FIXTURE_FILE,'utf8')):ntePendingFilterFixture();
  before=nteFixtureFingerprint(fixture,false);
});
test.afterAll(()=>{
  if(fixture)assert.equal(nteFixtureFingerprint(fixture,false),before,'Browser checks must preserve financial rows, work orders and restored marker states');
  if(evidence){mkdirSync(evidence,{recursive:true});writeFileSync(join(evidence,'browser-coverage.json'),JSON.stringify(coverage,null,2));}
});

test.beforeEach(async({context})=>{
  // Every browser request is restricted to this disposable localhost test stack.
  // Synthetic HTTPS URLs exercise the normal application CSP, not hosted services.
  await context.route('**/*',async route=>{
    const request=route.request(),url=new URL(request.url());
    let destination;
    if(url.origin===appOrigin)destination=new URL(url.pathname+url.search,'http://127.0.0.1:3187');
    else if(url.origin===databaseOrigin&&/^\/(auth|rest|storage)\/v1(?:\/|$)/.test(url.pathname))destination=new URL(url.pathname+url.search,'http://127.0.0.1:54321');
    else if(['http://127.0.0.1:3100','http://127.0.0.1:54321'].includes(url.origin))destination=url;
    else if(['blob:','data:'].includes(url.protocol))return route.continue();
    else return route.abort('blockedbyclient');
    try{
      for(let attempt=0;attempt<5;attempt++){
        const response=await route.fetch({url:destination.href,maxRedirects:0});
        const body=await response.body(),status=response.status();
        if(status===401&&body.includes(Buffer.from('JWT issued at future'))&&attempt<4){await new Promise(r=>setTimeout(r,1000));continue;}
        return await route.fulfill({status,headers:response.headers(),body});
      }
    }catch{return route.abort('aborted').catch(()=>{});}
  });
  await context.routeWebSocket('**/*',socket=>socket.close());
});

async function login(page,account){
  await page.goto('/');await page.getByPlaceholder('you@p1pros.com').fill(account.email);
  await page.locator('input[type=password]').fill(syntheticPassword);
  await page.getByRole('button',{name:'Sign in',exact:true}).click();
  await expect(page.locator('.app-root')).toBeVisible();
}
async function workOrders(page){
  await page.locator('.desktop-sidebar').getByRole('button').filter({hasText:'Work orders'}).first().click();
  await expect(page.getByLabel('Search work orders',{exact:true})).toBeVisible();
}
const filter=page=>page.getByLabel('Filter work orders by NTE approval',{exact:true});
async function choose(page,label,option){
  const control=page.getByLabel(label,{exact:true});
  if(await control.evaluate(el=>el.tagName==='SELECT'))return control.selectOption({label:option});
  await control.click();
  await page.getByRole('listbox').filter({visible:true}).getByRole('option').filter({hasText:option}).first().click();
}
const chooseNte=(page,value)=>choose(page,'Filter work orders by NTE approval',value==='pending'?'NTE Pending Approval':'All NTE approval states');
const visibleRows=page=>page.locator('.desktop-only-table tbody tr:visible, .mobile-only-cards .mobile-card:visible');
async function ids(page){return(await visibleRows(page).allTextContents()).flatMap(text=>text.match(new RegExp(fixture.prefix+'-\\d{3}','g'))||[]);}
async function count(page,total,length){
  await expect.poll(()=>ids(page)).toHaveLength(length);
  await expect(page.locator('.work-order-pagination').first()).toContainText(`of ${total}`);
}
async function screenshot(page,name){
  if(evidence)await page.screenshot({path:join(evidence,`${name}.png`),fullPage:false,animations:'disabled'});
}

test('recursive staff Work orders NTE filtering, paging, combinations, clear and reload',async({page})=>{
  test.setTimeout(180000);
  await login(page,accounts.backoffice);await workOrders(page);
  const search=page.getByLabel('Search work orders',{exact:true});await search.fill(fixture.prefix);
  await count(page,17,10);
  record('A','Work orders → search synthetic fixture','All 17 active fixture WOs appear across pages','17 total; first 10 visible');

  await filter(page).click();await expect(page.getByRole('listbox').filter({visible:true})).toBeVisible();
  await screenshot(page,'nte-filter-open-menu');await page.keyboard.press('Escape');
  await expect(filter(page)).toHaveAttribute('aria-expanded','false');await count(page,17,10);
  await filter(page).click();await expect(page.getByRole('listbox').filter({visible:true})).toBeVisible();
  await page.getByLabel('Search work orders',{exact:true}).click();
  await expect(filter(page)).toHaveAttribute('aria-expanded','false');
  record('A.menu','Open NTE menu → Escape → reopen → outside click','Both options visible; dismissals do not change selection','Menu reopened and closed; All NTE approval states retained');
  await chooseNte(page,'pending');await count(page,15,10);
  const first=await ids(page);assert.equal(new Set(first).size,10);
  for(const row of await visibleRows(page).all())await expect(row.getByRole('img',{name:'NTE request submitted — awaiting approval'})).toBeVisible();
  await screenshot(page,'desktop-filtered-first-page');
  record('A.1','Choose NTE Pending Approval','Only waiting-marker WOs; correct exact count; brown dots remain visible','15 total; 10 flagged rows; no duplicates');

  await page.getByRole('button',{name:'Next',exact:true}).first().click();await count(page,15,5);
  const second=await ids(page);assert.equal(new Set([...first,...second]).size,15);
  await expect(page.getByRole('button',{name:'Next',exact:true}).first()).toBeDisabled();
  await page.getByRole('button',{name:'Previous',exact:true}).first().click();await count(page,15,10);
  assert.deepEqual(await ids(page),first);
  record('A.1.1','Next → final page → Previous','15 unique results, no skipped or duplicate work orders','10 + 5 unique; final Next disabled; Previous restored first page');

  await page.getByRole('button',{name:'Next',exact:true}).first().click();await count(page,15,5);
  await choose(page,'Filter work orders by state','Texas');await count(page,8,8);
  await expect(page.locator('.work-order-pagination').first()).toContainText('Page 1');
  await choose(page,'Filter work orders by priority','P2 Emergency');await count(page,8,8);
  await page.getByLabel('Filter status column',{exact:true}).selectOption('pending_invoice');await count(page,8,8);
  await page.getByLabel('Filter summary column',{exact:true}).fill('row 1');await count(page,4,4);
  await page.getByLabel('Filter summary column',{exact:true}).fill('');await count(page,8,8);
  record('A.1.2','Combine TX, P2, status and a table-column filter','NTE condition remains active in generic and custom table reads','8 TX/P2; 4 matching summary; clearing summary restores 8');

  await choose(page,'Filter work orders by state','Virginia');
  await expect(page.getByText('No work orders match your filters.',{exact:true}).first()).toBeVisible();
  await expect(filter(page)).toContainText('NTE Pending Approval');await screenshot(page,'empty-filter-combination');
  await choose(page,'Filter work orders by state','All states');
  await choose(page,'Filter work orders by priority','All priorities');
  await page.getByLabel('Filter status column',{exact:true}).selectOption('all');await count(page,15,10);
  record('A.1.3','Choose no-match state → restore filters','Empty state, not unfiltered fallback; selected NTE filter retained','Empty notice shown; restoring state recovers 15');

  const contractor=page.getByLabel('Filter work orders by contractor',{exact:true});
  await contractor.click();
  await page.getByRole('searchbox',{name:'Search Filter work orders by contractor'}).fill('Synthetic Direct Contractor');
  await page.getByRole('option').filter({hasText:'Synthetic Direct Contractor'}).click();await count(page,15,10);
  await contractor.click();await page.getByRole('option',{name:'All contractors',exact:true}).click();await count(page,15,10);
  record('A.1.3.contractor','NTE Pending Approval → choose contractor → All contractors','Contractor directory filter combines with NTE and can be removed','15 matching contractor records; removing contractor retains NTE');
  for(const sort of ['Newest to oldest','Priority','SLA due soonest']){
    await choose(page,'Sort work orders',sort);await count(page,15,10);
  }
  await choose(page,'Sort work orders','Oldest to newest');await count(page,15,10);
  await expect.poll(async()=>(await ids(page))[0]).toBe(fixture.rows[14].id);
  await page.getByRole('checkbox',{name:'Hide closed calls',exact:true}).uncheck();await count(page,16,10);
  await page.getByRole('checkbox',{name:'Hide closed calls',exact:true}).check();await count(page,15,10);
  record('A.1.4','Oldest sort → include closed → hide closed','Sorted filtered set; closed flag included only when requested','Oldest first; total 15 → 16 → 15');

  await visibleRows(page).first().click();await expect(search).toBeHidden();
  await page.getByRole('button',{name:'Back to previous view',exact:true}).click();
  await expect(filter(page)).toContainText('NTE Pending Approval');await count(page,15,10);
  record('A.1.5','Open result → Back to work orders','Detail is reachable; list filter remains selected','Returned to the filtered 15-result list');

  for(const width of [768,390,320]){
    await page.setViewportSize({width,height:900});await expect(filter(page)).toBeVisible();
    await expect(visibleRows(page).first()).toBeVisible();
    const geometry=await filter(page).evaluate(el=>({left:el.getBoundingClientRect().left,right:el.getBoundingClientRect().right,viewport:innerWidth,document:document.documentElement.scrollWidth}));
    assert.ok(geometry.left>=0&&geometry.right<=width+1);assert.ok(geometry.document<=width+1);
    await filter(page).focus();await page.keyboard.press('Enter');await page.keyboard.press('Home');await page.keyboard.press('Enter');await count(page,17,10);
    await chooseNte(page,'pending');await count(page,15,10);
    await screenshot(page,`filtered-${width}`);
    record(`A.1.6.${width}`,'Resize → keyboard change → select Pending again','Usable filter and correct responsive results without horizontal overflow',`${width}px passed; totals 17 → 15`);
  }
  await page.setViewportSize({width:1440,height:1000});
  await page.getByRole('button',{name:'Clear',exact:true}).first().click();
  await expect(filter(page)).toContainText('All NTE approval states');await expect(search).toHaveValue('');
  await search.fill(fixture.prefix);await count(page,17,10);
  record('A.2','Clear filters → search fixture again','NTE disabled; ordinary list restored','17 active records, including unflagged ones');
  await chooseNte(page,'pending');await count(page,15,10);
  await page.reload();await expect(page.locator('.app-root')).toBeVisible();await workOrders(page);
  await expect(filter(page)).toContainText('All NTE approval states');await search.fill(fixture.prefix);await count(page,17,10);
  record('A.3','Reload → reopen Work orders','Filter follows existing session-only behavior; no business data changes','Defaults restored; 17 active records; fixture fingerprint unchanged');
});

test('filter failures expose Retry and never display an unfiltered fallback',async({page})=>{
  test.setTimeout(90000);await login(page,accounts.manager);await workOrders(page);
  await page.getByLabel('Search work orders',{exact:true}).fill(fixture.prefix);await count(page,17,10);
  let fail=true;
  await page.route('**/rest/v1/rpc/list_work_orders_nte_rows_v1',async route=>{
    if(fail)return route.fulfill({status:400,contentType:'application/json',body:JSON.stringify({code:'22023',message:'Synthetic read failure'})});
    return route.fallback();
  });
  await chooseNte(page,'pending');
  await expect(page.getByRole('alert').filter({hasText:'Work orders could not be loaded'}).first()).toBeVisible();
  assert.equal((await ids(page)).length,0);await screenshot(page,'read-failure-retry');
  fail=false;await page.getByRole('button',{name:'Retry',exact:true}).first().click();await count(page,15,10);
  record('B','Inject local row-read failure → Retry','Persistent error, zero unfiltered fallback rows, successful retry','Error and Retry visible; retry recovered 15 results');
});

test('marking and clearing NTE updates cached filtered membership',async({page})=>{
  test.setTimeout(90000);await login(page,accounts.backoffice);await workOrders(page);
  await page.getByLabel('Search work orders',{exact:true}).fill(fixture.prefix);await chooseNte(page,'pending');await count(page,15,10);
  // A permitted synthetic marker change exercises the real billing UI, cache
  // invalidation, normal auth and SQL command; no external message is sent.
  await page.locator('.desktop-sidebar').getByRole('button').filter({hasText:'7-Eleven billing'}).first().click();
  const target=fixture.rows[1];
  await page.getByRole('searchbox',{name:'Search billing invoices and work orders'}).fill(target.id);
  await page.getByRole('row').filter({hasText:target.id}).filter({visible:true}).first().click();
  await page.getByRole('button',{name:'Clear NTE wait',exact:true}).click();
  await expect(page.getByRole('button',{name:'Mark waiting on NTE approval',exact:true})).toBeVisible();
  await expect.poll(()=>sql(`select waiting_on_nte_approval from public.staff_invoice_nte_wait_flags where invoice_id='${target.invoiceId}'`)).toBe('f');
  await workOrders(page);await chooseNte(page,'pending');await count(page,14,10);
  await page.locator('.desktop-sidebar').getByRole('button').filter({hasText:'7-Eleven billing'}).first().click();
  await page.getByRole('searchbox',{name:'Search billing invoices and work orders'}).fill(target.id);
  await page.getByRole('row').filter({hasText:target.id}).filter({visible:true}).first().click();
  await page.getByRole('button',{name:'Mark waiting on NTE approval',exact:true}).click();
  await expect(page.getByRole('button',{name:'Clear NTE wait',exact:true})).toBeVisible();
  await workOrders(page);await chooseNte(page,'pending');await count(page,15,10);
  // afterAll ignores only the intentionally changed marker audit metadata;
  // every financial/work-order field and restored marker boolean must match.
  assert.equal(nteFixtureFingerprint(fixture,false),before);
  record('C','Clear marker in billing → Work orders → mark again → Work orders','Fresh membership and count immediately after each permitted command','Totals 15 → 14 → 15; invoice state/total unchanged');
});

for(const account of [accounts.direct,accounts.vaCoordinator]){
  test(`${account.name} cannot activate the staff NTE queue`,async({page})=>{
    await login(page,account);
    if(account===accounts.vaCoordinator)await workOrders(page);
    await expect(filter(page)).toHaveCount(0);
    record(`D.${account.email}`,'Sign in as restricted role','NTE staff filter absent','Not rendered; SQL access also tested separately');
  });
}
