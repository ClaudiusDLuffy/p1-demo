import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { administrativeTransferFixtures } from './administrative-transfer-fixtures.mjs';

export async function verifyAdministrativeContinuation(fixture,check) {
  const f=administrativeTransferFixtures(fixture);
  const { db,as,actors,activeWorkOrder,context,transfer,reject,snapshot,lifecycle,freshVisit,rawDenied,visit }=f;
  await check('pending receiving work cannot pause or complete before its new contractor opens a visit',async()=>{
    const { id }=await activeWorkOrder();await transfer(await context(id));const before=await snapshot();
    for(const kind of ['pause','complete']) {
      const args=await lifecycle.context(id);
      await reject(()=>lifecycle.command(kind,actors.outsider,args),['PT409']);assert.deepEqual(await snapshot(),before);
    }
    assert.equal((await freshVisit('start',actors.outsider,id)).applied,true);
  });
  await check('pending receiving work cannot be moved to ready-for-billing before the new visit',async()=>{
    const { id }=await activeWorkOrder();await transfer(await context(id));const args=await context(id);const before=await snapshot();
    await reject(()=>as('authenticated',actors.mgr,tx=>tx.query('select public.mark_work_order_ready_for_billing_v1($1,$2,$3,$4,$5)',args)),['PT409']);
    assert.deepEqual(await snapshot(),before);
    assert.equal((await db.query('select count(*)::int count from public.work_order_billing_operations where work_order_id=$1',[id])).rows[0].count,0);
  });
  await check('receiving check-in cannot be backdated before the transfer assignment boundary',async()=>{
    const { id,visit:original }=await activeWorkOrder();await transfer(await context(id));const before=await snapshot();
    for(const kind of ['start','resume']) {
      const args=await lifecycle.context(id);
      await reject(()=>lifecycle.command(kind,actors.outsider,args,[original.check_in_at.toISOString(),null]),['PT409']);
    }
    assert.deepEqual(await snapshot(),before);
  });
  await check('receiving company technician access remains current-assignment scoped after administrative transfer',async()=>{
    const { id }=await activeWorkOrder();await transfer(await context(id),actors.canonical);
    await as('authenticated',actors.admin,tx=>tx.query('select public.assign_contractor_technician($1,$2)',[id,actors.report]));
    const before=await snapshot();
    for(const actor of [actors.former,actors.unassigned,actors.invoice,actors.contractor]) {
      await reject(()=>freshVisit('resume',actor,id),['42501']);assert.deepEqual(await snapshot(),before);
    }
    const result=await freshVisit('resume',actors.report,id);const opened=await visit(result.visitId);
    assert.equal(opened.checked_in_by,actors.report);assert.equal(opened.contractor_id,actors.canonical);assert.equal(opened.duration_review_required,false);
  });
  await check('receiving start replay creates one new visit and cannot reuse its operation for resume',async()=>{
    const { id }=await activeWorkOrder();await transfer(await context(id));const args=await lifecycle.context(id);
    const stamp=(await db.query('select clock_timestamp()::text stamp')).rows[0].stamp;const payload=[stamp,'Synthetic replay-safe receiving check-in'];
    const first=await lifecycle.command('start',actors.outsider,args,payload);const after=await snapshot();
    const replay=await lifecycle.command('start',actors.outsider,args,payload);assert.equal(replay.reason,'already_applied');assert.equal(replay.visitId,first.visitId);
    assert.deepEqual(await snapshot(),after);await reject(()=>lifecycle.command('resume',actors.outsider,args,payload),['PT409']);assert.deepEqual(await snapshot(),after);
  });
  await check('raw parent receiving flags cannot impersonate an administrative transfer or authorize lifecycle work',async()=>{
    const { id }=await activeWorkOrder();const args=await context(id);await transfer(args);
    for(const [role,actor] of [['authenticated',actors.mgr],['authenticated',actors.outsider],['service_role',null]]) {
      await rawDenied(actor,'update public.work_orders set assignment_transfer_pending_visit=false where id=$1 returning id',[id],role);
      await rawDenied(actor,'update public.work_orders set assignment_transfer_operation_id=$2 where id=$1 returning id',[id,randomUUID()],role);
      await rawDenied(actor,`insert into public.work_orders(id,status,functional_status,assignment_transfer_pending_visit,assignment_transfer_operation_id)
        values($1,'wip','Work in Progress',true,$2) returning id`,[`WOT-HYBRID-FORGED-${role}`,args[4]],role);
    }
  });
  await check('trusted DO NOT DISPATCH refresh cannot silently unassign active work or leave a stranded visit',async()=>{
    const { id }=await activeWorkOrder();await db.query("update public.work_orders set priority='p4' where id=$1",[id]);
    const before=await snapshot();
    const patch={ summary:'Synthetic DO NOT DISPATCH active visit',billing_only:true,status:'pending_invoice',functional_status:'Completed',contractor_id:null };
    await reject(()=>as('service_role',null,tx=>tx.query('select public.refresh_email_work_order_dispatch($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
      [id,'p4',`<synthetic-hybrid-${id}@example.invalid>`,'2026-09-08T13:00:00Z','7-Eleven Priority P4 DO NOT DISPATCH',null,null,null,patch,null])),['PT409']);
    assert.deepEqual(await snapshot(),before);
    assert.equal((await db.query('select count(*)::int count from public.email_priority_escalation_events where work_order_id=$1',[id])).rows[0].count,0);
  });
  await check('administrative replay checks retained visit evidence and cannot repair a tampered legacy-owner row',async()=>{
    const { id,visit:original }=await activeWorkOrder();const args=await context(id);await transfer(args);
    await db.query("update public.work_order_visits set administrative_close_reason='Synthetic owner-only corruption fixture' where id=$1",[original.id]);
    const before=await snapshot();await reject(()=>transfer(args),['PT409']);assert.deepEqual(await snapshot(),before);
  });
}
