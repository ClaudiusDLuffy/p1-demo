import './pagination-test-support/syntheticSqlPrivacy.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createDatabase, applyThrough } from './receiving-dispatch-test-support/fixtures.mjs';
import { actorTransactions, initializeLifecycleActors } from './lifecycle-test-support/engine-fixtures.mjs';
import { syntheticSqlPrivacyReceipt } from './pagination-test-support/syntheticSqlPrivacy.mjs';
import { directoryScopeCases } from './pagination-test-support/directoryScopeCases.mjs';

const db = await createDatabase();
let checks = 0;
const check = async (label, run) => { await run(); checks++; console.log(`ok ${checks} - ${label}`); };
try {
  await applyThrough(db, 143);
  const actors = await initializeLifecycleActors(db);
  const as = actorTransactions(db);
  const definitions = async () => (await db.query(`select p.oid,p.proname,pg_get_functiondef(p.oid) definition,p.proacl
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.prokind='f' order by p.oid`)).rows;
  const sourceRows = async () => (await db.query(`select jsonb_build_object(
    'profiles',(select jsonb_agg(to_jsonb(p) order by id) from public.profiles p),
    'grants',(select jsonb_agg(to_jsonb(g) order by profile_id,permission) from public.staff_permission_grants g),
    'technicians',(select jsonb_agg(to_jsonb(t) order by id) from public.contractor_technicians t),
    'workOrders',(select jsonb_agg(to_jsonb(w) order by id) from public.work_orders w)) data`)).rows[0].data;
  const beforeFunctions = await definitions();
  const beforeRows = await sourceRows();
  await applyThrough(db, 144, 144);
  await check('additive migration preserves every earlier function definition/ACL and all source rows', async () => {
    const after = await definitions();
    for (const row of beforeFunctions) assert.deepEqual(after.find(candidate => candidate.oid === row.oid), row);
    assert.deepEqual(await sourceRows(), beforeRows);
  });
  const rpc = (name, args, actor = actors.mgr, role = 'authenticated') => as(role, actor, async tx => {
    await tx.exec('set transaction read only');
    return (await tx.query(`select public.${name}(${args.map((_, i) => `$${i + 1}`).join(',')}) result`, args)).rows[0].result;
  });
  const page = (domain, options = {}) => rpc('list_directory_page_v1', [domain, options.query ?? '', options.company ?? null,
    options.limit ?? 25, options.cursor ?? null], options.actor ?? actors.mgr, options.role ?? 'authenticated');
  const selected = (domain, id, company = null, actor = actors.mgr) => rpc('get_directory_selection_v1', [domain, id, company], actor);
  const denies = (run, code = '42501') => assert.rejects(run, error => error.code === code);
  await check('active staff scope, controller separation, no profile, anonymous and service denial', async () => {
    assert.equal((await page('assignable_contractors')).pageSize, 25);
    for (const actor of [actors.controller, actors.inactive, actors.contractor, '49999999-0000-4000-8000-000000000000']) {
      await denies(() => page('assignable_contractors', { actor }));
    }
    for (const role of ['anon', 'service_role']) await denies(() => page('assignable_contractors', { role }));
    assert.ok(Array.isArray((await page('contractor_filter', { actor: actors.controller })).items));
    await denies(()=>page('staff_choices',{actor:actors.controller}));
    assert.equal((await selected('staff_choices',actors.controller)).id,actors.controller);
    assert.equal(await selected('staff_choices',actors.inactive),null);
    for (const limit of [0, 51, -1]) await denies(() => page('contractor_filter', { limit }), '22023');
    await denies(() => page('invalid'), '22023');
    await denies(() => page('contractor_filter', { company: actors.contractor }), '22023');
    await denies(() => page('contractor_filter', { query: 'x'.repeat(201) }), '22023');
    for (const query of ['Synthetic\tTie','Synthetic\nTie','Synthetic\rTie','Synthetic\u007fTie']) {
      await denies(() => page('contractor_filter', { query }), '22023');
    }
  });

  // Reserved synthetic identities only: 5,000 profile rows, 5,000 record-only
  // rows and 5,000 active profile links, each in a worst-case single-company
  // scope. Rename profiles after linking to exercise canonical-name reads and
  // duplicate normalized display names without rewriting historical row names.
  await db.exec(`insert into auth.users(id,email)
    select ('50000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid, 'directory.'||n||'@example.invalid'
    from generate_series(1,5000) n;
    update public.profiles set name=case when right(id::text,1) in ('0','1') then '  Synthetic   Tie  '
      else 'Synthetic '||right(id::text,12) end, company='Synthetic Company',territory='Austin, TX',trades=array['HVAC'],
      is_assignable=true,active=true where id::text like '50000000-%';
    insert into public.contractor_technicians(id,contractor_id,name,is_active)
    select ('60000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
      '${actors.contractor}', 'Synthetic Technician '||lpad(n::text,6,'0'),true from generate_series(1,5000) n;
    insert into public.organizations(id,name,slug,active)
      values('71000000-0000-4000-8000-000000000001','Synthetic Scale Organization','synthetic-scale-directory',true);
    update public.profiles set contractor_organization_id='71000000-0000-4000-8000-000000000001',contractor_access_level='company_admin'
      where id='${actors.outsider}';
    update public.organizations set canonical_contractor_id='${actors.outsider}' where id='71000000-0000-4000-8000-000000000001';
    update public.profiles set contractor_organization_id='71000000-0000-4000-8000-000000000001',contractor_access_level='report_only',
      name='Synthetic '||right(id::text,12) where id::text like '50000000-%';
    insert into public.contractor_technicians(id,contractor_id,profile_id,name,is_active)
      select ('70000000-0000-4000-8000-'||right(p.id::text,12))::uuid,'${actors.outsider}',p.id,p.name,true
      from public.profiles p where p.id::text like '50000000-%';
    update public.profiles set name='  Synthetic   Tie  ' where id::text like '50000000-%' and right(id::text,1) in ('0','1');
    insert into auth.users(id,email)
      select ('72000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'staff.'||n||'@directory.example.invalid'
      from generate_series(1,2000) n;
    update public.profiles set name=case when right(id::text,1) in ('0','1','2') then '  Synthetic   Staff Tie  '
      else 'Synthetic Staff '||right(id::text,12) end,
      role=(case (right(id::text,12)::integer % 3) when 0 then 'manager' when 1 then 'dispatcher' else 'back_office' end)::public.user_role,
      active=(right(id::text,12)::integer % 5 <> 0),is_assignable=false where id::text like '72000000-%';
    analyze public.profiles; analyze public.contractor_technicians;`);
  const plans = {};
  const plan = async (label, sql, args = []) => {
    const result = (await db.query(`explain (analyze, buffers, format json) ${sql}`, args)).rows[0]['QUERY PLAN'][0];
    const summarize = node => ({ type: node['Node Type'], relation: node['Relation Name'], index: node['Index Name'],
      actualRows: node['Actual Rows'], loops: node['Actual Loops'], rowsRemoved: node['Rows Removed by Filter'],
      sharedHits: node['Shared Hit Blocks'], sortKey: node['Sort Key'], indexCondition: node['Index Cond'], plans: node.Plans?.map(summarize) });
    plans[label] = { executionMs: result['Execution Time'], planningMs: result['Planning Time'], plan: summarize(result.Plan) };
  };
  const candidateSignature = 'public.directory_candidates_v1(text,uuid,text,uuid,integer,text,uuid,timestamp with time zone)';
  const body = (await db.query('select prosrc from pg_proc where oid=$1::regprocedure', [candidateSignature])).rows[0].prosrc;
  const argumentNames = ['p_domain','p_contractor_id','p_query','p_id','p_limit','p_last_name','p_last_id','p_snapshot_at'];
  const argumentTypes = ['text','uuid','text','uuid','integer','text','uuid','timestamptz'];
  const parameterizedBody = body.replace(/\bp_[a-z_]+\b/g, name => {
    const index = argumentNames.indexOf(name); assert.ok(index >= 0); return `($${index + 1}::${argumentTypes[index]})`;
  });
  const indexSql = 'create index profiles_directory_name_cursor_v1 on public.profiles (public.directory_sort_key_v1(name) collate "C",id)';
  for (const phase of ['before','after']) {
    if (phase === 'after') { await db.exec(indexSql); await db.exec('analyze public.profiles'); }
    if (phase === 'after') await plan('direct_index_order_check', `select id,public.directory_sort_key_v1(name) collate "C" sort_name
      from public.profiles where role='contractor' order by public.directory_sort_key_v1(name) collate "C",id limit 26`);
    for (const domain of ['contractor_filter','company_technicians']) for (const later of [false,true]) {
      const technician = domain === 'company_technicians';
      const args = [domain, technician ? actors.contractor : null, '', null, 26,
        later ? technician ? 'synthetic technician 002500' : 'synthetic 000000002500' : null,
        later ? `${technician ? '6' : '5'}0000000-0000-4000-8000-000000002500` : null, new Date().toISOString()];
      await plan(`${phase}_${domain}_${later ? 'later' : 'first'}_actual_helper`,
        'select * from public.directory_candidates_v1($1,$2,$3,$4,$5,$6,$7,$8)', args);
      await plan(`${phase}_${domain}_${later ? 'later' : 'first'}_exact_body`, parameterizedBody, args);
    }
    for (const later of [false,true]) {
      const args = ['company_technicians',actors.outsider,'',null,26,
        later ? 'synthetic 000000002500' : null,later ? '70000000-0000-4000-8000-000000002500' : null,new Date().toISOString()];
      await plan(`${phase}_linked_company_${later ? 'later' : 'first'}_actual_helper`,
        'select * from public.directory_candidates_v1($1,$2,$3,$4,$5,$6,$7,$8)',args);
      await plan(`${phase}_linked_company_${later ? 'later' : 'first'}_exact_body`,parameterizedBody,args);
    }
    for (const [label,domain,company,actor] of [
      ['profiles','contractor_filter',null,actors.mgr],
      ['record_only','company_technicians',actors.contractor,actors.mgr],
      ['linked','company_technicians',actors.outsider,actors.outsider],
      ['staff','staff_choices',null,actors.mgr],
    ]) {
      const first=await page(domain,{company,actor});
      for (const [position,cursor] of [['first',null],['continuation',first.nextCursor]]) {
        await as('authenticated',actor,async tx=>{
          const result=await tx.query('explain(analyze,buffers,format json) select public.list_directory_page_v1($1,\'\',$2,25,$3)',
            [domain,company,cursor]);
          const explain=result.rows[0]['QUERY PLAN'][0];
          plans[`${phase}_${label}_${position}_actual_rpc`]={executionMs:explain['Execution Time'],actualRows:explain.Plan['Actual Rows']};
        });
      }
    }
  }
  for (const domain of ['contractor_filter','company_technicians']) {
    await as('authenticated', actors.mgr, async tx => {
      const result = await tx.query(`explain(analyze,buffers,format json) select public.list_directory_page_v1($1,'',$2,25,null)`,
        [domain,domain === 'company_technicians' ? actors.contractor : null]);
      const explain = result.rows[0]['QUERY PLAN'][0];
      plans[`after_${domain}_actual_rpc`] = { executionMs: explain['Execution Time'], actualRows: explain.Plan['Actual Rows'] };
    });
  }
  console.log(JSON.stringify({ representativeSyntheticPlans: plans }));
  console.log(JSON.stringify({ finalNoNewIndexRpcPlanSummary:Object.fromEntries(Object.entries(plans)
    .filter(([name])=>name.startsWith('before_')&&name.endsWith('_actual_rpc'))) }));
  // The candidate index remains a disposable measured experiment until the
  // migration explicitly adopts it; behavioral checks run against final DDL.
  await db.exec('drop index public.profiles_directory_name_cursor_v1');

  await check('5,000-row directory pagination reaches all identities once with normalized duplicate-name ties', async () => {
    const expected = (await db.query(`select id from public.profiles where role='contractor'
      order by public.directory_sort_key_v1(name) collate "C",id`)).rows.map(row => row.id);
    const seen = []; let cursor = null;
    do {
      const result = await page('contractor_filter', { limit: 50, cursor });
      assert.ok(result.items.length <= 50); assert.equal(result.pageSize, 50);
      assert.equal(result.hasMore, result.nextCursor !== null);
      result.items.forEach(item => assert.deepEqual(Object.keys(item).sort(), ['id', 'name']));
      seen.push(...result.items.map(item => item.id)); cursor = result.nextCursor;
    } while (cursor);
    assert.deepEqual(seen, expected); assert.equal(new Set(seen).size, seen.length);
    const exact = await selected('contractor_filter', expected.at(-1)); assert.equal(exact.id, expected.at(-1));
  });
  await check('5,000 canonical linked technician identities traverse once, including renamed/duplicate labels',async () => {
    const expected = (await db.query(`select t.id from public.contractor_technicians t join public.profiles p on p.id=t.profile_id
      where t.contractor_id=$1 order by public.directory_sort_key_v1(p.name) collate "C",t.id`,[actors.outsider])).rows.map(row=>row.id);
    const seen=[]; let cursor=null;
    do {
      const result=await page('company_technicians',{company:actors.outsider,limit:50,cursor,actor:actors.outsider});
      seen.push(...result.items.map(row=>row.id)); cursor=result.nextCursor;
    } while(cursor);
    assert.equal(seen.length,5000);assert.deepEqual(seen,expected);assert.equal(new Set(seen).size,5000);
    assert.equal((await selected('company_technicians',expected.at(-1),actors.outsider,actors.outsider)).id,expected.at(-1));
  });
  await check('5,000 record-only technician rows traverse once and remain selectable labels without portal authority',async () => {
    const expected=(await db.query(`select id from public.contractor_technicians where contractor_id=$1
      order by public.directory_sort_key_v1(name) collate "C",id`,[actors.contractor])).rows.map(row=>row.id);
    const seen=[];let cursor=null;
    do {
      const result=await page('company_technicians',{company:actors.contractor,limit:50,cursor});
      for(const item of result.items) assert.equal(item.profileId,null);
      seen.push(...result.items.map(row=>row.id));cursor=result.nextCursor;
    } while(cursor);
    assert.deepEqual(seen,expected);assert.equal(new Set(seen).size,5000);
  });
  await check('2,000 mixed staff fixtures page every active staff target once, exclude inactive, and preserve controller targets',async()=>{
    const expected=(await db.query(`select id from public.profiles where active=true and role in ('manager','dispatcher','back_office')
      order by public.directory_sort_key_v1(name) collate "C",id`)).rows.map(row=>row.id);
    const seen=[];let cursor=null;let maxPayload=0;
    do {
      const result=await page('staff_choices',{limit:50,cursor});
      maxPayload=Math.max(maxPayload,Buffer.byteLength(JSON.stringify(result)));
      for(const item of result.items) assert.deepEqual(Object.keys(item).sort(),['id','name']);
      seen.push(...result.items.map(row=>row.id));cursor=result.nextCursor;
    } while(cursor);
    assert.ok(expected.length>1000);assert.deepEqual(seen,expected);assert.equal(new Set(seen).size,seen.length);
    assert.ok(seen.includes(actors.controller));assert.equal(seen.includes(actors.inactive),false);
    console.log(JSON.stringify({staffFixtureRows:2000,staffFixtureActiveRows:1600,staffFixtureInactiveRows:400,
      visibleActiveStaffIncludingEarlierFixtures:seen.length,maxStaffPagePayloadBytes:maxPayload}));
  });
  await check('management and contact domains remain traversable beyond provider row caps with minimal projections',async()=>{
    for(const [domain,company,sql,args] of [
      ['contractor_directory',null,"select id from public.profiles where role='contractor' and is_assignable=true order by public.directory_sort_key_v1(name) collate \"C\",id",[]],
      ['contacts',null,"select id from public.profiles where active=true and role in ('manager','dispatcher','back_office','contractor') order by public.directory_sort_key_v1(name) collate \"C\",id",[]],
      ['technician_management',actors.contractor,'select id from public.contractor_technicians where contractor_id=$1 order by public.directory_sort_key_v1(name) collate "C",id',[actors.contractor]],
    ]) {
      const expected=(await db.query(sql,args)).rows.map(row=>row.id);const seen=[];let cursor=null;
      do {
        const result=await page(domain,{company,limit:50,cursor});
        for(const item of result.items) for(const key of ['email','phone','grants','permissions']) assert.equal(Object.hasOwn(item,key),false);
        seen.push(...result.items.map(row=>row.id));cursor=result.nextCursor;
      } while(cursor);
      assert.ok(expected.length>1000);assert.deepEqual(seen,expected);assert.equal(new Set(seen).size,seen.length);
    }
  });
  await check('cursor binds current actor/grants, domain, normalized search, company and limit with strict shape', async () => {
    const first = await page('contractor_filter');
    for (const options of [{ domain: 'contractor_directory' }, { limit: 26 }, { query: 'Synthetic' }, { actor: actors.controller }]) {
      await denies(() => page(options.domain ?? 'contractor_filter', { ...options, cursor: first.nextCursor }), 'PDC01');
    }
    for (const cursor of ['', '!!', 'null', `${first.nextCursor}\n`, first.nextCursor.slice(1)]) {
      await denies(() => page('contractor_filter', { cursor }), 'PDC01');
    }
    const raw = (await db.query('select public.portal_decode_cursor($1) value', [first.nextCursor])).rows[0].value;
    for (const changed of [{ ...raw, version: 2 }, { ...raw, extra: true }, { ...raw, id: null }, { ...raw, name: [] },
      { ...raw, snapshotAt: 'infinity' }, { ...raw, snapshotAt: '2999-01-01' }, { ...raw, snapshotAt:'now' }]) {
      const cursor = (await db.query('select public.portal_encode_cursor($1::jsonb) value', [JSON.stringify(changed)])).rows[0].value;
      await denies(() => page('contractor_filter', { cursor }), 'PDC01');
    }
    await db.query("insert into public.staff_permission_grants(profile_id,permission) values($1,'quickbooks_handoff')", [actors.mgr]);
    await denies(() => page('contractor_filter', { cursor: first.nextCursor }), 'PDC01');
  });
  await check('minimal list DTOs, exact private contacts and bounded exact labels do not hydrate grants', async () => {
    for (const domain of ['assignable_contractors', 'contractor_directory', 'contacts', 'staff_choices']) {
      const result = await page(domain);
      for (const item of result.items) for (const forbidden of ['email','phone','permissions','grants','rates','nte','hourlyRate']) {
        assert.equal(Object.hasOwn(item, forbidden), false);
      }
    }
    assert.equal((await selected('contact_detail', actors.contractor)).id, actors.contractor);
    assert.equal(await selected('contact_detail', actors.outsider, null, actors.contractor), null);
    const labels = await rpc('get_directory_profile_labels_v1', [[actors.contractor, actors.outsider]], actors.contractor);
    assert.deepEqual(labels.map(row => row.id), [actors.contractor]);
    await denies(() => rpc('get_directory_profile_labels_v1', [Array(101).fill(actors.contractor)]), '22023');
    assert.deepEqual(await rpc('get_directory_profile_labels_v1', [[]]), []);
    await denies(() => rpc('get_directory_profile_labels_v1', [[null]]), '22023');
    const management = await page('technician_management', { company: actors.contractor });
    assert.equal(management.items.length, 25); assert.equal(management.hasMore, true);
    await denies(() => page('company_technicians', { company: actors.contractor, actor: actors.contractor }));
  });
  await directoryScopeCases({ db, check, page, selected, rpc, denies, actors });
  await check('all directory entry points remain actual read-only and private helpers are not executable by portal roles', async () => {
    const before = await sourceRows();
    await page('contractor_directory'); await page('company_technicians', { company: actors.contractor });
    await rpc('get_directory_auto_assignment_candidate_v1', ['Austin', ['HVAC']]);
    assert.deepEqual(await sourceRows(), before);
    for (const role of ['anon','authenticated','service_role']) {
      await denies(() => as(role, actors.mgr, tx => tx.query("select public.directory_projection_v1('contact_detail',$1)", [actors.outsider])));
      await denies(() => as(role, actors.mgr, tx => tx.query("select * from public.directory_candidates_v1('contacts',null,'')")));
    }
  });
  await check('pinned function paths resist temporary shadows and the private identity materialization has a hard51 cap',async()=>{
    const rows=(await db.query("select * from public.directory_candidates_v1('contractor_filter',null,'',null,100000,null,null,now())")).rows;
    assert.equal(rows.length,51);
    await as('authenticated',actors.mgr,async tx=>{
      await tx.exec(`create temporary table profiles(id uuid,name text) on commit drop;
        create function pg_temp.directory_projection_v1(text,uuid) returns jsonb language sql as $$select '{"shadow":true}'::jsonb$$;`);
      const result=(await tx.query("select public.list_directory_page_v1('contractor_filter') value")).rows[0].value;
      assert.equal(result.items.length,25);for(const item of result.items) assert.equal(Object.hasOwn(item,'shadow'),false);
      await tx.exec('drop function pg_temp.directory_projection_v1(text,uuid)');
    });
  });
  const auditPath = new URL('../supabase/audits/0144_bounded_role_scoped_directories_verification.sql', import.meta.url);
  await check('metadata-only audit executes in READ ONLY transaction', async () => {
    const results = await db.transaction(async tx => { await tx.exec('set transaction read only'); return tx.exec(readFileSync(auditPath,'utf8')); });
    for (const result of results) for (const row of result.rows) for (const [key,value] of Object.entries(row)) {
      if (key !== 'signature') assert.equal(value, true, key);
    }
  });
  await check('clean numeric install through0144 and supported0143-to0144 data-bearing upgrade both pass the same audit',async () => {
    const fresh=await createDatabase();
    try {
      await applyThrough(fresh,144);
      const results=await fresh.transaction(async tx=>{await tx.exec('set transaction read only');return tx.exec(readFileSync(auditPath,'utf8'));});
      for(const result of results) for(const row of result.rows) for(const [key,value] of Object.entries(row)) {
        if(key!=='signature') assert.equal(value,true,key);
      }
    } finally {await fresh.close();}
  });
  console.log(JSON.stringify({ checks, contractorProfiles:5000,staffProfiles:2000,technicianProfileLinks:5000,recordOnlyTechnicians:5000,privacy:syntheticSqlPrivacyReceipt() }));
} catch (error) {
  console.error(JSON.stringify({ failed: true, code: error.code ?? error.name, message: error.message }));
  process.exitCode = 1;
} finally { await db.close(); }
