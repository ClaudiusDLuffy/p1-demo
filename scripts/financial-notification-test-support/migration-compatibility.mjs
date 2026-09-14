import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

export async function verifyFinancialExpansionCompatibility(f, check) {
  await check('expansion preserves old-code financial behavior without queuing alongside direct notification sender',async()=>{
    const target=await f.invoice();await f.review(target);
    assert.equal((await f.row(target.id)).state,'rejected');
    assert.equal((await f.events(target)).length,0);
    await f.retract(target);assert.equal((await f.events(target)).length,0);
    await f.hold(target);assert.equal((await f.events(target)).length,0);
    assert.equal((await f.holdEvents(target)).length,1);
    const oldSource=(await f.holdEvents(target))[0].id;
    assert.equal((await f.status(target)).latestHoldSourceEventId,oldSource);
    await f.candidateHold(target,{action:'release',source:oldSource});
    const trackedRelease=(await f.events(target))[0].source_id;
    await f.hold(target);
    const newOldSource=(await f.holdEvents(target)).at(-1).id;
    assert.equal((await f.status(target)).latestHoldSourceEventId,newOldSource);
    await f.denied(()=>f.candidateHold(target,{action:'release',source:trackedRelease}),['PT409']);
    assert.equal((await f.candidateHold(target,{action:'release',source:newOldSource})).applied,true);
  });
}

