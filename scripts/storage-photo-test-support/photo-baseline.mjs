import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { expectSqlDenial } from './fixtures.mjs';

export async function reproducePhotoBaseline(fixture, check) {
  const { db,as,actors,workOrder,object,objectRows,photo } = fixture;
  await check('contractor metadata graft makes another contractor photo object readable', async () => {
    const own = await workOrder();
    const victim = await workOrder({ owner:actors.outsider });
    const path = `wo/${victim}/${randomUUID()}.jpg`;
    await object('photos',path,actors.outsider);
    await photo(victim,path,actors.outsider);
    assert.equal((await objectRows(actors.contractor,'photos',path)).length,0);
    await photo(own,path);
    assert.equal((await objectRows(actors.contractor,'photos',path)).length,1);
  });
  await check('a forged own-parent photo binding also permits deleting the foreign object row', async () => {
    const own = await workOrder(); const victim = await workOrder({ owner:actors.outsider });
    const path = `wo/${victim}/${randomUUID()}.jpg`;
    await object('photos',path,actors.outsider); await photo(victim,path,actors.outsider);
    await photo(own,path);
    const removed = await as('authenticated',actors.contractor,tx => tx.query(
      "delete from storage.objects where bucket_id='photos' and name=$1 returning id",[path]));
    assert.equal(removed.rows.length,1);
    assert.equal((await db.query('select id from public.photos where storage_path=$1',[path])).rows.length,2);
  });
  await check('a current report-only technician can graft another technician work-order photo in the same company', async () => {
    const own = await workOrder({ owner:actors.canonical,technician:actors.report });
    const victim = await workOrder({ owner:actors.canonical,technician:actors.invoice });
    const path = `wo/${victim}/${randomUUID()}.jpg`;
    await object('photos',path,actors.invoice); await photo(victim,path,actors.invoice);
    assert.equal((await objectRows(actors.report,'photos',path)).length,0);
    await photo(own,path,actors.report);
    assert.equal((await objectRows(actors.report,'photos',path)).length,1);
  });
  await check('photo metadata can bind one object to multiple parents and duplicate the same binding', async () => {
    const first = await workOrder();
    const second = await workOrder();
    const path = `wo/${first}/${randomUUID()}.jpg`;
    await object('photos',path);
    await photo(first,path); await photo(second,path); await photo(second,path);
    assert.equal((await db.query('select id from public.photos where storage_path=$1',[path])).rows.length,3);
  });
  await check('photo metadata accepts missing objects and arbitrary URL-shaped paths', async () => {
    const own = await workOrder();
    await photo(own,`wo/${own}/${randomUUID()}.jpg`);
    await photo(own,'https://synthetic.example.invalid/not-a-storage-object.jpg');
    assert.equal((await db.query('select id from public.photos where work_order_id=$1',[own])).rows.length,2);
  });
  await check('operational staff can insert a Storage object row for a nonexistent photo parent prefix', async () => {
    const path = `wo/WOT-NONEXISTENT-${randomUUID()}/${randomUUID()}.jpg`;
    await as('authenticated',actors.mgr,tx => tx.query(
      "insert into storage.objects(bucket_id,name,owner) values ('photos',$1,$2)",[path,actors.mgr]));
    assert.equal((await objectRows(actors.mgr,'photos',path)).length,1);
    await expectSqlDenial(() => photo(`WOT-NONEXISTENT-${randomUUID()}`,path,actors.mgr),['23503']);
  });
  await check('contractor upload to another work-order prefix is already denied', async () => {
    const victim = await workOrder({ owner:actors.outsider });
    await expectSqlDenial(() => as('authenticated',actors.contractor,tx => tx.query(
      "insert into storage.objects(bucket_id,name,owner) values ('photos',$1,$2)",
      [`wo/${victim}/${randomUUID()}.jpg`,actors.contractor])),['42501']);
  });
  await check('authenticated metadata update is denied while service raw rebinding is allowed', async () => {
    const own = await workOrder(); const victim = await workOrder({ owner:actors.outsider });
    const original = `wo/${own}/${randomUUID()}.jpg`;
    const foreign = `wo/${victim}/${randomUUID()}.jpg`;
    const id = await photo(own,original);
    const changed = await as('authenticated',actors.contractor,tx => tx.query(
      'update public.photos set storage_path=$2 where id=$1 returning id',[id,foreign]));
    assert.equal(changed.rows.length,0);
    await as('service_role',null,tx => tx.query('update public.photos set storage_path=$2 where id=$1',[id,foreign]));
    assert.equal((await db.query('select storage_path from public.photos where id=$1',[id])).rows[0].storage_path,foreign);
  });
  await check('staff photo insert can impersonate another uploader; contractor insert cannot', async () => {
    const own = await workOrder(); const path = `wo/${own}/${randomUUID()}.jpg`;
    await as('authenticated',actors.mgr,tx => tx.query(`insert into public.photos
      (work_order_id,storage_path,uploader_id,uploader_name) values ($1,$2,$3,'Synthetic forged actor')`,[own,path,actors.outsider]));
    await expectSqlDenial(() => as('authenticated',actors.contractor,tx => tx.query(`insert into public.photos
      (work_order_id,storage_path,uploader_id) values ($1,$2,$3)`,[own,path,actors.outsider])),['42501']);
  });
  await check('metadata-first photo removal loses contractor object-delete authorization', async () => {
    const own = await workOrder(); const path = `wo/${own}/${randomUUID()}.jpg`;
    await object('photos',path); const id = await photo(own,path);
    assert.equal((await objectRows(actors.contractor,'photos',path)).length,1);
    const removed = await as('authenticated',actors.contractor,tx => tx.query('delete from public.photos where id=$1 returning id',[id]));
    assert.equal(removed.rows.length,1);
    const objects = await as('authenticated',actors.contractor,tx => tx.query(
      "delete from storage.objects where bucket_id='photos' and name=$1 returning id",[path]));
    assert.equal(objects.rows.length,0);
    assert.equal((await db.query("select id from storage.objects where bucket_id='photos' and name=$1",[path])).rows.length,1);
  });
  await check('committed upload remains after later metadata insert failure', async () => {
    const own = await workOrder(); const path = `wo/${own}/${randomUUID()}.jpg`;
    await as('authenticated',actors.contractor,tx => tx.query(
      "insert into storage.objects(bucket_id,name,owner) values ('photos',$1,$2)",[path,actors.contractor]));
    await expectSqlDenial(() => as('authenticated',actors.contractor,tx => tx.query(`insert into public.photos
      (work_order_id,storage_path,uploader_id) values ($1,null,$2)`,[own,actors.contractor])),['23502']);
    assert.equal((await db.query("select id from storage.objects where bucket_id='photos' and name=$1",[path])).rows.length,1);
    assert.equal((await db.query('select id from public.photos where storage_path=$1',[path])).rows.length,0);
  });
  await check('inactive and unassigned actors cannot read a correctly bound contractor photo', async () => {
    const own = await workOrder(); const path = `wo/${own}/${randomUUID()}.jpg`;
    await object('photos',path); await photo(own,path);
    for (const actor of [actors.inactive,actors.inactiveContractor,actors.unassigned]) {
      assert.equal((await objectRows(actor,'photos',path)).length,0);
    }
  });
  await check('anonymous, inactive and unassigned Storage photo insertions are denied', async () => {
    const own = await workOrder();
    for (const [role,actor] of [['anon',null],['authenticated',actors.inactive],
      ['authenticated',actors.inactiveContractor],['authenticated',actors.unassigned]]) {
      await expectSqlDenial(() => as(role,actor,tx => tx.query(
        "insert into storage.objects(bucket_id,name,owner) values ('photos',$1,$2)",
        [`wo/${own}/${randomUUID()}.jpg`,actor])),['42501']);
    }
  });
}
