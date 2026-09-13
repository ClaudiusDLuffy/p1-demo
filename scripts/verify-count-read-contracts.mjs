// Isolated synthetic schema/read-contract verification; no provider/network.
import './pagination-test-support/syntheticSqlPrivacy.mjs';
import assert from 'node:assert/strict';
import { readFileSync,mkdtempSync,writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDatabase,applyThrough,seedPerformanceFixture,workOrderId } from './query-performance-test-support/fixtures.mjs';

const db=await createDatabase();let checks=0;
const check=(condition,label)=>{assert.ok(condition,label);checks++;};
const families=[
  ['list_work_orders_page','list_work_orders_rows_v1','count_work_orders_v1',"p_scope=>'all'"],
  ['list_work_orders_table_page','list_work_orders_table_rows_v1','count_work_orders_table_v1',"p_scope=>'all'"],
  ['list_work_order_activities_page','list_work_order_activities_rows_v1','count_work_order_activities_v1',`p_work_order_id=>'${workOrderId(1)}'`],
  ['list_work_order_photos_page','list_work_order_photos_rows_v1','count_work_order_photos_v1',`p_work_order_id=>'${workOrderId(1)}'`],
  ['list_work_order_visits_page','list_work_order_visits_rows_v1','count_work_order_visits_v1',`p_work_order_id=>'${workOrderId(1)}'`],
  ['list_contractor_invoices_page','list_contractor_invoices_rows_v1','count_contractor_invoices_v1',"p_state=>'all'"],
  ['list_staff_invoices_page','list_staff_invoices_rows_v1','count_staff_invoices_v1',"p_queue=>'all'"],
];
try {
  await applyThrough(db,143);
  const oldDefinitions=(await db.query(`select oid::regprocedure::text signature,pg_get_functiondef(oid) definition
    from pg_proc where pronamespace='public'::regnamespace order by oid`)).rows;
  const policySnapshot=()=>db.query(`select polrelid::regclass::text relation,polname,polcmd,polpermissive,polroles,
    pg_get_expr(polqual,polrelid) using_expression,pg_get_expr(polwithcheck,polrelid) check_expression
    from pg_policy where not(polrelid='public.work_orders'::regclass and polname='wo_read') order by polrelid,polname`);
  const otherPolicies=(await policySnapshot()).rows;
  const f=await seedPerformanceFixture(db,{workOrders:100,largeDirectories:false});
  const priorVisibility={};
  for(const [actorName,actor]of Object.entries(f.actors)) priorVisibility[actorName]=
    (await f.read(actor,'select id from public.work_orders order by id')).rows;
  await applyThrough(db,144,144);
  assert.deepEqual((await policySnapshot()).rows,otherPolicies,'Every other RLS policy remains byte-equivalent');checks++;
  for(const [actorName,actor]of Object.entries(f.actors)) {
    assert.deepEqual((await f.read(actor,'select id from public.work_orders order by id')).rows,priorVisibility[actorName],
      'Forward read optimization preserves exact authorized work-order identity set');checks++;
  }
  const allSyntheticIds=(await db.query('select id from public.work_orders order by id')).rows.map(row=>row.id);
  const checkNavigation=async actor=>{
    const pair=(await f.read(actor,'select public.get_portal_navigation_summary() old,public.get_portal_navigation_summary_v1() next')).rows[0];
    assert.deepEqual(pair.next,pair.old,'Exact navigation scalars share role scope and statement-stable SLA clock');checks++;
    check(Object.keys(pair.next).length===14,'All fourteen legacy navigation fields remain');
  };
  for(const actor of Object.values(f.actors)) await checkNavigation(actor);
  await assert.rejects(()=>f.read(null,'select public.get_portal_navigation_summary_v1()',[],'anon'));checks++;
  const checkCurrentPolicy=async actor=>{
    const expected=(await f.read(actor,`select candidate.id from unnest($1::text[])candidate(id)
      where public.can_access_contractor_work_order(candidate.id) order by candidate.id`,[allSyntheticIds])).rows;
    assert.deepEqual((await f.read(actor,'select id from public.work_orders order by id')).rows,expected,
      'InitPlan policy equals unchanged canonical row helper after identity transition');checks++;
    await checkNavigation(actor);
  };
  await db.query('update public.profiles set active=false where id=$1',[f.actors.manager]);
  await checkCurrentPolicy(f.actors.manager);
  await db.query('update public.profiles set active=true where id=$1',[f.actors.manager]);
  await checkCurrentPolicy(f.actors.manager);
  await db.query("insert into public.staff_permission_grants(profile_id,permission)values($1,'invoice_controller')",[f.actors.manager]);
  await checkCurrentPolicy(f.actors.manager);
  await db.query("delete from public.staff_permission_grants where profile_id=$1 and permission='invoice_controller'",[f.actors.manager]);
  await db.query('update public.contractor_technicians set is_active=false where profile_id=$1',[f.actors.technician]);
  await checkCurrentPolicy(f.actors.technician);
  await db.query('update public.contractor_technicians set is_active=true where profile_id=$1',[f.actors.technician]);
  await checkCurrentPolicy(f.actors.technician);
  await db.query('update public.organizations set active=false where canonical_contractor_id=$1',[f.actors.companyAdmin]);
  await checkCurrentPolicy(f.actors.companyAdmin);await checkCurrentPolicy(f.actors.invoiceMember);
  await db.query('update public.organizations set active=true where canonical_contractor_id=$1',[f.actors.companyAdmin]);
  await checkCurrentPolicy(f.actors.companyAdmin);
  for(const previous of oldDefinitions) {
    const now=(await db.query('select pg_get_functiondef(to_regprocedure($1)) definition',[previous.signature])).rows[0];
    check(now.definition===previous.definition,'Existing function remains byte-identical');
  }
  const result=async(name,args,actor=f.actors.manager,role='authenticated')=>
    (await f.read(actor,`select public.${name}(${args}) result`,[],role)).rows[0].result;
  for(const [actorName,actor]of Object.entries(f.actors)) for(const [legacy,rows,count,args]of families) {
    const before=await result(legacy,args,actor),page=await result(rows,args,actor),total=await result(count,args,actor);
    assert.deepEqual(page.items,before.items,`${actorName}: row parity ${rows}`);checks++;
    check(page.hasMore===before.hasMore&&page.nextCursor===before.nextCursor,'Cursor compatibility');
    check(!Object.hasOwn(page,'totalCount')&&!Object.hasOwn(page,'aggregates'),'Rows omit global aggregates');
    check(total.totalCount===before.totalCount,'Exact count matches authorized legacy scope');
    if(before.hasMore) {
      const nextArgs=`${args},p_cursor=>$1`;
      const next=(await f.read(actor,`select public.${rows}(${nextArgs}) result`,[page.nextCursor])).rows[0].result;
      check(!Object.hasOwn(next,'totalCount'),'Continuation does not return total');
      check(!next.items.some(item=>page.items.some(first=>first.id===item.id)),'No tied-order duplicate');
    }
  }
  for(const scope of ['active','operations','operations_all','capital','history','ready_to_bill','staff_work',
    'staff_work_unread','staff_work_todo','staff_work_ready','dashboard_unassigned','dashboard_pending_submission',
    'dashboard_pending_approval','dashboard_awaiting_parts','dashboard_seven_eleven_updates','dashboard_p1_parts_to_order',
    'dashboard_pending_capital_completion']) {
    for(const [legacy,rows,count]of families.slice(0,2)) {
      const before=await result(legacy,`p_scope=>'${scope}'`),after=await result(rows,`p_scope=>'${scope}'`),total=await result(count,`p_scope=>'${scope}'`);
      assert.deepEqual(after.items,before.items);checks++;
      check(total.totalCount===before.totalCount,'Exact scope count parity');
      if(legacy==='list_work_orders_page') {assert.deepEqual(total.aggregates,before.aggregates);checks++;}
    }
  }
  for(const actor of [f.actors.manager,f.actors.contractor,f.actors.companyAdmin]) {
    for(const filters of ["p_needs_action=>true","p_needs_action=>null","p_needs_action=>null,p_pending_first=>null",
      "p_needs_action=>false,p_pending_first=>null","p_pending_first=>true","p_sort=>'priority'", "p_sort=>'sla_due'",
      "p_sort=>'oldest',p_search=>'SYNTHETIC-PERF-0000'", "p_scope=>'history',p_state=>'FL'",
      "p_scope=>'staff_work_unread',p_pending_first=>true", "p_scope=>'dashboard_seven_eleven_updates'",
      "p_priority=>'p1'", "p_from=>'2026-08-31',p_to=>'2026-09-03'",
      "p_scope=>'all',p_status=>'parts'", "p_contractor_id=>'"+f.actors.companyAdmin+"'"]) {
      for(const [legacy,rows,count]of families.slice(0,2)) {
        const before=await result(legacy,filters,actor),after=await result(rows,filters,actor),total=await result(count,filters,actor);
        assert.deepEqual(after.items,before.items);checks++;
        check(total.totalCount===before.totalCount,'Mixed filtered authorized count parity');
        check(after.nextCursor===before.nextCursor,'Mixed sort cursor parity');
      }
    }
  }
  for(const column of ['work_order','status','priority','incident','store','summary','contractor','technician','created','updated','closed','sla'])
    for(const direction of ['asc','desc']) {
      const args=`p_scope=>'all',p_sort_column=>'${column}',p_sort_direction=>'${direction}',p_pending_first=>true`;
      const before=await result('list_work_orders_table_page',args),after=await result('list_work_orders_table_rows_v1',args);
      assert.deepEqual(after.items,before.items);checks++;
      check(after.nextCursor===before.nextCursor,'Full table sorting and pending priority compatibility');
    }
  for(const filter of ["p_work_order_filter=>'0000'","p_incident_filter=>'missing'","p_store_filter=>'missing'",
    "p_summary_filter=>'Synthetic'","p_contractor_filter=>'company'","p_created_date_filter=>'2026-08-31'",
    "p_updated_date_filter=>'2026-08-31'","p_sla_filter=>'overdue'"]) {
    const before=await result('list_work_orders_table_page',filter),after=await result('list_work_orders_table_rows_v1',filter),
      total=await result('count_work_orders_table_v1',filter);
    assert.deepEqual(after.items,before.items);checks++;
    check(total.totalCount===before.totalCount,'Every table filter shares exact count policy');
  }
  for(const [,rows,count,args]of families) {
    for(const name of [rows,count]) await assert.rejects(()=>result(name,args,null,'anon'));checks++;
  }
  const helperCatalog=(await db.query(`select p.proname,p.prosecdef,p.provolatile,p.proconfig,
    has_function_privilege('anon',p.oid,'EXECUTE') anon_execute,p.prosrc
    from pg_proc p where p.pronamespace='p1_read_contracts'::regnamespace and proname<>'validate_v1'`)).rows;
  check(helperCatalog.length===7,'Seven focused helper families');
  for(const routine of helperCatalog) {
    check(!routine.prosecdef&&!routine.anon_execute&&routine.provolatile==='s','Helpers preserve RLS and grants');
    check(routine.prosrc.includes("case when p_read_mode='count'"),'Explicit count branch');
    check(routine.proconfig.includes('search_path=pg_catalog, public'),'Pinned helper path');
  }
  // A deliberately failing count expression proves rows/continuation do not
  // execute it; owner-only alteration is rolled back inside this test session.
  await db.exec("create function p1_read_contracts.synthetic_count_failure() returns bigint language plpgsql as $$ begin raise exception 'SYNTHETIC_COUNT_BRANCH'; end $$; grant execute on function p1_read_contracts.synthetic_count_failure() to authenticated");
  const definition=(await db.query("select pg_get_functiondef(oid) definition from pg_proc where pronamespace='p1_read_contracts'::regnamespace and proname='work_orders_v1'")).rows[0].definition;
  await db.exec(definition.replace("'totalCount', (select count(*) from filtered)","'totalCount', (select p1_read_contracts.synthetic_count_failure())"));
  const first=await result('list_work_orders_rows_v1',"p_scope=>'all',p_limit=>10");
  check(first.items.length===10,'Rows succeed while count branch fails');
  const continuation=(await f.read(f.actors.manager,'select public.list_work_orders_rows_v1(p_scope=>\'all\',p_limit=>10,p_cursor=>$1) result',[first.nextCursor])).rows[0].result;
  check(continuation.items.length===10,'Continuation also skips failing count');
  await assert.rejects(()=>result('count_work_orders_v1',"p_scope=>'all'"),error=>error.message.includes('SYNTHETIC_COUNT_BRANCH'));checks++;
  await db.exec(definition);
  await db.exec('drop function p1_read_contracts.synthetic_count_failure()');
  for(const [name,args]of [
    ['count_work_orders_v1',"p_scope=>'invalid'"],['count_work_orders_table_v1',"p_scope=>'invalid'"],
    ['count_work_orders_v1',"p_status=>'invalid'"],['count_work_orders_v1',"p_priority=>'invalid'"],
    ['count_work_orders_v1',"p_state=>'invalid'"],['count_work_orders_v1',"p_sort=>'invalid'"],
    ['count_work_orders_table_v1',"p_sort_column=>'invalid'"],['count_work_orders_table_v1',"p_sla_filter=>'invalid'"],
    ['count_contractor_invoices_v1',"p_state=>'invalid'"],['count_staff_invoices_v1',"p_queue=>'invalid'"],
    ['list_work_orders_rows_v1',"p_limit=>0"],['list_work_orders_rows_v1',"p_limit=>101"],
    ['list_contractor_invoices_rows_v1',"p_direction=>'invalid'"],
    ['count_staff_invoices_v1',"p_search=>repeat('a',1001)"],['count_staff_invoices_v1',"p_search=>chr(10)"],
  ]) {await assert.rejects(()=>result(name,args),error=>error.code==='22023'&&error.message==='INVALID_REQUEST');checks++;}
  const audit=readFileSync(new URL('../supabase/audits/0144_count_independent_page_reads_verification.sql',import.meta.url),'utf8');
  const auditRows=await db.query(audit);
  check(auditRows.rows.every(row=>row.all_checks_pass===true),'Read-only contract audit');
  const signatures=(await db.query(`select p.proname,pg_get_function_arguments(p.oid) arguments,
    pg_get_function_identity_arguments(p.oid) identity_arguments,pg_get_function_result(p.oid) result,
    p.prosecdef security_definer,p.provolatile volatility,p.proconfig,
    has_function_privilege('anon',p.oid,'execute') anon_execute,
    has_function_privilege('authenticated',p.oid,'execute') authenticated_execute,
    has_function_privilege('service_role',p.oid,'execute') service_role_execute
    from pg_proc p where pronamespace='public'::regnamespace and
      (proname=any($1::text[]) or proname='get_portal_navigation_summary_v1') order by proname`,
    [families.flatMap(([,rows,count])=>[rows,count])])).rows;
  const signaturePath=join(mkdtempSync(join(tmpdir(),'p1-phase6b-signatures-')),'signatures.json');
  writeFileSync(signaturePath,JSON.stringify(signatures,null,2)+'\n',{mode:0o600});
  console.log(JSON.stringify({evidence:'PGLITE_LOCAL',checks,failed:0,scale:f.scale,oldFunctionsPreserved:oldDefinitions.length,signaturePath}));
}catch(error){console.error(JSON.stringify({failed:true,code:error?.code||'ASSERTION',message:String(error?.message||'Verification failed').slice(0,500)}));process.exitCode=1;}
finally{await db.close();}