export async function verifyFinancialContractionCompatibility(f, check) {
  await check('contracted old review/retraction signatures delegate durable intent and preserve result fields',async()=>{
    const target=await f.invoice();const review=await f.review(target);
    assert.equal(review.notificationStatus,'queued');assert.equal((await f.events(target)).length,1);
    await f.retract(target);assert.equal((await f.events(target)).length,2);
    const batch=[await f.invoice(),await f.invoice()];await f.batchReview(batch);
    for(const target of batch)assert.equal((await f.events(target)).length,1);
  });
  await check('contracted old service hold/release delegates bound actor and source event without duplicate no-op intent',async()=>{
    const target=await f.invoice();await f.review(target,'approve');
    assert.equal((await f.hold(target)).notificationStatus,'queued');
    assert.equal((await f.hold(target)).applied,false);assert.equal((await f.events(target)).length,1);
    assert.equal((await f.hold(target,'released')).notificationStatus,'queued');
    assert.equal((await f.hold(target,'released')).applied,false);assert.equal((await f.events(target)).length,2);
    await f.denied(()=>f.as('service_role',f.actors.contractor,tx=>tx.query('select public.place_contractor_invoice_payment_hold($1,$2,$3)',[target.id,f.actors.mgr,'Synthetic forged actor'])),['42501']);
  });
  await check('prior financial revise and delete commands preserve protected evidence against final schema',async()=>{
    const target=await f.invoice();await f.candidateReview(target);
    const event=(await f.events(target))[0];
    const result=await f.financial.command('revise',f.actors.contractor,await f.financial.context(target.workOrderId,target.id),f.financial.payload({num:target.row.num}));
    assert.equal(result.invoiceId,target.id);
    assert.ok((await f.row(target.id)).review_revision>target.row.review_revision);
    assert.deepEqual((await f.events(target))[0],event);
    const workOrderId=await f.financial.workOrder();
    const draft=await f.financial.command('draft',f.actors.contractor,await f.financial.context(workOrderId),f.financial.payload());
    const context=await f.financial.context(workOrderId,draft.invoiceId);
    await f.as('authenticated',f.actors.contractor,tx=>tx.query('select public.delete_own_contractor_invoice_v1($1,$2,$3,$4,$5,$6)',context));
    assert.ok((await f.row(draft.invoiceId)).deleted_at);
  });
  await check('same-transaction hold/release/rehold with tied source timestamps uses monotonic causal source identity',async()=>{
    const target=await f.invoice();await f.candidateReview(target,{action:'approve'});
    const sources=await f.as('authenticated',f.actors.handoff,async tx=>{
      const ids=[];let previous=null;
      for(const action of ['place','release','place']) {
        const result=(await tx.query('select public.set_contractor_invoice_payment_hold_with_notification_v1($1,$2,$3,$4,$5) result',
          [target.id,action,'Synthetic tied-timestamp event',randomUUID(),previous])).rows[0].result;
        previous=result.notifications[0].sourceEventId;ids.push(previous);
      }
      return ids;
    });
    const events=await f.events(target);assert.equal(events.length,3);
    const ordered=[...events].sort((left,right)=>Number(left.event_sequence)-Number(right.event_sequence));
    assert.deepEqual(ordered.map(event=>event.source_id),sources);
    const holdSources=await f.holdEvents(target);
    assert.equal(new Set(holdSources.map(event=>new Date(event.created_at).toISOString())).size,1,'Historical hold source now() is transaction-stable');
    assert.equal((await f.status(target)).latestHoldSourceEventId,sources[2]);
    await f.denied(()=>f.candidateHold(target,{action:'release',source:sources[0]}),['PT409']);
    assert.equal((await f.candidateHold(target,{action:'release',source:sources[2]})).applied,true);
  });
  await check('contraction reserves review source evidence and raw hold/event mutations for both browser and service',async()=>{
    const target=await f.invoice();await f.candidateReview(target);
    const source=(await f.activity(target,'invoice_rejected'))[0];
    for(const role of ['authenticated','service_role']) {
      const actor=role==='authenticated'?f.actors.mgr:null;
      await f.denied(()=>f.as(role,actor,tx=>tx.query('update public.activities set text=$2 where id=$1 returning id',[source.id,'Forged synthetic source'])),['42501']);
      await f.denied(()=>f.as(role,actor,tx=>tx.query(`insert into public.activities(work_order_id,author_id,author_name,event_key,event_data,text)
        values($1,$2,'Synthetic staff','invoice_rejected',$3,'Forged synthetic source')`,[target.workOrderId,f.actors.mgr,JSON.stringify({invoiceId:target.id,revision:target.row.review_revision})])),['42501']);
      for(const table of ['contractor_invoice_payment_holds','contractor_invoice_payment_hold_events']) {
        for(const sql of [`insert into public.${table} default values`,`delete from public.${table}`,`truncate public.${table}`]) {
          await f.denied(()=>f.as(role,actor,tx=>tx.query(sql)),['42501']);
        }
      }
    }
  });
  await check('service table grants cannot bypass command-owned delivery and immutable history guards',async()=>{
    const target=await f.invoice();await f.candidateReview(target);
    const event=(await f.events(target))[0];const item=(await f.deliveries(event))[0];
    await f.db.exec('grant select,update,delete on public.financial_notification_deliveries,public.financial_notification_events to service_role');
    try {
      await f.denied(()=>f.as('service_role',null,tx=>tx.query("update public.financial_notification_deliveries set state='unknown' where id=$1",[item.id])),['42501']);
      await f.denied(()=>f.as('service_role',null,tx=>tx.query('delete from public.financial_notification_deliveries where id=$1',[item.id])),['42501']);
      await f.denied(()=>f.as('service_role',null,tx=>tx.query('update public.financial_notification_events set actor_id=$2 where id=$1',[event.id,f.actors.dispatcher])),['42501']);
    } finally {await f.db.exec('revoke select,update,delete on public.financial_notification_deliveries,public.financial_notification_events from service_role');}
  });
  await check('read-only financial audit executes inside enforced read-only transaction without payload exposure',async()=>{
    const audit=readFileSync(fileURLToPath(new URL('../../supabase/audits/0137_financial_notification_integrity_verification.sql',import.meta.url)),'utf8');
    const started=performance.now();
    await f.db.transaction(async tx=>{await tx.exec('set transaction read only');await tx.exec(audit);});
    console.log(`MEASURE financial integrity audit ${(performance.now()-started).toFixed(2)}ms; disposable synthetic PGlite only`);
  });
}
