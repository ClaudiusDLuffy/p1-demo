import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { expectSqlDenial } from './fixtures.mjs';

export async function verifyPhotoRoleAndPathMatrix(fixture, check) {
  const {db,as,actors,workOrder}=fixture;
  const file={name:'Synthetic.jpg',mimeType:'image/jpeg',sizeBytes:128,sha256:'a'.repeat(64)};
  const inspection={format:'jpeg',mimeType:'image/jpeg',extension:'jpg',sizeBytes:128,
    sha256:file.sha256,width:10,height:10,frames:1};
  const staff=[['manager',actors.mgr],['invoice_controller',actors.controller],['quickbooks_handoff',actors.handoff]];
  for(const role of ['dispatcher','back_office']) {
    const id=randomUUID();
    await db.query('insert into auth.users(id,email) values ($1,$2)',[id,`synthetic-${role}@storage.example.invalid`]);
    await db.query('update public.profiles set role=$2,active=true,name=$3 where id=$1',[id,role,`Synthetic ${role}`]);
    staff.push([role,id]);
  }
  async function begin(actor,id) {
    const row=(await db.query('select contractor_assignment_version,workflow_cycle from public.work_orders where id=$1',[id])).rows[0];
    return (await as('authenticated',actor,tx=>tx.query('select public.begin_work_order_photo_upload_v1($1,$2,$3,$4,$5,$6) result',
      [id,randomUUID(),randomUUID(),row.contractor_assignment_version,row.workflow_cycle,JSON.stringify(file)]))).rows[0].result;
  }
  async function upload(actor,intent,{bucket=intent.bucket,path=intent.objectPath,owner=actor}={}) {
    return as('authenticated',actor,tx=>tx.query('insert into storage.objects(bucket_id,name,owner) values ($1,$2,$3)',[bucket,path,owner]));
  }
  async function finish(actor,intent) {
    const claim=(await as('authenticated',actor,tx=>tx.query('select public.claim_private_object_upload_v1($1) result',[intent.intentId]))).rows[0].result;
    return (await as('service_role',null,tx=>tx.query('select public.finalize_private_object_upload_v1($1,$2,$3) result',
      [claim.intentId,claim.claimId,JSON.stringify(inspection)]))).rows[0].result;
  }
  for(const [label,actor] of staff) {
    await check(`active ${label} preserves legitimate photo access and derived staff audit without a new 7-Eleven alert`,async()=>{
      const id=await workOrder();const intent=await begin(actor,id);await upload(actor,intent);const ready=await finish(actor,intent);
      assert.equal((await fixture.objectRows(actor,ready.bucket,ready.objectPath)).length,1);
      const activity=(await db.query(`select author_id,entered_by_role,type,activity_channel,is_staff_override,
        override_for_contractor_id,requires_7eleven_sync from public.activities
        where work_order_id=$1 and event_key='photo_added'`,[id])).rows[0];
      assert.equal(activity.author_id,actor);assert.equal(activity.type,'note');
      assert.equal(activity.activity_channel,'system_event');assert.equal(activity.requires_7eleven_sync,false);
      assert.equal(activity.is_staff_override,true);assert.equal(activity.override_for_contractor_id,actors.contractor);
      await as('authenticated',actor,tx=>tx.query('select public.request_private_object_delete_v1($1,$2)',[ready.bindingId,randomUUID()]));
    });
  }
  let ready;
  await check('standalone contractor, canonical administrator and current linked report/invoice technicians finalize their own authorized photos',async()=>{
    for(const [actor,options] of [[actors.contractor,{}],[actors.canonical,{owner:actors.canonical}],
      [actors.report,{owner:actors.canonical,technician:actors.report}],[actors.invoice,{owner:actors.canonical,technician:actors.invoice}]]) {
      const id=await workOrder(options);const intent=await begin(actor,id);await upload(actor,intent);ready=await finish(actor,intent);
      assert.equal((await fixture.objectRows(actor,ready.bucket,ready.objectPath)).length,1);
      const activity=(await db.query(`select author_id,type,activity_channel,is_staff_override,requires_7eleven_sync
        from public.activities where work_order_id=$1 and event_key='photo_added'`,[id])).rows[0];
      assert.equal(activity.author_id,actor);assert.equal(activity.type,'note');assert.equal(activity.activity_channel,'system_event');
      assert.equal(activity.is_staff_override,false);assert.equal(activity.requires_7eleven_sync,false);
    }
  });
  await check('anonymous and missing-profile identities cannot begin, claim or read canonical photo metadata and objects',async()=>{
    for(const [role,actor] of [['anon',null],['authenticated',randomUUID()]]) {
      await expectSqlDenial(()=>as(role,actor,tx=>tx.query('select public.begin_work_order_photo_upload_v1($1,$2,$3,$4,$5,$6)',
        [ready.workOrderId,randomUUID(),randomUUID(),1,1,JSON.stringify(file)])),['42501']);
      await expectSqlDenial(()=>as(role,actor,tx=>tx.query('select public.claim_private_object_upload_v1($1)',[ready.intentId])),['42501']);
      try {assert.equal((await as(role,actor,tx=>tx.query('select id from storage.objects where bucket_id=$1 and name=$2',
        [ready.bucket,ready.objectPath]))).rows.length,0);}
      catch(error){if(error.code!=='42501') throw error;}
      try {assert.equal((await as(role,actor,tx=>tx.query('select id from public.photos where id=$1',[ready.photoId]))).rows.length,0);}
      catch(error){if(error.code!=='42501') throw error;}
    }
  });
  await check('inactive, other-company, unassigned and former technicians cannot read another current technician photo',async()=>{
    for(const actor of [actors.inactive,actors.inactiveContractor,actors.outsider,actors.unassigned,actors.former,actors.report,actors.admin]) {
      assert.equal((await fixture.objectRows(actor,ready.bucket,ready.objectPath)).length,0);
      assert.equal((await as('authenticated',actor,tx=>tx.query('select id from public.photos where id=$1',[ready.photoId]))).rows.length,0);
    }
  });
  await check('staff, contractor and raw service cannot graft, reparent, impersonate uploader or delete canonical photo metadata',async()=>{
    const other=await workOrder();
    for(const [role,actor] of [['authenticated',actors.mgr],['authenticated',actors.invoice],['service_role',null]]) {
      for(const [sql,args] of [
        ['insert into public.photos(work_order_id,storage_path,uploader_id,uploader_name) values ($1,$2,$3,$4)',[other,ready.objectPath,actors.outsider,'Synthetic impostor']],
        ['update public.photos set work_order_id=$2 where id=$1 returning id',[ready.photoId,other]],
        ['update public.photos set storage_path=$2 where id=$1 returning id',[ready.photoId,'wo/other/grafted']],
        ['update public.photos set uploader_id=$2 where id=$1 returning id',[ready.photoId,actors.outsider]],
        ['delete from public.photos where id=$1 returning id',[ready.photoId]],
      ]) await expectSqlDenial(()=>as(role,actor,tx=>tx.query(sql,args)),['42501']);
    }
    assert.equal((await db.query('select id from public.photos where id=$1',[ready.photoId])).rows.length,1);
  });
  await check('Storage INSERT requires the exact actor, owner, sibling, bucket, live pending intent and assignment snapshot',async()=>{
    const id=await workOrder();const intent=await begin(actors.contractor,id);
    await expectSqlDenial(()=>upload(actors.mgr,intent),['42501']);
    await expectSqlDenial(()=>upload(actors.outsider,intent),['42501']);
    await expectSqlDenial(()=>upload(actors.contractor,intent,{owner:actors.mgr}),['42501']);
    await expectSqlDenial(()=>upload(actors.contractor,intent,{path:`${intent.objectPath}-sibling`}),['42501']);
    await expectSqlDenial(()=>upload(actors.contractor,intent,{bucket:'invoices'}),['42501']);
    await db.query("update public.private_object_uploads set expires_at=clock_timestamp()-interval '1 second' where id=$1",[intent.intentId]);
    await expectSqlDenial(()=>upload(actors.contractor,intent),['42501']);
    const current=await begin(actors.contractor,id);
    await db.query('update public.work_orders set contractor_id=$2 where id=$1',[id,actors.outsider]);
    await expectSqlDenial(()=>upload(actors.contractor,current),['42501']);
    assert.equal((await db.query('select id from storage.objects where name=any($1::text[])',[[intent.objectPath,current.objectPath]])).rows.length,0);
  });
}
