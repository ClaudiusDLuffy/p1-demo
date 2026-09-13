import './pagination-test-support/syntheticSqlPrivacy.mjs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdtempSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve, dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { runInNewContext } from 'node:vm';
import { tmpdir } from 'node:os';
import { createDatabase, applyThrough, seedPerformanceFixture, workOrderId, syntheticId }
  from './query-performance-test-support/fixtures.mjs';

const root = process.cwd();
const requireHere = createRequire(join(root, 'package.json'));
const ts = requireHere('typescript');
const mode = process.argv.find(value => value.startsWith('--mode='))?.slice(7) || 'before';
assert.ok(['before', 'after', 'smoke'].includes(mode));
const baselinePath = process.argv.find(value => value.startsWith('--baseline='))?.slice(11);
const output = mkdtempSync(join(tmpdir(), `p1-7c2-activity-visit-${mode}-`));
const hash = value => createHash('sha256').update(value).digest('hex');
const warmups = mode === 'smoke' ? 0 : 3;
const iterations = mode === 'smoke' ? 1 : 20;
const report = { version: 1, mode, startedAt: new Date().toISOString(), result: 'INCOMPLETE', output,
  methodology: { warmups, iterations, percentile: 'nearest-rank',
    boundary: 'Actual complete db.ts public activity/visit exports and real boundedReadRpc; only Supabase request transport injected',
    scope: 'Disposable PGlite actual RLS/role/JWT GUC; not PostgREST, hosted, browser, or concurrency certification',
    currentVisit: 'No independent current/open visit read exists; current/open case exercises existing parent page containing its one open row',
    activityChannels: 'No channel query argument exists; staff-internal case selects a parent containing internal notes, contractor case exercises actual RLS',
    performanceAcceptance: 'Existing local p95 <=500 ms. C1 and Phase6B records define no relative-percentage tolerance; raw differences retained, no invented threshold.' },
  sources: {}, measurements: [], roleReads: [], privacyChecks: [], cursorChecks: [],
  rawFixtures: {}, publicFixtures: {}, failures: [] };
