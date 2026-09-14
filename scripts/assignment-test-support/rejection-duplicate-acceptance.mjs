import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

export async function verifyRejectionAndDuplication(fixture,check) {
  const { db,as,actors,workOrder,context,command,parent,reject,snapshot }=fixture;
  await check('pristine rejection binds actor/reason/version and replays without another event',async()=>{
    const id=await workOrder();const args=await context(id);const reason='Synthetic duplicate dispatch request';
    const first=await command('reject',actors.mgr,args,reason);
    assert.equal(first.applied,true);const row=await parent(id);
    assert.ok(row.deleted_at);assert.equal(row.deleted_by,actors.mgr);
    const events=(await db.query("select author_id,event_data from public.activities where work_order_id=$1 and event_key='work_order_rejected'",[id])).rows;
    assert.equal(events.length,1);assert.equal(events[0].author_id,actors.mgr);
    assert.ok(JSON.stringify(events[0].event_data).includes(reason));
    const after=await snapshot();
    assert.equal((await command('reject',actors.mgr,args,reason)).reason,'already_applied');
    await reject(()=>command('reject',actors.mgr,args,'Different synthetic rejection reason'));
    await reject(()=>command('reject',actors.dispatcher,args,reason));
    assert.deepEqual(await snapshot(),after);
  });
  await check('rejection enforces minimum and maximum reason length',async()=>{
    const id=await workOrder();const args=await context(id);const before=await snapshot();
    for (const reason of ['', ' abc ', 'a'.repeat(501)]) await reject(()=>command('reject',actors.mgr,args,reason),['22023']);
    assert.deepEqual(await snapshot(),before);
    assert.equal((await command('reject',actors.mgr,args,'a'.repeat(500))).applied,true);
  });
  const states=[['assigned','Dispatched'],['wip','Work in Progress'],['parts','Awaiting Parts'],['completed','Completed'],
    ['pending_invoice','Completed'],['pending_approval','Completed'],['pending_payment','Completed'],['capital','New'],['pending_capital_completion','New']];
  for (const [status,functional] of states) {
    await check(`rejection denies ${status} work without archive/evidence writes`,async()=>{
      const id=await workOrder({ status,functional,owner:status === 'capital' ? null : actors.contractor });
      const args=await context(id);const before=await snapshot();
      await reject(()=>command('reject',actors.mgr,args,'Synthetic rejected operational state'));
      assert.deepEqual(await snapshot(),before);
    });
  }
  const histories={
    assignment:async id=>db.query(`insert into public.work_order_assignment_history(work_order_id,contractor_id,assignment_version)
      values($1,$2,1)`,[id,actors.contractor]),
    invoice:async id=>db.query(`insert into public.invoices(work_order_id,contractor_id,invoice_type,num,state,subtotal,total,invoice_date)
      values($1,$2,'staff',$3,'draft',0,0,'2026-09-08')`,[id,actors.mgr,`SYNTHETIC-${id}`]),
    deletedInvoice:async id=>db.query(`insert into public.invoices(work_order_id,contractor_id,invoice_type,num,state,subtotal,total,invoice_date,deleted_at,deleted_by)
      values($1,$2,'staff',$3,'draft',0,0,'2026-09-08',now(),$4)`,[id,actors.mgr,`SYNTHETIC-${id}`,actors.mgr]),
    completion:async id=>db.query(`insert into public.activities(work_order_id,author_id,author_name,text,type,event_key)
      values($1,$2,'Synthetic owner','Synthetic legacy completion','system','job_completed')`,[id,actors.contractor]),
    report:async id=>db.query('insert into public.work_reports(work_order_id,contractor_id) values($1,$2)',[id,actors.contractor]),
    structuredParts:async id=>db.query("insert into public.wo_parts(work_order_id,description) values($1,'Synthetic historical motor')",[id]),
    estimate:async id=>db.query(`insert into public.contractor_estimates(work_order_id,contractor_id,contractor_assignment_version,created_by,updated_by)
      values($1,$2,0,$3,$3)`,[id,actors.contractor,actors.mgr]),
  };
  for (const [name,prepare] of Object.entries(histories)) {
    await check(`rejection denies otherwise New parent with ${name} history`,async()=>{
      const id=await workOrder();await prepare(id);const args=await context(id);const before=await snapshot();
      await reject(()=>command('reject',actors.mgr,args,'Synthetic history rejection check'));
      assert.deepEqual(await snapshot(),before);
    });
  }
  for (const closed of [false,true]) {
    await check(`rejection preserves work with ${closed ? 'closed' : 'open'} visit history`,async()=>{
      const id=await fixture.lifecycle.workOrder({ status:'wip',functional:'Work in Progress',visit:true });
      if (closed) await db.query('update public.work_order_visits set check_out_at=now(),checked_out_by=$2 where work_order_id=$1',[id,actors.contractor]);
      const args=await context(id);const before=await snapshot();
      await reject(()=>command('reject',actors.mgr,args,'Synthetic visit history check'));assert.deepEqual(await snapshot(),before);
    });
  }
  await check('rejection stale assignment, cycle and lifecycle tokens fail without archive',async()=>{
    const id=await workOrder();const before=await snapshot();
    for (const index of [1,2,3]) {
      const args=await context(id);args[index]+=1;
      await reject(()=>command('reject',actors.mgr,args,'Synthetic stale rejection'));
    }
    assert.deepEqual(await snapshot(),before);
  });
  await check('duplicate preserves source, root billing identity and clean technician state with one outgoing notice',async()=>{
    const id=await workOrder({ owner:actors.contractor,status:'assigned',functional:'Dispatched' });
    await db.query("update public.work_orders set store_number='99999',technician_on_job='Synthetic old technician',sla_started_at='2026-09-09T00:00Z' where id=$1",[id]);
    const before=await parent(id);const args=await context(id);const first=await command('duplicate',actors.mgr,args);
    assert.equal(first.applied,true);assert.equal(first.workOrderId,`${id}-1`);
    const copy=await parent(first.workOrderId);assert.equal(copy.contractor_id,null);
    assert.equal(copy.technician_on_job,null);assert.equal(copy.assigned_technician_profile_id,null);
    assert.equal(copy.duplicate_root_work_order_id,id);assert.equal(copy.duplicated_from_work_order_id,id);
    assert.equal(copy.duplicate_sequence,1);assert.equal(copy.contractor_assignment_version,0);
    assert.equal(copy.sla_started_at.toISOString(),before.sla_started_at.toISOString());
    assert.deepEqual(await parent(id),before,'Source financial/field identity must stay intact');
    assert.ok(first.deliveryId);const after=await snapshot();
    const replay=await command('duplicate',actors.mgr,args);
    assert.equal(replay.reason,'already_applied');assert.equal(replay.workOrderId,first.workOrderId);
    assert.equal(replay.deliveryId,first.deliveryId);assert.deepEqual(await snapshot(),after);
    await reject(()=>command('transition',actors.mgr,args,actors.outsider));
  });
  await check('existing continuation blocks another source copy; assigned continuation retains root suffix allocation',async()=>{
    const id=await workOrder({ owner:actors.contractor,status:'parts',functional:'Awaiting Parts' });
    const first=await command('duplicate',actors.mgr,await context(id));
    const args=await context(id);const before=await snapshot();
    await reject(()=>command('duplicate',actors.mgr,args));assert.deepEqual(await snapshot(),before);
    await command('transition',actors.mgr,await context(first.workOrderId),actors.outsider);
    const second=await command('duplicate',actors.mgr,await context(first.workOrderId));
    assert.equal(first.workOrderId,`${id}-1`);assert.equal(second.workOrderId,`${id}-2`);
  });
  await check('stale duplicate cannot create a continuation after source reassignment',async()=>{
    const id=await workOrder({ owner:actors.contractor,status:'assigned',functional:'Dispatched' });const args=await context(id);
    await command('transition',actors.mgr,[...args.slice(0,4),randomUUID()],actors.outsider);const after=await snapshot();
    await reject(()=>command('duplicate',actors.mgr,args));assert.deepEqual(await snapshot(),after);
  });
  await check('legacy versioned three-argument assignment signature remains compatible after contraction',async()=>{
    const id=await workOrder();
    const result=(await as('authenticated',actors.mgr,tx=>tx.query('select public.transition_work_order_contractor($1,$2,$3) result',[id,actors.contractor,0]))).rows[0].result;
    assert.equal(result.applied,true);assert.equal(result.contractorId,actors.contractor);
  });
}
