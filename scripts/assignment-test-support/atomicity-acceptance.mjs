import assert from 'node:assert/strict';

// AFTER triggers deliberately fail synthetic transactions after real writes.
// None of these hooks is shipped in a migration, RPC or production API.
export async function withAssignmentWriteFailure(db,{ table,operation },run) {
  assert.ok(['work_orders','work_order_assignment_history','activities','contractor_assignment_transition_deliveries',
    'work_order_assignment_operations'].includes(table));
  assert.ok(['insert','update'].includes(operation));
  await db.exec(`create or replace function pg_temp.fail_assignment_fixture_write()
    returns trigger language plpgsql as $$ begin
      raise exception 'Synthetic assignment post-write failure' using errcode='P0001';
    end $$;
    create trigger assignment_fixture_failure after ${operation} on public.${table}
      for each row execute function pg_temp.fail_assignment_fixture_write();`);
  try { await run(); }
  finally { await db.exec(`drop trigger assignment_fixture_failure on public.${table}`); }
}

export async function verifyAssignmentAtomicity(fixture,check) {
  const { db,actors,workOrder,context,command,snapshot,reject }=fixture;
  for (const action of ['initial','reassign','unassign']) {
    const writes=[['work_orders','update'],['activities','insert'],['work_order_assignment_operations','insert'],
      ['work_order_assignment_operations','update']];
    if (action !== 'initial') writes.push(['work_order_assignment_history','insert'],['contractor_assignment_transition_deliveries','insert']);
    for (const [table,operation] of writes) {
      await check(`${action} rolls back parent/version/history/evidence/delivery after ${table} ${operation} failure`,async()=>{
        const id=await workOrder(action === 'initial' ? {} : { owner:actors.contractor,status:'assigned',functional:'Dispatched' });
        const args=await context(id);const before=await snapshot();
        await withAssignmentWriteFailure(db,{ table,operation },()=>reject(
          ()=>command('transition',actors.mgr,args,action === 'initial' ? actors.contractor : action === 'reassign' ? actors.outsider : null),['P0001']));
        assert.deepEqual(await snapshot(),before);
      });
    }
  }
  for (const family of ['reject','duplicate']) {
    const writes=[['work_orders',family === 'reject' ? 'update' : 'insert'],['activities','insert'],
      ['work_order_assignment_operations','insert'],['work_order_assignment_operations','update']];
    if (family === 'duplicate') writes.push(['contractor_assignment_transition_deliveries','insert']);
    for (const [table,operation] of writes) {
      await check(`${family} fully rolls back archive/copy/evidence after ${table} ${operation} failure`,async()=>{
        const id=await workOrder(family === 'reject' ? {} : { owner:actors.contractor,status:'assigned',functional:'Dispatched' });
        const args=await context(id);const before=await snapshot();
        await withAssignmentWriteFailure(db,{ table,operation },()=>reject(
          ()=>command(family,actors.mgr,args,family === 'reject' ? 'Synthetic atomic rejection' : null),['P0001']));
        assert.deepEqual(await snapshot(),before);
      });
    }
  }
  await check('legacy outgoing-delivery preplay cannot satisfy new authoritative assignment evidence',async()=>{
    const id=await workOrder({ owner:actors.contractor,status:'assigned',functional:'Dispatched' });const args=await context(id);
    await db.query(`insert into public.contractor_assignment_transition_deliveries(event_key,work_order_id,external_work_order_id,
      outgoing_contractor_id,outgoing_assignment_version,outgoing_contractor_name,outgoing_contractor_email,transition_type,initiated_by)
      values($1,$2,$2,$3,$4,'Synthetic old delivery','synthetic@example.invalid','reassigned',$5)`,
    [`assignment:${id}:${args[1]}`,id,actors.contractor,args[1],actors.mgr]);
    const before=await snapshot();
    await reject(()=>command('transition',actors.mgr,args,actors.outsider),['23514']);
    assert.deepEqual(await snapshot(),before);
  });
  await check('replay requires immutable accepted evidence and cannot silently recreate corrupted history',async()=>{
    const id=await workOrder({ owner:actors.contractor,status:'assigned',functional:'Dispatched' });const args=await context(id);
    await command('transition',actors.mgr,args,actors.outsider);
    await db.query("update public.work_order_assignment_history set workflow_snapshot='{}' where work_order_id=$1",[id]);
    const before=await snapshot();await reject(()=>command('transition',actors.mgr,args,actors.outsider),['PT409','23514']);
    assert.deepEqual(await snapshot(),before);
  });
  await check('a legacy caller-shaped assignment event alone neither suppresses nor impersonates a new command',async()=>{
    const id=await workOrder();
    await db.query(`insert into public.activities(work_order_id,author_id,author_name,text,type,event_key)
      values($1,$2,'Synthetic legacy','Synthetic legacy preplay','system','work_order_assignment')`,[id,actors.mgr]);
    const result=await command('transition',actors.mgr,await context(id),actors.contractor);
    assert.equal(result.applied,true);
    assert.equal((await db.query('select count(*)::int count from public.activities where work_order_id=$1 and assignment_operation_id is not null',[id])).rows[0].count,1);
  });
}