const save = () => writeFileSync(join(output, 'evidence.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
const dist = values => { const sorted = [...values].sort((a,b) => a-b); return {
  p50Ms: sorted[Math.ceil(sorted.length*.5)-1], p95Ms: sorted[Math.ceil(sorted.length*.95)-1], samples: values }; };
let db, fixture, currentActor, currentRole = 'authenticated', calls = [], rpcElapsed = 0, lastRaw;
const allowed = new Set(['list_work_order_activities_rows_v1', 'list_work_order_visits_rows_v1']);
const transport = { rpc(name,args) {
  assert.ok(allowed.has(name), `Unexpected RPC ${name}`);
  assert.equal(Object.keys(args).sort().join(','), 'p_cursor,p_limit,p_work_order_id');
  let signal;
  const request = { abortSignal(value) { signal = value; return request; }, async then(fulfilled) {
    signal?.throwIfAborted(); calls.push({ name, args, signalPresent: Boolean(signal) });
    const started = performance.now();
    try {
      const result = await fixture.read(currentActor, `select public.${name}(p_work_order_id=>$1,p_limit=>$2,p_cursor=>$3) result`,
        [args.p_work_order_id,args.p_limit,args.p_cursor],currentRole);
      lastRaw = result.rows[0]?.result; rpcElapsed += performance.now()-started;
      return fulfilled({data:lastRaw,error:null});
    } catch(error) { rpcElapsed += performance.now()-started; return fulfilled({data:null,error}); }
  } }; return request;
} };
const cache = new Map();
function load(filename) {
  const absolute = resolve(filename);
  if (cache.has(absolute)) return cache.get(absolute).exports;
  if (absolute === join(root,'src/lib/supabase/client.ts')) return {supabase:()=>transport};
  const source = readFileSync(absolute,'utf8'); report.sources[absolute.slice(root.length+1)] = hash(source);
  const loadedModule = {exports:{}}; cache.set(absolute,loadedModule);
  const request = name => {
    if (!name.startsWith('.') && !name.startsWith('@/')) return requireHere(name);
    const target = name.startsWith('@/') ? join(root,'src',name.slice(2)) : resolve(dirname(absolute),name);
    const resolved = [target,`${target}.ts`,`${target}.tsx`,join(target,'index.ts')].find(path=>existsSync(path)&&/\.(ts|tsx|js)$/.test(path));
    assert.ok(resolved);
    if (resolved===join(root,'src/lib/supabase/client.ts') || resolved===join(root,'src/lib/counts/readRpc.ts') ||
      resolved.startsWith(join(root,'src/features/work-orders/data/'))) return load(resolved);
    return requireHere(resolved);
  };
  runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,
    {exports:loadedModule.exports,module:loadedModule,require:request,Date,console,Map,Set,AbortController,AbortSignal,URL,crypto:globalThis.crypto}, {filename:absolute});
  return loadedModule.exports;
}
async function historicalSupplement() {
  const filename=join(root,'scripts/verify-performance-and-invoice-payload-closeout.mjs');
  const source=readFileSync(filename,'utf8'); const ast=ts.createSourceFile(filename,source,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
  const block=ast.statements.find(ts.isTryStatement).tryBlock;
  const transaction=block.statements.find(node=>ts.isExpressionStatement(node)&&node.getText(ast).startsWith('await db.transaction(async tx =>'));
  assert.ok(transaction); const text=transaction.getText(ast);
  assert.ok(text.includes('SYNTHETIC-FRACTIONAL')&&text.includes('disable trigger user')&&text.includes('enable trigger user'));
  report.supplement={source:filename,sourceSha256:hash(source),transactionSha256:hash(text)};
  const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
  await new AsyncFunction('db','f','syntheticId','workOrderId','high','staff','empty','maximumText',text)(db,fixture,syntheticId,workOrderId,
    syntheticId('92',1),syntheticId('92',2),syntheticId('92',3),syntheticId('92',4));
}
const activityId=n=>`a7100000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const visitId=n=>`a7200000-0000-4000-8000-${String(n).padStart(12,'0')}`;
async function supplementReadFixtures() {
  const a=fixture.actors;
  // Do not add/change base activity density: repurpose 20 existing synthetic
  // rows on a reserved parent, retaining exactly 101000 rows in the dataset.
  await db.transaction(async tx=>{
    for(const table of ['work_orders','activities','work_order_visits','work_order_assignment_operations']) await tx.exec(`alter table public.${table} disable trigger user`);
    // The historical fixture leaves these at now(); make this added visit
    // comparison deterministic without changing the historical fixture file.
    await tx.exec("update public.work_order_visits set created_at=check_in_at,updated_at=check_out_at where id::text like '95000000-%'");
    await tx.exec("update public.activities set created_at='2026-09-05T00:16:21Z' where id='9a000000-0000-4000-8000-000000000991'");
    await tx.query(`update public.work_orders set contractor_id=$2,assigned_technician_profile_id=$3,
      contractor_assignment_version=2,contractor_assignment_started_at='2026-09-03T00:00:00Z',workflow_cycle=3,
      status='wip',functional_status='Work in Progress',deleted_at=null where id=$1`,[workOrderId(22),a.companyAdmin,a.reportTechnician]);
    const cases=[
      ['general','contractor_message',false,false,'note',2,3,'2026-09-05T01:00:00Z'],
      ['internal','internal_note',true,false,'note',2,3,'2026-09-05T01:00:01Z'],
      ['field','field_note',false,true,'note',2,3,'2026-09-05T01:00:02Z'],
      ['lifecycle','field_note',false,true,'check_in',2,3,'2026-09-05T01:00:03Z'],
      ['invoice','system_event',false,false,'invoice_submitted',2,3,'2026-09-05T01:00:04Z'],
      ['prior_assignment','contractor_message',false,false,'note',1,3,'2026-09-05T01:00:05Z'],
      ['before_assignment','contractor_message',false,false,'note',2,3,'2026-09-02T01:00:06Z'],
      ['prior_workflow','contractor_message',false,false,'note',2,2,'2026-09-05T01:00:07Z'],
      ['deleted_activity','contractor_message',false,false,'note',2,3,'2026-09-05T01:00:08Z'],
      ['unknown_text_type','legacy',false,false,'custom_legacy_event',2,3,null],
    ];
    for(const [i,[label,channel,staff,sync,event,version,cycle,created]]of cases.entries()) {
      await tx.query(`update public.activities set id=$1,work_order_id=$2,author_id=$3,author_name='Synthetic activity author',
        text=$4,type=$5,created_at=$6,activity_channel=$7,is_staff_only=$8,requires_7eleven_sync=$9,
        requires_contractor_attention=false,contractor_assignment_version=$10,workflow_cycle=$11,event_key=$12,
        deleted_at=$13,event_data=$14 where id=$15`,[activityId(i+1),workOrderId(22),a.manager,`Synthetic ${label}`,
        label==='unknown_text_type'?'historic_custom_type':'note',created,channel,staff,sync,version,cycle,event,
        label==='deleted_activity'?'2026-09-06T00:00:00Z':null,JSON.stringify({z:2,a:1,label}),syntheticId('91',20+i)]);
    }
    report.activityCases=cases.map(([label],i)=>({label,id:activityId(i+1)}));
    for (let n=1;n<=80;n++) await tx.query(`insert into public.work_order_visits(id,work_order_id,contractor_id,check_in_at,
      check_out_at,checked_in_by,checked_out_by,created_at,updated_at) values($1,$2,$3,
      '2026-09-05T00:00:00Z'::timestamptz+$4*interval '1 minute',
      '2026-09-05T00:00:00Z'::timestamptz+$4*interval '1 minute'+interval '30 second',$5,$5,
      '2026-09-05T00:00:00Z','2026-09-05T00:00:00Z')`,[visitId(n),workOrderId(2),a.companyAdmin,n,a.technician]);
    for(const[n,owner,created,open]of [[81,a.companyAdmin,'2026-09-05T00:00:00Z',false],
      [82,a.companyAdmin,'2026-09-02T00:00:00Z',false],[83,a.contractor,'2026-09-05T00:00:00Z',false],
      [85,a.companyAdmin,'2026-09-05T00:00:00Z',true]]) await tx.query(`insert into public.work_order_visits(
        id,work_order_id,contractor_id,check_in_at,check_out_at,checked_in_by,checked_out_by,created_at,updated_at)
        values($1,$2,$3,'2026-09-05T02:00:00Z',$4,$5,$6,$7,$7)`,
        [visitId(n),workOrderId(22),owner,open?null:'2026-09-05T03:00:00Z',a.reportTechnician,open?null:a.reportTechnician,created]);
    const operation='a7300000-0000-4000-8000-000000000001';
    await tx.query(`insert into public.work_order_assignment_operations(operation_id,work_order_id,actor_id,actor_role,
      command_family,payload,created_at) values($1,$2,$3,'authenticated','transition','{}','2026-09-05T04:00:00Z')`,
      [operation,workOrderId(22),a.manager]);
    await tx.query(`insert into public.work_order_visits(id,work_order_id,contractor_id,check_in_at,check_out_at,
      checked_in_by,checked_out_by,created_at,updated_at,closure_kind,duration_review_required,administrative_closed_at,
      administrative_closed_by,administrative_close_reason,administrative_transfer_operation_id)
      values($1,$2,$3,'2026-09-05T02:00:00Z','2026-09-05T03:30:00Z',$4,$5,'2026-09-05T02:00:00Z','2026-09-05T04:00:00Z',
      'administrative_transfer',true,'2026-09-05T03:00:00Z',$5,'Synthetic corrected administrative visit requires review',$6)`,
      [visitId(84),workOrderId(22),a.companyAdmin,a.reportTechnician,a.manager,operation]);
    report.visitSupplement={rows:85,administrative:'Schema-valid synthetic corrected times; not a command execution claim',
      cases:{normal:visitId(81),priorAssignment:visitId(82),foreignContractor:visitId(83),administrativeCorrected:visitId(84),open:visitId(85)}};
    for(const table of ['work_orders','activities','work_order_visits','work_order_assignment_operations']) await tx.exec(`alter table public.${table} enable trigger user`);
  });
  await db.exec('analyze public.activities; analyze public.work_order_visits; analyze public.work_orders');
}
async function metric(name,actorName,invoke) {
  currentActor=fixture.actors[actorName];currentRole='authenticated';
  const samples=[],database=[];let value,payload,queryLog;
  for(let n=0;n<warmups+iterations;n++) {
    calls=[];rpcElapsed=0;const start=performance.now();value=await invoke();const elapsed=performance.now()-start;
    payload=JSON.stringify(value);queryLog=calls;assert.equal(calls.length,1);assert.equal(value.totalCount,null);
    if(n>=warmups){samples.push(elapsed);database.push(rpcElapsed);}
  }
  const measured={name,actorName,total:dist(samples),database:dist(database),bytes:Buffer.byteLength(payload),publicSha256:hash(payload),
    queryCount:queryLog.length,queryLog,targetP95Ms:500,withinLocalBudget:dist(samples).p95Ms<=500};
  report.measurements.push(measured);report.rawFixtures[name]=lastRaw;report.publicFixtures[name]=value;save();
  assert.ok(measured.withinLocalBudget, `${name} must preserve the established local 500 ms budget`);
  console.log(JSON.stringify({measurement:name,p50:measured.total.p50Ms,p95:measured.total.p95Ms,bytes:measured.bytes}));return value;
}
async function ownerUpdate(table,sql,args=[]) {
  assert.ok(['work_orders','activities','work_order_visits'].includes(table));
  await db.transaction(async tx=>{await tx.exec(`alter table public.${table} disable trigger user`);
    await tx.query(sql,args);await tx.exec(`alter table public.${table} enable trigger user`);});
}
async function verifyPrivacy(activities,visits) {
  const ids=value=>value.items.map(item=>item.id);
  const a=fixture.actors,parent=workOrderId(22);
  currentRole='authenticated';currentActor=a.manager;
  const staff=await activities(parent,null,100),staffIds=ids(staff);
  for(const n of [1,2,3,4,5,6,7,8,10])assert.ok(staffIds.includes(activityId(n)),`Staff retains activity fixture ${n}`);
  assert.ok(!staffIds.includes(activityId(9)));
  const nullable=staff.items.find(item=>item.id===activityId(10));
  assert.equal(nullable.createdAt,null);assert.equal(nullable.type,'historic_custom_type');
  assert.equal(nullable.eventKey,'custom_legacy_event');
  assert.equal(JSON.stringify(nullable.eventData),JSON.stringify({a:1,z:2,label:'unknown_text_type'}));
  currentActor=a.reportTechnician;
  const reportIds=ids(await activities(parent,null,100));
  for(const n of [1,3,4,8])assert.ok(reportIds.includes(activityId(n)),`Current report technician retains ${n}`);
  for(const n of [2,5,6,7,9,10])assert.ok(!reportIds.includes(activityId(n)),`Report technician excludes ${n}`);
  const reportVisits=await visits(parent,null,100),visitIds=ids(reportVisits);
  for(const n of [81,84,85])assert.ok(visitIds.includes(visitId(n)));
  for(const n of [82,83])assert.ok(!visitIds.includes(visitId(n)));
  const administrative=reportVisits.items.find(item=>item.id===visitId(84));
  assert.equal(administrative.closureKind,'administrative_transfer');assert.equal(administrative.durationReviewRequired,true);
  assert.notEqual(administrative.checkOutAt,administrative.administrativeClosedAt);
  assert.equal(reportVisits.items.filter(item=>item.checkOutAt===null).length,1);
  report.privacyChecks.push({name:'Current report technician: channel, invoice event, assignment epoch, prior workflow, visit provenance',result:'PASS',activityIds:reportIds,visitIds});
  currentActor=a.companyAdmin;
  assert.ok(ids(await activities(parent,null,100)).includes(activityId(5)));
  report.privacyChecks.push({name:'Company admin retains invoice event while report-only does not',result:'PASS'});
  for(const[actorName,actor]of [['formerTechnician',a.formerTechnician],['outgoingContractor',a.contractor],['otherCompany',a.otherCompany],['inactive',a.inactive]]) {
    currentActor=actor;assert.equal((await activities(parent)).items.length,0);assert.equal((await visits(parent)).items.length,0);
    report.privacyChecks.push({name:`${actorName}: other/current assignment private`,result:'PASS'});
  }
  for(const status of ['closed','capital','pending_capital_completion']) {
    await ownerUpdate('work_orders','update public.work_orders set status=$2 where id=$1',[parent,status]);
    currentActor=a.reportTechnician;assert.equal(JSON.stringify(ids(await activities(parent,null,100))),JSON.stringify(reportIds));
    assert.equal(JSON.stringify(ids(await visits(parent,null,100))),JSON.stringify(visitIds));
    report.privacyChecks.push({name:`${status} retains current authorized child history`,result:'PASS'});
  }
  await ownerUpdate('work_orders',"update public.work_orders set status='wip',deleted_at='2026-09-06T00:00:00Z' where id=$1",[parent]);
  currentActor=a.reportTechnician;assert.equal((await activities(parent)).items.length,0);assert.equal((await visits(parent)).items.length,0);
  currentActor=a.manager;assert.ok((await activities(parent)).items.length>0);assert.ok((await visits(parent)).items.length>0);
  report.privacyChecks.push({name:'Deleted parent: staff child history remains, contractor denied',result:'PASS'});
  await ownerUpdate('work_orders',"update public.work_orders set deleted_at=null,contractor_id=$2,assigned_technician_profile_id=null,contractor_assignment_version=3,contractor_assignment_started_at='2026-09-07T00:00:00Z' where id=$1",[parent,a.contractor]);
  for(const actor of [a.reportTechnician,a.companyAdmin,a.contractor]){currentActor=actor;assert.equal((await activities(parent)).items.length,0);assert.equal((await visits(parent)).items.length,0);}
  report.privacyChecks.push({name:'Receiving/outgoing assignment: neither inherits pre-epoch activity or visits',result:'PASS'});
  await ownerUpdate('work_orders',"update public.work_orders set contractor_id=$2,assigned_technician_profile_id=$3,contractor_assignment_version=2,contractor_assignment_started_at='2026-09-03T00:00:00Z' where id=$1",[parent,a.companyAdmin,a.reportTechnician]);
  // Additive current-owner positive RLS evidence. This was not a separately
  // measured BEFORE visit case; preserve the sealed comparison rows above.
  currentActor=a.contractor;calls=[];
  const standalone=await visits(workOrderId(1));
  assert.ok(standalone.items.some(row=>row.id===syntheticId('95',1)));
  assert.ok(standalone.items.every(row=>row.workOrderId===workOrderId(1)&&row.contractorId===a.contractor));
  assert.equal(calls.length,1);assert.equal(standalone.totalCount,null);
  report.additionalScopeChecks=[{name:'Standalone contractor reads its existing assigned visit',result:'PASS',
    evidencePhase:'ADDITIONAL_CURRENT_OWNER_NOT_A_BEFORE_MEASUREMENT',queryLog:calls,
    ids:standalone.items.map(row=>row.id),publicSha256:hash(JSON.stringify(standalone))}];
}
function verifyRecordedRoleMatrix(roleReads) {
  const checks=[],reads=['activities','visits','assigned_invoice_technician_activities','assigned_invoice_technician_visits'];
  const get=actor=>{const value=roleReads.find(row=>row.actorName===actor);assert.ok(value);return value;};
  const manager=get('manager');
  for(const actor of ['manager','dispatcher','backOffice','controller','quickbooksOnly','handoffOnly']){
    for(const read of reads){assert.equal(get(actor)[read].status,'returned');assert.ok(get(actor)[read].ids.length>0);
      assert.deepEqual(get(actor)[read].ids,manager[read].ids);}
    checks.push({actor,result:'PASS',contract:'Active operational base role retains staff child visibility'});
  }
  for(const actor of ['contractor','invoiceMember','formerTechnician','inactive','otherCompany','missingProfile']){
    for(const read of reads){assert.equal(get(actor)[read].status,'returned');assert.deepEqual(get(actor)[read].ids,[]);}
    checks.push({actor,result:'PASS',contract:'Inaccessible assignment/company or inactive/missing profile returns empty child rows'});
  }
  for(const actor of ['companyAdmin','secondAdmin']){
    for(const read of reads){assert.equal(get(actor)[read].status,'returned');assert.ok(get(actor)[read].ids.length>0);
      assert.deepEqual(get(actor)[read].ids,get('companyAdmin')[read].ids);}
    assert.ok(get(actor).activities.ids.includes(activityId(5))&&!get(actor).activities.ids.includes(activityId(2)));
    checks.push({actor,result:'PASS',contract:'Active company administrator reads current company assignment, including invoice events, not internal notes'});
  }
  assert.ok(get('reportTechnician').activities.ids.length>0&&get('reportTechnician').visits.ids.length>0);
  assert.ok(!get('reportTechnician').activities.ids.includes(activityId(5)));
  assert.deepEqual(get('reportTechnician').assigned_invoice_technician_activities.ids,[]);
  assert.deepEqual(get('reportTechnician').assigned_invoice_technician_visits.ids,[]);
  checks.push({actor:'reportTechnician',result:'PASS',contract:'Current report-only technician is parent-bound and cannot read invoice lifecycle events'});
  assert.deepEqual(get('technician').activities.ids,[]);assert.deepEqual(get('technician').visits.ids,[]);
  assert.ok(get('technician').assigned_invoice_technician_activities.ids.length>0&&get('technician').assigned_invoice_technician_visits.ids.length>0);
  checks.push({actor:'technician',result:'PASS',contract:'Current invoice-enabled technician cannot read another current technician parent'});
  for(const read of reads){assert.equal(get('anonymous')[read].status,'rejected');assert.equal(get('anonymous')[read].code,'FORBIDDEN');}
  checks.push({actor:'anonymous',result:'PASS',contract:'Anonymous role cannot execute either authenticated page RPC'});
  assert.equal(checks.length,17);return checks;
}
async function verifyCursors(activities,visits) {
  currentActor=fixture.actors.manager;currentRole='authenticated';
  for(const[name,read,table,timeKey,timeColumn]of [['activity',activities,'activities','created','created_at'],['visit',visits,'work_order_visits','checkIn','check_in_at']]) {
    const parent=workOrderId(2),walk=[];let cursor=null,pages=0;
    do{calls=[];const page=await read(parent,cursor,17);assert.equal(calls.length,1);assert.equal(page.totalCount,null);
      assert.equal(page.hasMore,page.nextCursor!==null);walk.push(...page.items.map(item=>item.id));cursor=page.nextCursor;
      assert.ok(++pages<=20);if(cursor){const decoded=JSON.parse(Buffer.from(cursor,'base64url').toString('utf8'));
        assert.equal(Object.keys(decoded).sort().join(','),[timeKey,'id'].sort().join(','));}}
    while(cursor);
    assert.equal(new Set(walk).size,walk.length);
    const expected=(await fixture.read(currentActor,`select id from public.${table} where work_order_id=$1 ${name==='activity'?'and deleted_at is null':''} order by ${timeColumn} desc nulls last,id desc`,[parent])).rows.map(item=>item.id);
    assert.equal(JSON.stringify(walk),JSON.stringify(expected));
    report.cursorChecks.push({name:`${name}: full bounded traversal exact ordered identities`,result:'PASS',pages,rows:walk.length});
    const first=await read(parent,null,17);
    await assert.rejects(()=>read(parent,'not-valid-base64-json'),error=>error.code==='VALIDATION_FAILED');
    const reused=await read(workOrderId(22),first.nextCursor,100);
    const raw=lastRaw;assert.ok(raw.items.every(item=>item.work_order_id===workOrderId(22)));
    report.cursorChecks.push({name:`${name}: cursor remains positional; another parent re-applies exact filter`,result:'PASS',rows:reused.items.length});
    currentActor=fixture.actors.otherCompany;assert.equal((await read(parent,first.nextCursor)).items.length,0);
    currentActor=fixture.actors.manager;
    report.cursorChecks.push({name:`${name}: replayed cursor cannot bypass actor RLS`,result:'PASS'});
    const pageBefore=await read(parent,null,17),nextBefore=await read(parent,pageBefore.nextCursor,17);
    const rawRow=async id=>(await db.query(`select row_to_json(t) row from public.${table} t where id=$1`,[id])).rows[0].row;
    const removed=await rawRow(nextBefore.items[0].id),inserted=await rawRow(pageBefore.items[0].id);
    inserted.id=name==='activity'?'a7400000-0000-4000-8000-000000000001':'a7400000-0000-4000-8000-000000000002';
    inserted[timeColumn]='2026-09-06T00:00:00Z';
    if(name==='visit')inserted.check_out_at='2026-09-06T01:00:00Z';
    const insert=async row=>ownerUpdate(table,`insert into public.${table} select * from json_populate_record(null::public.${table},$1::json)`,[JSON.stringify(row)]);
    await insert(inserted);await ownerUpdate(table,`delete from public.${table} where id=$1`,[removed.id]);
    try{
      const continuation=await read(parent,pageBefore.nextCursor,17);
      assert.ok(continuation.items.every(item=>item.id!==inserted.id&&item.id!==removed.id&&!pageBefore.items.some(prior=>prior.id===item.id)));
      report.cursorChecks.push({name:`${name}: later insert and deletion preserve positional continuation without count`,result:'PASS',ids:continuation.items.map(item=>item.id)});
    }finally{await ownerUpdate(table,`delete from public.${table} where id=$1`,[inserted.id]);await insert(removed);}
    if(name==='visit'){
      const changed=await rawRow(pageBefore.items[0].id),decoded=JSON.parse(Buffer.from(pageBefore.nextCursor,'base64url').toString('utf8'));
      const earlier=new Date(new Date(decoded.checkIn).getTime()-1).toISOString();
      await ownerUpdate(table,'update public.work_order_visits set check_in_at=$2 where id=$1',[changed.id,earlier]);
      try{const continuation=await read(parent,pageBefore.nextCursor,17);
        assert.ok(continuation.items.some(item=>item.id===changed.id));
        report.cursorChecks.push({name:'visit: inherited mutable sort-key correction may repeat a previously seen identity; caller dedup remains required',result:'CHARACTERIZED',repeatedId:changed.id});
      }finally{await ownerUpdate(table,'update public.work_order_visits set check_in_at=$2 where id=$1',[changed.id,changed.check_in_at]);}
    }
  }
}
try {
  console.log(JSON.stringify({phase:'schema',mode,output}));db=await createDatabase();await applyThrough(db,144);
  fixture=await seedPerformanceFixture(db,{workOrders:mode==='smoke'?100:50000,largeDirectories:mode!=='smoke'});
  await historicalSupplement();await applyThrough(db,146,145);await supplementReadFixtures();
  report.scale=(await db.query(`select (select count(*) from public.work_orders)::integer work_orders,
    (select count(*) from public.activities)::integer activities,(select count(*) from public.invoices)::integer invoices,
    (select count(*) from public.invoice_lines)::integer invoice_lines,(select count(*) from public.work_order_visits)::integer visits`)).rows[0];
  if(mode!=='smoke')assert.deepEqual({...report.scale,visits:undefined},{work_orders:50000,activities:101000,invoices:10007,invoice_lines:11212,visits:undefined});
  const facade=load(join(root,'src/lib/db.ts'));const signal=new AbortController().signal;
  const activities=(id,cursor=null,limit=30)=>facade.loadWorkOrderActivitiesPage({id,storeTimezone:'America/New_York'},cursor,limit,signal);
  const visits=(id,cursor=null,limit=30)=>facade.loadWorkOrderVisitsPage(id,cursor,limit,signal);
  const first=await metric('activity_first_page','manager',()=>activities(workOrderId(2)));
  assert.equal(first.items.length,30);assert.ok(first.hasMore&&first.nextCursor);
  const continuation=await metric('activity_continuation','manager',()=>activities(workOrderId(2),first.nextCursor));
  assert.ok(continuation.items.every(item=>!first.items.some(before=>before.id===item.id)));
  const internal=await metric('staff_internal_activity_page','manager',()=>activities(workOrderId(11)));
  assert.ok(internal.items.length>0&&internal.items.every(item=>item.activityChannel==='internal_note'&&item.isStaffOnly));
  const visible=await metric('contractor_visible_activity_page','contractor',()=>activities(workOrderId(1)));
  assert.ok(visible.items.length>0&&visible.items.every(item=>!item.isStaffOnly));
  const visitFirst=await metric('visit_first_page','manager',()=>visits(workOrderId(2)));
  assert.equal(visitFirst.items.length,30);assert.ok(visitFirst.hasMore&&visitFirst.nextCursor);
  await metric('visit_continuation','manager',()=>visits(workOrderId(2),visitFirst.nextCursor));
  const current=await metric('current_open_visit_in_parent_page','manager',()=>visits(workOrderId(22)));
  assert.equal(current.items.filter(item=>item.checkOutAt===null).length,1);
  for(const actorName of [...Object.keys(fixture.actors),'missingProfile','anonymous']) {
    currentActor=actorName==='missingProfile'?'a7500000-0000-4000-8000-000000000001':fixture.actors[actorName]||null;currentRole=actorName==='anonymous'?'anon':'authenticated';
    const result={actorName};
    for(const[name,invoke]of [['activities',()=>activities(workOrderId(22),null,100)],['visits',()=>visits(workOrderId(22),null,100)],
      ['assigned_invoice_technician_activities',()=>activities(workOrderId(2),null,100)],['assigned_invoice_technician_visits',()=>visits(workOrderId(2),null,100)]]) {
      calls=[];try{const value=await invoke();result[name]={status:'returned',ids:value.items.map(item=>item.id),
        payloadSha256:hash(JSON.stringify(value)),queryCount:calls.length};}
      catch(error){result[name]={status:'rejected',code:error.code||null,name:error.name,queryCount:calls.length};}
    }report.roleReads.push(result);save();
  }
  report.roleChecks=verifyRecordedRoleMatrix(report.roleReads);
  await verifyPrivacy(activities,visits);await verifyCursors(activities,visits);
  if(baselinePath){const text=readFileSync(baselinePath,'utf8'),baseline=JSON.parse(text);assert.equal(baseline.result,'PASS');
    report.baseline={path:baselinePath,sha256:hash(text)};assert.deepEqual(report.scale,baseline.scale);
    for(const row of report.measurements){const before=baseline.measurements.find(item=>item.name===row.name);assert.ok(before);
      assert.equal(row.bytes,before.bytes);assert.equal(row.publicSha256,before.publicSha256);
      assert.equal(JSON.stringify(row.queryLog),JSON.stringify(before.queryLog));row.beforeAfter={beforeP50Ms:before.total.p50Ms,
        beforeP95Ms:before.total.p95Ms,p95DifferenceMs:row.total.p95Ms-before.total.p95Ms,
        localBudgetDecision:row.withinLocalBudget?'PASS':'FAIL',relativeTolerance:'NOT_DEFINED_BY_EXISTING_RECORDS'};}
    assert.equal(JSON.stringify(report.roleReads),JSON.stringify(baseline.roleReads));
    report.baselineRoleChecks=verifyRecordedRoleMatrix(baseline.roleReads);
    assert.deepEqual(report.roleChecks,report.baselineRoleChecks);
    assert.equal(JSON.stringify(report.privacyChecks),JSON.stringify(baseline.privacyChecks));
    assert.equal(JSON.stringify(report.cursorChecks),JSON.stringify(baseline.cursorChecks));}
  report.result='PASS';
}catch(error){report.result='FAIL';report.failures.push({message:error.message,stack:error.stack});process.exitCode=1;}
finally{report.completedAt=new Date().toISOString();save();await db?.close();console.log(JSON.stringify({result:report.result,output}));}
