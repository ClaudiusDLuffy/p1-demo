import assert from 'node:assert/strict';

export async function reproduceEmailSecurityBaseline(fixture, check) {
  const { db,as,actors,legacyLog,workOrder,archivedWorkOrder,snapshot,rawDenied,rolledBack,setActor } = fixture;
  for (const actorName of ['inactive','inactiveManager','inactiveBackOffice']) {
    await check(`BASELINE ${actorName} retains log and privileged incident reads with an inactive profile`, async () => {
      const log = await as('authenticated',actors[actorName],tx => tx.query('select id from public.email_intake_log where id=$1',[legacyLog]));
      assert.equal(log.rows.length,1);
      const warnings = await as('authenticated',actors[actorName],tx => tx.query('select * from public.get_incident_reuse_warnings() where work_order_id=$1',[workOrder]));
      assert.equal(warnings.rows.length,1);
      assert.deepEqual(warnings.rows[0].related_work_order_ids,[archivedWorkOrder]);
      assert.equal(warnings.rows[0].crosses_state,true);
    });
  }
  await check('BASELINE deactivation leaves get_my_role unchanged for the same authenticated identity', async () => {
    const role = (await as('authenticated',actors.dispatcher,tx => tx.query('select public.get_my_role() role'))).rows[0].role;
    assert.equal(role,'dispatcher');
    await db.query('update public.profiles set active=false where id=$1',[actors.dispatcher]);
    try {
      assert.equal((await as('authenticated',actors.dispatcher,tx => tx.query('select public.get_my_role() role'))).rows[0].role,role);
      assert.equal((await as('authenticated',actors.dispatcher,tx => tx.query('select id from public.email_intake_log where id=$1',[legacyLog]))).rows.length,1);
    } finally { await db.query('update public.profiles set active=true where id=$1',[actors.dispatcher]); }
  });
  for (const actorName of ['mgr','controller','contractor','admin','report','inactive','inactiveContractor']) {
    await check(`BASELINE ${actorName} can forge an arbitrary intake result without owning a work order or service command`, async () => {
      const before = await snapshot();
      await rolledBack(async tx => {
        await setActor(tx,'authenticated',actors[actorName]);
        // No RETURNING: contractor SELECT is correctly denied even though INSERT succeeds.
        await tx.query(`insert into public.email_intake_log(email_id,action,work_order_id,reason,parse_confidence,contractor_assigned,processed_at)
          values('synthetic-forged','invented-action','WOT-NONEXISTENT','Synthetic forged result','invented-confidence',$1,'2001-01-01')`, [actors.outsider]);
        await tx.exec('reset role');
        assert.equal((await tx.query("select count(*)::int count from public.email_intake_log where email_id='synthetic-forged'")).rows[0].count,1);
      });
      assert.deepEqual(await snapshot(),before);
    });
  }
  await check('BASELINE active contractor log/incident reads and authenticated row updates/deletes are already denied', async () => {
    assert.equal((await as('authenticated',actors.contractor,tx => tx.query('select id from public.email_intake_log'))).rows.length,0);
    assert.equal((await as('authenticated',actors.contractor,tx => tx.query('select * from public.get_incident_reuse_warnings()'))).rows.length,0);
    for (const actor of [actors.mgr,actors.contractor,actors.inactive]) {
      await rawDenied(actor,"update public.email_intake_log set action='forged' where id=$1 returning id",[legacyLog]);
      await rawDenied(actor,'delete from public.email_intake_log where id=$1 returning id',[legacyLog]);
    }
  });
  await check('BASELINE service raw log mutation and deletion succeed with no immutable provenance guard', async () => {
    await rolledBack(async tx => {
      await setActor(tx,'service_role');
      assert.equal((await tx.query("update public.email_intake_log set action='forged-service' where id=$1 returning id",[legacyLog])).rows.length,1);
      assert.equal((await tx.query('delete from public.email_intake_log where id=$1 returning id',[legacyLog])).rows.length,1);
    });
  });
  await check('BASELINE raw same-email inserts have no uniqueness or accepted outcome identity', async () => {
    await rolledBack(async tx => {
      await setActor(tx,'service_role');
      await tx.exec("insert into public.email_intake_log(email_id,action) values('synthetic-duplicate','created'),('synthetic-duplicate','created'),('synthetic-duplicate','failed')");
      assert.equal((await tx.query("select count(*)::int count from public.email_intake_log where email_id='synthetic-duplicate'")).rows[0].count,3);
    });
  });
  await check('BASELINE SQL table TRUNCATE privileges bypass row-policy immutability (not a PostgREST endpoint claim)', async () => {
    for (const role of ['authenticated','service_role']) {
      assert.equal((await db.query("select has_table_privilege($1,'public.email_intake_log','TRUNCATE') allowed",[role])).rows[0].allowed,true);
    }
  });
  await check('BASELINE role helper has no pinned search path while incident RPC does', async () => {
    const rows = (await db.query(`select p.proname,p.proconfig from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname in ('get_my_role','get_incident_reuse_warnings') order by p.proname`)).rows;
    assert.equal(rows.find(row=>row.proname==='get_my_role').proconfig,null);
    assert.ok(rows.find(row=>row.proname==='get_incident_reuse_warnings').proconfig.includes('search_path=public, pg_temp'));
  });
  await check('BASELINE inactive staff bare parts DELETE reaches legacy active-blind policy while targeted DELETE is read-constrained', async () => {
    await rolledBack(async tx => {
      const id = (await tx.query("insert into public.wo_parts(work_order_id,description,created_by) values($1,'Synthetic plain part',$2) returning id",[workOrder,actors.mgr])).rows[0].id;
      await setActor(tx,'authenticated',actors.inactive);
      await tx.query('delete from public.wo_parts where id=$1',[id]);
      await tx.exec('reset role');
      assert.equal((await tx.query('select count(*)::int count from public.wo_parts where id=$1',[id])).rows[0].count,1);
      await setActor(tx,'authenticated',actors.inactive);
      await tx.exec('delete from public.wo_parts');
      await tx.exec('reset role');
      assert.equal((await tx.query('select count(*)::int count from public.wo_parts where id=$1',[id])).rows[0].count,0);
    });
  });
}
