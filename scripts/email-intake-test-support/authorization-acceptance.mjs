import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { receiptTools } from './receipt-acceptance.mjs';

export async function verifyActiveEmailAuthorization(fixture,check) {
  const { db,as,actors,legacyLog,workOrder,archivedWorkOrder,rolledBack,setActor }=fixture;
  for(const name of ['mgr','dispatcher','backOffice','controller','handoff']) {
    await check(`Active ${name} retains intake and incident read contract including archived sibling identity`,async()=>{
      const rows=(await as('authenticated',actors[name],tx=>tx.query('select id from public.email_intake_log where id=$1',[legacyLog]))).rows;
      assert.equal(rows.length,1);
      const warning=(await as('authenticated',actors[name],tx=>tx.query('select * from public.get_incident_reuse_warnings() where work_order_id=$1',[workOrder]))).rows[0];
      assert.deepEqual(warning,{work_order_id:workOrder,incident_id:fixture.incident,related_work_order_ids:[archivedWorkOrder],crosses_state:true});
    });
  }
  for(const name of ['inactive','inactiveManager','inactiveBackOffice','contractor','canonical','admin','report','invoice','former','unassigned','outsider','inactiveContractor']) {
    await check(`${name} cannot read staff intake evidence or privileged incident relationships`,async()=>{
      assert.equal((await as('authenticated',actors[name],tx=>tx.query('select id from public.email_intake_log'))).rows.length,0);
      assert.equal((await as('authenticated',actors[name],tx=>tx.query('select * from public.get_incident_reuse_warnings()'))).rows.length,0);
    });
  }
  await check('Deactivation and reactivation take effect with the same authenticated identity and no token change',async()=>{
    const id=actors.dispatcher;
    assert.equal((await as('authenticated',id,tx=>tx.query('select public.get_my_role() role'))).rows[0].role,'dispatcher');
    await db.query('update public.profiles set active=false where id=$1',[id]);
    try {
      assert.equal((await as('authenticated',id,tx=>tx.query('select public.get_my_role() role'))).rows[0].role,null);
      assert.equal((await as('authenticated',id,tx=>tx.query('select id from public.email_intake_log'))).rows.length,0);
      assert.equal((await as('authenticated',id,tx=>tx.query('select * from public.get_incident_reuse_warnings()'))).rows.length,0);
      // Login/profile hydration can still discover its own disabled profile.
      assert.deepEqual((await as('authenticated',id,tx=>tx.query('select id,active from public.profiles where id=$1',[id]))).rows,[{id,active:false}]);
    } finally { await db.query('update public.profiles set active=true where id=$1',[id]); }
    assert.equal((await as('authenticated',id,tx=>tx.query('select id from public.email_intake_log where id=$1',[legacyLog]))).rows.length,1);
  });
  await check('Role change and profile removal revoke staff reads for the same retained authenticated identity',async()=>{
    const id=randomUUID();
    await db.query('insert into auth.users(id,email) values($1,$2)',[id,'synthetic-retained-session@intake.example.invalid']);
    await db.query("update public.profiles set role='dispatcher',active=true where id=$1",[id]);
    assert.equal((await as('authenticated',id,tx=>tx.query('select id from public.email_intake_log where id=$1',[legacyLog]))).rows.length,1);
    await db.query("update public.profiles set role='contractor' where id=$1",[id]);
    assert.equal((await as('authenticated',id,tx=>tx.query('select public.get_my_role() role'))).rows[0].role,'contractor');
    assert.equal((await as('authenticated',id,tx=>tx.query('select id from public.email_intake_log'))).rows.length,0);
    assert.equal((await as('authenticated',id,tx=>tx.query('select * from public.get_incident_reuse_warnings()'))).rows.length,0);
    await db.query('delete from public.profiles where id=$1',[id]);
    assert.equal((await as('authenticated',id,tx=>tx.query('select public.get_my_role() role'))).rows[0].role,null);
    assert.equal((await as('authenticated',id,tx=>tx.query('select id from public.email_intake_log'))).rows.length,0);
  });
  await check('Actorless service incident lookup remains empty; missing authenticated profile gains no staff authority',async()=>{
    for(const [role,id] of [['service_role',null],['authenticated',randomUUID()],['authenticated',null]]) {
      assert.equal((await as(role,id,tx=>tx.query('select * from public.get_incident_reuse_warnings()'))).rows.length,0);
      assert.equal((await as(role,id,tx=>tx.query('select public.get_my_role() role'))).rows[0].role,null);
    }
  });
  await check('Anonymous intake SELECT and reviewed role/incident routines are denied explicitly',async()=>{
    for(const sql of ['select * from public.email_intake_log','select public.get_my_role()',
      'select * from public.get_incident_reuse_warnings()']) {
      await assert.rejects(()=>as('anon',null,tx=>tx.query(sql)),error=>error.code==='42501');
    }
    await assert.rejects(()=>as('anon',null,tx=>tx.query('select public.is_staff() allowed')),error=>error.code==='42501',
      'The existing global staff predicate also denies anonymous execution; this batch does not broaden it');
  });
  await check('Untrusted role/active claims cannot override the current contractor profile',async()=>{
    await as('authenticated',actors.contractor,async tx=>{
      await tx.query("select set_config('request.jwt.claims',$1,true),set_config('p1.active','true',true),set_config('p1.role','manager',true)",
        [JSON.stringify({role:'manager',active:true,app_metadata:{role:'manager',active:true}})]);
      assert.equal((await tx.query('select public.get_my_role() role,public.is_staff() staff')).rows[0].role,'contractor');
      assert.equal((await tx.query('select public.is_staff() allowed')).rows[0].allowed,false);
      assert.equal((await tx.query('select id from public.email_intake_log')).rows.length,0);
      assert.equal((await tx.query('select * from public.get_incident_reuse_warnings()')).rows.length,0);
    });
  });
  await check('Pinned schema-qualified authorization ignores temporary shadow profiles and staff helper',async()=>{
    await rolledBack(async tx=>{
      await setActor(tx,'authenticated',actors.contractor);
      await tx.exec(`create temporary table profiles(id uuid,role text,active boolean) on commit drop;
        create function pg_temp.is_staff() returns boolean language sql as $$select true$$;
        set local search_path=pg_temp,public;`);
      await tx.query("insert into pg_temp.profiles values($1,'manager',true)",[actors.contractor]);
      assert.equal((await tx.query('select public.get_my_role() role,public.is_staff() staff')).rows[0].role,'contractor');
      assert.equal((await tx.query('select public.is_staff() allowed')).rows[0].allowed,false);
      assert.equal((await tx.query('select id from public.email_intake_log')).rows.length,0);
      assert.equal((await tx.query('select * from public.get_incident_reuse_warnings()')).rows.length,0);
    });
  });
  await check('Inactive users cannot self-reactivate or grant themselves an operational role through the existing profile guard',async()=>{
    for(const actor of [actors.inactive,actors.inactiveContractor]) {
      const before=(await db.query('select active,role from public.profiles where id=$1',[actor])).rows[0];
      await assert.rejects(()=>as('authenticated',actor,tx=>tx.query("update public.profiles set active=true,role='manager' where id=$1",[actor])),
        error=>['42501','23514'].includes(error.code));
      assert.deepEqual((await db.query('select active,role from public.profiles where id=$1',[actor])).rows[0],before);
    }
  });
  for(const name of ['inactive','inactiveManager','inactiveBackOffice','inactiveContractor','contractor']) {
    await check(`${name} cannot exploit bare parts DELETE without a SELECT predicate`,async()=>{
      await rolledBack(async tx=>{
        const id=(await tx.query("insert into public.wo_parts(work_order_id,description,created_by) values($1,'Synthetic protected part',$2) returning id",[workOrder,actors.mgr])).rows[0].id;
        await setActor(tx,'authenticated',actors[name]);await tx.exec('delete from public.wo_parts');
        await tx.exec('reset role');
        assert.equal((await tx.query('select count(*)::int count from public.wo_parts where id=$1',[id])).rows[0].count,1);
      });
    });
  }
  for(const name of ['mgr','dispatcher','backOffice','controller']) {
    await check(`Active ${name} retains existing plain-part delete permission`,async()=>{
      await rolledBack(async tx=>{
        const id=(await tx.query("insert into public.wo_parts(work_order_id,description,created_by) values($1,'Synthetic ordinary part',$2) returning id",[workOrder,actors.mgr])).rows[0].id;
        await setActor(tx,'authenticated',actors[name]);await tx.query('delete from public.wo_parts where id=$1',[id]);
        await tx.exec('reset role');
        assert.equal((await tx.query('select count(*)::int count from public.wo_parts where id=$1',[id])).rows[0].count,0);
      });
    });
  }
}

