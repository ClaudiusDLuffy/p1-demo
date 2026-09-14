import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { administrativeTransferFixtures } from './administrative-transfer-fixtures.mjs';

// Deterministic orderings prove stale-token/transaction behavior, not row-lock
// scheduling across independent PostgreSQL sessions. That remains a release gate.
export async function verifyAssignmentInterleavings(fixture,check) {
  const { db,as,actors,workOrder,context,command,snapshot,reject,financial,lifecycle }=fixture;
  for(const action of ['initial','reassign','unassign']) {
    await check(`two staff ${action} attempts with the same captured version cannot silently overwrite`,async()=>{
      const id=await workOrder(action==='initial'?{}:{ owner:actors.contractor,status:'assigned',functional:'Dispatched' });
      const first=await context(id);const second=[...first.slice(0,4),randomUUID()];
      await command('transition',actors.mgr,first,action==='unassign'?null:actors.outsider);
      const after=await snapshot();
      await reject(()=>command('transition',actors.dispatcher,second,action==='initial'?actors.contractor:null));
      assert.deepEqual(await snapshot(),after);
    });
  }
  for(const first of ['assign','reject']) {
    await check(`${first} wins before the opposing assignment/rejection request; stale loser writes nothing`,async()=>{
      const id=await workOrder();const args=await context(id);const other=[...args.slice(0,4),randomUUID()];
      await command(first==='assign'?'transition':'reject',actors.mgr,args,first==='assign'?actors.contractor:'Synthetic winning rejection');
      const after=await snapshot();
      await reject(()=>command(first==='assign'?'reject':'transition',actors.dispatcher,other,first==='assign'?'Synthetic stale rejection':actors.contractor));
      assert.deepEqual(await snapshot(),after);
    });
  }
  await check('completion accepted before reassignment invalidates the stale assignment command',async()=>{
    const id=await lifecycle.workOrder({ status:'wip',functional:'Work in Progress',visit:true });const args=await context(id);
    await lifecycle.command('complete',actors.contractor,await lifecycle.context(id));const after=await snapshot();
    await reject(()=>command('transition',actors.mgr,args,actors.outsider));assert.deepEqual(await snapshot(),after);
  });
  await check('assignment accepted before completion invalidates old contractor and staff completion snapshots',async()=>{
    const id=await lifecycle.workOrder({ status:'wip',functional:'Work in Progress',visit:true });const args=await lifecycle.context(id);
    await administrativeTransferFixtures(fixture).transfer(await context(id),actors.outsider);const after=await snapshot();
    for(const actor of [actors.contractor,actors.mgr]) await reject(()=>lifecycle.command('complete',actor,args));
    assert.deepEqual(await snapshot(),after);
  });
  for(const first of ['invoice','reject']) {
    await check(`${first} wins before staff invoice creation/rejection; financial history cannot become an archived orphan`,async()=>{
      const id=await workOrder();const assignmentArgs=await context(id);const invoiceArgs=await financial.context(id);
      if(first==='invoice') await financial.staffCommand(actors.mgr,invoiceArgs,financial.staffPayload());
      else await command('reject',actors.mgr,assignmentArgs,'Synthetic rejection before invoice');
      const after=await snapshot();
      if(first==='invoice') await reject(()=>command('reject',actors.mgr,assignmentArgs,'Synthetic stale rejection after invoice'));
      else await reject(()=>financial.staffCommand(actors.mgr,invoiceArgs,financial.staffPayload()));
      assert.deepEqual(await snapshot(),after);
    });
  }
  await check('ordinary staff correction before pristine rejection remains supported; edits after rejection fail safely',async()=>{
    const id=await workOrder();const args=await context(id);
    await as('authenticated',actors.mgr,tx=>tx.query("update public.work_orders set description='Synthetic corrected description' where id=$1",[id]));
    await command('reject',actors.mgr,args,'Synthetic still-pristine rejection');
    await fixture.rawDenied(actors.dispatcher,"update public.work_orders set description='Synthetic stale edit' where id=$1 returning id",[id]);
  });
  await check('inactive canonical company cannot receive an assignment',async()=>{
    const id=await workOrder();const args=await context(id);
    const company=(await db.query('select contractor_organization_id id from public.profiles where id=$1',[actors.canonical])).rows[0].id;
    await db.query('update public.organizations set active=false where id=$1',[company]);
    try { const before=await snapshot();await reject(()=>command('transition',actors.mgr,args,actors.canonical));assert.deepEqual(await snapshot(),before); }
    finally { await db.query('update public.organizations set active=true where id=$1',[company]); }
  });
  await check('clearing JWT role fields cannot turn an actual authenticated/service SQL role into owner maintenance',async()=>{
    const id=await workOrder();const before=await snapshot();
    for(const role of ['authenticated','service_role']) {
      await reject(()=>as(role,actors.mgr,async tx=>{
        await tx.exec("select set_config('request.jwt.claim.role','',true)");
        await tx.query('update public.work_orders set deleted_at=now(),deleted_by=$2 where id=$1',[id,actors.mgr]);
      }),['42501']);
    }
    assert.deepEqual(await snapshot(),before);
  });
}
