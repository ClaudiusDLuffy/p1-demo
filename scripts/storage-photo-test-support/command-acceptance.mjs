import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { expectSqlDenial } from './fixtures.mjs';

export async function verifyCanonicalObjectCommands(fixture, check) {
  const { db,as,actors,workOrder } = fixture;
  const file = { name:'Synthetic.jpg',mimeType:'image/jpeg',sizeBytes:128,sha256:'a'.repeat(64) };
  const inspection = { format:'jpeg',mimeType:'image/jpeg',extension:'jpg',sizeBytes:128,
    sha256:file.sha256,width:10,height:10,frames:1 };
  async function begin(actor,id,patch={},operation=randomUUID(),batch=randomUUID()) {
    const row=(await db.query('select contractor_assignment_version,workflow_cycle from public.work_orders where id=$1',[id])).rows[0];
    return (await as('authenticated',actor,tx=>tx.query(
      'select public.begin_work_order_photo_upload_v1($1,$2,$3,$4,$5,$6) result',
      [id,operation,batch,row.contractor_assignment_version,row.workflow_cycle,JSON.stringify({...file,...patch})]))).rows[0].result;
  }
  async function upload(intent,actor=actors.contractor) {
    await as('authenticated',actor,tx=>tx.query('insert into storage.objects(bucket_id,name,owner,metadata) values ($1,$2,$3,$4)',
      [intent.bucket,intent.objectPath,actor,JSON.stringify({mimetype:file.mimeType,size:file.sizeBytes})]));
  }
  async function claim(intent,actor=actors.contractor) {
    return (await as('authenticated',actor,tx=>tx.query('select public.claim_private_object_upload_v1($1) result',[intent.intentId]))).rows[0].result;
  }
  async function finalize(intent,input=inspection) {
    return (await as('service_role',null,tx=>tx.query('select public.finalize_private_object_upload_v1($1,$2,$3) result',
      [intent.intentId,intent.claimId,JSON.stringify(input)]))).rows[0].result;
  }
  let ready;
  await check('clean installation supports authenticated intent upload and service finalization',async()=>{
    const id=await workOrder();const intent=await begin(actors.contractor,id);
    assert.equal(intent.status,'pending');assert.equal(intent.objectPath,`wo/${id}/${intent.intentId}`);
    await upload(intent);ready=await finalize(await claim(intent));
    assert.equal(ready.status,'finalized');assert.ok(ready.photoId);assert.ok(ready.bindingId);
    assert.equal((await fixture.objectRows(actors.contractor,'photos',intent.objectPath)).length,1);
    assert.equal((await db.query("select id from public.activities where work_order_id=$1 and event_key='photo_added'",[id])).rows.length,1);
    const replay=await finalize(ready);assert.equal(replay.bindingId,ready.bindingId);
    assert.equal((await db.query('select id from public.photos where work_order_id=$1',[id])).rows.length,1);
  });
  await check('raw metadata graft, service rebinding and raw object deletion are denied',async()=>{
    const own=await workOrder();
    await expectSqlDenial(()=>fixture.photo(own,ready.objectPath),['42501']);
    await expectSqlDenial(()=>as('service_role',null,tx=>tx.query('update public.photos set storage_path=$2 where id=$1',
      [ready.photoId,'wo/foreign/not-owned'])),['42501']);
    const removed=await as('authenticated',actors.contractor,tx=>tx.query('delete from storage.objects where name=$1 returning id',[ready.objectPath]));
    assert.equal(removed.rows.length,0);
  });
  await check('metadata-first deletion is replaced by claimed durable tombstone and immutable evidence',async()=>{
    const operation=randomUUID();
    const requested=(await as('authenticated',actors.contractor,tx=>tx.query(
      'select public.request_private_object_delete_v1($1,$2) result',[ready.bindingId,operation]))).rows[0].result;
    assert.equal(requested.status,'pending');
    assert.equal((await fixture.objectRows(actors.contractor,'photos',ready.objectPath)).length,0);
    const claimed=(await as('service_role',null,tx=>tx.query('select public.claim_private_object_deletion_v1($1) result',[requested.deletionId]))).rows[0].result;
    await expectSqlDenial(()=>as('service_role',null,tx=>tx.query('select public.complete_private_object_deletion_v1($1,$2,$3)',
      [claimed.deletionId,claimed.claimId,'deleted'])),['PT409']);
    await as('service_role',null,tx=>tx.query('delete from storage.objects where bucket_id=$1 and name=$2',[claimed.bucket,claimed.objectPath]));
    const completed=(await as('service_role',null,tx=>tx.query('select public.complete_private_object_deletion_v1($1,$2,$3) result',
      [claimed.deletionId,claimed.claimId,'deleted']))).rows[0].result;
    assert.equal(completed.status,'deleted');
    assert.equal((await db.query('select id from public.photos where id=$1',[ready.photoId])).rows.length,0);
    assert.equal((await db.query("select id from public.activities where event_key='photo_removed' and event_data->>'bindingId'=$1",[ready.bindingId])).rows.length,1);
    await expectSqlDenial(()=>claim(ready),['PT409']);
    await expectSqlDenial(()=>finalize(ready),['PT409']);
    await expectSqlDenial(()=>as('authenticated',actors.contractor,tx=>tx.query('select public.get_private_object_upload_v1($1)',[ready.intentId])),['PT409']);
  });
  await check('inactive, foreign, anonymous and controller service impersonation is denied',async()=>{
    const id=await workOrder();
    for(const actor of [actors.inactive,actors.inactiveContractor,actors.outsider,actors.unassigned]) {
      await expectSqlDenial(()=>begin(actor,id),['42501']);
    }
    await expectSqlDenial(()=>as('anon',null,tx=>tx.query('select public.get_private_object_upload_v1($1)',[ready.intentId])),['42501']);
    await expectSqlDenial(()=>as('authenticated',actors.mgr,tx=>tx.query('select public.finalize_private_object_upload_v1($1,$2,$3)',
      [ready.intentId,ready.claimId,JSON.stringify(inspection)])),['42501']);
  });
  await check('operation replay binds batch, parent and complete declared file and prevents another intent',async()=>{
    const id=await workOrder(); const operation=randomUUID(); const batch=randomUUID();
    const first=await begin(actors.contractor,id,{},operation,batch);
    const again=await begin(actors.contractor,id,{},operation,batch);
    assert.equal(again.intentId,first.intentId);
    for(const [target,patch,nextBatch] of [[id,{name:'Different.jpg'},batch],[id,{sha256:'b'.repeat(64)},batch],
      [id,{},randomUUID()],[await workOrder(),{},batch]]) {
      await expectSqlDenial(()=>begin(actors.contractor,target,patch,operation,nextBatch),['PT409']);
    }
  });
  await check('invalid declarations reject the entire command without an upload intent',async()=>{
    const id=await workOrder();
    for(const patch of [{sizeBytes:'128'},{sizeBytes:0},{sizeBytes:1.5},{sizeBytes:10485761},
      {sha256:'invalid'},{name:''},{mimeType:null},{unexpected:true}]) {
      await expectSqlDenial(()=>begin(actors.contractor,id,patch),['PT422']);
    }
    assert.equal((await db.query('select id from public.private_object_uploads where work_order_id=$1',[id])).rows.length,0);
  });
  await check('claim identity is exclusive and mismatched finalization cannot create metadata',async()=>{
    const id=await workOrder();const intent=await begin(actors.contractor,id);await upload(intent);
    const claimed=await claim(intent);
    await expectSqlDenial(()=>claim(intent),['PT409']);
    await expectSqlDenial(()=>finalize({...claimed,claimId:randomUUID()}),['PT409']);
    await expectSqlDenial(()=>finalize(claimed,{...inspection,sha256:'b'.repeat(64)}),['PT422']);
    assert.equal((await db.query('select id from public.photos where work_order_id=$1',[id])).rows.length,0);
    assert.equal((await db.query('select id from public.private_object_bindings where work_order_id=$1',[id])).rows.length,0);
  });
  for(const [label,patch] of [['actual BMP',{format:'bmp',mimeType:'image/bmp',extension:'bmp'}],
    ['actual HEIC',{format:'heic',mimeType:'image/heic',extension:'heic'}],
    ['actual HEIF',{format:'heif',mimeType:'image/heif',extension:'heif'}],
    ['too many pixels',{width:10000,height:10000}],['too many frames',{frames:101}],
    ['too wide',{width:12001}],['fractional dimensions',{height:1.5}],['missing dimensions',{width:null}]]) {
    await check(`trusted service inspection rejects ${label}`,async()=>{
      const id=await workOrder();const intent=await begin(actors.contractor,id);await upload(intent);
      await expectSqlDenial(async()=>finalize(await claim(intent),{...inspection,...patch}),['PT422']);
      assert.equal((await db.query('select id from public.photos where work_order_id=$1',[id])).rows.length,0);
    });
  }
  await check('JPEG content with a HEIC filename is accepted without extension-based misclassification',async()=>{
    const id=await workOrder();const intent=await begin(actors.contractor,id,{name:'Synthetic.heic',mimeType:'image/heic'});
    await upload(intent);const finished=await finalize(await claim(intent));
    assert.equal(finished.status,'finalized');assert.equal(finished.file.name,'Synthetic.heic');
  });
  await check('missing binary-row validation resets the same intent and path for safe upload retry',async()=>{
    const id=await workOrder();const intent=await begin(actors.contractor,id);const claimed=await claim(intent);
    await expectSqlDenial(()=>finalize(claimed),['P0002']);
    const failed=(await as('service_role',null,tx=>tx.query('select public.fail_private_object_upload_v1($1,$2,$3) result',
      [claimed.intentId,claimed.claimId,'OBJECT_MISSING']))).rows[0].result;
    assert.equal(failed.status,'pending');assert.equal(failed.objectPath,intent.objectPath);
    await upload(failed);assert.equal((await finalize(await claim(failed))).status,'finalized');
  });
  await check('stale assignment on claim persists known-intent cleanup without allowing reads',async()=>{
    const id=await workOrder();const intent=await begin(actors.contractor,id);await upload(intent);
    await db.query('update public.work_orders set contractor_id=$2 where id=$1',[id,actors.outsider]);
    const stale=await claim(intent);assert.equal(stale.status,'cleanup_required');assert.equal(stale.errorCode,'STALE_PARENT');
    assert.equal((await fixture.objectRows(actors.contractor,'photos',intent.objectPath)).length,0);
    await expectSqlDenial(()=>finalize({...stale,claimId:randomUUID()}),['42501','PT409']);
  });
  await check('explicit cancellation, cleanup claim, absence and lost-response replay preserve one durable record',async()=>{
    const id=await workOrder();const intent=await begin(actors.contractor,id);await upload(intent);
    const cancelled=(await as('authenticated',actors.contractor,tx=>tx.query('select public.cancel_private_object_upload_v1($1) result',[intent.intentId]))).rows[0].result;
    assert.equal(cancelled.status,'cleanup_required');
    const cleanup=(await as('service_role',null,tx=>tx.query('select public.claim_private_object_upload_cleanup_v1($1) result',[intent.intentId]))).rows[0].result;
    await as('service_role',null,tx=>tx.query('delete from storage.objects where bucket_id=$1 and name=$2',[cleanup.bucket,cleanup.objectPath]));
    const args=[intent.intentId,cleanup.claimId,'deleted'];
    const cleaned=(await as('service_role',null,tx=>tx.query('select public.complete_private_object_upload_cleanup_v1($1,$2,$3) result',args))).rows[0].result;
    assert.equal(cleaned.status,'cleaned');
    assert.equal((await as('service_role',null,tx=>tx.query('select public.complete_private_object_upload_cleanup_v1($1,$2,$3) result',args))).rows[0].result.status,'cleaned');
    assert.equal((await db.query('select id from public.photos where work_order_id=$1',[id])).rows.length,0);
  });
  await check('unknown delete outcome keeps evidence and same-operation resolution available',async()=>{
    const id=await workOrder();const intent=await begin(actors.contractor,id);await upload(intent);const finished=await finalize(await claim(intent));
    const operation=randomUUID();
    const deletion=(await as('authenticated',actors.contractor,tx=>tx.query('select public.request_private_object_delete_v1($1,$2) result',
      [finished.bindingId,operation]))).rows[0].result;
    const leased=(await as('service_role',null,tx=>tx.query('select public.claim_private_object_deletion_v1($1) result',[deletion.deletionId]))).rows[0].result;
    const unknown=(await as('service_role',null,tx=>tx.query('select public.complete_private_object_deletion_v1($1,$2,$3) result',
      [leased.deletionId,leased.claimId,'unknown']))).rows[0].result;
    assert.equal(unknown.status,'unknown');
    const resolver=(await as('authenticated',actors.contractor,tx=>tx.query('select public.resolve_private_object_binding_v1($1,$2,$3) result',
      ['photo',finished.photoId,operation]))).rows[0].result;
    assert.equal(resolver.bindingId,finished.bindingId);
    await expectSqlDenial(()=>as('authenticated',actors.contractor,tx=>tx.query('select public.resolve_private_object_binding_v1($1,$2,$3)',
      ['photo',finished.photoId,randomUUID()])),['42501']);
    assert.equal((await db.query('select id from public.photos where id=$1',[finished.photoId])).rows.length,1);
  });
  await check('private capabilities and tables cannot be granted by browser or service identities',async()=>{
    for(const [role,actor] of [['authenticated',actors.mgr],['authenticated',actors.contractor],['service_role',null]]) {
      for(const table of ['private_object_uploads','private_object_bindings','private_object_deletions','private_object_transition_guards']) {
        await expectSqlDenial(()=>as(role,actor,tx=>tx.query(`select * from public.${table}`)),['42501']);
      }
      await expectSqlDenial(()=>as(role,actor,tx=>tx.query('select public.private_object_cap($1,$2,$3)',
        ['photos',randomUUID(),randomUUID()])),['42501']);
    }
  });
  await check('explicit service-side actor scope preserves canonical-company and linked current-technician restrictions',async()=>{
    const reportWork=await workOrder({owner:actors.canonical,technician:actors.report});
    const invoiceWork=await workOrder({owner:actors.canonical,technician:actors.invoice});
    await begin(actors.report,reportWork);await begin(actors.invoice,invoiceWork);await begin(actors.canonical,reportWork);
    for(const actor of [actors.invoice,actors.admin,actors.unassigned,actors.former]) {
      await expectSqlDenial(()=>begin(actor,reportWork),['42501']);
    }
    await db.query('update public.contractor_technicians set is_active=false where profile_id=$1',[actors.invoice]);
    await expectSqlDenial(()=>begin(actors.invoice,invoiceWork),['42501']);
    await db.query('update public.contractor_technicians set is_active=true where profile_id=$1',[actors.invoice]);
    const newIntent=await begin(actors.invoice,invoiceWork);await upload(newIntent,actors.invoice);
    const claimed=await claim(newIntent,actors.invoice);
    await db.query('update public.contractor_technicians set is_active=false where profile_id=$1',[actors.invoice]);
    await expectSqlDenial(()=>finalize(claimed),['42501']);
    await db.query('update public.contractor_technicians set is_active=true where profile_id=$1',[actors.invoice]);
  });
  await check('same-operation begin cannot falsely replay a finalized upload after its object disappears',async()=>{
    const id=await workOrder();const operation=randomUUID();const batch=randomUUID();
    const intent=await begin(actors.contractor,id,{},operation,batch);await upload(intent);await finalize(await claim(intent));
    await as('service_role',null,tx=>tx.query('delete from storage.objects where bucket_id=$1 and name=$2',[intent.bucket,intent.objectPath]));
    await expectSqlDenial(()=>begin(actors.contractor,id,{},operation,batch),['PT409']);
  });
  await check('caller-set JWT role claims do not create service authority even if EXECUTE were mistakenly granted',async()=>{
    await db.exec('grant execute on function public.get_verified_invoice_object_v1(uuid) to authenticated');
    try {
      await expectSqlDenial(()=>as('authenticated',actors.mgr,async tx=>{
        await tx.query("select set_config('request.jwt.claim.role','service_role',true)");
        return tx.query('select public.get_verified_invoice_object_v1($1)',[randomUUID()]);
      }),['42501']);
    } finally {await db.exec('revoke execute on function public.get_verified_invoice_object_v1(uuid) from authenticated');}
  });
  await check('owned evidence cannot be inserted, changed, deleted or truncated by browser identities',async()=>{
    const id=await workOrder();const intent=await begin(actors.contractor,id);await upload(intent);await finalize(await claim(intent));
    const activity=(await db.query("select id from public.activities where work_order_id=$1 and event_key='photo_added'",[id])).rows[0].id;
    for(const key of ['photo_added','photo_removed','contractor_estimate_attachment_added','contractor_estimate_attachment_removed']) {
      await expectSqlDenial(()=>as('authenticated',actors.mgr,tx=>tx.query(`insert into public.activities
        (work_order_id,author_id,author_name,text,type,activity_channel,event_key) values ($1,$2,'Synthetic actor','Synthetic text','system','system_event',$3)`,
        [id,actors.mgr,key])),['42501']);
    }
    for(const sql of ['update public.activities set text=\'Changed\' where id=$1 returning id','delete from public.activities where id=$1 returning id']) {
      try { assert.equal((await as('authenticated',actors.mgr,tx=>tx.query(sql,[activity]))).rows.length,0); }
      catch(error) { if(error.code!=='42501') throw error; }
    }
    assert.equal((await db.query('select text from public.activities where id=$1',[activity])).rows[0].text,'Added 1 photo.');
    for(const table of ['photos','contractor_estimate_attachments','private_object_photo_batches','private_object_uploads','private_object_bindings','private_object_deletions','activities']) {
      for(const role of ['authenticated','service_role']) {
        assert.equal((await db.query('select has_table_privilege($1,$2,\'TRUNCATE\') allowed',[role,`public.${table}`])).rows[0].allowed,false);
      }
    }
  });
  await check('finalized replay verifies batch-owned evidence and never demotes a finished intent merely because its old upload lease expired',async()=>{
    const id=await workOrder();const intent=await begin(actors.contractor,id);await upload(intent);const final=await finalize(await claim(intent));
    await db.query("update public.private_object_uploads set expires_at=clock_timestamp()-interval '1 day' where id=$1",[intent.intentId]);
    assert.equal((await claim(final)).status,'finalized');
    await db.query("update public.activities set event_data=jsonb_set(event_data,'{count}','999') where work_order_id=$1 and event_key='photo_added'",[id]);
    await expectSqlDenial(()=>claim(final),['PT409']);
    await expectSqlDenial(()=>finalize(final),['PT409']);
    assert.equal((await db.query('select status from public.private_object_uploads where id=$1',[intent.intentId])).rows[0].status,'finalized');
  });
  await check('protected metadata and evidence grant no browser/service trigger-installation capability',async()=>{
    for(const table of ['photos','contractor_estimate_attachments','activities']) {
      for(const role of ['authenticated','service_role']) {
        for(const privilege of ['TRIGGER','REFERENCES']) {
          assert.equal((await db.query('select has_table_privilege($1,$2,$3) allowed',[role,`public.${table}`,privilege])).rows[0].allowed,false);
        }
      }
    }
  });
}
