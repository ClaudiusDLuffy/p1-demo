import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { administrativeTransferFixtures,ADMINISTRATIVE_TRANSFER_EVENT,ADMINISTRATIVE_TRANSFER_RPC,TRANSFER_REASON } from './administrative-transfer-fixtures.mjs';

export async function verifyAdministrativeTransferSecurity(fixture,check) {
  const f=administrativeTransferFixtures(fixture);
  const { db,as,actors,activeWorkOrder,context,transfer,reject,snapshot,rawDenied,visit,events,workOrder }=f;
  for(const actorName of ['inactive','controller','contractor','canonical','admin','report','invoice','unassigned','former','outsider']) {
    await check(`${actorName} cannot administratively close another actor's visit or transfer assignment`,async()=>{
      const { id }=await activeWorkOrder();const args=await context(id);const before=await snapshot();
      await reject(()=>transfer(args,actors.outsider,TRANSFER_REASON,true,actors[actorName]),['42501']);assert.deepEqual(await snapshot(),before);
    });
  }
  for(const role of ['anon','service_role']) {
    await check(`${role} cannot invoke actorless administrative transfer`,async()=>{
      const { id }=await activeWorkOrder();const args=await context(id);const before=await snapshot();
      await reject(()=>transfer(args,actors.outsider,TRANSFER_REASON,true,null,role),['42501']);
      assert.deepEqual(await snapshot(),before);
    });
  }
  await check('administrative transfer requires explicit true confirmation and a trimmed nonempty bounded reason',async()=>{
    const { id }=await activeWorkOrder();const args=await context(id);const before=await snapshot();
    for(const reason of ['', '  ', '\n\t\r ', 'a'.repeat(501),null]) await reject(()=>transfer(args,actors.outsider,reason),['22023']);
    for(const confirmed of [false,null]) await reject(()=>transfer(args,actors.outsider,TRANSFER_REASON,confirmed),['22023']);
    assert.deepEqual(await snapshot(),before);
    assert.equal((await transfer(args,actors.outsider,'x',true)).applied,true,'Policy requires nonempty, not an invented five-character minimum');
  });
  for(const target of ['inactiveContractor','mgr','admin','report','nonassignable']) {
    await check(`administrative transfer cannot close a visit before rejecting ${target} destination`,async()=>{
      const { id }=await activeWorkOrder();const args=await context(id);const before=await snapshot();
      await reject(()=>transfer(args,actors[target]));assert.deepEqual(await snapshot(),before);
    });
  }
  await check('administrative transfer rejects absent target identity, nonexistent parent and no-active-visit misuse',async()=>{
    const { id }=await activeWorkOrder();const args=await context(id);const withoutVisit=await workOrder({ owner:actors.contractor,status:'assigned',functional:'Dispatched' });
    const otherArgs=await context(withoutVisit);const before=await snapshot();
    await reject(()=>transfer(args,randomUUID()));
    await reject(()=>transfer(['WOT999888777',...args.slice(1)]));
    await reject(()=>transfer(otherArgs));
    await reject(()=>transfer(args,actors.contractor));
    assert.deepEqual(await snapshot(),before);
  });
  await check('administrative command exposes no actor/backdate parameter and grants no anonymous/service authority',async()=>{
    const routines=(await db.query(`select p.pronargs,p.proargnames,
      has_function_privilege('anon',p.oid,'EXECUTE') anon,
      has_function_privilege('authenticated',p.oid,'EXECUTE') authenticated,
      has_function_privilege('service_role',p.oid,'EXECUTE') service
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname=$1`,[ADMINISTRATIVE_TRANSFER_RPC])).rows;
    assert.equal(routines.length,1);const row=routines[0];assert.equal(row.pronargs,8);
    assert.deepEqual(row.proargnames,['p_work_order_id','p_new_contractor_id','p_expected_assignment_version','p_expected_workflow_cycle',
      'p_expected_lifecycle_version','p_operation_id','p_reason','p_confirmed']);
    assert.deepEqual([row.anon,row.authenticated,row.service],[false,true,false]);
  });
  await check('administrative visit metadata cannot be forged, erased, reassigned or downgraded through raw roles',async()=>{
    const { id,visit:original }=await activeWorkOrder();await transfer(await context(id));
    for(const [role,actor] of [['authenticated',actors.mgr],['authenticated',actors.outsider],['authenticated',actors.contractor],['service_role',null]]) {
      for(const [sql,args] of [
        ['update public.work_order_visits set duration_review_required=false where id=$1 returning id',[original.id]],
        ['update public.work_order_visits set closure_kind=null where id=$1 returning id',[original.id]],
        ['update public.work_order_visits set administrative_closed_by=$2 where id=$1 returning id',[original.id,actors.contractor]],
        ["update public.work_order_visits set administrative_close_reason='Synthetic forgery' where id=$1 returning id",[original.id]],
        ["update public.work_order_visits set administrative_closed_at=now()-interval '1 day' where id=$1 returning id",[original.id]],
        ['update public.work_order_visits set administrative_transfer_operation_id=$2 where id=$1 returning id',[original.id,randomUUID()]],
        ['update public.work_order_visits set check_out_at=null where id=$1 returning id',[original.id]],
        ['delete from public.work_order_visits where id=$1 returning id',[original.id]],
      ]) await rawDenied(actor,sql,args,role);
    }
    const untouched=await activeWorkOrder();
    await rawDenied(actors.mgr,`update public.work_order_visits set closure_kind='administrative_transfer',duration_review_required=true,
      administrative_closed_at=now(),administrative_closed_by=$2,administrative_close_reason=$3,
      administrative_transfer_operation_id=$4 where id=$1 returning id`,[untouched.visit.id,actors.mgr,TRANSFER_REASON,randomUUID()]);
  });
  await check('administrative closure event cannot be forged, reclassified, edited or removed',async()=>{
    const { id }=await activeWorkOrder();const result=await transfer(await context(id));
    for(const [role,actor] of [['authenticated',actors.mgr],['authenticated',actors.contractor],['service_role',null]]) {
      await rawDenied(actor,`insert into public.activities(work_order_id,author_id,author_name,text,type,event_key)
        values($1,$2,'Synthetic forged actor','Synthetic false administrative closure','system',$3) returning id`,
      [id,actors.mgr,ADMINISTRATIVE_TRANSFER_EVENT],role);
      for(const sql of ["update public.activities set text='Synthetic changed closure' where id=$1 returning id",
        'update public.activities set author_id=null where id=$1 returning id',
        "update public.activities set event_key='note' where id=$1 returning id",
        'update public.activities set deleted_at=now() where id=$1 returning id',
        'delete from public.activities where id=$1 returning id']) await rawDenied(actor,sql,[result.administrativeClosureActivityId],role);
    }
  });
  await check('reasoned visit-time correction preserves administrative provenance and review-required flag with immutable new evidence',async()=>{
    // Correction checks overlap across every visit of its technician, not only
    // this work order. Use a distinct synthetic actor rather than concurrent
    // fixture visits belonging to the common contractor identity.
    const isolatedContractor=randomUUID();
    await db.query('insert into auth.users(id,email) values($1,$2)',[isolatedContractor,`${isolatedContractor}@assignment.example.invalid`]);
    await db.query("update public.profiles set role='contractor',active=true,is_assignable=true where id=$1",[isolatedContractor]);
    const { id,visit:original }=await activeWorkOrder({ owner:isolatedContractor });await transfer(await context(id));const closed=await visit(original.id);
    const correctedIn=new Date(closed.check_in_at.getTime()+60_000).toISOString();const correctedOut=new Date(closed.check_out_at.getTime()-60_000).toISOString();
    const before=await snapshot();
    await reject(()=>as('authenticated',actors.mgr,tx=>tx.query('select public.correct_work_order_visit($1,$2,$3,$4)',
      [original.id,correctedIn,correctedOut,''])),['P0001','22023']);assert.deepEqual(await snapshot(),before);
    await as('authenticated',actors.mgr,tx=>tx.query('select public.correct_work_order_visit($1,$2,$3,$4)',
      [original.id,correctedIn,correctedOut,'Synthetic actual-time correction; duration still requires review']));
    const corrected=await visit(original.id);assert.equal(corrected.check_in_at.toISOString(),correctedIn);assert.equal(corrected.check_out_at.toISOString(),correctedOut);
    for(const key of ['closure_kind','duration_review_required','administrative_closed_at','administrative_closed_by',
      'administrative_close_reason','administrative_transfer_operation_id']) assert.deepEqual(corrected[key],closed[key],key);
    const corrections=(await events(id)).filter(row=>row.event_key==='visit_time_corrected');assert.equal(corrections.length,1);
    assert.equal(corrections[0].author_id,actors.mgr);assert.ok(JSON.stringify(corrections[0].event_data).includes('Synthetic actual-time correction'));
    await rawDenied(actors.mgr,"update public.activities set text='Synthetic corrupted correction' where id=$1 returning id",[corrections[0].id]);
    await rawDenied(actors.mgr,'delete from public.activities where id=$1 returning id',[corrections[0].id]);
    await rawDenied(actors.mgr,'update public.work_order_visits set duration_review_required=false where id=$1 returning id',[original.id]);
  });
}
