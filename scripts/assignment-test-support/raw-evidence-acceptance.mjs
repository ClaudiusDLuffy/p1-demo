import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ASSIGNMENT_EVENT_KEYS } from './legacy-reproductions.mjs';

export async function verifyAssignmentRawAndEvidence(fixture,check) {
  const { db,as,actors,workOrder,context,command,snapshot,rawDenied,reject }=fixture;
  const id=await workOrder({ owner:actors.contractor,status:'assigned',functional:'Dispatched' });
  const unassigned=await workOrder();
  for (const actorName of ['mgr','dispatcher','backOffice','handoff','controller','inactive','contractor','admin','report','invoice','unassigned','former','outsider']) {
    await check(`${actorName} raw assignment/archive/version writes cannot bypass commands`,async()=>{
      for (const [sql,values] of [
        ['update public.work_orders set contractor_id=$2 where id=$1 returning id',[id,actors.outsider]],
        ['update public.work_orders set contractor_id=null where id=$1 returning id',[id]],
        ['update public.work_orders set contractor_id=$2 where id=$1 returning id',[unassigned,actors.contractor]],
        ['update public.work_orders set deleted_at=now(),deleted_by=$2 where id=$1 returning id',[id,actors.outsider]],
        ['update public.work_orders set deleted_by=$2 where id=$1 returning id',[id,actors.mgr]],
        ['update public.work_orders set contractor_assignment_version=999 where id=$1 returning id',[id]],
        ["update public.work_orders set contractor_assignment_started_at=now()-interval '1 year' where id=$1 returning id",[id]],
        ["update public.work_orders set dispatched_at=now()-interval '1 year' where id=$1 returning id",[id]],
      ]) await rawDenied(actors[actorName],sql,values);
    });
  }
  await check('deletion author cannot impersonate active, inactive, contractor or nonexistent identity',async()=>{
    for(const author of [actors.mgr,actors.inactive,actors.contractor,randomUUID()]) {
      await rawDenied(actors.mgr,'update public.work_orders set deleted_at=now(),deleted_by=$2 where id=$1 returning id',[id,author]);
    }
  });
  await check('raw physical deletion and forged continuation lineage cannot remove or duplicate work history',async()=>{
    await rawDenied(actors.mgr,'delete from public.work_orders where id=$1 returning id',[id]);
    await rawDenied(null,'delete from public.work_orders where id=$1 returning id',[id],'service_role');
    await rawDenied(actors.mgr,`insert into public.work_orders(id,status,functional_status,duplicated_from_work_order_id,duplicate_root_work_order_id,duplicate_sequence)
      values($1,'unassigned','New',$2,$2,99) returning id`,[`${id}-99`,id]);
  });
  for (const role of ['anon','service_role']) {
    await check(`${role} raw assignment/archive authority is not implicit`,async()=>{
      await rawDenied(null,'update public.work_orders set contractor_id=$2 where id=$1 returning id',[id,actors.outsider],role);
      await rawDenied(null,'update public.work_orders set deleted_at=now(),deleted_by=$2 where id=$1 returning id',[id,actors.mgr],role);
    });
  }
  await check('raw assigned insert rejects every eligible/ineligible target and raw predeleted insert',async()=>{
    for (const [index,target] of [actors.contractor,actors.inactiveContractor,actors.mgr,actors.nonassignable,actors.admin,randomUUID()].entries()) {
      await rawDenied(actors.mgr,`insert into public.work_orders(id,status,functional_status,contractor_id)
        values($1,'assigned','Dispatched',$2) returning id`,[`WOT959990${index}`,target]);
    }
    await rawDenied(actors.mgr,`insert into public.work_orders(id,status,functional_status,deleted_at,deleted_by,nte,nte_flagged,nte_flag_threshold,nte_flag_amount)
      values('WOT9599910','unassigned','New',now(),$1,1000,false,null,null) returning id`,[actors.contractor]);
    await rawDenied(null,`insert into public.work_orders(id,status,functional_status,contractor_id)
      values('WOT9599911','assigned','Dispatched',$1) returning id`,[actors.contractor],'service_role');
  });
  await check('ordinary unassigned creation and non-lifecycle staff edits remain supported',async()=>{
    const newId='WOT9599912';
    await as('authenticated',actors.mgr,tx=>tx.query("insert into public.work_orders(id,status,functional_status,description) values($1,'unassigned','New','Synthetic description')",[newId]));
    const updated=(await as('authenticated',actors.mgr,tx=>tx.query("update public.work_orders set description='Synthetic corrected description' where id=$1 returning description",[newId]))).rows[0];
    assert.equal(updated.description,'Synthetic corrected description');
  });
  for (const event of ASSIGNMENT_EVENT_KEYS) {
    await check(`reserved ${event} cannot be forged or reclassified by staff or contractor`,async()=>{
      for (const actor of [actors.mgr,actors.contractor]) {
        await rawDenied(actor,`insert into public.activities(work_order_id,author_id,author_name,text,type,event_key)
          values($1,$2,'Synthetic caller','Synthetic forgery','note',$3) returning id`,[id,actor,event]);
      }
      const note=(await as('authenticated',actors.mgr,tx=>tx.query(`insert into public.activities(work_order_id,author_id,author_name,text,type)
        values($1,$2,'Synthetic caller','Synthetic ordinary note','note') returning id`,[id,actors.mgr]))).rows[0];
      await rawDenied(actors.mgr,'update public.activities set event_key=$2 where id=$1 returning id',[note.id,event]);
    });
  }
  await check('authoritative assignment evidence cannot be edited, reclassified, soft-deleted or physically deleted',async()=>{
    const target=await workOrder();await command('transition',actors.mgr,await context(target),actors.contractor);
    const event=(await db.query("select id from public.activities where work_order_id=$1 and event_key='work_order_assignment'",[target])).rows[0];
    for (const [sql,values] of [
      ["update public.activities set text='Synthetic replaced evidence' where id=$1 returning id",[event.id]],
      ['update public.activities set author_id=$2 where id=$1 returning id',[event.id,actors.outsider]],
      ['update public.activities set event_key=null where id=$1 returning id',[event.id]],
      ['update public.activities set deleted_at=now() where id=$1 returning id',[event.id]],
      ['delete from public.activities where id=$1 returning id',[event.id]],
    ]) await rawDenied(actors.mgr,sql,values);
  });
  await check('assignment history and outgoing delivery are command-owned and browser-immutable',async()=>{
    const target=await workOrder({ owner:actors.contractor,status:'assigned',functional:'Dispatched' });
    const result=await command('transition',actors.mgr,await context(target),actors.outsider);
    const history=(await db.query('select id from public.work_order_assignment_history where work_order_id=$1',[target])).rows[0];
    await rawDenied(actors.mgr,`insert into public.work_order_assignment_history(work_order_id,contractor_id,assignment_version,assignment_ended_by)
      values($1,$2,999,$3) returning id`,[target,actors.contractor,actors.outsider]);
    await rawDenied(actors.mgr,'update public.work_order_assignment_history set assignment_version=998 where id=$1 returning id',[history.id]);
    await rawDenied(actors.mgr,'delete from public.work_order_assignment_history where id=$1 returning id',[history.id]);
    await rawDenied(actors.mgr,"update public.contractor_assignment_transition_deliveries set status='sent' where id=$1 returning id",[result.deliveryId]);
    await rawDenied(null,"update public.contractor_assignment_transition_deliveries set outgoing_contractor_id=$2 where id=$1 returning id",[result.deliveryId,actors.mgr],'service_role');
  });
  await check('rejected tombstone cannot be restored or assigned by browser or raw service',async()=>{
    const target=await workOrder();await command('reject',actors.mgr,await context(target),'Synthetic pristine reject');
    for (const [role,actor] of [['authenticated',actors.mgr],['service_role',null]]) {
      await rawDenied(actor,'update public.work_orders set deleted_at=null,deleted_by=null where id=$1 returning id',[target],role);
      await rawDenied(actor,'update public.work_orders set contractor_id=$2 where id=$1 returning id',[target,actors.contractor],role);
    }
  });
  await check('private capability and operation tables are inaccessible and a client GUC is not authority',async()=>{
    for (const role of ['anon','authenticated','service_role']) {
      for (const table of ['work_order_assignment_command_guards','work_order_assignment_operations']) {
        await reject(()=>as(role,role === 'authenticated' ? actors.mgr : null,tx=>tx.query(`select * from public.${table}`)),['42501']);
        await reject(()=>as(role,role === 'authenticated' ? actors.mgr : null,tx=>tx.query(`delete from public.${table}`)),['42501']);
      }
      await reject(()=>as(role,role === 'authenticated' ? actors.mgr : null,tx=>tx.query(`
        insert into public.work_order_assignment_command_guards(transaction_id,work_order_id,actor_id,actor_role,command_family,parent_allowed)
        values(txid_current(),$1,$2,$3,'transition',true)`,[id,actors.mgr,role])),['42501']);
    }
    const before=await snapshot();
    await reject(()=>as('authenticated',actors.mgr,async tx=>{
      await tx.exec("select set_config('p1.assignment_authorized','true',true),set_config('app.assignment_command','true',true)");
      await tx.query('update public.work_orders set deleted_at=now(),deleted_by=$2 where id=$1',[id,actors.mgr]);
    }),['42501']);
    assert.deepEqual(await snapshot(),before);
  });
  await check('accepted command cleans its capability before a subsequent same-transaction raw mutation',async()=>{
    const target=await workOrder();const args=await context(target);const before=await snapshot();
    await reject(()=>as('authenticated',actors.mgr,async tx=>{
      await fixture.query(tx,'transition',args,actors.contractor);
      await tx.query('update public.work_orders set deleted_at=now(),deleted_by=$2 where id=$1',[id,actors.mgr]);
    }),['42501']);
    assert.deepEqual(await snapshot(),before,'The enclosing test transaction rolls back its earlier accepted command as well');
  });
}
