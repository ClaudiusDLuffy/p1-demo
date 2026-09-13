import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

export async function verifyAssignmentCommands(fixture,check) {
  const { db,actors,workOrder,context,command,parent,reject,snapshot }=fixture;
  for (const role of ['mgr','dispatcher','backOffice','handoff']) {
    await check(`${role} valid initial assignment, reassignment and unassignment are authoritative`,async()=>{
      const id=await workOrder();
      let version=0;
      for (const target of [actors.contractor,actors.outsider,null]) {
        const result=await command('transition',actors[role],await context(id),target);
        assert.equal(result.applied,true);
        assert.equal(result.assignmentVersion,++version);
        assert.equal((await parent(id)).contractor_id,target);
      }
      assert.equal((await db.query('select count(*)::int count from public.work_order_assignment_history where work_order_id=$1',[id])).rows[0].count,2);
      assert.equal((await db.query('select count(*)::int count from public.contractor_assignment_transition_deliveries where work_order_id=$1',[id])).rows[0].count,2);
      assert.equal((await db.query("select count(*)::int count from public.activities where work_order_id=$1 and event_key in ('work_order_assignment','work_order_reassigned','work_order_unassigned')",[id])).rows[0].count,3);
    });
  }
  await check('canonical active company contractor is assignable; noncanonical company members are not',async()=>{
    const id=await workOrder();
    const result=await command('transition',actors.mgr,await context(id),actors.canonical);
    assert.equal(result.contractorId,actors.canonical);
    for (const target of [actors.admin,actors.report,actors.invoice]) {
      const before=await snapshot();const args=await context(id);
      await reject(()=>command('transition',actors.mgr,args,target));
      assert.deepEqual(await snapshot(),before);
    }
  });
  for (const targetRole of ['inactiveContractor','mgr','controller','nonassignable']) {
    await check(`assignment rejects ${targetRole} target without writes`,async()=>{
      const id=await workOrder();const args=await context(id);const before=await snapshot();
      await reject(()=>command('transition',actors.mgr,args,actors[targetRole]));
      assert.deepEqual(await snapshot(),before);
    });
  }
  await check('nonexistent target and manipulated work-order identity are rejected',async()=>{
    const id=await workOrder();const args=await context(id);const before=await snapshot();
    await reject(()=>command('transition',actors.mgr,args,randomUUID()));
    await reject(()=>command('transition',actors.mgr,['WOT9999999',...args.slice(1)],actors.contractor));
    assert.deepEqual(await snapshot(),before);
  });
  for (const role of ['controller','inactive','contractor','admin','report','invoice','unassigned','former','outsider']) {
    await check(`${role} cannot invoke assignment, rejection or duplicate commands`,async()=>{
      const id=await workOrder();const source=await workOrder({ owner:actors.contractor,status:'assigned',functional:'Dispatched' });
      const args=await context(id);const duplicateArgs=await context(source);const before=await snapshot();
      await reject(()=>command('transition',actors[role],args,actors.outsider));
      await reject(()=>command('reject',actors[role],args,'Synthetic rejection reason'));
      await reject(()=>command('duplicate',actors[role],duplicateArgs));
      assert.deepEqual(await snapshot(),before);
    });
  }
  for (const role of ['anon','service_role']) {
    await check(`${role} has no generic actorless assignment authority`,async()=>{
      const id=await workOrder();const args=await context(id);const before=await snapshot();
      await reject(()=>command('transition',null,args,actors.contractor,role));
      await reject(()=>command('reject',null,args,'Synthetic rejection reason',role));
      await reject(()=>command('duplicate',null,args,null,role));
      assert.deepEqual(await snapshot(),before);
    });
  }
  for (const status of ['completed','pending_invoice','pending_approval','pending_payment','closed']) {
    await check(`assignment rejects ${status} state`,async()=>{
      const id=await workOrder({ owner:actors.contractor,status,functional:'Completed' });const args=await context(id);
      const before=await snapshot();await reject(()=>command('transition',actors.mgr,args,actors.outsider));
      assert.deepEqual(await snapshot(),before);
    });
  }
  await check('assignment same-operation replay preserves one version, event and outgoing delivery',async()=>{
    const id=await workOrder({ owner:actors.contractor,status:'assigned',functional:'Dispatched' });const args=await context(id);
    const first=await command('transition',actors.mgr,args,actors.outsider);const after=await snapshot();
    const replay=await command('transition',actors.mgr,args,actors.outsider);
    assert.equal(replay.reason,'already_applied');assert.equal(replay.assignmentVersion,first.assignmentVersion);
    assert.equal(replay.deliveryId,first.deliveryId);assert.deepEqual(await snapshot(),after);
  });
  await check('operation UUID binds actor, work order, contractor target and command family',async()=>{
    const id=await workOrder();const other=await workOrder();const args=await context(id);
    await command('transition',actors.mgr,args,actors.contractor);const after=await snapshot();
    await reject(()=>command('transition',actors.mgr,args,actors.outsider));
    await reject(()=>command('transition',actors.dispatcher,args,actors.contractor));
    await reject(()=>command('transition',actors.mgr,[other,...args.slice(1)],actors.contractor));
    await reject(()=>command('reject',actors.mgr,args,'Synthetic rejection reason'));
    assert.deepEqual(await snapshot(),after);
  });
  await check('stale assignment and stale lifecycle/workflow context cannot overwrite current state',async()=>{
    const id=await workOrder();const old=await context(id);
    await command('transition',actors.mgr,old,actors.contractor);
    const after=await snapshot();await reject(()=>command('transition',actors.mgr,[...old.slice(0,4),randomUUID()],actors.outsider));
    for (const index of [2,3]) {
      const args=await context(id);args[index]+=1;
      await reject(()=>command('transition',actors.mgr,args,actors.outsider));
    }
    assert.deepEqual(await snapshot(),after);
  });
  await check('replay after later accepted assignment conflicts rather than restoring old parent',async()=>{
    const id=await workOrder();const args=await context(id);
    await command('transition',actors.mgr,args,actors.contractor);
    await command('transition',actors.mgr,await context(id),actors.outsider);const after=await snapshot();
    await reject(()=>command('transition',actors.mgr,args,actors.contractor));assert.deepEqual(await snapshot(),after);
  });
  // Active-visit assignment is covered by the checkout-first / explicit
  // administrative-transfer acceptance module after forward migration 0128.
}
