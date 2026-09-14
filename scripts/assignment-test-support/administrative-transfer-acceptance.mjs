import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { administrativeTransferFixtures,ADMINISTRATIVE_TRANSFER_EVENT,TRANSFER_REASON } from './administrative-transfer-fixtures.mjs';

export async function verifyAdministrativeTransfers(fixture,check) {
  const f=administrativeTransferFixtures(fixture);
  const { db,actors,activeWorkOrder,context,command,reject,snapshot,parent,transfer,visit,events,freshVisit,lifecycle,as }=f;
  for(const target of ['reassign','unassign']) {
    await check(`normal ${target} with an active visit fails atomically until contractor checkout`,async()=>{
      const { id }=await activeWorkOrder();const args=await context(id);const before=await snapshot();
      const next=target==='reassign'?actors.outsider:null;
      await reject(()=>command('transition',actors.mgr,args,next),['PT409']);
      await reject(()=>as('authenticated',actors.mgr,tx=>tx.query('select public.transition_work_order_contractor($1,$2,$3)',[id,next,args[1]])),['PT409']);
      assert.deepEqual(await snapshot(),before);
      await lifecycle.command('pause',actors.contractor,await lifecycle.context(id));
      const result=await command('transition',actors.mgr,await context(id),next);
      assert.equal(result.applied,true);
      assert.equal((await db.query('select count(*)::int count from public.work_order_visits where work_order_id=$1 and check_out_at is null',[id])).rows[0].count,0);
      assert.equal((await events(id)).filter(row=>row.event_key===ADMINISTRATIVE_TRANSFER_EVENT).length,0);
    });
  }
  for(const actorName of ['mgr','dispatcher','backOffice','handoff']) {
    await check(`${actorName} explicit administrative transfer preserves WIP and creates honest review-required evidence`,async()=>{
      const { id,visit:original }=await activeWorkOrder();const args=await context(id);
      const beforeClock=Date.now();const result=await transfer(args,actors.outsider,`  ${TRANSFER_REASON}  `,true,actors[actorName]);
      const afterClock=Date.now();const closed=await visit(original.id);const row=await parent(id);const evidence=await events(id);
      assert.equal(result.applied,true);assert.equal(result.administrativeClosedVisitId,original.id);
      assert.equal(result.durationReviewRequired,true);
      assert.equal(result.receivingVisitRequired,true);
      assert.equal(row.status,'wip');assert.equal(row.functional_status,'Work in Progress');
      assert.equal(row.assignment_transfer_pending_visit,true);assert.equal(row.assignment_transfer_operation_id,args[4]);
      assert.equal(row.contractor_id,actors.outsider);assert.equal(row.contractor_assignment_version,args[1]+1);
      assert.equal(closed.contractor_id,actors.contractor);assert.equal(closed.checked_in_by,actors.contractor);
      assert.equal(closed.checked_out_by,actors[actorName]);assert.equal(closed.check_out_activity_id,result.administrativeClosureActivityId);
      assert.equal(closed.closure_kind,'administrative_transfer');assert.equal(closed.duration_review_required,true);
      assert.equal(closed.administrative_closed_by,actors[actorName]);assert.equal(closed.administrative_close_reason,TRANSFER_REASON);
      assert.equal(closed.administrative_transfer_operation_id,args[4]);
      assert.equal(closed.check_out_at.toISOString(),closed.administrative_closed_at.toISOString());
      assert.ok(closed.check_out_at.getTime()>=beforeClock-1&&closed.check_out_at.getTime()<=afterClock+1);
      assert.equal(new Date(result.administrativeClosedAt).toISOString(),closed.administrative_closed_at.toISOString());
      const administrative=evidence.filter(event=>event.event_key===ADMINISTRATIVE_TRANSFER_EVENT);
      assert.equal(administrative.length,1);assert.equal(administrative[0].id,result.administrativeClosureActivityId);
      assert.equal(administrative[0].author_id,actors[actorName]);assert.equal(administrative[0].administrative_transfer_operation_id,args[4]);
      assert.equal(administrative[0].assignment_operation_id,null,'Distinct transfer evidence must not impersonate the normal assignment event');
      assert.ok(JSON.stringify(administrative[0].event_data).includes(TRANSFER_REASON));
      assert.equal(evidence.filter(event=>event.event_key==='check_out').length,0,'Administrative closure is not contractor checkout');
      assert.equal(evidence.filter(event=>event.event_key==='job_paused').length,0,'Administrative closure does not invent parts/contractor pause');
      assert.equal(evidence.filter(event=>event.event_key==='job_completed').length,0);
      assert.ok(result.deliveryId);assert.equal(evidence.filter(event=>event.event_key==='work_order_reassigned').length,1);
      assert.equal((await db.query('select count(*)::int count from public.work_order_visits where work_order_id=$1 and check_out_at is null',[id])).rows[0].count,0);
    });
  }
  for(const kind of ['start','resume']) {
    await check(`receiving contractor ${kind} creates its own continuation visit after administrative transfer`,async()=>{
      const { id,visit:original }=await activeWorkOrder();await transfer(await context(id));
      const before=await snapshot();await reject(()=>freshVisit(kind,actors.contractor,id),['42501']);assert.deepEqual(await snapshot(),before);
      const result=await freshVisit(kind,actors.outsider,id);const current=await visit(result.visitId);
      assert.notEqual(current.id,original.id);assert.equal(current.contractor_id,actors.outsider);assert.equal(current.checked_in_by,actors.outsider);
      assert.equal(current.check_out_at,null);assert.equal(current.duration_review_required,false);assert.equal(current.closure_kind,null);
      assert.equal((await visit(original.id)).duration_review_required,true);
      assert.equal((await parent(id)).functional_status,'Work in Progress');
      assert.equal((await parent(id)).assignment_transfer_pending_visit,false);
    });
  }
  await check('administrative unassignment and later assignment preserve started state without automatic receiving visit',async()=>{
    const { id,visit:original }=await activeWorkOrder();await transfer(await context(id),null);
    let row=await parent(id);assert.equal(row.contractor_id,null);assert.equal(row.functional_status,'Work in Progress');
    assert.notEqual(row.status,'unassigned','Started work cannot be rewound to the New/unassigned workflow');
    await command('transition',actors.mgr,await context(id),actors.outsider);row=await parent(id);
    assert.equal(row.status,'wip');assert.equal(row.functional_status,'Work in Progress');
    assert.equal((await db.query('select count(*)::int count from public.work_order_visits where work_order_id=$1 and check_out_at is null',[id])).rows[0].count,0);
    const started=await freshVisit('resume',actors.outsider,id);assert.notEqual(started.visitId,original.id);
  });
  await check('administrative transfer replay binds target, actor, reason, confirmation, family and expected versions',async()=>{
    const { id }=await activeWorkOrder();const args=await context(id);const first=await transfer(args);const after=await snapshot();
    const replay=await transfer(args);assert.equal(replay.reason,'already_applied');assert.equal(replay.administrativeClosedVisitId,first.administrativeClosedVisitId);
    assert.equal(replay.administrativeClosedAt,first.administrativeClosedAt);assert.equal(replay.deliveryId,first.deliveryId);
    assert.deepEqual(await snapshot(),after);
    for(const run of [()=>transfer(args,null),()=>transfer(args,actors.outsider,'Changed synthetic reason'),
      ()=>transfer(args,actors.outsider,TRANSFER_REASON,false),()=>transfer(args,actors.outsider,TRANSFER_REASON,true,actors.dispatcher),
      ()=>command('transition',actors.mgr,args,actors.outsider)]) await reject(run);
    const { id:other }=await activeWorkOrder();const current=await snapshot();await reject(()=>transfer([other,...args.slice(1)]));
    assert.deepEqual(await snapshot(),current);
    await reject(()=>transfer([...args.slice(0,4),randomUUID()]));
  });
  for(const staleIndex of [1,2,3]) {
    await check(`administrative transfer rejects stale concurrency token ${staleIndex} with no writes`,async()=>{
      const { id }=await activeWorkOrder();const args=await context(id);args[staleIndex]+=1;const before=await snapshot();
      await reject(()=>transfer(args),['PT409']);assert.deepEqual(await snapshot(),before);
    });
  }
  await check('later receiving lifecycle activity makes old administrative replay conflict without rewriting history',async()=>{
    const { id }=await activeWorkOrder();const args=await context(id);await transfer(args);await freshVisit('start',actors.outsider,id);
    const before=await snapshot();await reject(()=>transfer(args),['PT409']);assert.deepEqual(await snapshot(),before);
  });
  for(const terminal of ['sent','unknown']) {
    await check(`administrative transfer replay preserves outgoing ${terminal} delivery and does not repeat administrative closure`,async()=>{
      const { id,visit:original }=await activeWorkOrder();const args=await context(id);const first=await transfer(args);
      const initial=(await db.query('select * from public.contractor_assignment_transition_deliveries where id=$1',[first.deliveryId])).rows[0];
      assert.equal(initial.outgoing_contractor_id,actors.contractor);assert.equal(initial.outgoing_assignment_version,args[1]);
      const claim=(await as('service_role',null,tx=>tx.query('select public.claim_contractor_assignment_transition_delivery($1,$2) result',
        [first.deliveryId,actors.mgr]))).rows[0].result;
      assert.equal(claim.claimStatus,'new_claim');assert.equal(Object.hasOwn(claim,'receivingContractorId'),false);
      await as('service_role',null,tx=>tx.query('select public.complete_contractor_assignment_transition_delivery($1,$2,$3)',
        [first.deliveryId,terminal,terminal==='unknown'?'Synthetic ambiguous send':null]));
      const before=await snapshot();const replay=await transfer(args);
      assert.equal(replay.reason,'already_applied');assert.equal(replay.deliveryId,first.deliveryId);assert.equal(replay.deliveryStatus,terminal);
      assert.equal(replay.administrativeClosedVisitId,original.id);assert.equal(replay.administrativeClosedAt,first.administrativeClosedAt);
      assert.deepEqual(await snapshot(),before);
    });
  }
}
