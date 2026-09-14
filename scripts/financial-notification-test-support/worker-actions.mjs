import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { failWrite, ownerFixtureUpdate } from './candidate-fixtures.mjs';

export async function verifyFinancialNotificationWorkerActions(f, check) {
  const make = async () => {
    const target = await f.invoice();
    await f.candidateReview(target);
    const event = (await f.events(target))[0];
    return { target,event,item:(await f.deliveries(event))[0] };
  };
  await f.settle();
  await check('unknown outcome is terminal to automatic worker; explicit resend creates child with immutable original and replay', async () => {
    const {target,event,item} = await make();
    await f.settle(item.id,'unknown');
    const original = await f.delivery(item.id);
    assert.equal(original.state,'unknown');
    assert.equal((await f.claim()).rows.length,0);
    const operation = randomUUID();
    const result = await f.action('resend',event,item,{operation});
    assert.equal(result.status,'queued');
    assert.equal(result.deliveryCount,1);
    assert.notEqual(result.deliveryId,item.id);
    const child = await f.delivery(result.deliveryId);
    assert.equal(child.parent_delivery_id,item.id);
    assert.equal(child.root_delivery_id,item.id);
    assert.equal(child.state,'pending');
    assert.deepEqual(await f.delivery(item.id),original);
    const replay = await f.action('resend',event,item,{operation});
    assert.equal(replay.replayed,true);
    assert.equal(replay.deliveryId,result.deliveryId);
    for (const changed of [{reason:'Different synthetic reason'},{actor:f.actors.dispatcher}]) {
      await f.denied(()=>f.action('resend',event,item,{operation,...changed}),['PT409']);
    }
    await f.denied(()=>f.action('manual',event,item,{operation}),['PT409']);
    await f.denied(()=>f.action('resend',event,item),['PT409']);
    assert.equal((await f.status(target)).items[0].id,child.id);
    assert.equal((await f.status(target)).items[0].state,'pending');
    const history = await f.history(event);
    assert.ok(history.items.some(row=>row.kind==='resend' && row.reason==='Synthetic reasoned operator contact'));
    assert.ok(history.items.some(row=>row.kind==='attempt' && row.state==='unknown'));
    await f.settle();
    assert.equal((await f.delivery(child.id)).state,'sent');
    assert.deepEqual(await f.delivery(item.id),original);
  });
  await check('manual reconciliation stores separate actor/reason/time and preserves original unknown outcome', async () => {
    const {target,event,item} = await make();
    await f.settle(item.id,'unknown');
    const original = await f.delivery(item.id);
    const operation = randomUUID();
    const result = await f.action('manual',event,item,{operation});
    assert.equal(result.status,'manually_resolved');
    assert.equal(result.deliveryId,item.id);
    assert.deepEqual(await f.delivery(item.id),original);
    const stored = (await f.db.query('select * from public.financial_notification_operations where operation_id=$1',[operation])).rows[0];
    assert.equal(stored.action,'manual_resolution');
    assert.equal(stored.actor_id,f.actors.mgr);
    assert.equal(stored.reason,'Synthetic reasoned operator contact');
    assert.ok(stored.created_at);
    assert.equal((await f.status(target)).items[0].state,'manually_resolved');
    assert.equal((await f.status(target)).items[0].canResend,false);
    assert.equal((await f.action('manual',event,item,{operation})).replayed,true);
    await f.denied(()=>f.action('manual',event,item,{operation,reason:'Changed reason'}),['PT409']);
    await f.denied(()=>f.action('resend',event,item),['PT409']);
    assert.equal((await f.claim()).rows.length,0);
    const history = await f.history(event);
    assert.ok(history.items.some(row=>row.kind==='manual_resolution' && row.state==='manually_resolved'));
    assert.ok(history.items.some(row=>row.kind==='attempt' && row.state==='unknown'));
  });
  for (const state of ['pending','claimed','sending','sent']) {
    await check(`${state} deliveries cannot be manually resolved or explicitly resent`, async () => {
      const {event,item} = await make();
      let claim;
      if (state!=='pending') claim=await f.claim();
      if (state==='sending' || state==='sent') await f.prepare(item.id,claim.token);
      if (state==='sent') await f.complete(item.id,claim.token,'sent');
      for (const action of ['resend','manual']) await f.denied(()=>f.action(action,event,item),['PT409']);
      if (state==='claimed') await f.prepare(item.id,claim.token);
      if (state==='claimed'||state==='sending') await f.complete(item.id,claim.token,'sent');
      if (state==='pending') await f.settle();
    });
  }
  await check('stale event, changed recipient and missing address block explicit resend; reason bounds validated', async () => {
    const {target,event,item}=await make();
    await f.settle(item.id,'unknown');
    for (const reason of ['', ' ', 'x'.repeat(501)]) await f.denied(()=>f.action('resend',event,item,{reason}),['PT422']);
    const original=(await f.db.query('select * from public.profiles where id=$1',[f.actors.contractor])).rows[0];
    try {
      await ownerFixtureUpdate(f.db,'profiles','update public.profiles set active=false where id=$1',[f.actors.contractor]);
      await f.denied(()=>f.action('resend',event,item),['PT409']);
      await ownerFixtureUpdate(f.db,'profiles',"update public.profiles set active=true,email='' where id=$1",[f.actors.contractor]);
      await f.denied(()=>f.action('resend',event,item),['PT409']);
    } finally { await ownerFixtureUpdate(f.db,'profiles','update public.profiles set active=$2,email=$3 where id=$1',[f.actors.contractor,original.active,original.email]); }
    await f.candidateRetract(target);
    await f.denied(()=>f.action('resend',event,item),['PT409']);
    await f.denied(()=>f.action('manual',event,item),['PT409']);
    await f.settle();
  });
  for (const kind of ['resend','manual']) {
    for (const table of kind==='resend' ? ['financial_notification_deliveries','financial_notification_operations'] : ['financial_notification_operations']) {
      await check(`${kind} ${table} injected write failure preserves source, attempts and operation atomicity`,async()=>{
        const {target,event,item}=await make();
        await f.settle(item.id,'unknown');
        const before=await f.snapshot(target);
        const operation=randomUUID();
        await failWrite(f.db,table,async()=>{ await f.denied(()=>f.action(kind,event,item,{operation}),['P0001']); });
        assert.deepEqual(await f.snapshot(target),before);
        assert.equal((await f.action(kind,event,item,{operation})).status,kind==='resend'?'queued':'manually_resolved');
        await f.settle();
      });
    }
  }
  await check('overlapping claims have disjoint ownership and stale claim token cannot prepare/complete',async()=>{
    const targets=[await make(),await make()];
    const first=await f.claim(1);const second=await f.claim(1);
    assert.equal(first.rows.length,1);assert.equal(second.rows.length,1);
    assert.notEqual(first.rows[0].id,second.rows[0].id);
    assert.equal(await f.prepare(first.rows[0].id,second.token),null);
    await f.denied(()=>f.complete(first.rows[0].id,second.token,'sent'),['PT409']);
    await f.denied(()=>f.complete(first.rows[0].id,first.token,'sent'),['PT409']);
    for (const claim of [first,second]) { await f.prepare(claim.rows[0].id,claim.token);await f.complete(claim.rows[0].id,claim.token,'sent'); }
    assert.ok(targets.every(target=>[first.rows[0].id,second.rows[0].id].includes(target.item.id)));
  });
  await check('expired pre-send claim is reclaimed, expired started claim becomes unknown and never auto-reclaims',async()=>{
    const first=await make();let claim=await f.claim(1);
    await ownerFixtureUpdate(f.db,'financial_notification_deliveries',"update public.financial_notification_deliveries set claim_expires_at=clock_timestamp()-interval '1 second' where id=$1",[first.item.id]);
    const reclaimed=await f.claim(1);
    assert.equal(reclaimed.summary.recoveredBeforeSend,1);
    assert.equal(reclaimed.rows[0].id,first.item.id);
    assert.notEqual(reclaimed.token,claim.token);
    assert.equal((await f.delivery(first.item.id)).attempt_count,2);
    await f.prepare(first.item.id,reclaimed.token);await f.complete(first.item.id,reclaimed.token,'sent');
    const second=await make();claim=await f.claim(1);await f.prepare(second.item.id,claim.token);
    await ownerFixtureUpdate(f.db,'financial_notification_deliveries',"update public.financial_notification_deliveries set claim_expires_at=clock_timestamp()-interval '1 second' where id=$1",[second.item.id]);
    const recovery=await f.claim();assert.equal(recovery.rows.length,0);assert.equal(recovery.summary.recoveredUnknown,1);
    assert.equal((await f.delivery(second.item.id)).state,'unknown');
    await f.denied(()=>f.complete(second.item.id,claim.token,'sent'),['PT409']);
    const journal=(await f.db.query('select * from public.financial_notification_attempt_events where delivery_id=$1 order by created_at,id',[second.item.id])).rows;
    assert.ok(journal.some(row=>row.phase==='sending'));
    assert.ok(journal.some(row=>row.phase==='claim_expired' && row.state==='unknown'));
  });
  await check('completion is idempotent and ambiguous HTTP outcomes cannot masquerade as automatically retryable failure',async()=>{
    const {item}=await make();const claim=await f.claim();await f.prepare(item.id,claim.token);
    for (const [code,status] of [['GRAPH_OUTCOME_UNKNOWN',null],['GRAPH_SEND_FAILED',408],['GRAPH_SEND_FAILED',500],['GRAPH_SEND_FAILED',503]]) {
      await f.denied(()=>f.complete(item.id,claim.token,'failed',code,status),['PT422']);
    }
    const result=await f.complete(item.id,claim.token,'unknown','GRAPH_OUTCOME_UNKNOWN');
    assert.equal(result.state,'unknown');
    assert.equal((await f.complete(item.id,claim.token,'unknown','GRAPH_OUTCOME_UNKNOWN')).replayed,true);
    await f.denied(()=>f.complete(item.id,claim.token,'sent'),['PT409']);
    assert.equal((await f.claim()).rows.length,0);
  });
  await check('known-unsent retry uses delay and cap, never a tight or infinite retry',async()=>{
    const {target,item}=await make();
    for (let attempt=1;attempt<=3;attempt++) {
      const claim=await f.claim(1);assert.equal(claim.rows[0].id,item.id);await f.prepare(item.id,claim.token);
      await f.complete(item.id,claim.token,'failed','GRAPH_RATE_LIMITED',429,600);
      const row=await f.delivery(item.id);assert.equal(row.attempt_count,attempt);
      assert.ok(new Date(row.next_attempt_at).getTime()-Date.now()>590_000);
      assert.equal((await f.claim()).rows.length,0);
      const status=(await f.status(target)).items[0];assert.equal(status.canResend,attempt===3);
      if(attempt<3) await ownerFixtureUpdate(f.db,'financial_notification_deliveries',"update public.financial_notification_deliveries set next_attempt_at=clock_timestamp()-interval '1 second' where id=$1",[item.id]);
    }
    const attempts=(await f.db.query("select count(*)::int n from public.financial_notification_attempt_events where delivery_id=$1 and phase='completed'",[item.id])).rows[0].n;
    assert.equal(attempts,3);
  });
  await check('one delivery cannot reuse an old claim token on a later retry attempt',async()=>{
    const {item}=await make();const first=await f.claim(1);await f.prepare(item.id,first.token);
    await f.complete(item.id,first.token,'failed','GRAPH_RATE_LIMITED',429);
    await ownerFixtureUpdate(f.db,'financial_notification_deliveries',"update public.financial_notification_deliveries set next_attempt_at=clock_timestamp()-interval '1 second' where id=$1",[item.id]);
    const original=await f.delivery(item.id);
    await f.denied(()=>f.claim(1,first.token),['23505']);
    assert.deepEqual(await f.delivery(item.id),original);
    const next=await f.claim(1);assert.equal(next.rows[0].id,item.id);await f.prepare(item.id,next.token);await f.complete(item.id,next.token,'sent');
  });
  await check('provider acceptance followed by completion-write loss preserves sending until lease recovery quarantines unknown',async()=>{
    const {item}=await make();const claim=await f.claim(1);await f.prepare(item.id,claim.token);
    await failWrite(f.db,'financial_notification_attempt_events',async()=>{await f.denied(()=>f.complete(item.id,claim.token,'sent'),['P0001']);});
    assert.equal((await f.delivery(item.id)).state,'sending');
    await ownerFixtureUpdate(f.db,'financial_notification_deliveries',"update public.financial_notification_deliveries set claim_expires_at=clock_timestamp()-interval '1 second' where id=$1",[item.id]);
    assert.equal((await f.claim()).rows.length,0);
    assert.equal((await f.delivery(item.id)).state,'unknown');
  });
  await check('claim batch, lease and provider-record bounds reject oversized requests safely',async()=>{
    for (const limit of [0,26,1000]) await f.denied(()=>f.claim(limit),['PT422']);
    for (const lease of [0,301]) await f.denied(()=>f.claim(1,randomUUID(),lease),['PT422']);
    await f.denied(()=>f.claim(1,null),['PT422']);
    await f.denied(()=>f.prepare(null,randomUUID()),['PT422']);
    await f.denied(()=>f.complete(randomUUID(),randomUUID(),'failed','Contains raw error!'),['PT422']);
  });
  await check('approved latest-effective hold policy supersedes pending historical notices and sends only the current source',async()=>{
    await f.settle();
    const target=await f.invoice();await f.candidateReview(target,{action:'approve'});
    await f.candidateHold(target);let source=(await f.status(target)).latestHoldSourceEventId;
    await f.candidateHold(target,{action:'release',source});source=(await f.status(target)).latestHoldSourceEventId;
    await f.candidateHold(target,{source});
    const events=await f.events(target);const first=await f.deliveries(events[0]);
    const release=await f.deliveries(events[1]);const latest=await f.deliveries(events[2]);
    assert.ok(first.every(row=>row.state==='superseded'));
    assert.ok(release.every(row=>row.state==='superseded'));
    const claimed=await f.claim();
    assert.deepEqual(new Set(claimed.rows.map(row=>row.id)),new Set(latest.map(row=>row.id)));
    for(const row of claimed.rows){await f.prepare(row.id,claimed.token);await f.complete(row.id,claimed.token,'unknown','GRAPH_OUTCOME_UNKNOWN');}
    await f.denied(()=>f.action('resend',events[0],first[0]),['PT409']);
    const historical=(await f.status(target)).items.find(item=>item.id===first[0].id);
    assert.equal(historical.canResend,false,'Approved policy forbids resending an obsolete hold source');
    await f.denied(()=>f.action('manual',events[1],release[0]),['42501']);
    await f.denied(()=>f.action('resend',events[1],release[0]),['42501']);
    assert.equal((await f.action('manual',events[2],latest[0])).status,'manually_resolved');
    assert.equal((await f.claim()).rows.length,0,'Current unknown and historical superseded rows never automatically resend');
  });
}
