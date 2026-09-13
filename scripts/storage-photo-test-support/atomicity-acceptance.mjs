import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { expectSqlDenial } from './fixtures.mjs';

export async function verifyPhotoAtomicity(fixture,check) {
  const {db,as,actors,workOrder}=fixture;
  const file={name:'Synthetic.jpg',mimeType:'image/jpeg',sizeBytes:128,sha256:'d'.repeat(64)};
  const inspection={format:'jpeg',mimeType:'image/jpeg',extension:'jpg',sizeBytes:128,sha256:file.sha256,width:10,height:10,frames:1};
  async function pending(id=null,batch=randomUUID(),actor=actors.contractor,sha=randomUUID().replaceAll('-','').repeat(2)) {
    id ??= await workOrder();
    const version=(await db.query('select contractor_assignment_version,workflow_cycle from public.work_orders where id=$1',[id])).rows[0];
    const row=(await as('authenticated',actor,tx=>tx.query('select public.begin_work_order_photo_upload_v1($1,$2,$3,$4,$5,$6) result',
      [id,randomUUID(),batch,version.contractor_assignment_version,version.workflow_cycle,JSON.stringify({...file,sha256:sha})]))).rows[0].result;
    await as('authenticated',actor,tx=>tx.query('insert into storage.objects(bucket_id,name,owner) values ($1,$2,$3)',[row.bucket,row.objectPath,actor]));
    return (await as('authenticated',actor,tx=>tx.query('select public.claim_private_object_upload_v1($1) result',[row.intentId]))).rows[0].result;
  }
  async function finalize(row) {
    return (await as('service_role',null,tx=>tx.query('select public.finalize_private_object_upload_v1($1,$2,$3) result',
      [row.intentId,row.claimId,JSON.stringify({...inspection,sha256:row.file.sha256})]))).rows[0].result;
  }
  async function snapshot(id) {
    return (await db.query(`select
      (select coalesce(jsonb_agg(to_jsonb(u) order by id),'[]') from public.private_object_uploads u where work_order_id=$1) uploads,
      (select coalesce(jsonb_agg(to_jsonb(b) order by id),'[]') from public.private_object_bindings b where work_order_id=$1) bindings,
      (select coalesce(jsonb_agg(to_jsonb(p) order by id),'[]') from public.photos p where work_order_id=$1) photos,
      (select coalesce(jsonb_agg(to_jsonb(a) order by id),'[]') from public.activities a where work_order_id=$1) activities,
      (select coalesce(jsonb_agg(to_jsonb(b) order by id),'[]') from public.private_object_photo_batches b where work_order_id=$1) batches,
      (select coalesce(jsonb_agg(to_jsonb(g)),'[]') from public.private_object_transition_guards g) guards`,[id])).rows[0];
  }
  for(const [table,event] of [['private_object_bindings','insert'],['photos','insert'],['activities','insert'],
    ['private_object_photo_batches','update'],['private_object_uploads','update']]) {
    await check(`finalization rolls back all metadata/evidence/intent writes after ${table} ${event} failure`,async()=>{
      const row=await pending();const before=await snapshot(row.workOrderId);
      await db.exec(`create function public.synthetic_object_failure() returns trigger language plpgsql as $$
        begin raise exception 'Synthetic controlled failure' using errcode='23514'; end; $$;
        create trigger synthetic_object_failure after ${event} on public.${table}
          for each row execute function public.synthetic_object_failure();`);
      try { await expectSqlDenial(()=>finalize(row),['23514']);assert.deepEqual(await snapshot(row.workOrderId),before); }
      finally { await db.exec(`drop trigger synthetic_object_failure on public.${table};drop function public.synthetic_object_failure();`); }
      assert.equal((await finalize(row)).status,'finalized');
    });
  }
  await check('a partial batch exposes one aggregate event counting only finalized files; replay does not increment',async()=>{
    const id=await workOrder();const batch=randomUUID();const rows=[await pending(id,batch),await pending(id,batch),await pending(id,batch)];
    await finalize(rows[0]);await finalize(rows[1]);await finalize(rows[1]);
    const events=(await db.query("select text,event_data from public.activities where work_order_id=$1 and event_key='photo_added'",[id])).rows;
    assert.equal(events.length,1);assert.equal(events[0].text,'Added 2 photos.');assert.equal(events[0].event_data.count,2);
    assert.equal((await db.query('select finalized_count from public.private_object_photo_batches where id=$1',[batch])).rows[0].finalized_count,2);
    await finalize(rows[2]);assert.equal((await db.query("select text from public.activities where work_order_id=$1 and event_key='photo_added'",[id])).rows[0].text,'Added 3 photos.');
  });
  await check('photo batch UUID cannot cross work orders or actors and permits at most eight intents',async()=>{
    const id=await workOrder();const batch=randomUUID();await pending(id,batch);
    await expectSqlDenial(()=>pending(id,batch,actors.mgr),['PT409']);
    await expectSqlDenial(async()=>pending(await workOrder(),batch),['PT409']);
    for(let index=1;index<8;index++) await pending(id,batch);
    await expectSqlDenial(()=>pending(id,batch),['PT422']);
    assert.equal((await db.query('select id from public.private_object_uploads where batch_id=$1',[batch])).rows.length,8);
  });
  await check('identical file hashes cannot create two photo intents in one batch but may be reused in a different batch',async()=>{
    const id=await workOrder();const batch=randomUUID();const sha='e'.repeat(64);
    await pending(id,batch,actors.contractor,sha);
    await expectSqlDenial(()=>pending(id,batch,actors.contractor,sha),['23505']);
    await pending(id,randomUUID(),actors.contractor,sha);
    assert.equal((await db.query('select id from public.private_object_uploads where work_order_id=$1',[id])).rows.length,2);
  });
  await check('a parent lifecycle/status change after inspection prevents photo finalization with no metadata',async()=>{
    const row=await pending();
    await db.query("update public.work_orders set status='closed' where id=$1",[row.workOrderId]);
    await expectSqlDenial(()=>finalize(row),['PT409']);
    assert.equal((await db.query('select id from public.photos where work_order_id=$1',[row.workOrderId])).rows.length,0);
  });
  await check('a replaced object row after inspection is rejected, and deletion never claims a replacement identity',async()=>{
    const row=await pending();
    await as('service_role',null,tx=>tx.query('delete from storage.objects where bucket_id=$1 and name=$2',[row.bucket,row.objectPath]));
    await fixture.object(row.bucket,row.objectPath,actors.contractor);
    await expectSqlDenial(()=>finalize(row),['PT409']);
    const valid=await finalize(await pending());
    const deletion=(await as('authenticated',actors.contractor,tx=>tx.query('select public.request_private_object_delete_v1($1,$2) result',
      [valid.bindingId,randomUUID()]))).rows[0].result;
    await as('service_role',null,tx=>tx.query('delete from storage.objects where bucket_id=$1 and name=$2',[valid.bucket,valid.objectPath]));
    await fixture.object(valid.bucket,valid.objectPath,actors.contractor);
    await expectSqlDenial(()=>as('service_role',null,tx=>tx.query('select public.claim_private_object_deletion_v1($1)',[deletion.deletionId])),['PT409']);
  });
  await check('deletion audit failure leaves metadata/binding pending and retry commits one removal event',async()=>{
    const valid=await finalize(await pending());
    const requested=(await as('authenticated',actors.contractor,tx=>tx.query('select public.request_private_object_delete_v1($1,$2) result',
      [valid.bindingId,randomUUID()]))).rows[0].result;
    const leased=(await as('service_role',null,tx=>tx.query('select public.claim_private_object_deletion_v1($1) result',[requested.deletionId]))).rows[0].result;
    await as('service_role',null,tx=>tx.query('delete from storage.objects where bucket_id=$1 and name=$2',[valid.bucket,valid.objectPath]));
    const before=await snapshot(valid.workOrderId);
    await db.exec(`create function public.synthetic_object_failure() returns trigger language plpgsql as $$
      begin raise exception 'Synthetic controlled audit failure' using errcode='23514'; end; $$;
      create trigger synthetic_object_failure after insert on public.activities for each row execute function public.synthetic_object_failure();`);
    const complete=()=>as('service_role',null,tx=>tx.query('select public.complete_private_object_deletion_v1($1,$2,$3)',
      [leased.deletionId,leased.claimId,'deleted']));
    try { await expectSqlDenial(complete,['23514']);assert.deepEqual(await snapshot(valid.workOrderId),before); }
    finally { await db.exec('drop trigger synthetic_object_failure on public.activities;drop function public.synthetic_object_failure();'); }
    await complete();await complete();
    assert.equal((await db.query("select id from public.activities where work_order_id=$1 and event_key='photo_removed'",[valid.workOrderId])).rows.length,1);
  });
}
