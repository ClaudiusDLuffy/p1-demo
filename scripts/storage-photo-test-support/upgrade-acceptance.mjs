import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { expectSqlDenial } from './fixtures.mjs';

export async function verifyStorageUpgrade({db,fixture,applyNumber,check}) {
  const {as,actors,workOrder,object,photo,objectRows}=fixture;
  const legacy=[];
  for(const extension of ['heic','heif','bmp']) {
    const id=await workOrder();const path=`wo/${id}/legacy-synthetic.${extension}`;
    const objectId=await object('photos',path,actors.contractor,{mimetype:`image/${extension}`,size:128});
    const photoId=await photo(id,path);
    legacy.push({id,path,objectId,photoId});
  }
  const before=(await db.query('select to_jsonb(o) object from storage.objects o where id=any($1::uuid[]) order by id',
    [legacy.map(item=>item.objectId)])).rows;
  const photoMetadataBefore=(await db.query('select to_jsonb(p) photo from public.photos p where id=any($1::uuid[]) order by id',
    [legacy.map(item=>item.photoId)])).rows;
  await applyNumber(131);
  await check('expansion keeps legitimate legacy formats and reads unchanged',async()=>{
    for(const row of legacy) assert.equal((await objectRows(actors.contractor,'photos',row.path)).length,1);
    assert.equal((await db.query('select enforced from public.private_object_control')).rows[0].enforced,false);
  });
  await check('expansion enables canonical estimate intent upload without depending on the old name-shadowed policy',async()=>{
    const parent=await fixture.estimate();
    const file={name:'Synthetic.xlsx',mimeType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',sizeBytes:128,sha256:'e'.repeat(64)};
    const intent=(await as('authenticated',actors.contractor,tx=>tx.query('select public.begin_contractor_attachment_upload_v1($1,$2,$3,$4) result',
      [parent.id,'estimate_attachment',randomUUID(),JSON.stringify(file)]))).rows[0].result;
    await as('authenticated',actors.contractor,tx=>tx.query('insert into storage.objects(bucket_id,name,owner) values ($1,$2,$3)',
      [intent.bucket,intent.objectPath,actors.contractor]));
    assert.equal((await db.query('select id from storage.objects where bucket_id=$1 and name=$2',[intent.bucket,intent.objectPath])).rows.length,1);
  });
  await check('unreviewed legacy records stop contraction without changing existing policy/control state',async()=>{
    await expectSqlDenial(()=>applyNumber(132),['23514']);
    await db.exec('rollback');
    assert.equal((await db.query('select enforced from public.private_object_control')).rows[0].enforced,false);
    for(const row of legacy) assert.equal((await objectRows(actors.contractor,'photos',row.path)).length,1);
  });
  await check('legacy mapping requires explicit owner review and cannot be browser or service fabricated',async()=>{
    const row=legacy[0];
    for(const [role,actor] of [['authenticated',actors.mgr],['service_role',null]]) {
      await expectSqlDenial(()=>as(role,actor,tx=>tx.query('select public.register_verified_legacy_object_v1($1,$2,$3,$4)',
        ['photo',row.photoId,row.objectId,'Synthetic owner review CASE-001'])),['42501']);
    }
    await expectSqlDenial(()=>db.query('select public.register_verified_legacy_object_v1($1,$2,$3,$4)',
      ['photo',row.photoId,legacy[1].objectId,'Synthetic mismatched object review']),['PT409']);
    for(const [index,item] of legacy.entries()) {
      const values=['photo',item.photoId,item.objectId,`Synthetic owner review CASE-${index+1}`];
      const first=(await db.query('select public.register_verified_legacy_object_v1($1,$2,$3,$4) result',values)).rows[0].result;
      const again=(await db.query('select public.register_verified_legacy_object_v1($1,$2,$3,$4) result',values)).rows[0].result;
      assert.equal(first.bindingId,again.bindingId);
    }
  });
  await applyNumber(132);
  await check('reviewed legacy HEIC/HEIF/BMP remain readable after contraction without rewriting or decoding existing objects',async()=>{
    assert.equal((await db.query('select enforced from public.private_object_control')).rows[0].enforced,true);
    for(const row of legacy) assert.equal((await objectRows(actors.contractor,'photos',row.path)).length,1);
    assert.deepEqual((await db.query('select to_jsonb(o) object from storage.objects o where id=any($1::uuid[]) order by id',
      [legacy.map(item=>item.objectId)])).rows,before);
    assert.deepEqual((await db.query('select to_jsonb(p) photo from public.photos p where id=any($1::uuid[]) order by id',
      [legacy.map(item=>item.photoId)])).rows,photoMetadataBefore);
    assert.deepEqual((await db.query("select allowed_mime_types from storage.buckets where id='photos'")).rows[0].allowed_mime_types,
      ['image/jpeg','image/png','image/webp','image/gif','image/tiff']);
    for(const row of legacy) await expectSqlDenial(()=>photo(row.id,`${row.path}.new`),['42501']);
  });
}
