import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { ownerFixtureUpdate } from './candidate-fixtures.mjs';

export async function verifyFinancialNotificationPagination(f, check) {
  await f.settle();
  const targets=[];
  await check('121 authoritative synthetic review events generate discoverable unknown deliveries',async()=>{
    for(let index=0;index<121;index++) {
      const target=await f.invoice();await f.candidateReview(target);
      const event=(await f.events(target))[0];const item=(await f.deliveries(event))[0];
      targets.push({target,event,item});
    }
    const ids=new Set(targets.map(target=>target.item.id));
    let processed=0;
    for(let page=0;page<20;page++) {
      const claim=await f.claim();if(!claim.rows.length)break;
      for(const row of claim.rows) {
        const message=await f.prepare(row.id,claim.token);if(!message || message.status)continue;
        await f.complete(row.id,claim.token,ids.has(row.id)?'unknown':'sent',ids.has(row.id)?'GRAPH_OUTCOME_UNKNOWN':null);
        if(ids.has(row.id))processed++;
      }
    }
    assert.equal(processed,121);
    const stamp=(await f.db.query('select clock_timestamp() stamp')).rows[0].stamp;
    await ownerFixtureUpdate(f.db,'financial_notification_deliveries','update public.financial_notification_deliveries set created_at=$2 where id=any($1::uuid[])',[[...ids],stamp]);
  });
  let first;
  await check('queue orders tied timestamps by unique UUID and caps each page without exact-count dependence',async()=>{
    const started=performance.now();
    first=await f.page({family:'invoice_rejected',state:'unknown',limit:25});
    console.log(`MEASURE financial unknown queue first25 ${(performance.now()-started).toFixed(2)}ms; synthetic121+existing rows, local PGlite only`);
    assert.equal(first.items.length,25);assert.equal(first.hasMore,true);assert.ok(first.nextCursor);
    assert.ok(!Object.hasOwn(first,'totalCount'));
    for(const item of first.items) {
      assert.equal(item.recipientLabel,null,'Broad queue does not reveal recipient display identity');
      assert.equal(typeof item.canResend,'boolean');assert.equal(typeof item.canResolve,'boolean');
      assert.ok(!JSON.stringify(item).includes('@'));
    }
    const expected=targets.map(target=>target.item.id).sort().reverse().slice(0,25);
    assert.deepEqual(first.items.map(item=>item.id),expected);
    assert.equal((await f.page({family:'invoice_rejected',state:'unknown',limit:50})).items.length,50);
    for(const limit of [0,51,1000])await f.denied(()=>f.page({limit}),['PT422']);
  });
  await check('keyset continuation reaches more than100 tied rows without duplicates across insertion and resolution',async()=>{
    const visible=new Set(first.items.map(item=>item.id));
    const unresolved=targets.find(target=>!visible.has(target.item.id));
    await f.action('manual',unresolved.event,unresolved.item);
    const newTarget=await f.invoice();await f.candidateReview(newTarget);
    const newEvent=(await f.events(newTarget))[0];const newItem=(await f.deliveries(newEvent))[0];
    await f.settle(newItem.id,'unknown');
    const all=[...first.items];let cursor=first.nextCursor;let hasMore=true;
    for(let count=0;hasMore && count<20;count++) {
      const page=await f.page({family:'invoice_rejected',state:'unknown',limit:25,cursor});
      assert.ok(page.items.length<=25);all.push(...page.items);cursor=page.nextCursor;hasMore=page.hasMore;
    }
    assert.equal(hasMore,false);assert.equal(cursor,null);
    const ids=all.map(item=>item.id);assert.equal(new Set(ids).size,ids.length);
    assert.ok(!ids.includes(newItem.id),'Insertion after snapshot does not enter continuation');
    assert.ok(!ids.includes(unresolved.item.id),'Resolved unseen event is removed before subsequent page');
    for(const target of targets)if(target.item.id!==unresolved.item.id)assert.ok(ids.includes(target.item.id),'Every still-unresolved original event is reachable');
    assert.ok((await f.page({family:'invoice_rejected',state:'unknown',limit:25})).items.some(item=>item.id===newItem.id),'Refresh includes inserted event');
  });
  await check('cursor filter/search/invoice binding and malformed cursor rejection are deterministic',async()=>{
    const cursor=first.nextCursor;
    const corrupt=[[],{},'not-a-cursor',{...cursor,version:2},{...cursor,id:'invalid'},
      {...cursor,createdAt:'infinity'},{...cursor,snapshotAt:'2099-01-01T00:00:00Z'},
      {...cursor,unexpected:'value'},{...cursor,search:'changed'},{...cursor,family:'payment_hold_placed'}];
    const absent={...cursor};delete absent.snapshotAt;corrupt.push(absent);
    for(const value of corrupt)await f.denied(()=>f.page({family:'invoice_rejected',state:'unknown',cursor:value}),['PT422']);
    await f.denied(()=>f.page({family:'invoice_rejected',state:'failed',cursor}),['PT422']);
    await f.denied(()=>f.page({family:'invoice_rejected',state:'unknown',search:'changed',cursor}),['PT422']);
    await f.denied(()=>f.status(targets[0].target,cursor),['PT422']);
    await f.denied(()=>f.page({search:'x'.repeat(101)}),['PT422']);
    await f.denied(()=>f.page({family:'arbitrary'}),['PT422']);
    await f.denied(()=>f.page({state:'sent'}),['PT422']);
    const searched=await f.page({search:targets[0].target.workOrderId,state:'unknown'});
    assert.ok(searched.items.every(item=>item.workOrderId===targets[0].target.workOrderId));
    const empty=await f.page({search:'SYNTHETIC-NO-MATCH'});
    assert.deepEqual(empty.items,[]);assert.equal(empty.hasMore,false);assert.equal(empty.nextCursor,null);
  });
  await check('bounded attempt history exposes immutable unknown and explicit evidence with tamper-resistant continuation',async()=>{
    const sample=targets.find(target=>target.item.id!==first.items[0].id);
    const firstPage=await f.history(sample.event,null,2);
    assert.equal(firstPage.items.length,2);assert.equal(firstPage.hasMore,true);
    const all=[...firstPage.items];let cursor=firstPage.nextCursor;let more=true;
    for(let index=0;more && index<20;index++) {
      const next=await f.history(sample.event,cursor,2);all.push(...next.items);cursor=next.nextCursor;more=next.hasMore;
    }
    assert.equal(more,false);assert.equal(new Set(all.map(item=>item.id)).size,all.length);
    assert.ok(all.some(item=>item.kind==='attempt' && item.state==='unknown'));
    assert.ok(all.every(item=>!Object.hasOwn(item,'recipientEmail') && !Object.hasOwn(item,'providerReference')));
    for(const value of [{},[],{...firstPage.nextCursor,eventId:targets.at(-1).event.id},{...firstPage.nextCursor,id:'arbitrary'},
      {...firstPage.nextCursor,unexpected:'value'}])await f.denied(()=>f.history(sample.event,value,2),['PT422']);
    for(const limit of [0,51])await f.denied(()=>f.history(sample.event,null,limit),['PT422']);
  });
}
