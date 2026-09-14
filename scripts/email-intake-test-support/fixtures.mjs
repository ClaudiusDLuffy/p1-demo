import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createLifecycleFixtures } from '../lifecycle-test-support/command-fixtures.mjs';

export async function createEmailSecurityFixtures({ db, as, actors }) {
  const lifecycle = await createLifecycleFixtures({ db, as, ...actors });
  const identities = lifecycle.actors;
  for (const [name, role, active] of [
    ['dispatcher','dispatcher',true], ['backOffice','back_office',true],
    ['handoff','back_office',true], ['inactiveManager','manager',false],
    ['inactiveBackOffice','back_office',false],
  ]) {
    const id = randomUUID();
    await db.query('insert into auth.users(id,email) values($1,$2)', [id,`${name}@intake.example.invalid`]);
    await db.query('update public.profiles set role=$2,active=$3,name=$4 where id=$1', [id,role,active,`Synthetic ${name}`]);
    identities[name] = id;
  }
  await db.query("insert into public.staff_permission_grants(profile_id,permission) values($1,'quickbooks_handoff')", [identities.handoff]);
  const incident = 'SYNTHETIC-INTAKE-INCIDENT';
  const workOrder = 'WOT9600001';
  const archivedWorkOrder = 'WOT9600002';
  await db.query(`insert into public.work_orders(id,status,functional_status,incident_id,store_state)
    values($1,'unassigned','New',$3,'VA'),($2,'unassigned','New',$3,'FL')`, [workOrder,archivedWorkOrder,incident]);
  await db.query('update public.work_orders set deleted_at=clock_timestamp(),deleted_by=$2 where id=$1', [archivedWorkOrder,identities.mgr]);
  const legacyLog = (await db.query(`insert into public.email_intake_log(email_id,subject,action,work_order_id,reason,parse_confidence)
    values('synthetic-legacy-email','Synthetic safe subject','created',$1,'Synthetic legacy result','high') returning id`, [workOrder])).rows[0].id;
  async function snapshot() {
    return (await db.query("select coalesce(jsonb_agg(to_jsonb(l) order by l.id),'[]') rows from public.email_intake_log l")).rows[0].rows;
  }
  async function rawDenied(actor, sql, values = [], role = 'authenticated') {
    const before = await snapshot();
    try {
      const result = await as(role,actor,tx => tx.query(sql,values));
      assert.equal(result.rows.length,0,'Denied invisible row mutation may return zero rows, never a changed target');
    } catch (error) {
      assert.ok(['42501','23514','PT409'].includes(error.code),`Expected denial, received ${error.code}`);
    }
    assert.deepEqual(await snapshot(),before,'Denied log write must preserve all history');
  }
  async function rolledBack(run) {
    const rollback = new Error('Expected isolated intake fixture rollback');
    try { await db.transaction(async tx => { await run(tx); throw rollback; }); }
    catch (error) { if (error !== rollback) throw error; }
  }
  async function setActor(tx, role, actor = null) {
    assert.ok(['anon','authenticated','service_role'].includes(role));
    await tx.exec(`set local role ${role}`);
    await tx.query("select set_config('request.jwt.claim.role',$1,true),set_config('request.jwt.claim.sub',$2,true)", [role,actor || '']);
  }
  return { db,as,actors:identities,lifecycle,workOrder,archivedWorkOrder,incident,legacyLog,snapshot,rawDenied,rolledBack,setActor };
}
