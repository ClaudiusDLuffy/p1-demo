import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

export const LIFECYCLE_FUNCTIONS = {
  eta: 'set_work_order_eta_v1',
  start: 'start_work_order_visit_v1',
  resume: 'resume_work_order_visit_v1',
  pause: 'pause_work_order_for_parts_v1',
  complete: 'complete_work_order_field_v1',
};
export const RESERVED_EVENTS = ['eta_updated', 'check_in', 'check_out', 'job_paused', 'job_completed', 'visit_time_corrected'];

export async function createLifecycleFixtures({ db, as, contractor, mgr, controller, inactive, outsider }) {
  let sequence = 0;
  const stamp = minutes => new Date(Date.now() + minutes * 60_000).toISOString();
  const time = { eta: stamp(60), start: stamp(-50), pause: stamp(-30), resume: stamp(-20), complete: stamp(-10) };
  const company = '61000000-0000-4000-8000-000000000001';
  const identities = {
    canonical: '62000000-0000-4000-8000-000000000001',
    admin: '62000000-0000-4000-8000-000000000002',
    report: '62000000-0000-4000-8000-000000000003',
    invoice: '62000000-0000-4000-8000-000000000004',
    unassigned: '62000000-0000-4000-8000-000000000005',
    former: '62000000-0000-4000-8000-000000000006',
    inactiveContractor: '62000000-0000-4000-8000-000000000007',
  };
  await db.query("insert into public.organizations(id,name,slug,active) values ($1,'Lifecycle Fixture Company','lifecycle-fixture-company',true)", [company]);
  for (const [name, id] of Object.entries(identities)) {
    await db.query('insert into auth.users(id,email) values ($1,$2)', [id, `${name}@lifecycle.example.invalid`]);
    await db.query(`update public.profiles set role='contractor',name=$2,active=true,is_assignable=true,
      contractor_organization_id=$3,contractor_access_level=$4 where id=$1`, [
      id, `Synthetic ${name}`, name === 'inactiveContractor' ? null : company,
      name === 'inactiveContractor' ? null : ['canonical', 'admin'].includes(name) ? 'company_admin' : name === 'invoice' ? 'invoice' : 'report_only',
    ]);
  }
  await db.query('update public.organizations set canonical_contractor_id=$2 where id=$1', [company, identities.canonical]);
  for (const name of ['report', 'invoice', 'unassigned', 'former']) {
    await db.query(`insert into public.contractor_technicians(contractor_id,profile_id,name,is_active)
      values ($1,$2,$3,true)`, [identities.canonical, identities[name], `Synthetic ${name}`]);
  }
  await db.query('update public.profiles set active=false where id=$1', [identities.inactiveContractor]);
  const actors = { contractor, mgr, controller, inactive, outsider, ...identities };

  async function workOrder({ status = 'assigned', functional = 'Dispatched', owner = contractor, technician = null, visit = false } = {}) {
    const id = `WOT92${String(++sequence).padStart(5, '0')}`;
    await db.query(`insert into public.work_orders(
      id,status,functional_status,contractor_id,assigned_technician_profile_id,
      contractor_assignment_started_at,start_time
    ) values ($1,$2,$3,$4,$5,now()-interval '1 day',case when $6 then $7::timestamptz else null end)`,
    [id, status, functional, owner, technician, visit, time.start]);
    if (visit) await db.query(`insert into public.work_order_visits(work_order_id,contractor_id,checked_in_by,check_in_at)
      values ($1,$2,$3,$4)`, [id, owner, technician || owner, time.start]);
    return id;
  }
  async function context(id, operationId = randomUUID()) {
    const row = (await db.query(`select contractor_assignment_version,workflow_cycle,lifecycle_version
      from public.work_orders where id=$1`, [id])).rows[0];
    assert.ok(row, 'Synthetic command target must exist');
    return [id, row.contractor_assignment_version, row.workflow_cycle, Number(row.lifecycle_version), operationId];
  }
  const payloads = {
    eta: () => [time.eta],
    start: () => [time.start, 'Synthetic initial notes'],
    resume: () => [time.resume, 'Synthetic return notes'],
    pause: () => [time.pause, 'Awaiting parts', JSON.stringify([{ description: 'Synthetic motor', partNumber: 'FIXTURE-1', qty: 2, expectedReturnDate: '2026-09-10' }]), 'Synthetic pause notes', null, null],
    complete: () => [time.complete, 'Fixture Make', 'Fixture Model', 'Fixture Serial', 2020, 'Current Asset Repaired', 'Synthetic completion notes'],
  };
  function query(tx, kind, args, payload = payloads[kind]()) {
    assert.ok(Object.hasOwn(LIFECYCLE_FUNCTIONS, kind));
    const values = [...args, ...payload];
    return tx.query(`select public.${LIFECYCLE_FUNCTIONS[kind]}(${values.map((_, index) => `$${index + 1}`).join(',')}) as result`, values);
  }
  async function command(kind, actor, args, payload = payloads[kind](), role = 'authenticated') {
    return (await as(role, actor, tx => query(tx, kind, args, payload))).rows[0].result;
  }
  async function snapshot(id) {
    return (await db.query(`select
      (select to_jsonb(w) from public.work_orders w where w.id=$1) parent,
      (select coalesce(jsonb_agg(to_jsonb(v) order by v.id),'[]') from public.work_order_visits v where v.work_order_id=$1) visits,
      (select coalesce(jsonb_agg(to_jsonb(p) order by p.id),'[]') from public.wo_parts p where p.work_order_id=$1) parts,
      (select coalesce(jsonb_agg(to_jsonb(a) order by a.id),'[]') from public.activities a where a.work_order_id=$1) activities,
      (select coalesce(jsonb_agg(to_jsonb(o) order by o.operation_id),'[]') from public.work_order_lifecycle_operations o where o.work_order_id=$1) operations`, [id])).rows[0];
  }
  async function rejection(fn, codes = ['PT409', '22023', '42501', '23514']) {
    await assert.rejects(fn, error => codes.includes(error.code));
  }
  async function rawDenied(actor, sql, values, id, role = 'authenticated') {
    const before = await snapshot(id);
    try {
      const result = await as(role, actor, tx => tx.query(sql, values));
      assert.equal(result.rows.length, 0, 'Denied RLS update may affect zero visible rows but must not change a target');
    } catch (error) {
      assert.ok(['42501', '23514', 'PT409'].includes(error.code), `Expected authorization denial, got ${error.code}`);
    }
    assert.deepEqual(await snapshot(id), before);
  }
  return { db, as, actors, time, workOrder, context, payloads, query, command, snapshot, rejection, rawDenied };
}
