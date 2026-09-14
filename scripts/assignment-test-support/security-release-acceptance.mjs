import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { preparePreHybridReplay,preparePreAssignmentFinancialReplay } from './hybrid-upgrade-compatibility.mjs';

export async function verifyAssignmentAudit(db,repo,check,label,contracted=true) {
  await check(`${label}: read-only assignment consistency audit executes and reports expected enforcement`,async()=>{
    const results=await db.transaction(async tx=>{
      await tx.exec('set transaction read only');
      return tx.exec(readFileSync(`${repo}/supabase/audits/0128_authoritative_assignment_archive_verification.sql`,'utf8'));
    });
    assert.equal(results[0].rows[0].all_checks_pass,contracted,JSON.stringify(results[0].rows[0]));
    assert.ok(results.length>1,'Structural checks and historical anomalies must remain separate');
  });
}

export async function verifyHybridAssignmentAudit(db,repo,check,label) {
  await check(`${label}: hybrid transfer audit executes in a read-only transaction`,async()=>{
    const results=await db.transaction(async tx=>{
      await tx.exec('set transaction read only');
      return tx.exec(readFileSync(`${repo}/supabase/audits/0129_hybrid_assignment_transfer_verification.sql`,'utf8'));
    });
    assert.ok(results.length>1);
    assert.equal(results[0].rows[0].all_checks_pass,true,JSON.stringify(results[0].rows[0]));
  });
}

export async function verifyAssignmentSecurity(fixture,check,baseline) {
  const { db,as,actors,reject }=fixture;
  const browser=['transition_work_order_contractor_v1','reject_unassigned_work_order_v1',
    'duplicate_work_order_for_reassignment_v1','create_work_order_with_assignment_v1','administrative_close_visit_and_transfer_v1'];
  const service=['create_email_work_order_with_assignment_v1'];
  await check('all added assignment routines have deliberate grants and pinned search paths',async()=>{
    const routines=(await db.query(`select p.oid,p.proname,p.prosecdef,p.proconfig,
      p.proname||'('||pg_get_function_identity_arguments(p.oid)||')' identity,
      has_function_privilege('anon',p.oid,'EXECUTE') anon,
      has_function_privilege('authenticated',p.oid,'EXECUTE') authenticated,
      has_function_privilege('service_role',p.oid,'EXECUTE') service
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'`)).rows;
    const added=routines.filter(row=>!baseline.routines.has(row.identity));
    assert.ok(added.length>=10);
    for (const row of added) {
      assert.equal(row.anon,false,row.proname);
      assert.equal(row.authenticated,browser.includes(row.proname),row.proname);
      assert.equal(row.service,service.includes(row.proname),row.proname);
      if(row.prosecdef) assert.ok(row.proconfig?.includes('search_path=public, pg_temp'),row.proname);
    }
  });
  await check('obsolete rejection/duplication entry points are retired but versioned assignment remains available',async()=>{
    for(const signature of ['public.reject_unassigned_work_order(text,text)',
      'public.duplicate_work_order_for_reassignment(text)','public.duplicate_work_order_for_reassignment_notified(text)']) {
      const grants=(await db.query(`select has_function_privilege('authenticated',$1,'EXECUTE') authenticated,
        has_function_privilege('service_role',$1,'EXECUTE') service`,[signature])).rows[0];
      assert.deepEqual(grants,{ authenticated:false,service:false });
    }
    assert.equal((await db.query("select has_function_privilege('authenticated','public.transition_work_order_contractor(text,uuid,integer)','EXECUTE') allowed")).rows[0].allowed,true);
  });
  await check('browser/service SQL roles cannot truncate guarded assignment parents or evidence',async()=>{
    for(const table of ['work_orders','activities','work_order_assignment_history','contractor_assignment_transition_deliveries']) {
      for(const role of ['anon','authenticated','service_role']) {
        assert.equal((await db.query("select has_table_privilege($1,$2,'TRUNCATE') allowed",[role,`public.${table}`])).rows[0].allowed,false);
      }
    }
  });
  await check('private assignment helpers cannot mint browser/service capabilities',async()=>{
    for(const role of ['anon','authenticated','service_role']) {
      for(const sql of ['select public.require_work_order_assignment_actor()',
        `select public.begin_work_order_assignment_command('WOT9999999',0,0,0,gen_random_uuid(),'transition','{}')`,
        `select public.finish_work_order_assignment_command(gen_random_uuid(),'{}')`]) {
        await reject(()=>as(role,role==='authenticated'?actors.mgr:null,tx=>tx.query(sql)),['42501']);
      }
    }
    for(const table of ['work_order_assignment_operations','work_order_assignment_control','work_order_assignment_command_guards']) {
      const row=(await db.query(`select c.relrowsecurity,
        has_table_privilege('anon',c.oid,'SELECT,INSERT,UPDATE,DELETE') anon,
        has_table_privilege('authenticated',c.oid,'SELECT,INSERT,UPDATE,DELETE') authenticated,
        has_table_privilege('service_role',c.oid,'SELECT,INSERT,UPDATE,DELETE') service
        from pg_class c where c.oid=$1::regclass`,[`public.${table}`])).rows[0];
      assert.deepEqual(row,{ relrowsecurity:true,anon:false,authenticated:false,service:false });
    }
    assert.equal((await db.query('select count(*)::int count from public.work_order_assignment_command_guards')).rows[0].count,0);
  });
}

