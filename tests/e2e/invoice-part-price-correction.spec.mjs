import {accounts,expect,login,test} from './fixtures.mjs';
import {invoicePartPriceFixture,invoicePartPriceSnapshot,addContractorPriceSource} from '../../scripts/e2e/invoice-part-price-fixtures.mjs';

async function billing(page) {
  if(await page.locator('.desktop-sidebar').isVisible()) {
    await page.locator('.desktop-sidebar button').filter({hasText:'7-Eleven billing'}).first().click();
  } else {
    await page.getByRole('button',{name:'Open menu',exact:true}).click();
    await page.getByRole('dialog',{name:'Navigation menu',exact:true}).locator('button').filter({hasText:'7-Eleven billing'}).first().click();
  }
}

test('contractor part correction survives pulling its source again without changing ownership',async({page})=>{
  const f=invoicePartPriceFixture(),source=addContractorPriceSource(f);
  await login(page,accounts.backoffice);await billing(page);
  await page.getByRole('button',{name:'+ Create Invoice',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'Create P1 to 7-Eleven invoice',exact:true});
  await dialog.getByLabel('Search work order',{exact:true}).fill(f.work);
  await page.getByRole('listbox',{name:'Matching work orders'}).getByRole('option',{name:new RegExp(`^${f.work} `)}).click();
  await dialog.getByRole('checkbox',{name:new RegExp(source.number)}).check();
  await dialog.getByRole('button',{name:'Pull lines + calculate',exact:true}).click();
  await expect(dialog.getByLabel('Line 2 rate',{exact:true})).toHaveValue('125');
  await dialog.getByRole('button',{name:'Edit part price',exact:true}).nth(1).click();
  await dialog.getByLabel('Amount represents',{exact:true}).selectOption('billing_rate');
  await dialog.getByLabel('Final unit billing price',{exact:true}).fill('250');
  await dialog.getByLabel('Reason / contractor note reference',{exact:true}).fill('Verified synthetic contractor note');
  await dialog.getByRole('button',{name:'Apply price correction',exact:true}).click();
  await expect(dialog.getByLabel('Line 2 rate',{exact:true})).toHaveValue('250');
  await dialog.getByRole('button',{name:'Pull lines + calculate',exact:true}).click();
  await expect(dialog.getByLabel('Line 2 rate',{exact:true})).toHaveValue('250');
  await dialog.getByLabel('Invoice #',{exact:true}).fill(f.number);
  await dialog.getByLabel('Manual sales tax amount',{exact:true}).fill('0');
  await dialog.getByRole('button',{name:'Save as Draft',exact:true}).click();
  await expect(dialog).toBeHidden();
  const saved=invoicePartPriceSnapshot(f);
  expect(saved.invoices).toHaveLength(1);expect(saved.invoices[0].lines).toHaveLength(2);
  expect(saved.invoices[0].total).toBe(251.26);expect(saved.audit).toHaveLength(1);
  const corrected=saved.invoices[0].lines.find(line=>line.source_invoice_line_id===source.lineId);
  expect(corrected.rate).toBe(250);expect(corrected.source_unit_cost).toBe(100);expect(corrected.source_work_order_part_id).toBeNull();
  expect(saved.purchaseCost).toBe(1.01);
});
test.beforeEach(async({page})=>{
  await page.context().route('**/*',route=>{
    const url=new URL(route.request().url());
    if(['127.0.0.1','localhost','::1'].includes(url.hostname)||['data:','blob:'].includes(url.protocol))return route.continue();
    return route.abort('blockedbyclient');
  });
});
test.afterEach(async({page})=>{
  // Drain page-level JWT retry handlers before the shared diagnostics fixture
  // removes them. Ignoring an in-flight handler error can otherwise fall
  // through to the context guard after the request was already handled.
  // Keep that context-level external-network guard active until closure.
  await page.unrouteAll({behavior:'wait'});
});
for(const width of [1440,390,320]) for(const basis of ['purchase_cost','billing_rate']) {
  test(`part price ${basis}: apply, cancel, save, reopen and reload at ${width}px`,async({page},info)=>{
    const f=invoicePartPriceFixture();const rate=basis==='purchase_cost'?'4094.21':'3275.37';
    const reason='Verified synthetic contractor receipt for UI testing';
    await page.setViewportSize({width,height:width<=390?568:1000});
    await login(page,accounts.backoffice);await billing(page);
    await page.getByRole('button',{name:'+ Create Invoice',exact:true}).click();
    let dialog=page.getByRole('dialog',{name:'Create P1 to 7-Eleven invoice',exact:true});
    await dialog.getByLabel('Search work order',{exact:true}).fill(f.work);
    await page.getByRole('listbox',{name:'Matching work orders'}).getByRole('option',{name:new RegExp(`^${f.work} `)}).click();
    await expect(dialog.getByLabel('Line 1 rate',{exact:true})).toHaveValue('1.26');
    await dialog.getByRole('button',{name:'Edit part price',exact:true}).click();
    await expect(dialog.getByRole('button',{name:'Save as Draft',exact:true})).toBeDisabled();
    await dialog.getByLabel('Amount represents',{exact:true}).selectOption(basis);
    await dialog.getByLabel(basis==='purchase_cost'?'Corrected purchase unit cost':'Final unit billing price',{exact:true}).fill('3275.37');
    await dialog.getByLabel('Reason / contractor note reference',{exact:true}).fill('short');
    await dialog.getByRole('button',{name:'Apply price correction',exact:true}).click();
    await expect(dialog.getByRole('alert').filter({hasText:'at least 10 characters'})).toBeVisible();
    await dialog.getByLabel('Reason / contractor note reference',{exact:true}).fill(reason);
    await expect(dialog.getByText(`Final unit billing price: $${rate}`,{exact:false})).toBeVisible();
    await page.screenshot({path:info.outputPath('price-correction-preview.png'),fullPage:true});
    await dialog.getByRole('button',{name:'Apply price correction',exact:true}).click();
    await expect(dialog.getByLabel('Line 1 rate',{exact:true})).toHaveValue(rate);
    expect(invoicePartPriceSnapshot(f).invoices).toHaveLength(0);
    await dialog.getByRole('button',{name:'Edit part price',exact:true}).click();
    await dialog.getByLabel(basis==='purchase_cost'?'Corrected purchase unit cost':'Final unit billing price',{exact:true}).fill('9999');
    await dialog.getByRole('button',{name:'Cancel price edit',exact:true}).click();
    await expect(dialog.getByLabel('Line 1 rate',{exact:true})).toHaveValue(rate);
    await dialog.getByLabel('Invoice #',{exact:true}).fill(f.number);
    // Synthetic TX address has no verified location rate. Use the existing
    // explicit manual-tax control; never weaken or mock the tax guard.
    await dialog.getByLabel('Manual sales tax amount',{exact:true}).fill('0');
    await expect(dialog.getByRole('button',{name:'Save as Draft',exact:true})).toBeEnabled();
    await dialog.getByRole('button',{name:'Save as Draft',exact:true}).click();
    await expect(dialog).toBeHidden();
    if(width<=390){
      const header=page.locator('.invoice-top-header');
      await expect(header.locator('.invoice-company-details')).toBeVisible();
      const bounds=await header.evaluate(element=>{
        const parent=element.getBoundingClientRect();
        const left=element.querySelector('.invoice-top-header-left').getBoundingClientRect();
        const right=element.querySelector('.invoice-top-header-right').getBoundingClientRect();
        return {sellerWidth:right.width,height:parent.height,left:left.left,right:right.right,
          parentLeft:parent.left,parentRight:parent.right};
      });
      expect(bounds.sellerWidth).toBeGreaterThanOrEqual(80);
      expect(bounds.height).toBeLessThan(240);
      expect(bounds.left).toBeGreaterThanOrEqual(bounds.parentLeft-1);
      expect(bounds.right).toBeLessThanOrEqual(bounds.parentRight+1);
      await page.screenshot({path:info.outputPath('mobile-invoice-header.png')});
    }
    const saved=invoicePartPriceSnapshot(f);
    expect(saved.purchaseCost).toBe(1.01);expect(saved.invoices).toHaveLength(1);expect(saved.audit).toHaveLength(1);
    expect(saved.audit[0].actor).toBe(f.actor);expect(saved.audit[0].correction).toEqual({basis,amount:3275.37,reason});
    expect(saved.invoices[0].lines[0].rate).toBe(Number(rate));
    expect(saved.invoices[0].lines[0].source_work_order_part_id).toBe(f.part);
    await page.getByRole('button',{name:'Edit invoice',exact:true}).click();
    dialog=page.getByRole('dialog',{name:`Edit invoice #${f.number}`,exact:true});
    await expect(dialog.getByLabel('Line 1 rate',{exact:true})).toHaveValue(rate);
    await expect(dialog.getByText(`Correction reason: ${reason}`,{exact:true})).toBeVisible();
    await page.screenshot({path:info.outputPath('persisted-price-correction.png'),fullPage:true});
    // A current client may re-save the correction without resetting it or
    // producing a duplicate correction-audit entry.
    await dialog.getByLabel('Manual sales tax amount',{exact:true}).fill('0');
    await dialog.getByRole('button',{name:'Save Draft',exact:true}).click();
    await expect(dialog).toBeHidden();
    expect(invoicePartPriceSnapshot(f).audit).toHaveLength(1);
    await page.getByRole('button',{name:'Edit invoice',exact:true}).click();
    dialog=page.getByRole('dialog',{name:`Edit invoice #${f.number}`,exact:true});
    await expect(dialog.getByLabel('Line 1 rate',{exact:true})).toHaveValue(rate);
    // A reload with no unsaved edits must still rehydrate the persisted correction.
    await dialog.getByRole('button',{name:'Close',exact:true}).click();
    await expect(dialog).toBeHidden();
    await page.reload();await expect(page.locator('.app-root')).toBeVisible();await billing(page);
    await page.getByRole('searchbox',{name:'Search billing invoices and work orders',exact:true}).fill(f.number);
    await page.getByText(`#${f.number}`,{exact:true}).filter({visible:true}).first().click();
    await page.getByRole('button',{name:'Edit invoice',exact:true}).click();
    dialog=page.getByRole('dialog',{name:`Edit invoice #${f.number}`,exact:true});
    await expect(dialog.getByLabel('Line 1 rate',{exact:true})).toHaveValue(rate);
    await expect(dialog.getByText(`Correction reason: ${reason}`,{exact:true})).toBeVisible();
  });
}
