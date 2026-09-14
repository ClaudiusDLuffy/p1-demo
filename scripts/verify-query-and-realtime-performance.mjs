// Local synthetic evidence only. Never reads environment configuration or
// contacts a Supabase/Graph/Twilio endpoint. Uses the already approved engine.
import './pagination-test-support/syntheticSqlPrivacy.mjs';
import assert from 'node:assert/strict';
import { mkdtempSync,writeFileSync,readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import { createDatabase,applyThrough,seedPerformanceFixture,seedNotificationPerformanceFixture,
  workOrderId,syntheticId } from './query-performance-test-support/fixtures.mjs';
import { captureIsolatedPlan,classifyHarnessFailure } from './query-performance-test-support/harness-safety.mjs';

const measuredIterations=10,warmups=2;
const report={version:1,evidence:'PGLITE_LOCAL',generatedAt:new Date().toISOString(),
  methodology:{warmups,measuredIterations,percentile:'nearest-rank; small local sample, not hosted p95',
    timers:'end-to-end local RPC including SET LOCAL ROLE/AuthGUC transaction; EXPLAIN times separately',
    seed:20260910,rls:'actual installed policies under SET LOCAL ROLE authenticated + JWT claim GUCs; no PostgREST gateway'},
  measurements:[],roleMatrix:[],plans:[],failures:[],
  unavailable:['POSTGRES_DISPOSABLE','POSTGREST_JWT_DISPOSABLE','PREVIEW_HOSTED','PRODUCTION_LIKE',
    'Independent PostgreSQL sessions','Browser usable/render/memory traces','Hosted p50/p95'],
  budgets:{normalPageBytes:{maximum:204800,evidence:'LOCAL_MEASURED',enforced:true},
    warmSql:{p50Ms:150,p95Ms:500,evidence:'PREVIEW_TARGET / PRODUCTION_TARGET',enforced:false},
    search:{p95Ms:700,evidence:'PREVIEW_TARGET / PRODUCTION_TARGET',enforced:false},
    queueUsable:{p95Ms:2000,evidence:'UNVERIFIED',enforced:false},
    detailUsable:{p95Ms:2500,evidence:'UNVERIFIED',enforced:false},
    invoiceUsable:{p95Ms:3000,evidence:'UNVERIFIED',enforced:false}},
  limitations:['Synthetic owner seed bypasses mutation triggers only during fixture creation; real FK/checks and RLS remain.',
    'Stored deadlines unchanged. Synthetic dates and skew are deterministic, not an SLA policy change.',
    'Detailed operator trees captured for SQL read bodies; PL/pgSQL outer RPC plans do not reveal nested statements.',
    'No new index is assumed necessary from a sequential scan alone. Existing object sizes are local only.']};
const outputDirectory=mkdtempSync(join(tmpdir(),'p1-phase6b-performance-'));
const evidencePath=join(outputDirectory,'evidence.json');
const save=()=>writeFileSync(evidencePath,JSON.stringify(report,null,2)+'\n',{mode:0o600});
let db=null,phase='engine',checks=0;
try {
  db=await createDatabase();phase='schema';
  await applyThrough(db,144);
  phase='fixture';
  const f=await seedPerformanceFixture(db);
  report.scale={...f.scale,...await seedNotificationPerformanceFixture(db,f.actors)};
  phase='measurement';
  const run=async(actor,sql,params=[],role='authenticated')=>
    f.as(role,actor,tx=>tx.query(sql,params)).then(result=>result.rows[0]?.result);
  const metric=async(name,actorClass,sql,params=[],options={})=>{
    const times=[];let value;
    for(let n=0;n<warmups+measuredIterations;n++) {
      const started=performance.now();value=await run(f.actors[actorClass],sql,params,options.role);
      if(n>=warmups)times.push(performance.now()-started);
    }
    times.sort((a,b)=>a-b);
    const bytes=Buffer.byteLength(JSON.stringify(value));
    const rows=Array.isArray(value?.items)?value.items.length:Array.isArray(value?.holds)?value.holds.length:null;
    if(rows!==null) {assert.ok(rows<=(options.limit??25),`${name} is bounded`);checks++;
      assert.ok(bytes<=204800,`${name} payload budget`);checks++;}
    if(options.noTotal) {assert.ok(!Object.hasOwn(value,'totalCount'),`${name} has no total`);checks++;}
    if(options.nonempty) {assert.ok(rows>0,`${name} representative page is not empty`);checks++;}
    const result={name,actorClass,engine:'PGLITE_LOCAL',p50Ms:times[4],p95Ms:times[9],maxMs:times[9],
      rows,payloadBytes:bytes,totalCount:value?.totalCount??null,hasMore:value?.hasMore??null,
      comparisonToProposedWarm500ms:times[9]<=500?'WITHIN_LOCAL_SAMPLE':'LOCAL_SAMPLE_EXCEEDS_PROPOSED_HOSTED_TARGET',
      planVisibility:options.planVisibility??'RPC outer plan; detailed SQL body captured separately'};
    report.measurements.push(result);save();
    console.log(JSON.stringify({measurement:name,p50Ms:result.p50Ms,p95Ms:result.p95Ms,rows,payloadBytes:bytes}));
    return value;
  };
  const initial=await metric('legacy_work_orders_first','manager',"select public.list_work_orders_page(p_scope=>'active',p_limit=>25) result");
  await metric('legacy_work_orders_continuation','manager',"select public.list_work_orders_page(p_scope=>'active',p_limit=>25,p_cursor=>$1) result",[initial.nextCursor]);
  await metric('legacy_staff_table_actual','manager',"select public.list_work_orders_table_page(p_scope=>'operations',p_limit=>25,p_pending_first=>true,p_sort_column=>'created') result");
  await applyThrough(db,145,145);
  const first=await metric('work_orders_first','manager',"select public.list_work_orders_rows_v1(p_scope=>'active',p_limit=>25) result",[],{noTotal:true,nonempty:true});
  await metric('work_orders_continuation','manager',"select public.list_work_orders_rows_v1(p_scope=>'active',p_limit=>25,p_cursor=>$1) result",[first.nextCursor],{noTotal:true,nonempty:true});
  await metric('work_orders_count','manager',"select public.count_work_orders_v1(p_scope=>'active') result");
  await metric('staff_table_actual','manager',"select public.list_work_orders_table_rows_v1(p_scope=>'operations',p_limit=>25,p_pending_first=>true,p_sort_column=>'created') result",[],{noTotal:true,nonempty:true});
  await metric('staff_table_count','manager',"select public.count_work_orders_table_v1(p_scope=>'operations') result");
  await metric('my_jobs_actual','contractor','select public.list_work_orders_table_rows_v1(p_scope=>\'active\',p_contractor_id=>$1,p_limit=>25,p_sort_column=>\'created\') result',[f.actors.contractor],{noTotal:true,nonempty:true});
  const detailId=workOrderId(2);
  await metric('work_order_exact','manager','select public.get_portal_work_order($1) result',[detailId]);
  for(const [family,limit] of [['activities',30],['photos',24],['visits',30]]) {
    await metric(`${family}_first`,'manager',`select public.list_work_order_${family}_rows_v1($1,$2,null) result`,[detailId,limit],{noTotal:true,limit,nonempty:true});
    await metric(`${family}_count`,'manager',`select public.count_work_order_${family}_v1($1) result`,[detailId]);
  }
  await metric('parts_parent','manager',`select coalesce(jsonb_agg(to_jsonb(p)),'[]') result from
    (select * from public.wo_parts where work_order_id=$1 order by created_at,id)p`,[detailId]);
  await metric('contractor_invoices_first','manager','select public.list_contractor_invoices_rows_v1() result',[],{noTotal:true,nonempty:true});
  await metric('contractor_invoices_count','manager','select public.count_contractor_invoices_v1() result');
  await metric('staff_invoices_first_authorized_service_scope','manager','select public.list_staff_invoices_rows_v1() result',[],{role:'service_role',noTotal:true,nonempty:true});
  await metric('staff_invoices_count_authorized_service_scope','manager','select public.count_staff_invoices_v1() result',[],{role:'service_role'});
  const holds=await metric('holds_first','manager','select public.list_contractor_invoice_payment_holds_page_v1(25,null) result',[],{nonempty:true});
  await metric('holds_continuation','manager','select public.list_contractor_invoice_payment_holds_page_v1(25,$1) result',[holds.nextCursor],{nonempty:true});
  const contractors=await metric('directory_contractors_first','manager',"select public.list_directory_page_v1('assignable_contractors') result",[],{nonempty:true});
  await metric('directory_contractors_continuation','manager',"select public.list_directory_page_v1('assignable_contractors',p_cursor=>$1) result",[contractors.nextCursor],{nonempty:true});
  for(const search of ['directory','099','no-match-synthetic'])
    await metric(`directory_contractors_search_${search==='directory'?'common':search==='099'?'rare':'none'}`,'manager',"select public.list_directory_page_v1('assignable_contractors',$1) result",[search]);
  await metric('directory_staff_first','manager',"select public.list_directory_page_v1('staff_choices') result",[],{nonempty:true});
  await metric('directory_staff_search','manager',"select public.list_directory_page_v1('staff_choices','099') result",[],{nonempty:true});
  await metric('directory_company_first','companyAdmin',"select public.list_directory_page_v1('company_technicians','',$1) result",[f.actors.companyAdmin],{nonempty:true});
  await metric('directory_company_search','companyAdmin',"select public.list_directory_page_v1('company_technicians','099',$1) result",[f.actors.companyAdmin],{nonempty:true});
  await metric('directory_exact','manager',"select public.get_directory_selection_v1('assignable_contractors',$1,null) result",[f.actors.contractor]);
  await metric('staff_grants_exact','manager',"select coalesce(jsonb_agg(permission),'[]') result from public.staff_permission_grants where profile_id=$1",[f.actors.controller]);
  await metric('navigation_legacy_summary','manager','select public.get_portal_navigation_summary() result');
  await metric('navigation_visible_summary','manager','select public.get_portal_navigation_summary_v1() result');
  await metric('receiving_unresolved','manager','select public.list_receiving_dispatch_unresolved_v1() result',[],{nonempty:true});
  await metric('financial_unresolved','manager','select public.list_financial_notification_unresolved_v1() result',[],{nonempty:true});
  await metric('parts_sms_unresolved','manager','select public.list_parts_sms_unresolved_v1() result',[],{nonempty:true});
  await metric('parts_sms_health','manager','select public.get_parts_sms_worker_health_v1() result');

  const roleQueries=[
    ['work_orders_rows',"select public.list_work_orders_rows_v1(p_scope=>'active') result"],
    ['work_orders_count',"select public.count_work_orders_v1(p_scope=>'active') result"],
    ['work_order_exact','select public.get_portal_work_order($1) result',[detailId]],
    ['invoice_rows','select public.list_contractor_invoices_rows_v1() result'],
    ['invoice_count','select public.count_contractor_invoices_v1() result'],
    ['holds','select public.list_contractor_invoice_payment_holds_page_v1(25,null) result'],
    ['assignable_contractors',"select public.list_directory_page_v1('assignable_contractors') result"],
    ['staff_directory',"select public.list_directory_page_v1('staff_choices') result"],
    ['company_technicians',"select public.list_directory_page_v1('company_technicians','',$1) result",[f.actors.companyAdmin]],
    ['receiving','select public.list_receiving_dispatch_unresolved_v1() result'],
    ['financial','select public.list_financial_notification_unresolved_v1() result'],
    ['parts_sms','select public.list_parts_sms_unresolved_v1() result'],
    ['navigation_count','select public.get_portal_navigation_summary_v1() result'],
  ];
  for(const [actorClass,actor]of Object.entries({...f.actors,missingProfile:syntheticId('80',999),anonymous:null})) {
    for(const [name,sql,params=[]]of roleQueries) {
      const role=actorClass==='anonymous'?'anon':'authenticated',started=performance.now();
      try {const value=await run(actor,sql,params,role);
        report.roleMatrix.push({actorClass,name,status:'AUTHORIZED_RESULT',rows:value?.items?.length??value?.holds?.length??null,
          count:value?.totalCount??null,notFound:value===null,elapsedMs:performance.now()-started});
      }catch(error){assert.ok(['42501','P0002','PT404','PT403','PT401'].includes(error.code),`${name}: unexpected role error`);
        report.roleMatrix.push({actorClass,name,status:'DENIED',code:error.code,elapsedMs:performance.now()-started});}
      checks++;
    }
    save();console.log(JSON.stringify({roleMatrixActor:actorClass,queries:roleQueries.length}));
  }

  const summarizePlan=value=>{
    const nodes=[];
    const walk=(node,depth=0)=>{const entry={depth};
      for(const key of ['Node Type','Parent Relationship','Relation Name','Index Name','Subplan Name','Plan Rows',
        'Actual Rows','Actual Loops','Actual Total Time','Rows Removed by Filter','Sort Method','Sort Space Used','Sort Space Type',
        'Shared Hit Blocks','Shared Read Blocks'])if(key in node)entry[key]=node[key];
      nodes.push(entry);for(const child of node.Plans??[])walk(child,depth+1);};
    walk(value.Plan);return {planningMs:value['Planning Time'],executionMs:value['Execution Time'],nodes};
  };
  const planCases=[['work_orders_v1','rows','manager'],['work_orders_v1','count','manager'],
    ['work_orders_table_v1','rows','manager'],['work_orders_table_v1','count','manager'],
    ['work_orders_table_v1','rows','companyAdmin'],['work_orders_table_v1','rows','reportTechnician'],
    ['work_order_activities_v1','rows','manager'],['work_order_photos_v1','rows','manager'],
    ['work_order_visits_v1','rows','manager'],['contractor_invoices_v1','rows','manager'],
    ['contractor_invoices_v1','count','controller'],['staff_invoices_v1','rows','controller'],
    ['work_orders_table_v1','rows','manager',{p_pending_first:'true',p_scope:"'operations'::text"}]];
  phase='plan';
  for(const [name,mode,actorClass,overrides={}]of planCases) {
    const routine=(await db.query("select prosrc,pg_get_function_arguments(oid) args from pg_proc where pronamespace='p1_read_contracts'::regnamespace and proname=$1",[name])).rows[0];
    let sql=routine.prosrc;
    const args=routine.args.split(', ').map(arg=>[arg.split(' ')[0],overrides[arg.split(' ')[0]]??
      (arg.includes(' DEFAULT ')?arg.split(' DEFAULT ')[1]:arg.startsWith('p_read_mode ')?`'${mode}'::text`:`'${detailId}'::text`)]);
    for(const [arg,value]of args.sort((a,b)=>b[0].length-a[0].length))sql=sql.replace(new RegExp(`\\b${arg}\\b`,'g'),`(${value})`);
    const plan=await f.as('authenticated',f.actors[actorClass],tx=>captureIsolatedPlan((query,params)=>tx.query(query,params),sql));
    report.plans.push({name,mode,actorClass,inputVariant:overrides.p_pending_first?'actual_staff_pending_first':'default',evidence:'PGLITE_LOCAL',visibility:'expanded production SQL helper body under actual RLS; constants can plan differently from nested RPC',
      bodySha256:createHash('sha256').update(routine.prosrc).digest('hex'),...summarizePlan(plan)});
    checks++;save();
  }
  for(const [name,sql,params=[]]of roleQueries.slice(5)) {
    const plan=await f.as('authenticated',f.actors.manager,tx=>captureIsolatedPlan((query,bindings)=>tx.query(query,bindings),sql,params));
    report.plans.push({name,actorClass:'manager',evidence:'PGLITE_LOCAL',visibility:'outer production RPC only; PL/pgSQL internals unavailable',...summarizePlan(plan)});checks++;
  }
  const navigationBody=(await db.query("select prosrc from pg_proc where oid='public.get_portal_navigation_summary_v1()'::regprocedure")).rows[0].prosrc;
  const navigationPlan=await f.as('authenticated',f.actors.manager,
    tx=>captureIsolatedPlan((query,bindings)=>tx.query(query,bindings),navigationBody));
  report.plans.push({name:'navigation_visible_summary',actorClass:'manager',evidence:'PGLITE_LOCAL',
    visibility:'expanded production SQL body under actual RLS',bodySha256:createHash('sha256').update(navigationBody).digest('hex'),...summarizePlan(navigationPlan)});checks++;
  phase='audit';
  report.existingIndexes=(await db.query(`select schemaname,tablename,indexname,pg_relation_size(indexname::regclass)::integer bytes
    from pg_indexes where schemaname='public' and tablename in ('work_orders','activities','photos','work_order_visits','wo_parts',
    'invoices','invoice_lines','profiles','contractor_technicians','contractor_invoice_payment_holds',
    'contractor_receiving_dispatch_deliveries','financial_notification_deliveries','p1_parts_alert_deliveries') order by tablename,indexname`)).rows;
  report.newIndexes=[];
  report.indexDecision='No index added. Existing child/hold/delivery indexes are used. Remaining50k queue/count costs dominated by current role helpers and required candidate/filter evaluation, not demonstrated missing-index seek.';
  const audit=await db.query(readFileSync(new URL('../supabase/audits/0145_count_independent_page_reads_verification.sql',import.meta.url),'utf8'));
  assert.ok(audit.rows.every(row=>row.all_checks_pass));checks++;
  const realtime=spawnSync(process.execPath,['--import','tsx','scripts/measure-realtime-performance.ts'],{encoding:'utf8',maxBuffer:2*1024*1024,timeout:60000});
  assert.equal(realtime.status,0,'Realtime local measurement process');
  report.realtime=JSON.parse(realtime.stdout);checks++;
  report.checks=checks;report.result='LOCAL_CONTRACT_AND_PAYLOAD_GATES_PASS; PROPOSED_HOSTED_TIMINGS_NOT_CERTIFIED';
}catch(error){report.failures.push(classifyHarnessFailure(phase,error));process.exitCode=1;}
finally{if(db)await db.close();report.checks=checks;save();console.log(JSON.stringify({evidencePath,checks,failures:report.failures,
  measurements:report.measurements.length,roleCases:report.roleMatrix.length,plans:report.plans.length}));}
