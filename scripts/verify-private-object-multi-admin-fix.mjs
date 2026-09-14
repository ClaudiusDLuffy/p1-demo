// Disposable synthetic PostgreSQL verification only. This script never reads
// environment files, connects to Supabase, or handles Storage object bytes.
import './pagination-test-support/syntheticSqlPrivacy.mjs';

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createDatabase, repo } from './receiving-dispatch-test-support/fixtures.mjs';
import { readMigrationInventory } from './migration-inventory.mjs';
import { actorTransactions, applyFixtureMigration } from './lifecycle-test-support/engine-fixtures.mjs';
import { migrationStatements } from './invoice-test-support/migration-statements.mjs';

const db = await createDatabase();
const as = actorTransactions(db);
const migrations = readMigrationInventory(repo);
const migrationNumber = name => Number(name.slice(0, 4));
const correctiveMigration = '0150_restore_multi_admin_private_object_access.sql';

const organization = '51000000-0000-4000-8000-000000000001';
const canonical = '51000000-0000-4000-8000-000000000002';
const secondAdmin = '51000000-0000-4000-8000-000000000003';
const outsider = '51000000-0000-4000-8000-000000000004';
const workOrder = 'WOTMULTIADMIN01';
const file = {
  name: 'synthetic-photo.jpg',
  mimeType: 'image/jpeg',
  sizeBytes: 128,
  sha256: 'a'.repeat(64),
};

async function apply(name) {
  await applyFixtureMigration({ db, repo, name, statements: migrationStatements });
}

async function actorAccess(actor, invoiceCapable = false) {
  return (await db.query(
    'select public.private_object_actor_access($1,$2,$3) allowed',
    [actor, workOrder, invoiceCapable],
  )).rows[0].allowed;
}

async function snapshot() {
  const result = {};
  for (const table of ['profiles', 'organizations', 'work_orders', 'private_object_uploads', 'private_object_photo_batches']) {
    result[table] = (await db.query(
      `select to_jsonb(row) data from public.${table} row order by to_jsonb(row)::text`,
    )).rows;
  }
  return result;
}

async function beginPhoto() {
  const parent = (await db.query(
    'select contractor_assignment_version,workflow_cycle from public.work_orders where id=$1',
    [workOrder],
  )).rows[0];
  return as('authenticated', secondAdmin, tx => tx.query(
    'select public.begin_work_order_photo_upload_v1($1,$2,$3,$4,$5,$6) result',
    [workOrder, randomUUID(), randomUUID(), parent.contractor_assignment_version, parent.workflow_cycle, JSON.stringify(file)],
  ));
}

try {
  for (const name of migrations.filter(name => migrationNumber(name) <= 149)) await apply(name);

  await db.query(
    "insert into public.organizations(id,name,slug,active) values ($1,'Synthetic Multi Admin','synthetic-multi-admin',true)",
    [organization],
  );
  for (const [id, name] of [[canonical, 'Canonical contractor'], [secondAdmin, 'Second company admin'], [outsider, 'Outside contractor']]) {
    await db.query('insert into auth.users(id,email) values ($1,$2)', [id, `${id}@example.invalid`]);
    await db.query("update public.profiles set name=$2,role='contractor',active=true where id=$1", [id, name]);
  }
  await db.query(
    "update public.profiles set contractor_organization_id=$1,contractor_access_level='company_admin' where id in ($2,$3)",
    [organization, canonical, secondAdmin],
  );
  await db.query('update public.organizations set canonical_contractor_id=$1 where id=$2', [canonical, organization]);
  await db.query(
    "insert into public.work_orders(id,contractor_id,status,functional_status) values ($1,$2,'assigned','Dispatched')",
    [workOrder, canonical],
  );

  assert.equal(await actorAccess(canonical), true, 'the canonical company profile starts authorized');
  assert.equal(await actorAccess(secondAdmin), false, '0149 reproduces the non-canonical company-admin regression');
  assert.equal(await actorAccess(secondAdmin, true), false, '0149 also blocks invoice-capable attachment access');
  assert.equal(await actorAccess(outsider), false, 'another contractor remains outside the company wall');
  await assert.rejects(beginPhoto, error => error.code === '42501' && /Object access is not permitted/.test(error.message));

  const before = await snapshot();
  await apply(correctiveMigration);
  assert.deepEqual(await snapshot(), before, '0150 must not rewrite any existing business or upload rows');

  assert.equal(await actorAccess(canonical), true);
  assert.equal(await actorAccess(secondAdmin), true, '0150 restores company-wide photo authorization');
  assert.equal(await actorAccess(secondAdmin, true), true, '0150 restores company-admin attachment authorization');
  assert.equal(await actorAccess(outsider), false, '0150 does not cross the contractor-company wall');

  const created = (await beginPhoto()).rows[0].result;
  assert.equal(created.status, 'pending');
  assert.equal(created.workOrderId, workOrder);
  assert.equal((await db.query(
    'select actor_id,purpose,work_order_id from public.private_object_uploads where id=$1',
    [created.intentId],
  )).rows[0].actor_id, secondAdmin);

  await db.query('update public.profiles set active=false where id=$1', [canonical]);
  assert.equal(await actorAccess(secondAdmin), false, 'an inactive canonical account fails closed');

  console.log(JSON.stringify({
    suite: 'private-object-multi-admin-fix',
    migrationsApplied: 151,
    reproducedSqlState: '42501',
    existingRowsChangedByMigration: 0,
    secondAdminPhotoIntent: 'pending',
    crossCompanyAccess: false,
    inactiveCanonicalAccess: false,
    externalCalls: 0,
    passed: true,
  }));
} finally {
  await db.close();
}
