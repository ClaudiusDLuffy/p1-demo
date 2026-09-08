// Isolated, in-memory regression checks. No Docker, Supabase connection,
// environment-file loading, or production data. See the release runbook.
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, readdirSync } from 'node:fs';
import assert from 'node:assert/strict';
process.on('uncaughtException', e => { console.error(`FATAL ${e.code || ''}: ${e.message}`); process.exit(1); });
if (!process.env.P1_SQL_TEST_ENGINE_DIR) {
  throw new Error('Set P1_SQL_TEST_ENGINE_DIR to an isolated installation of @electric-sql/pglite (tested with 0.5.8).');
}
const requireEngine = createRequire(resolve(process.env.P1_SQL_TEST_ENGINE_DIR, 'package.json'));
const { PGlite } = requireEngine('@electric-sql/pglite');
const { pg_trgm } = requireEngine('@electric-sql/pglite/contrib/pg_trgm');
const { pgcrypto } = requireEngine('@electric-sql/pglite/contrib/pgcrypto');
const repo = fileURLToPath(new URL('../', import.meta.url));
const db = new PGlite({ extensions: { pg_trgm, pgcrypto } });
// Test-only Supabase platform stubs. Portal migrations and RPCs are unchanged.
await db.exec(`
create role anon; create role authenticated; create role service_role bypassrls;
create schema auth; create schema storage; create schema extensions;
create table auth.users(id uuid primary key, email text, raw_user_meta_data jsonb default '{}');
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
create function auth.role() returns text language sql stable as $$ select coalesce(current_setting('request.jwt.claim.role', true), '') $$;
create function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb) $$;
grant usage on schema auth, public, storage to anon, authenticated, service_role;
create table storage.buckets(id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
create table storage.objects(id uuid primary key default gen_random_uuid(), bucket_id text, name text, owner uuid, metadata jsonb, created_at timestamptz default now(), updated_at timestamptz default now());
alter table storage.objects enable row level security;
create publication supabase_realtime;
alter default privileges in schema public grant all on tables to authenticated, service_role;
alter default privileges in schema public grant all on sequences to authenticated, service_role;
`);

function statements(sql) {
  const parts = []; let start = 0, quote = '', dollar = '', block = 0, line = false;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i], n = sql[i + 1];
    if (line) { if (c === '\n') line = false; continue; }
    if (block) { if (c === '/' && n === '*') { block++; i++; } else if (c === '*' && n === '/') { block--; i++; } continue; }
    if (dollar) { if (sql.startsWith(dollar, i)) { i += dollar.length - 1; dollar = ''; } continue; }
    if (quote) { if (c === quote) { if (n === quote) i++; else quote = ''; } continue; }
    if (c === '-' && n === '-') { line = true; i++; continue; }
    if (c === '/' && n === '*') { block = 1; i++; continue; }
    if (c === "'" || c === '"') { quote = c; continue; }
    if (c === '$') { const tag = sql.slice(i).match(/^\$(?:[A-Za-z_][\w]*)?\$/)?.[0]; if (tag) { dollar = tag; i += tag.length - 1; continue; } }
    if (c === ';') { parts.push(sql.slice(start, i + 1)); start = i + 1; }
  }
  if (sql.slice(start).trim()) parts.push(sql.slice(start));
  return parts;
}

