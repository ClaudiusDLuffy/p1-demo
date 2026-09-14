import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { withAssignmentWriteFailure } from './atomicity-acceptance.mjs';

export async function verifyAssignmentCreationAndDelivery(fixture,check) {
  const { db,as,actors,workOrder,context,command,parent,reject,snapshot }=fixture;
  let sequence=0;
  function input(email=false,patch={}) {
    return { id:`WOT96${String(++sequence).padStart(5,'0')}`,source:email ? 'email_intake' : 'manual',priority:'p3',
      status:'assigned',functional_status:email ? 'New' : 'Dispatched',contractor_id:actors.contractor,
      nte:1000,summary:'Synthetic assignment creation',description:'Synthetic description',...patch };
  }
  function create(actor,operationId,payload,email=false,role=email ? 'service_role' : 'authenticated') {
    const name=email ? 'create_email_work_order_with_assignment_v1' : 'create_work_order_with_assignment_v1';
    return as(role,actor,tx=>tx.query(`select public.${name}($1,$2) result`,[operationId,JSON.stringify(payload)]))
      .then(result=>result.rows[0].result);
  }
  for (const email of [false,true]) {
    await check(`${email ? 'trusted email' : 'manual'} assigned creation is atomic, operation-bound and preserves its functional status`,async()=>{
      const payload=input(email);const operationId=randomUUID();const actor=email ? null : actors.mgr;
      const result=await create(actor,operationId,payload,email);assert.equal(result.applied,true);
      const row=await parent(payload.id);assert.equal(row.contractor_id,actors.contractor);
      assert.equal(row.contractor_assignment_version,1);assert.equal(row.functional_status,email ? 'New' : 'Dispatched');
      assert.equal(row.source,payload.source);assert.equal(row.created_by,actor);
      const event=(await db.query("select author_id,assignment_operation_id from public.activities where work_order_id=$1 and event_key='work_order_assignment'",[payload.id])).rows;
      assert.equal(event.length,1);assert.equal(event[0].author_id,actor);assert.equal(event[0].assignment_operation_id,operationId);
      assert.equal((await db.query('select count(*)::int count from public.contractor_assignment_transition_deliveries where work_order_id=$1',[payload.id])).rows[0].count,0,
        'Initial receiving dispatch is not repurposed as an outgoing-delivery row');
      const after=await snapshot();assert.equal((await create(actor,operationId,payload,email)).reason,'already_applied');
      await reject(()=>create(actor,operationId,{ ...payload,contractor_id:actors.outsider },email));
      assert.deepEqual(await snapshot(),after);
    });
    await check(`${email ? 'email' : 'manual'} creation rejects invalid targets and caller-provided assignment/archive provenance`,async()=>{
      for (const patch of [{ contractor_id:actors.inactiveContractor },{ contractor_id:actors.mgr },{ contractor_id:actors.admin },
        { contractor_id:randomUUID() },{ deleted_by:actors.outsider },{ deleted_at:'2026-09-08T00:00Z' },
        { contractor_assignment_version:99 },{ contractor_assignment_started_at:'2026-09-08T00:00Z' },
        { created_by:actors.outsider },{ duplicated_from_work_order_id:'WOT9999999' }]) {
        const payload=input(email,patch);const before=await snapshot();
        await reject(()=>create(email ? null : actors.mgr,randomUUID(),payload,email),['42501','22023','P0002','23514']);
        assert.deepEqual(await snapshot(),before);
      }
    });
    for (const [table,operation] of [['work_orders','insert'],['activities','insert'],['work_order_assignment_operations','insert'],['work_order_assignment_operations','update']]) {
      await check(`${email ? 'email' : 'manual'} assigned creation rolls back after ${table} ${operation}`,async()=>{
        const payload=input(email);const before=await snapshot();
        await withAssignmentWriteFailure(db,{ table,operation },()=>reject(
          ()=>create(email ? null : actors.mgr,randomUUID(),payload,email),['P0001']));
        assert.deepEqual(await snapshot(),before);
      });
    }
  }
  await check('unassigned manual creation and billing-only email intake preserve supported neutral assignment state',async()=>{
    const manual=input(false,{ status:'unassigned',functional_status:'New',contractor_id:null });
    await create(actors.mgr,randomUUID(),manual);assert.equal((await parent(manual.id)).contractor_assignment_version,0);
    const billing=input(true,{ status:'pending_invoice',functional_status:'Completed',contractor_id:null,billing_only:true,
      billing_ready_at:'2026-09-08T00:00:00Z',billing_ready_by:null,dispatched_at:null });
    await create(null,randomUUID(),billing,true);const row=await parent(billing.id);
    assert.equal(row.billing_only,true);assert.equal(row.contractor_id,null);assert.equal(row.contractor_assignment_version,0);
  });
  await check('creation roles and service boundaries reject inactive, controller and contractor actors',async()=>{
    for (const actor of [actors.inactive,actors.controller,actors.contractor,actors.admin,actors.report]) {
      await reject(()=>create(actor,randomUUID(),input()));
      await reject(()=>create(actor,randomUUID(),input(true),true,'authenticated'),['42501']);
    }
    await reject(()=>create(null,randomUUID(),input(),false,'service_role'),['42501']);
    await reject(()=>create(actors.mgr,randomUUID(),input(true),true,'service_role'),['42501']);
    await reject(()=>create(null,randomUUID(),input(true,{ source:'manual' }),true),['42501']);
  });
  for (const terminal of ['sent','unknown']) {
    await check(`outgoing delivery preserves ${terminal} classification, recipient snapshot and assignment replay`,async()=>{
      const id=await workOrder({ owner:actors.contractor,status:'assigned',functional:'Dispatched' });
      const args=await context(id);const result=await command('transition',actors.mgr,args,actors.outsider);
      const initial=(await db.query('select * from public.contractor_assignment_transition_deliveries where id=$1',[result.deliveryId])).rows[0];
      assert.equal(initial.outgoing_contractor_id,actors.contractor);assert.equal(initial.outgoing_assignment_version,args[1]);
      assert.equal(initial.initiated_by,actors.mgr);assert.equal(initial.assignment_operation_id,args[4]);
      const claim=await as('service_role',null,tx=>tx.query('select public.claim_contractor_assignment_transition_delivery($1,$2) result',[result.deliveryId,actors.mgr]));
      assert.equal(claim.rows[0].result.claimStatus,'new_claim');
      assert.equal(Object.hasOwn(claim.rows[0].result,'receivingContractorId'),false);
      const repeatedClaim=await as('service_role',null,tx=>tx.query('select public.claim_contractor_assignment_transition_delivery($1,$2) result',[result.deliveryId,actors.mgr]));
      assert.equal(repeatedClaim.rows[0].result.claimStatus,'pending_or_unknown');
      await as('service_role',null,tx=>tx.query('select public.complete_contractor_assignment_transition_delivery($1,$2,$3)',
        [result.deliveryId,terminal,terminal === 'unknown' ? 'Synthetic ambiguous provider result' : null]));
      const finalClaim=await as('service_role',null,tx=>tx.query('select public.claim_contractor_assignment_transition_delivery($1,$2) result',[result.deliveryId,actors.mgr]));
      assert.equal(finalClaim.rows[0].result.claimStatus,terminal === 'sent' ? 'already_sent' : 'delivery_unknown');
      const after=await snapshot();assert.equal((await command('transition',actors.mgr,args,actors.outsider)).reason,'already_applied');
      assert.deepEqual(await snapshot(),after);
      for (const actor of [actors.mgr,actors.contractor]) await reject(()=>as('authenticated',actor,tx=>tx.query(
        'select public.complete_contractor_assignment_transition_delivery($1,$2,$3)',[result.deliveryId,'sent',null])),['42501']);
    });
  }
  await check('capital assignment and unassignment preserve capital identity rather than resetting lifecycle',async()=>{
    const id=await workOrder({ status:'capital',functional:'New' });
    await db.query('update public.work_orders set is_capital=true where id=$1',[id]);
    await command('transition',actors.mgr,await context(id),actors.contractor);
    let row=await parent(id);assert.equal(row.is_capital,true);assert.equal(row.status,'capital');
    await command('transition',actors.mgr,await context(id),null);
    row=await parent(id);assert.equal(row.is_capital,true);assert.equal(row.status,'capital');assert.equal(row.contractor_id,null);
  });
}