export async function verifyAssignmentReleasePaths({ createDatabase,applyNumber,applyBaseline,check,initializeActors,asFor,repo }) {
  for(const staged of [false,true]) {
    const db=await createDatabase();
    try {
      await applyBaseline(db);
      // Clean path finishes every forward migration before introducing current
      // workflow actors/data; staged path has supported existing assigned data.
      if(!staged) for(const number of [123,124,125,126,127,128,129]) await applyNumber(db,number);
      const actors=await initializeActors(db);const as=asFor(db);
      let financialUpgrade;
      const id=staged?'WOT9780001':'WOT9780002';
      await db.query("insert into public.work_orders(id,status,functional_status) values($1,'unassigned','New')",[id]);
      if(staged) for(const number of [123,124,125,126]) await applyNumber(db,number);
      if(staged) financialUpgrade=await preparePreAssignmentFinancialReplay({ db,as,actors });
      if(staged) await check('staged upgrade before0127 lacks new assignment RPC, preserves old guarded assignment surface',async()=>{
        assert.equal((await db.query("select to_regprocedure('public.transition_work_order_contractor_v1(text,uuid,integer,integer,bigint,uuid)') is null absent")).rows[0].absent,true);
        const result=(await as('authenticated',actors.mgr,tx=>tx.query('select public.transition_work_order_contractor($1,$2,$3) result',[id,actors.contractor,0]))).rows[0].result;
        assert.equal(result.applied,true);
      });
      if(staged) await applyNumber(db,127);
      if(staged) {
        await verifyAssignmentAudit(db,repo,check,'Expansion-only',false);
        await check('assignment expansion preserves old rejection/duplicate signatures and old assigned-create caller until cutover',async()=>{
          await as('authenticated',actors.mgr,tx=>tx.query(`insert into public.work_orders(id,status,functional_status,contractor_id)
            values('WOT9780003','assigned','Dispatched',$1)`,[actors.contractor]));
          await as('authenticated',actors.mgr,tx=>tx.query('select public.duplicate_work_order_for_reassignment_notified($1)',['WOT9780003']));
          await db.query("insert into public.work_orders(id,status,functional_status) values('WOT9780004','unassigned','New')");
          const result=(await as('authenticated',actors.mgr,tx=>tx.query("select public.reject_unassigned_work_order('WOT9780004','Synthetic expansion reject') result"))).rows[0].result;
          assert.equal(result.applied,true);
        });
      }
      if(staged) {
        await applyNumber(db,128);
        const verifyReplay=await preparePreHybridReplay({ db,as,actors,financial:financialUpgrade.financial });
        await applyNumber(db,129);
        await financialUpgrade.verify(check);
        await verifyReplay(check);
      }
      await check(`${staged?'Supported populated upgrade':'Clean numeric installation'} final command and denial gate`,async()=>{
        const version=(await db.query('select contractor_assignment_version,workflow_cycle,lifecycle_version from public.work_orders where id=$1',[id])).rows[0];
        const result=(await as('authenticated',actors.mgr,tx=>tx.query(`select public.transition_work_order_contractor_v1($1,$2,$3,$4,$5,gen_random_uuid()) result`,
          [id,staged?actors.outsider:actors.contractor,version.contractor_assignment_version,version.workflow_cycle,version.lifecycle_version]))).rows[0].result;
        assert.equal(result.applied,true);
        await assert.rejects(()=>as('authenticated',actors.mgr,tx=>tx.query('update public.work_orders set deleted_at=now(),deleted_by=$2 where id=$1',[id,actors.mgr])),error=>error.code==='42501');
      });
      await verifyAssignmentAudit(db,repo,check,staged?'Supported populated upgrade':'Clean numeric installation');
      await verifyHybridAssignmentAudit(db,repo,check,staged?'Supported populated upgrade':'Clean numeric installation');
    } finally { await db.close(); }
  }
}
