import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { receiptTools,verifyEmailReceipts } from './receipt-acceptance.mjs';
import { verifyActiveEmailAuthorization,verifyEmailRawAndGrants } from './authorization-acceptance.mjs';
import { createEmailSecurityFixtures } from './fixtures.mjs';
import { initializeLifecycleActors,actorTransactions } from '../lifecycle-test-support/engine-fixtures.mjs';

export async function verifyEmailReceiptAtomicity(fixture,check) {
  const { db,snapshot }=fixture;
  const { payload,command }=receiptTools(fixture);
  for(const [table,operation,label] of [
    ['email_intake_log_write_guards','insert','after private capability insertion'],
    ['email_intake_log','insert','after result/evidence insertion'],
    ['email_intake_log_write_guards','delete','after private capability cleanup'],
  ]) {
    await check(`Receipt failure ${label} rolls back the entire command and permits safe same-event retry`,async()=>{
      const eventId=randomUUID(),input=payload(),source=`synthetic-failure-${operation}-${table}`,before=await snapshot();
      await db.exec(`create or replace function pg_temp.fail_intake_fixture_write() returns trigger
        language plpgsql as $$ begin raise exception 'Synthetic intake post-write failure' using errcode='P0001';end $$;
        create trigger intake_fixture_failure after ${operation} on public.${table}
          for each row execute function pg_temp.fail_intake_fixture_write();`);
      try {
        await assert.rejects(()=>command(eventId,source,input),error=>error.code==='P0001');
        assert.deepEqual(await snapshot(),before);
        assert.equal((await db.query('select count(*)::int count from public.email_intake_log_write_guards')).rows[0].count,0);
      } finally { await db.exec(`drop trigger intake_fixture_failure on public.${table}`); }
      assert.equal((await command(eventId,source,input)).reason,'recorded');
      assert.equal((await command(eventId,source,input)).reason,'already_recorded');
    });
  }
}

export async function verifyEmailExpansion(fixture,check) {
  const { db,as,actors,legacyLog,rawDenied }=fixture;
  const { payload,command }=receiptTools(fixture);
  await check('Expansion preserves the original service raw INSERT as explicitly unverified compatibility only',async()=>{
    const id=(await as('service_role',null,tx=>tx.query(`insert into public.email_intake_log(email_id,action,reason)
      values('synthetic-expansion-legacy','unknown-legacy-action','Synthetic legacy evidence') returning id`))).rows[0].id;
    const row=(await db.query('select provenance,event_id,source_message_id from public.email_intake_log where id=$1',[id])).rows[0];
    assert.deepEqual(row,{provenance:'legacy_unverified',event_id:null,source_message_id:null});
  });
  await check('Expansion provides the service command and guards trusted rows before raw-write contraction',async()=>{
    const eventId=randomUUID();const accepted=await command(eventId,'synthetic-expansion-trusted',payload());
    for(const [role,id] of [['authenticated',actors.mgr],['service_role',null]]) {
      await rawDenied(id,"update public.email_intake_log set reason='forged' where id=$1 returning id",[accepted.logId],role);
      await rawDenied(id,'delete from public.email_intake_log where id=$1 returning id',[accepted.logId],role);
      await rawDenied(id,`insert into public.email_intake_log(email_id,action,event_id,source_message_id,provenance)
        values('synthetic-preplay','created',$1,'synthetic-source','trusted_service_v1') returning id`,[randomUUID()],role);
      await rawDenied(id,`update public.email_intake_log set provenance='trusted_service_v1',event_id=$2,
        source_message_id='synthetic-source' where id=$1 returning id`,[legacyLog,randomUUID()],role);
    }
  });
  await check('Expansion active-aware helper and staff reads close stale-profile authorization without waiting for contraction',async()=>{
    assert.equal((await as('authenticated',actors.inactive,tx=>tx.query('select id from public.email_intake_log'))).rows.length,0);
    assert.equal((await as('authenticated',actors.inactive,tx=>tx.query('select * from public.get_incident_reuse_warnings()'))).rows.length,0);
    assert.equal((await as('authenticated',actors.mgr,tx=>tx.query('select id from public.email_intake_log where id=$1',[legacyLog]))).rows.length,1);
  });
}

export async function verifyEmailAudit(db,repo,check,label) {
  const path=`${repo}/supabase/audits/0131_active_authorization_intake_provenance_verification.sql`;
  await check(`${label}: read-only intake authorization/provenance audit executes`,async()=>{
    const source=readFileSync(path,'utf8');
    const output=await db.transaction(async tx=>{
      await tx.exec('set transaction read only');
      return tx.exec(source);
    });
    assert.ok(output.length>0);
    const records=output.flatMap(result=>result.rows);
    assert.ok(records.length>0);
    const structural=records.find(row=>Object.hasOwn(row,'all_checks_pass'));
    assert.ok(structural,'Audit must expose explicit structural result');
    assert.equal(structural.all_checks_pass,true);
  });
}