const files = readdirSync(`${repo}/supabase/migrations`).filter(f => /^\d+.*\.sql$/.test(f)).sort();
for (const name of files) {
  try {
    if (name.startsWith('0105_')) {
      // Empty fixtures matching the identifiers required by historical data
      // repairs; no production records or credentials are read.
      const fixtureSource = readFileSync(`${repo}/supabase/migrations/${name}`, 'utf8');
      const fixtureEmails = [...new Set(fixtureSource.match(/[a-z0-9.]+@[a-z0-9.]+\.[a-z]+/g))];
      await db.exec("insert into public.organizations(id,name,slug,active) values ('10000000-0000-4000-8000-000000000001','Fixture Company','fixture-company',true)");
      for (const [i,email] of fixtureEmails.entries()) {
        const id = `20000000-0000-4000-8000-${String(i+1).padStart(12,'0')}`;
        await db.query('insert into auth.users(id,email) values ($1,$2)',[id,email]);
        await db.query("update public.profiles set contractor_organization_id='10000000-0000-4000-8000-000000000001', contractor_access_level='report_only', name=$2 where id=$1",[id,`Fixture ${i+1}`]);
        if (i === 0) await db.query("update public.organizations set canonical_contractor_id=$1 where id='10000000-0000-4000-8000-000000000001'",[id]);
      }
    }
    if (name.startsWith('0108_')) {
      const fixtureEmail = readFileSync(`${repo}/supabase/migrations/${name}`, 'utf8').match(/[a-z0-9.]+@[a-z0-9.]+\.[a-z]+/)[0];
      await db.query('insert into auth.users(id,email) values ($1,$2)', ['30000000-0000-4000-8000-000000000001',fixtureEmail]);
      await db.exec("update public.profiles set role='back_office',name='Accounting Fixture' where id='30000000-0000-4000-8000-000000000001'");
    }
    for (const statement of statements(readFileSync(`${repo}/supabase/migrations/${name}`, 'utf8'))) await db.exec(statement);
    if (name >= '0105') console.log(`applied ${name}`);
  } catch (e) { console.error(`FAILED ${name}: ${e.code} ${e.message}`); process.exit(1); }
}
const mgr = '40000000-0000-4000-8000-000000000001';
const controller = '40000000-0000-4000-8000-000000000002';
const inactive = '40000000-0000-4000-8000-000000000003';
const contractor = '40000000-0000-4000-8000-000000000004';
const outsider = '40000000-0000-4000-8000-000000000005';
let passed = 0;
async function check(name, fn) {
  try { await fn(); passed++; console.log(`PASS ${name}`); }
  catch (e) { console.error(`FAIL ${name}: ${e.code || ''} ${e.message}`); process.exit(1); }
}
const as = (role, id, fn) => db.transaction(async tx => {
  assert.ok(['anon','authenticated','service_role'].includes(role));
  await tx.exec(`set local role ${role}`);
  await tx.query("select set_config('request.jwt.claim.role',$1,true), set_config('request.jwt.claim.sub',$2,true)",[role,id || '']);
  return fn(tx);
});
const state = async id => (await db.query('select id,status,workflow_cycle,contractor_assignment_version,updated_at::text,closed_at::text from public.work_orders where id=$1',[id])).rows[0];
const closeArgs = row => [row.id,row.workflow_cycle,row.contractor_assignment_version,row.updated_at];
const closeFollowUp = (tx,args) => tx.query("select public.close_reopened_work_order_without_additional_billing($1,$2,$3,$4,'Prior billing covers this follow-up') as result",args);
const closeNoInvoice = (tx,args) => tx.query('select public.close_work_order_without_invoice($1,$2,$3,$4) as result',args);
const deny = async (fn,code) => assert.rejects(fn, e => e.code === code);
for (const [id,role,active] of [[mgr,'manager',true],[controller,'back_office',true],[inactive,'dispatcher',false],[contractor,'contractor',true],[outsider,'contractor',true]]) {
  await db.query('insert into auth.users(id,email) values ($1,$2)',[id,`${id}@example.invalid`]);
  await db.query('update public.profiles set role=$2,active=$3,is_assignable=true where id=$1',[id,role,active]);
}
await db.query("insert into public.staff_permission_grants(profile_id,permission) values ($1,'invoice_controller')",[controller]);
await db.query("insert into public.work_orders(id,status,functional_status,contractor_id,contractor_assignment_started_at,priority,sla_started_at,response_breach_at,resolution_breach_at) values ('WOT9000001','assigned','Dispatched',$1,now()-interval '3 days','p4',now()-interval '3 days',now()-interval '1 day',now()+interval '1 day')",[contractor]);
await db.exec("insert into public.work_orders(id) values ('WOT9000002')");
await check('direct terminal update and terminal insert denied',async()=>{
  await deny(()=>as('authenticated',mgr,tx=>tx.exec("update public.work_orders set status='closed',closed_at=now() where id='WOT9000002'")),'42501');
  await deny(()=>as('authenticated',mgr,tx=>tx.exec("insert into public.work_orders(id,status) values ('WOT9000999','closed')")),'42501');
});
await check('no-invoice close, reopen, and stale replay',async()=>{
  const original = closeArgs(await state('WOT9000002'));
  await as('authenticated',mgr,tx=>closeNoInvoice(tx,original));
  await as('authenticated',mgr,tx=>tx.query("select public.reopen_work_order('WOT9000002','resume_work','Follow-up fixture')"));
  await deny(()=>as('authenticated',mgr,tx=>closeNoInvoice(tx,original)),'40001');
  assert.notEqual((await state('WOT9000002')).status,'closed');
  await deny(()=>as('authenticated',mgr,tx=>tx.query("select public.close_work_order_without_invoice('WOT9000002')")),'42501');
});
const ci='50000000-0000-4000-8000-000000000001', si='50000000-0000-4000-8000-000000000002';
await db.query("insert into public.invoices(id,num,work_order_id,contractor_id,invoice_type,invoice_date,state,created_at) values ($1,'990001','WOT9000001',$2,'contractor',current_date,'paid',now()-interval '2 days')",[ci,contractor]);
await db.query("insert into public.invoices(id,num,work_order_id,invoice_type,invoice_date,state,created_at) values ($1,'P1-FIXTURE-01','WOT9000001','staff',current_date,'submitted',now()-interval '1 day')",[si]);
await db.query("insert into public.activities(work_order_id,author_id,author_name,text,type,event_key,event_data,created_at) values ('WOT9000001',$1,'Fixture','Submitted','system','invoice_submitted',jsonb_build_object('invoiceId',$2::text),now()-interval '2 days')",[contractor,ci]);
await as('service_role',null,tx=>tx.query('select public.mark_staff_invoice_billed($1,$2)',[si,mgr]));
await as('authenticated',mgr,tx=>tx.query("select public.reopen_work_order('WOT9000001','resume_work','Replacement covered by prior billing')"));
const followUpArgs = closeArgs(await state('WOT9000001'));
await check('post-reopen staff edits and deletion tombstones block exception closure',async()=>{
  for (const operation of ['edit','create-delete']) {
    await deny(()=>db.transaction(async tx=>{
      if (operation==='edit') {
        await tx.query("insert into public.activities(work_order_id,author_id,author_name,text,type,event_key,event_data) values ('WOT9000001',$1,'Fixture','Invoice edited','system','staff_billing',jsonb_build_object('action','updated','invoiceId',$2::text))",[mgr,si]);
      } else {
        await tx.query("insert into public.invoices(num,work_order_id,invoice_type,invoice_date,state,deleted_at,deleted_by) values ('P1-DELETED-FIXTURE','WOT9000001','staff',current_date,'draft',now(),$1)",[mgr]);
      }
      await tx.exec('set local role authenticated');
      await tx.query("select set_config('request.jwt.claim.role','authenticated',true),set_config('request.jwt.claim.sub',$1,true)",[mgr]);
      const row=(await tx.query("select id,workflow_cycle,contractor_assignment_version,updated_at::text from public.work_orders where id='WOT9000001'")).rows[0];
      await closeFollowUp(tx,closeArgs(row));
    }),'23514');
  }
});
await check('follow-up close role denials',async()=>{
  for (const id of [controller,inactive,contractor,outsider]) await deny(()=>as('authenticated',id,tx=>closeFollowUp(tx,followUpArgs)),'42501');
  await deny(()=>as('anon',null,tx=>closeFollowUp(tx,followUpArgs)),'42501');
});
await check('forged billing evidence and edited prior billing denied',async()=>{
  await deny(()=>as('authenticated',contractor,tx=>tx.query("insert into public.activities(work_order_id,author_id,author_name,text,type,event_key,event_data) values ('WOT9000001',$1,'Fixture','forged approval','system','invoice_approved',jsonb_build_object('invoiceId',$2::text))",[contractor,ci])),'42501');
  await deny(()=>as('authenticated',mgr,tx=>tx.query("insert into public.activities(work_order_id,author_id,author_name,text,type,event_key,event_data) values ('WOT9000001',$1,'Fixture','forged','system','staff_billing','{\"action\":\"billed_to_7_eleven\"}')",[mgr])),'42501');
  await deny(()=>as('authenticated',mgr,tx=>tx.exec("update public.activities set deleted_at=now() where work_order_id='WOT9000001' and event_key='staff_billing'")),'42501');
});
await check('pending field update blocks close until synchronized',async()=>{
  const activity = await as('authenticated',mgr,tx=>tx.query("insert into public.activities(work_order_id,author_id,author_name,text,type,event_key,activity_channel) values ('WOT9000001',$1,'Fixture','Replacement complete','note','note','field_note') returning id",[mgr]));
  await deny(()=>as('authenticated',mgr,tx=>closeFollowUp(tx,followUpArgs)),'23514');
  await as('authenticated',mgr,tx=>tx.query("update public.activities set synced_to_7eleven_at=now(),synced_to_7eleven_by=null where id=$1",[activity.rows[0].id]));
});
await as('authenticated',contractor,tx=>tx.query("insert into public.work_order_visits(work_order_id,contractor_id,checked_in_by,check_in_at) values ('WOT9000001',$1,$1,now()-interval '1 hour')",[contractor]));
await check('follow-up close preserves invoices, closes visit, and replays safely',async()=>{
  const result = await as('authenticated',mgr,tx=>closeFollowUp(tx,followUpArgs));
  assert.equal(result.rows[0].result.applied,true);
  assert.equal(result.rows[0].result.visitsClosed,1);
  assert.equal((await state('WOT9000001')).status,'closed');
  assert.equal((await db.query("select count(*)::int n from public.invoices where work_order_id='WOT9000001'")).rows[0].n,2);
  assert.equal((await as('authenticated',mgr,tx=>closeFollowUp(tx,followUpArgs))).rows[0].result.applied,false);
});
await check('closed visit, terminal date, and new field activity cannot be reopened directly',async()=>{
  await deny(()=>as('authenticated',mgr,tx=>tx.exec("update public.work_order_visits set check_out_at=null,checked_out_by=null,check_out_activity_id=null where work_order_id='WOT9000001'")),'23514');
  await deny(()=>as('authenticated',mgr,tx=>tx.exec("update public.work_orders set closed_at=null where id='WOT9000001'")),'42501');
  await deny(()=>as('authenticated',mgr,tx=>tx.query("insert into public.activities(work_order_id,author_id,author_name,text,type,event_key,activity_channel,synced_to_7eleven_at,synced_to_7eleven_by) values ('WOT9000001',$1,'Fixture','forged synced note','note','note','field_note',now(),$1)",[mgr])),'23514');
});
await check('later legitimate reopen keeps earlier close audit valid',async()=>{
  await as('authenticated',mgr,tx=>tx.query("select public.reopen_work_order('WOT9000001','resume_work','Another fixture follow-up')"));
  await deny(()=>as('authenticated',mgr,tx=>closeFollowUp(tx,followUpArgs)),'40001');
});
await db.query("insert into public.work_orders(id,status,functional_status,contractor_id,priority,sla_started_at,response_breach_at,resolution_breach_at) values ('WOT9000003','assigned','Dispatched',$1,'p4','2026-09-01T00:00:00Z','2026-09-03T00:00:00Z','2026-09-05T00:00:00Z')",[contractor]);
const priorityArgs = ['WOT9000003','p2','<fixture-priority-01@example.invalid>','2026-09-04T12:00:00Z','7-Eleven Priority P2 Work Order WOT9000003 has been updated.','2026-09-01T00:00:00Z','2026-09-01T04:00:00Z','2026-09-02T00:00:00Z'];
const priorityCall = (tx,args) => tx.query('select public.apply_email_work_order_priority_escalation($1,$2,$3,$4,$5,$6,$7,$8) result',args);
const refreshCall = (tx,args,patch) => tx.query('select public.refresh_email_work_order_dispatch($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) result',[...args,patch,null]);
let eventId, childId;
await check('priority tables and functions deny anonymous and browser callers',async()=>{
  for (const role of ['anon','authenticated']) {
    await deny(()=>as(role,mgr,tx=>priorityCall(tx,priorityArgs)),'42501');
    await deny(()=>as(role,mgr,tx=>tx.exec('select * from public.email_priority_escalation_events')),'42501');
    await deny(()=>as(role,mgr,tx=>refreshCall(tx,priorityArgs,{summary:'Forged'})),'42501');
  }
});
await check('escalation, audit, notice and metadata commit atomically',async()=>{
  const r=(await as('service_role',null,tx=>refreshCall(tx,priorityArgs,{summary:'Updated provider description',store_number:'12345'}))).rows[0].result;
  eventId=r.eventId; assert.equal(r.applied,true); assert.equal(r.metadataRefreshed,true);
  const row=(await db.query("select priority,sla_started_at::text,summary from public.work_orders where id='WOT9000003'")).rows[0];
  assert.equal(row.priority,'p2'); assert.match(row.sla_started_at,/2026-09-01/); assert.equal(row.summary,'Updated provider description');
  assert.equal((await db.query('select summary,delivery_status from public.email_priority_escalation_events where id=$1',[eventId])).rows[0].summary,row.summary);
});
await check('priority replays are idempotent and payload changes are rejected',async()=>{
  const r=(await as('service_role',null,tx=>refreshCall(tx,priorityArgs,{summary:'Replay must not overwrite'}))).rows[0].result;
  assert.equal(r.replayed,true); assert.equal(r.metadataRefreshed,false);
  assert.equal((await db.query('select count(*)::int n from public.email_priority_escalation_events')).rows[0].n,1);
  for (const [i,value] of [[0,'WOT9000002'],[1,'p1'],[3,'2026-09-04T13:00:00Z'],[4,'Changed subject']]) {
    const args=[...priorityArgs]; args[i]=value;
    await deny(()=>as('service_role',null,tx=>priorityCall(tx,args)),'23514');
  }
});
await check('invalid refresh rolls back priority and event, not just metadata',async()=>{
  const args=[...priorityArgs]; args[1]='p1'; args[2]='<fixture-invalid-refresh@example.invalid>'; args[3]='2026-09-04T14:00:00Z';
  await deny(()=>as('service_role',null,tx=>refreshCall(tx,args,{status:'closed'})),'22023');
  assert.equal((await db.query("select priority from public.work_orders where id='WOT9000003'")).rows[0].priority,'p2');
  assert.equal((await db.query('select count(*)::int n from public.email_priority_escalation_events')).rows[0].n,1);
});
await check('duplicate-first and escalation-first use current family head',async()=>{
  const r=(await as('authenticated',mgr,tx=>tx.query("select public.duplicate_work_order_for_reassignment_notified('WOT9000003') result"))).rows[0].result;
  childId=r.workOrderId || r.duplicateWorkOrderId || r.id;
  assert.equal(childId,'WOT9000003-1');
  assert.equal((await db.query('select priority from public.work_orders where id=$1',[childId])).rows[0].priority,'p2');
  const replay=(await as('service_role',null,tx=>priorityCall(tx,priorityArgs))).rows[0].result;
  assert.equal(replay.workOrderId,childId);
  await deny(()=>as('authenticated',mgr,tx=>tx.exec("update public.work_orders set priority='p1' where id='WOT9000003'")),'PT409');
  const anchor=(await db.query('select sla_started_at::text from public.work_orders where id=$1',[childId])).rows[0].sla_started_at;
  const args=[...priorityArgs]; args[1]='p1'; args[2]='<fixture-child-priority@example.invalid>'; args[3]='2026-09-04T15:00:00Z'; args[5]=anchor;
  if (!anchor) { args[6]=null; args[7]=null; }
  const updated=(await as('service_role',null,tx=>priorityCall(tx,args))).rows[0].result;
  assert.equal(updated.workOrderId,childId); assert.equal(updated.applied,true);
  assert.equal((await db.query('select priority from public.work_orders where id=$1',[childId])).rows[0].priority,'p1');
});
await check('stale/lower-priority emails do not downgrade or overwrite metadata',async()=>{
  const args=[...priorityArgs]; args[1]='p4'; args[2]='<fixture-stale-priority@example.invalid>'; args[3]='2026-09-04T11:00:00Z';
  assert.equal((await as('service_role',null,tx=>refreshCall(tx,args,{summary:'Stale description'}))).rows[0].result.outcome,'stale');
  args[2]='<fixture-lower-priority@example.invalid>'; args[3]='2026-09-04T16:00:00Z';
  assert.equal((await as('service_role',null,tx=>priorityCall(tx,args))).rows[0].result.outcome,'not_escalation');
  assert.equal((await db.query('select priority,summary from public.work_orders where id=$1',[childId])).rows[0].priority,'p1');
});
await check('forged priority audit and direct provenance-copy insert denied',async()=>{
  await deny(()=>as('authenticated',mgr,tx=>tx.exec("update public.activities set deleted_at=now() where work_order_id='WOT9000003' and event_key='work_order_priority_escalated'")),'42501');
  await deny(()=>as('authenticated',mgr,tx=>tx.exec("insert into public.work_orders(id,duplicated_from_work_order_id,duplicate_root_work_order_id,duplicate_sequence) values ('WOT9000003-2','WOT9000003-1','WOT9000003',2)")),'42501');
});
await check('notice claims cannot resend an in-flight or sent delivery',async()=>{
  const claim=()=>as('service_role',null,tx=>tx.query('select public.claim_email_priority_escalation_delivery($1) result',[eventId]));
  assert.equal((await claim()).rows[0].result.claimStatus,'new_claim');
  assert.equal((await claim()).rows[0].result.claimStatus,'pending_or_unknown');
  await as('service_role',null,tx=>tx.query("select public.complete_email_priority_escalation_delivery($1,'sent',null)",[eventId]));
  assert.equal((await claim()).rows[0].result.claimStatus,'already_sent');
});
await check('uncertain sends require reconciliation and rate-limit retries stop at three',async()=>{
  // Roll back only this deliberately failed-delivery fixture after assertions;
  // leaving it pending lets subsequent audit checks exercise a clean queue.
  const rollbackFixture = new Error('Rollback expected failure-state fixture');
  await assert.rejects(()=>as('service_role',null,async tx=>{
    const pending=(await tx.query("select id from public.email_priority_escalation_events where delivery_status='pending' order by created_at,id limit 1")).rows[0].id;
    for (let attempt=1; attempt<=3; attempt++) {
      // Advance the fixture's retry clock, not any production delivery.
      if (attempt>1) await tx.query('update public.email_priority_escalation_events set next_attempt_at=clock_timestamp() where id=$1',[pending]);
      const claim=(await tx.query('select public.claim_email_priority_escalation_delivery($1) result',[pending])).rows[0].result;
      assert.equal(claim.claimStatus,'new_claim');
      if (attempt===1) {
        await tx.query("select public.complete_email_priority_escalation_delivery($1,'unknown','Fixture connection timeout')",[pending]);
        assert.equal((await tx.query('select public.claim_email_priority_escalation_delivery($1) result',[pending])).rows[0].result.claimStatus,'delivery_unknown');
        // A fixture-only reset to exercise the separate throttling branch.
        await tx.query("update public.email_priority_escalation_events set delivery_status='claimed',completed_at=null,error_message=null where id=$1",[pending]);
      }
      const retry=(await tx.query("select public.retry_email_priority_escalation_delivery($1,'Fixture HTTP 429',1) result",[pending])).rows[0].result;
      assert.equal(retry.attemptCount,attempt);
      assert.equal(retry.deliveryStatus,attempt===3?'failed':'pending');
    }
    assert.equal((await tx.query('select public.claim_email_priority_escalation_delivery($1) result',[pending])).rows[0].result.claimStatus,'delivery_failed');
    throw rollbackFixture;
  }), e=>e===rollbackFixture);
});
await check('assigned DO NOT DISPATCH refresh reaches billing without redispatch',async()=>{
  await db.query("insert into public.work_orders(id,status,functional_status,contractor_id,priority) values ('WOT9000004','assigned','Dispatched',$1,'p4')",[contractor]);
  const args=['WOT9000004','p4','<fixture-dnd@example.invalid>','2026-09-04T17:00:00Z','7-Eleven Priority P4 DO NOT DISPATCH',null,null,null];
  await as('service_role',null,tx=>refreshCall(tx,args,{summary:'DO NOT DISPATCH fixture',billing_only:true,status:'pending_invoice',functional_status:'Completed',contractor_id:null}));
  const row=(await db.query("select status,functional_status,contractor_id,billing_only,sla_started_at from public.work_orders where id='WOT9000004'")).rows[0];
  assert.deepEqual(row,{status:'pending_invoice',functional_status:'Completed',contractor_id:null,billing_only:true,sla_started_at:null});
  assert.equal((await db.query("select count(*)::int n from public.work_order_assignment_history where work_order_id='WOT9000004'")).rows[0].n,1);
  const retry=(await as('service_role',null,tx=>refreshCall(tx,args,{summary:'Must not refresh on replay',billing_only:true}))).rows[0].result;
  assert.equal(retry.replayed,true); assert.equal(retry.metadataRefreshed,false);
});
await check('billing-stage priority notice cannot change state or provider metadata',async()=>{
  const args=['WOT9000004','p1','<fixture-billing-priority@example.invalid>','2026-09-04T18:00:00Z','7-Eleven Priority P1 Update',null,null,null];
  const result=(await as('service_role',null,tx=>refreshCall(tx,args,{summary:'Invalid historical overwrite'}))).rows[0].result;
  assert.equal(result.outcome,'non_operational'); assert.equal(result.metadataRefreshed,false);
  assert.equal((await db.query("select priority from public.work_orders where id='WOT9000004'")).rows[0].priority,'p4');
});
await check('intake-owned removal claims are private, bounded to their provenance, and replay safe',async()=>{
  const id=(await db.query("select assignment_removal_delivery_id from public.email_priority_escalation_events where source_message_id='<fixture-dnd@example.invalid>'")).rows[0].assignment_removal_delivery_id;
  assert.ok(id);
  for (const role of ['anon','authenticated']) await deny(()=>as(role,mgr,tx=>tx.query('select public.claim_email_assignment_removal_delivery($1)',[id])),'42501');
  const otherId=(await db.query("select id from public.contractor_assignment_transition_deliveries where transition_type='duplicated_for_reassignment' limit 1")).rows[0].id;
  await deny(()=>as('service_role',null,tx=>tx.query('select public.claim_email_assignment_removal_delivery($1)',[otherId])),'42501');
  const claim=()=>as('service_role',null,tx=>tx.query('select public.claim_email_assignment_removal_delivery($1) result',[id]));
  assert.equal((await claim()).rows[0].result.claimStatus,'new_claim');
  assert.equal((await claim()).rows[0].result.claimStatus,'pending_or_unknown');
  await as('service_role',null,tx=>tx.query("select public.complete_contractor_assignment_transition_delivery($1,'sent',null)",[id]));
  assert.equal((await claim()).rows[0].result.claimStatus,'already_sent');
});
await check('new migrations can be reapplied to populated workflow fixtures',async()=>{
  for (const name of files.filter(f=>/^(0119|0120|0121)_/.test(f))) {
    for (const statement of statements(readFileSync(`${repo}/supabase/migrations/${name}`, 'utf8'))) await db.exec(statement);
  }
});
for (const name of ['0119_close_reopened_follow_up_without_billing_verification.sql', '0120_atomic_email_priority_escalations_verification.sql', '0121_atomic_repeat_dispatch_refresh_verification.sql']) {
  try {
    const result = await db.query(readFileSync(`${repo}/supabase/audits/${name}`, 'utf8'));
    assert.equal(result.rows[0].all_checks_pass, true, JSON.stringify(result.rows));
    console.log(`PASS audit ${name}`);
  } catch (e) { console.error(`FAILED audit ${name}: ${e.code} ${e.message}`); process.exit(1); }
}
console.log(`${passed} runtime workflow checks passed`);
await db.close();