export async function verifyEmailRawAndGrants(fixture,check) {
  const { db,as,actors,legacyLog,rawDenied }=fixture;
  const { payload,query,command,rejected }=receiptTools(fixture);
  const eventId=randomUUID();const accepted=await command(eventId,'synthetic-immutable',payload());
  for(const [name,role,actor] of [
    ...Object.entries(actors).map(([name,id])=>[name,'authenticated',id]),
    ['anonymous','anon',null],['service raw','service_role',null],
  ]) {
    await check(`${name} cannot raw insert, alter, delete or reclassify trusted or legacy intake evidence`,async()=>{
      await rawDenied(actor,"insert into public.email_intake_log(email_id,action) values('synthetic-raw','created') returning id",[],role);
      for(const id of [accepted.logId,legacyLog]) {
        await rawDenied(actor,"update public.email_intake_log set action='failed',reason='forged' where id=$1 returning id",[id],role);
        await rawDenied(actor,"update public.email_intake_log set provenance='legacy_unverified',event_id=null,source_message_id=null where id=$1 returning id",[id],role);
        await rawDenied(actor,'delete from public.email_intake_log where id=$1 returning id',[id],role);
      }
    });
  }
  for(const [name,role,actor] of [
    ...Object.entries(actors).map(([name,id])=>[name,'authenticated',id]),
    ['anonymous','anon',null],['service with browser identity','service_role',actors.mgr],
  ]) {
    await check(`${name} cannot impersonate the trusted intake processor RPC`,()=>
      rejected(()=>command(randomUUID(),'synthetic-forbidden-command',payload(),role,actor),['42501']));
  }
  await check('Caller GUCs cannot create a trusted intake capability or event identity',async()=>{
    for(const role of ['authenticated','service_role']) {
      const actor=role==='authenticated'?actors.mgr:null;
      await assert.rejects(()=>as(role,actor,async tx=>{
        await tx.query("select set_config('p1.intake_trusted','true',true),set_config('p1.email_intake_event_id',$1,true)",[eventId]);
        return tx.query('insert into public.email_intake_log_write_guards(transaction_id,event_id) values(txid_current(),$1)',[randomUUID()]);
      }),error=>error.code==='42501');
    }
  });
  await check('A browser SQL role cannot manufacture service command authority by spoofing JWT session settings',async()=>{
    await rejected(()=>as('authenticated',actors.mgr,async tx=>{
      await tx.exec("select set_config('request.jwt.claim.role','service_role',true),set_config('request.jwt.claim.sub','',true)");
      return query(tx,randomUUID(),'synthetic-forged-service-context',payload());
    }),['42501']);
    await rejected(()=>as('service_role',null,async tx=>{
      await tx.exec("select set_config('request.jwt.claim.role','',true)");
      return query(tx,randomUUID(),'synthetic-missing-service-context',payload());
    }),['42501']);
  });
  await check('Effective log grants remove raw mutations/TRUNCATE and restrict private guards and helper execution',async()=>{
    for(const role of ['anon','authenticated','service_role']) {
      for(const permission of ['INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) {
        assert.equal((await db.query("select has_table_privilege($1,'public.email_intake_log',$2) allowed",[role,permission])).rows[0].allowed,false);
      }
      for(const permission of ['SELECT','INSERT','UPDATE','DELETE','TRUNCATE']) {
        assert.equal((await db.query("select has_table_privilege($1,'public.email_intake_log_write_guards',$2) allowed",[role,permission])).rows[0].allowed,false);
      }
      assert.equal((await db.query("select has_function_privilege($1,'public.record_email_intake_result_v1(uuid,text,jsonb)','EXECUTE') allowed",[role])).rows[0].allowed,role==='service_role');
      assert.equal((await db.query("select has_function_privilege($1,'public.protect_email_intake_log_provenance()','EXECUTE') allowed",[role])).rows[0].allowed,false);
      await rawDenied(role==='authenticated'?actors.mgr:null,'truncate table public.email_intake_log',[],role);
    }
    const routines=(await db.query(`select proname,proconfig,prosecdef,
      p.proowner=(select oid from pg_roles where rolname=current_user) trusted_fixture_owner,
      exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) permission
        where permission.grantee=0 and permission.privilege_type='EXECUTE') public_execute
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and proname=any($1::text[])`,[['record_email_intake_result_v1','protect_email_intake_log_provenance','get_my_role','get_incident_reuse_warnings']])).rows;
    assert.equal(routines.length,4);assert.ok(routines.every(row=>row.proconfig?.includes('search_path=public, pg_temp')));
    assert.ok(routines.every(row=>row.prosecdef&&row.trusted_fixture_owner&&!row.public_execute),
      'Each reviewed definer is owned by the isolated migration owner, pinned, and has no PUBLIC execution ACL');
    assert.equal((await db.query('select count(*)::int count from public.email_intake_log_write_guards')).rows[0].count,0);
  });
}