export async function verifyEmailAuditAnomalies(fixture,repo,check) {
  const source=readFileSync(`${repo}/supabase/audits/0131_active_authorization_intake_provenance_verification.sql`,'utf8');
  await check('Read-only audit reports bounded legacy/identity anomalies and distinguishes repeated outcomes from legitimate source history',async()=>{
    await fixture.rolledBack(async tx=>{
      const counts=async()=>new Map((await tx.exec(source)).flatMap(result=>result.rows)
        .filter(row=>Object.hasOwn(row,'issue')).map(row=>[row.issue,Number(row.anomaly_count)]));
      const before=await counts();
      await tx.query(`insert into public.email_intake_log(email_id,action,reason,parse_confidence)
        values($1,'unknown-legacy-action',$2,'unknown-confidence')`,[' \t\n ','x'.repeat(2001)]);
      for(const [sourceId,action,reason] of [
        ['synthetic-audit-different-outcomes','failed','Synthetic hold'],
        ['synthetic-audit-different-outcomes','created','Synthetic success'],
      ]) {
        await tx.query(`insert into public.email_intake_log(email_id,action,reason,parse_confidence,work_order_id,event_id,source_message_id,provenance)
          values('synthetic-audit-message',$1,$2,'high',$3,$4,$5,'trusted_service_v1')`,[action,reason,fixture.workOrder,randomUUID(),sourceId]);
      }
      assert.equal((await counts()).get('duplicate_normalized_outcome_different_event')||0,before.get('duplicate_normalized_outcome_different_event')||0,
        'A held/failed email that later succeeds must not be a duplicate-outcome anomaly');
      for(const reason of ['Synthetic duplicate outcome','  Synthetic duplicate outcome  ']) {
        await tx.query(`insert into public.email_intake_log(email_id,action,reason,parse_confidence,event_id,source_message_id,provenance)
          values('synthetic-alias','failed',$1,'low',$2,'synthetic-audit-repeated-outcome','trusted_service_v1')`,[reason,randomUUID()]);
      }
      await tx.query(`insert into public.email_intake_log(email_id,action,reason,parse_confidence,event_id,source_message_id,provenance)
        values('synthetic-control-source','failed','Synthetic source anomaly','low',$1,$2,'trusted_service_v1')`,[randomUUID(),'synthetic\nsource']);
      const after=await counts();
      for(const issue of ['legacy_unverified_history_requires_review','empty_or_control_email_identity',
        'legacy_or_new_content_bounds_review','invalid_action_or_confidence','invalid_source_message_identity']) {
        assert.ok((after.get(issue)||0)>(before.get(issue)||0),`Expected explicit audit category ${issue}`);
      }
      assert.equal(after.get('duplicate_normalized_outcome_different_event'),(before.get('duplicate_normalized_outcome_different_event')||0)+2);
    });
  });
}

export async function verifyEmailReleasePaths({createDatabase,applyThrough,applyNumber,repo,check}) {
  const clean=await createDatabase();
  try {
    await applyThrough(clean,131);
    const actors=await initializeLifecycleActors(clean);
    const fixture=await createEmailSecurityFixtures({db:clean,as:actorTransactions(clean),actors});
    await verifyEmailReceipts(fixture,check);
    await verifyEmailRawAndGrants(fixture,check);
    await verifyEmailAudit(clean,repo,check,'Fresh numeric 001–0131 synthetic install');
  } finally { await clean.close(); }
  const upgrade=await createDatabase();
  try {
    await applyThrough(upgrade,129);
    const actors=await initializeLifecycleActors(upgrade);
    const fixture=await createEmailSecurityFixtures({db:upgrade,as:actorTransactions(upgrade),actors});
    const legacyBefore=await fixture.snapshot();
    await applyNumber(upgrade,130);await verifyEmailExpansion(fixture,check);
    const {payload,command}=receiptTools(fixture);
    const event=randomUUID(),source='synthetic-upgrade-replay',input=payload();
    const accepted=await command(event,source,input);
    await applyNumber(upgrade,131);
    await check('Populated upgrade preserves accepted expansion event replay and original legacy content',async()=>{
      const replay=await command(event,source,input);
      assert.equal(replay.reason,'already_recorded');assert.equal(replay.logId,accepted.logId);
      const after=await fixture.snapshot();
      for(const old of legacyBefore) {
        const current=after.find(row=>row.id===old.id);assert.ok(current);
        const {event_id,source_message_id,provenance,...retained}=current;
        assert.deepEqual(retained,old);assert.equal(event_id,null);assert.equal(source_message_id,null);
        assert.equal(provenance,'legacy_unverified');
      }
    });
    await verifyActiveEmailAuthorization(fixture,check);
    await verifyEmailRawAndGrants(fixture,check);
    await verifyEmailAudit(upgrade,repo,check,'Supported populated 0129→0130→0131 upgrade');
  } finally { await upgrade.close(); }
}
