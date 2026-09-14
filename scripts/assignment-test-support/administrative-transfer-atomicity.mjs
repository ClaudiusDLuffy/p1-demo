import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { administrativeTransferFixtures,withAdministrativeTransferFailure,ADMINISTRATIVE_TRANSFER_EVENT } from './administrative-transfer-fixtures.mjs';

export async function verifyAdministrativeTransferAtomicity(fixture,check) {
  const f=administrativeTransferFixtures(fixture);
  const { db,actors,activeWorkOrder,context,transfer,reject,snapshot,command,lifecycle,as,queryTransfer }=f;
  for(const mode of ['reassign','unassign']) {
    const writes=[['work_order_visits','update'],['work_orders','update'],['work_order_assignment_history','insert'],
      ['activities','insert',`new.event_key = '${ADMINISTRATIVE_TRANSFER_EVENT}'`],
      ['activities','insert',`new.event_key = 'work_order_${mode==='reassign'?'reassigned':'unassigned'}'`],
      ['contractor_assignment_transition_deliveries','insert'],['work_order_assignment_operations','insert'],['work_order_assignment_operations','update']];
    for(const [table,operation,condition] of writes) {
      await check(`administrative ${mode} rolls back visit/parent/evidence/delivery/operation after ${table} ${operation} ${condition||''}`,async()=>{
        const { id }=await activeWorkOrder();const args=await context(id);const before=await snapshot();
        await withAdministrativeTransferFailure(db,{ table,operation,condition },()=>reject(
          ()=>transfer(args,mode==='reassign'?actors.outsider:null),['P0001']));
        assert.deepEqual(await snapshot(),before);
      });
    }
  }
  await check('two administrative transfers sharing expected versions cannot close the visit twice or overwrite winner',async()=>{
    const { id }=await activeWorkOrder();const first=await context(id);const second=[...first.slice(0,4),randomUUID()];
    await transfer(first);const after=await snapshot();await reject(()=>transfer(second,null),['PT409']);assert.deepEqual(await snapshot(),after);
  });
  await check('normal checkout wins before stale administrative override without a second closure or transfer',async()=>{
    const { id }=await activeWorkOrder();const stale=await context(id);await lifecycle.command('pause',actors.contractor,await lifecycle.context(id));
    const before=await snapshot();await reject(()=>transfer(stale),['PT409']);assert.deepEqual(await snapshot(),before);
    assert.equal((await command('transition',actors.mgr,await context(id),actors.outsider)).applied,true);
  });
  await check('administrative transfer wins before contractor completion; stale completion cannot update the transferred parent',async()=>{
    const { id }=await activeWorkOrder();const stale=await lifecycle.context(id);await transfer(await context(id));const before=await snapshot();
    await reject(()=>lifecycle.command('complete',actors.contractor,stale),['42501','PT409']);assert.deepEqual(await snapshot(),before);
  });
  await check('administrative capability cannot authorize a subsequent raw visit update in the same transaction',async()=>{
    const { id,visit }=await activeWorkOrder();const args=await context(id);const before=await snapshot();
    await reject(()=>as('authenticated',actors.mgr,async tx=>{
      await queryTransfer(tx,args,actors.outsider);
      await tx.query('update public.work_order_visits set duration_review_required=false where id=$1',[visit.id]);
    }),['42501']);assert.deepEqual(await snapshot(),before);
  });
}
