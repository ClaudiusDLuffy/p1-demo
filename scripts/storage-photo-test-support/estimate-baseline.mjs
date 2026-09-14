import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { expectSqlDenial } from './fixtures.mjs';

export async function reproduceEstimateStorageBaseline(fixture, check) {
  const { db,as,actors,estimate,object,attachEstimate } = fixture;
  await check('estimate upload policy rejects an otherwise valid path when profile name is ordinary text', async () => {
    const own = await estimate(); const path = `${own.id}/${randomUUID()}.xlsx`;
    await expectSqlDenial(() => as('authenticated',actors.contractor,tx => tx.query(
      "insert into storage.objects(bucket_id,name,owner) values ('contractor-estimate-attachments',$1,$2)",
      [path,actors.contractor])),['42501']);
  });
  await check('profile-name shadowing makes estimate upload accept another estimate prefix', async () => {
    const own = await estimate(); const victim = await estimate(actors.outsider);
    const path = `${victim.id}/${randomUUID()}.xlsx`;
    const previous = (await db.query('select name from public.profiles where id=$1',[actors.contractor])).rows[0].name;
    try {
      // This is the actual existing authenticated self-profile edit, not a
      // database-owner policy substitution. The name is synthetic, not secret.
      await as('authenticated',actors.contractor,tx => tx.query(
        'update public.profiles set name=$2 where id=$1',[actors.contractor,own.id]));
      assert.equal((await db.query('select name from public.profiles where id=$1',[actors.contractor])).rows[0].name,own.id);
      await as('authenticated',actors.contractor,tx => tx.query(
        "insert into storage.objects(bucket_id,name,owner) values ('contractor-estimate-attachments',$1,$2)",
        [path,actors.contractor]));
      assert.equal((await db.query("select id from storage.objects where bucket_id='contractor-estimate-attachments' and name=$1",[path])).rows.length,1);
      await expectSqlDenial(() => attachEstimate(actors.contractor,own.id,path),['22023']);
    } finally {
      await as('authenticated',actors.contractor,tx => tx.query('update public.profiles set name=$2 where id=$1',[actors.contractor,previous]));
    }
  });
  await check('estimate attachment validates object existence and canonical prefix', async () => {
    const own = await estimate(); const missing = `${own.id}/${randomUUID()}.xlsx`;
    await expectSqlDenial(() => attachEstimate(actors.contractor,own.id,missing),['P0002']);
    await expectSqlDenial(() => attachEstimate(actors.contractor,own.id,`${randomUUID()}/${randomUUID()}.xlsx`),['22023']);
    assert.equal((await db.query('select id from public.contractor_estimate_attachments where estimate_id=$1',[own.id])).rows.length,0);
  });
  await check('estimate attach trusts claimed MIME/size and ignores actual object owner metadata', async () => {
    const own = await estimate(); const path = `${own.id}/${randomUUID()}.xlsx`;
    await object('contractor-estimate-attachments',path,actors.outsider,{ mimetype:'text/plain',size:30000000 });
    await attachEstimate(actors.contractor,own.id,path,128);
    const row = (await db.query('select uploaded_by,size_bytes,mime_type from public.contractor_estimate_attachments where storage_path=$1',[path])).rows[0];
    assert.equal(row.uploaded_by,actors.contractor);
    assert.equal(Number(row.size_bytes),128);
    assert.equal(row.mime_type,'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    await expectSqlDenial(() => attachEstimate(actors.contractor,own.id,path),['23505']);
  });
  await check('browser estimate metadata writes are denied while service rebinding is unguarded', async () => {
    const own = await estimate(); const path = `${own.id}/${randomUUID()}.xlsx`;
    await object('contractor-estimate-attachments',path);
    await attachEstimate(actors.contractor,own.id,path);
    const id = (await db.query('select id from public.contractor_estimate_attachments where storage_path=$1',[path])).rows[0].id;
    const other = `${randomUUID()}/${randomUUID()}.xlsx`;
    await expectSqlDenial(() => as('authenticated',actors.contractor,tx => tx.query(
      'update public.contractor_estimate_attachments set storage_path=$2 where id=$1',[id,other])),['42501']);
    await as('service_role',null,tx => tx.query('update public.contractor_estimate_attachments set storage_path=$2 where id=$1',[id,other]));
    assert.equal((await db.query('select storage_path from public.contractor_estimate_attachments where id=$1',[id])).rows[0].storage_path,other);
  });
  await check('estimate soft-delete hides the object from filtered cleanup despite the deletion grace policy', async () => {
    const own = await estimate(); const path = `${own.id}/${randomUUID()}.xlsx`;
    await object('contractor-estimate-attachments',path);
    await attachEstimate(actors.contractor,own.id,path);
    const id = (await db.query('select id from public.contractor_estimate_attachments where storage_path=$1',[path])).rows[0].id;
    await as('authenticated',actors.contractor,tx => tx.query('select public.remove_contractor_estimate_file($1)',[id]));
    const removed = await as('authenticated',actors.contractor,tx => tx.query(
      "delete from storage.objects where bucket_id='contractor-estimate-attachments' and name=$1 returning id",[path]));
    assert.equal(removed.rows.length,0);
    await as('authenticated',actors.contractor,tx => tx.query(
      "delete from storage.objects where bucket_id='contractor-estimate-attachments' and name=$1",[path]));
    assert.equal((await db.query("select id from storage.objects where bucket_id='contractor-estimate-attachments' and name=$1",[path])).rows.length,1);
    assert.equal((await as('authenticated',actors.contractor,tx => tx.query(
      'select id from public.contractor_estimate_attachments where id=$1',[id]))).rows.length,1);
    assert.ok((await db.query('select deleted_at from public.contractor_estimate_attachments where id=$1',[id])).rows[0].deleted_at);
  });
  await check('templates and controller archives expose no browser INSERT policy', async () => {
    for (const bucket of ['contractor-estimate-templates','controller-exports']) {
      assert.equal((await db.query('select id from storage.buckets where id=$1',[bucket])).rows.length,1);
      await expectSqlDenial(() => as('authenticated',actors.mgr,tx => tx.query(
        'insert into storage.objects(bucket_id,name,owner) values ($1,$2,$3)',
        [bucket,`${randomUUID()}/synthetic.bin`,actors.mgr])),['42501']);
    }
  });
}
