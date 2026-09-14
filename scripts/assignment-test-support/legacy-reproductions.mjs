import assert from 'node:assert/strict';

export const ASSIGNMENT_EVENT_KEYS = ['work_order_assignment', 'work_order_reassigned',
  'work_order_unassigned', 'work_order_rejected', 'work_order_duplicated'];

// These reproduce the actual effective 0126 baseline, not an assumed old audit.
// Every unsafe test is rolled back so later upgrade checks never repair fixtures.
export async function reproduceAssignmentBaseline({ db, actors, check }) {
  const inactiveContractor='74000000-0000-4000-8000-000000000001';
  const notAssignable='74000000-0000-4000-8000-000000000002';
  for (const id of [inactiveContractor,notAssignable]) {
    await db.query('insert into auth.users(id,email) values($1,$2)',[id,`${id}@assignment.example.invalid`]);
    await db.query("update public.profiles set role='contractor',active=$2,is_assignable=$3 where id=$1",
      [id,id !== inactiveContractor,id !== notAssignable]);
  }
  let sequence = 0;
  async function fixture(run, options = {}) {
    const id = `WOT940${String(++sequence).padStart(4, '0')}`;
    const rollback = new Error('Expected isolated baseline rollback');
    try { await db.transaction(async tx => {
      await tx.query(`insert into public.work_orders(id,status,functional_status,contractor_id)
        values($1,$2,$3,$4)`, [id, options.status || 'unassigned', options.functional || 'New', options.owner || null]);
      if (options.prepare) await options.prepare(tx, id);
      await tx.exec(`set local role ${options.role || 'authenticated'}`);
      await tx.query("select set_config('request.jwt.claim.role',$1,true),set_config('request.jwt.claim.sub',$2,true)",
        [options.role || 'authenticated', options.actor === null ? '' : options.actor || actors.mgr]);
      await run(tx,id);
      throw rollback;
    }); } catch (error) { if (error !== rollback) throw error; }
    assert.equal((await db.query('select count(*)::int count from public.work_orders where id=$1',[id])).rows[0].count,0);
  }
  await check('BASELINE existing guards already deny authenticated raw assignment, reassignment and unassignment',async () => {
    for (const [owner,target] of [[null,actors.contractor],[actors.contractor,actors.outsider],[actors.contractor,null]]) {
      await assert.rejects(() => fixture((tx,id) => tx.query('update public.work_orders set contractor_id=$2 where id=$1',[id,target]),
        { owner,status: owner ? 'assigned' : 'unassigned',functional: owner ? 'Dispatched' : 'New' }),error => error.code === '42501');
    }
  });
  await check('BASELINE staff raw archive accepts assigned parent and impersonated deletion author without rejection evidence',async () => {
    await fixture(async (tx,id) => {
      const result = (await tx.query(`update public.work_orders set deleted_at=now(),deleted_by=$2 where id=$1
        returning deleted_at is not null deleted,deleted_by`,[id,actors.contractor])).rows[0];
      assert.deepEqual(result,{ deleted: true,deleted_by: actors.contractor });
      assert.equal((await tx.query("select count(*)::int count from public.activities where work_order_id=$1 and event_key='work_order_rejected'",[id])).rows[0].count,0);
    },{ owner: actors.contractor,status:'assigned',functional:'Dispatched' });
  });
  for (const [targetName,target] of [['inactive contractor',inactiveContractor],['staff profile',actors.mgr],['nonassignable contractor',notAssignable]]) {
    await check(`BASELINE staff directly inserts assigned work order targeting ${targetName} without evidence`,async () => {
      await fixture(async (tx,id) => {
        const inserted = (await tx.query(`insert into public.work_orders(id,status,functional_status,contractor_id)
          values($1,'assigned','Dispatched',$2) returning contractor_id,contractor_assignment_version`,[`${id}-1`,target])).rows[0];
        assert.equal(inserted.contractor_id,target);
        assert.equal(inserted.contractor_assignment_version,1);
        assert.equal((await tx.query('select count(*)::int count from public.activities where work_order_id=$1',[`${id}-1`])).rows[0].count,0);
      });
    });
  }
  await check('BASELINE nonexistent assignment and deletion author fail existing foreign keys',async () => {
    for (const column of ['contractor_id','deleted_by']) {
      await assert.rejects(() => fixture((tx,id) => tx.query(`insert into public.work_orders(id,${column}) values($1,$2)`,
        [`${id}-1`,'74000000-0000-4000-8000-999999999999'])),error => error.code === '23503');
    }
  });
  await check('BASELINE raw assignment version/start edits are silently normalized, not explicit denials',async () => {
    await fixture(async (tx,id) => {
      const before=(await tx.query('select contractor_assignment_started_at,contractor_assignment_version from public.work_orders where id=$1',[id])).rows[0];
      const after=(await tx.query(`update public.work_orders set contractor_assignment_version=999,
        contractor_assignment_started_at=now()-interval '1 year' where id=$1
        returning contractor_assignment_started_at,contractor_assignment_version`,[id])).rows[0];
      assert.deepEqual(after,before);
    });
  });
  await check('BASELINE service raw assignment still denied by lifecycle guard, but raw archive remains permitted',async () => {
    await assert.rejects(() => fixture((tx,id) => tx.query('update public.work_orders set contractor_id=$2 where id=$1',[id,actors.contractor]),
      { role:'service_role',actor:null }),error => error.code === '42501');
    await fixture(async (tx,id) => {
      assert.equal((await tx.query('update public.work_orders set deleted_at=now(),deleted_by=$2 where id=$1 returning id',
        [id,actors.contractor])).rows.length,1);
    },{ role:'service_role',actor:null });
  });
  const archiveHistories = {
    assignment: (tx,id) => tx.query(`insert into public.work_order_assignment_history(work_order_id,contractor_id,assignment_version)
      values($1,$2,1)`,[id,actors.contractor]),
    visit: (tx,id) => tx.query(`insert into public.work_order_visits(work_order_id,contractor_id,checked_in_by,checked_out_by,check_in_at,check_out_at)
      values($1,$2,$2,$2,now()-interval '1 hour',now())`,[id,actors.contractor]),
    // The fixture parent and invoice share one transaction. DEFAULT now() can
    // precede the assignment trigger's clock_timestamp(), so bind the synthetic
    // invoice to the recorded assignment boundary instead of wall-clock timing.
    invoice: (tx,id) => tx.query(`insert into public.invoices(work_order_id,contractor_id,invoice_type,num,state,total,subtotal,invoice_date,created_at)
      select $1,$2,'contractor','SYNTHETIC-ARCHIVE','draft',0,0,'2026-09-08',contractor_assignment_started_at
      from public.work_orders where id=$1`,[id,actors.contractor]),
    completion: (tx,id) => tx.query(`insert into public.activities(work_order_id,author_id,author_name,text,type,event_key)
      values($1,$2,'Synthetic owner','Synthetic historical completion','system','job_completed')`,[id,actors.contractor]),
  };
  for (const [name,prepare] of Object.entries(archiveHistories)) {
    await check(`BASELINE raw archive bypasses ${name} history eligibility`,async () => {
      await fixture(async (tx,id) => {
        assert.equal((await tx.query('update public.work_orders set deleted_at=now(),deleted_by=$2 where id=$1 returning id',
          [id,actors.mgr])).rows.length,1);
      },{ prepare,owner:actors.contractor,status:'assigned',functional:'Dispatched' });
    });
  }
  for (const status of ['completed','pending_invoice','capital']) {
    await check(`BASELINE raw archive bypasses ${status} workflow eligibility`,async () => {
      await fixture(async (tx,id) => {
        assert.equal((await tx.query('update public.work_orders set deleted_at=now(),deleted_by=$2 where id=$1 returning id',
          [id,actors.mgr])).rows.length,1);
      },{ status,functional:status === 'capital' ? 'New' : 'Completed' });
    });
  }
  await check('BASELINE raw predeleted insert accepts caller-selected deletion author',async () => {
    await fixture(async (tx,id) => {
      const inserted = (await tx.query(`insert into public.work_orders(id,status,functional_status,deleted_at,deleted_by,nte,nte_flagged,nte_flag_threshold,nte_flag_amount)
        values($1,'unassigned','New',now(),$2,1000,false,null,null) returning deleted_at is not null deleted,deleted_by`,[`${id}-1`,actors.contractor])).rows[0];
      assert.deepEqual(inserted,{ deleted:true,deleted_by: actors.contractor });
    });
  });
  for (const event of ASSIGNMENT_EVENT_KEYS) {
    await check(`BASELINE staff can forge, edit and soft-delete ${event} activity`,async () => {
      await fixture(async (tx,id) => {
        const activity = (await tx.query(`insert into public.activities(work_order_id,author_id,author_name,text,type,event_key)
          values($1,$2,'Synthetic author','Synthetic forged assignment','system',$3) returning id`,[id,actors.mgr,event])).rows[0];
        assert.ok(activity.id);
        assert.equal((await tx.query("update public.activities set text='Synthetic replacement',deleted_at=now() where id=$1 returning id",[activity.id])).rows.length,1);
      });
    });
  }
  await check('BASELINE staff can forge, alter and remove assignment history',async () => {
    await fixture(async (tx,id) => {
      const row = (await tx.query(`insert into public.work_order_assignment_history(work_order_id,contractor_id,assignment_version,assignment_ended_by)
        values($1,$2,999,$3) returning id`,[id,actors.contractor,actors.outsider])).rows[0];
      assert.equal((await tx.query('update public.work_order_assignment_history set assignment_version=998 where id=$1 returning id',[row.id])).rows.length,1);
      assert.equal((await tx.query('delete from public.work_order_assignment_history where id=$1 returning id',[row.id])).rows.length,1);
    });
  });
  await check('BASELINE authenticated/service SQL roles retain activity TRUNCATE privilege outside PostgREST',async()=>{
    for(const role of ['authenticated','service_role']) {
      assert.equal((await db.query("select has_table_privilege($1,'public.activities','TRUNCATE') allowed",[role])).rows[0].allowed,true);
    }
  });
  await check('BASELINE WIP reassignment receiving-start compatibility probe',async()=>{
    await fixture(async(tx,id)=>{
      const initial=(await tx.query('select contractor_assignment_version from public.work_orders where id=$1',[id])).rows[0];
      const transition=(await tx.query('select public.transition_work_order_contractor($1,$2,$3) result',[id,actors.outsider,initial.contractor_assignment_version])).rows[0].result;
      assert.equal(transition.applied,true);
      const activeVisits=(await tx.query('select count(*)::int count from public.work_order_visits where work_order_id=$1 and check_out_at is null',[id])).rows[0].count;
      const row=(await tx.query('select contractor_assignment_version,workflow_cycle,lifecycle_version from public.work_orders where id=$1',[id])).rows[0];
      await tx.query("select set_config('request.jwt.claim.sub',$1,true)",[actors.outsider]);
      await tx.exec('savepoint receiver_start_probe');
      let outcome='applied';
      try { await tx.query('select public.start_work_order_visit_v1($1,$2,$3,$4,gen_random_uuid(),now(),null)',
        [id,row.contractor_assignment_version,row.workflow_cycle,row.lifecycle_version]); }
      catch(error) { outcome=`${error.code}: ${error.message}`;await tx.exec('rollback to savepoint receiver_start_probe'); }
      console.log(`OBSERVATION baseline WIP reassignment: remaining active visits=${activeVisits}; receiving start=${outcome}`);
      assert.equal(activeVisits,1);assert.ok(outcome.startsWith('PT409:'));
    },{ owner:actors.contractor,status:'wip',functional:'Work in Progress',prepare:(tx,id)=>tx.query(
      `insert into public.work_order_visits(work_order_id,contractor_id,checked_in_by,check_in_at)
       values($1,$2,$2,now()-interval '1 hour')`,[id,actors.contractor]) });
  });
}
