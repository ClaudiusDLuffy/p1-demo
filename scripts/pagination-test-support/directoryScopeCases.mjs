import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

export async function directoryScopeCases({ db, check, page, selected, rpc, denies, actors }) {
  const user = async (name, values = {}) => {
    const id = randomUUID();
    await db.query('insert into auth.users(id,email) values($1,$2)', [id, `${id}@directory.example.invalid`]);
    await db.query(`update public.profiles set name=$2,role=$3,active=$4,is_assignable=$5,
      contractor_organization_id=$6,contractor_access_level=$7,contractor_tier=$8,dispatcher_id=$9,
      company='Synthetic Company',phone='555-0100' where id=$1`,
    [id,name,values.role ?? 'contractor',values.active ?? true,values.assignable ?? true,
      values.organization ?? null,values.access ?? null,values.tier ?? null,values.dispatcher ?? null]);
    return id;
  };
  const organization = async name => {
    const id = randomUUID();
    await db.query('insert into public.organizations(id,name,slug,active) values($1,$2,$3,true)', [id,name,`synthetic-${id}`]);
    const owner = await user(`${name} Owner`, { organization: id, access: 'company_admin' });
    await db.query('update public.organizations set canonical_contractor_id=$2 where id=$1', [id,owner]);
    return { id, owner };
  };
  const a = await organization('Synthetic Alpha');
  const b = await organization('Synthetic Beta');
  const admin = await user('Synthetic Second Admin', { organization: a.id, access: 'company_admin' });
  const invoice = await user('Synthetic Invoice Member', { organization: a.id, access: 'invoice' });
  const report = await user('Synthetic Report Member', { organization: a.id, access: 'report_only' });
  const inactive = await user('Synthetic Inactive Member', { organization: a.id, access: 'report_only' });
  const link = async (profile, name, active = true, owner = a.owner) => {
    const id = randomUUID();
    await db.query('insert into public.contractor_technicians(id,contractor_id,profile_id,name,is_active) values($1,$2,$3,$4,$5)',
      [id,owner,profile,name,active]);
    return id;
  };
  const invoiceLink = await link(invoice, 'Synthetic Stale Invoice Name');
  const reportLink = await link(report, 'Synthetic Stale Report Name');
  const inactiveLink = await link(inactive, 'Synthetic Inactive Record');
  await db.query('update public.profiles set active=false where id=$1',[inactive]);
  const recordOnly = await link(null, 'Synthetic Record Only');
  const deactivated = await link(null, 'Synthetic Deactivated Record', false);
  const legacy = await user('Synthetic Legacy Dispatcher', { tier: 'mr_freeze' });
  const legacyChild = await user('Synthetic Legacy Child', { dispatcher: legacy });
  await check('canonical assignment eligibility and distinct historical management/filter domains', async () => {
    for (const id of [a.owner,b.owner]) assert.equal((await selected('assignable_contractors',id)).id,id);
    for (const id of [admin,invoice,report,inactive]) assert.equal(await selected('assignable_contractors',id), null);
    assert.equal((await selected('contractor_directory',admin)).id,admin);
    assert.equal((await selected('contractor_directory',inactive)).id,inactive);
    assert.equal((await selected('contractor_filter',inactive)).id,inactive);
    await db.query('update public.organizations set active=false where id=$1',[b.id]);
    assert.equal(await selected('assignable_contractors',b.owner),null);
    assert.equal((await selected('contractor_directory',b.owner)).id,b.owner);
  });
  await check('own company second admin scope; active linked canonical names; no cross-company/member enumeration', async () => {
    const result = await page('company_technicians',{company:a.owner,actor:admin});
    assert.deepEqual(new Set(result.items.map(row=>row.id)),new Set([invoiceLink,reportLink,recordOnly]));
    assert.equal(result.items.find(row=>row.id===invoiceLink).name,'Synthetic Invoice Member');
    for (const item of result.items) assert.equal(Object.hasOwn(item,'email'),false);
    for (const actor of [invoice,report]) await denies(()=>page('company_technicians',{company:a.owner,actor}));
    await denies(()=>page('company_technicians',{company:b.owner,actor:admin}));
    await denies(()=>page('technician_management',{company:a.owner,actor:admin}));
    assert.equal((await page('technician_management',{company:a.owner})).items.length,5);
    assert.equal((await selected('technician_detail',inactiveLink,a.owner)).profileActive,false);
    assert.equal((await selected('technician_detail',deactivated,a.owner)).isActive,false);
    assert.equal(await selected('technician_detail',invoiceLink,b.owner),null);
    const own = await selected('technician_profile',invoice,a.owner,invoice);
    assert.equal(own.id,invoiceLink); assert.equal(own.profileId,invoice);
    assert.equal(await selected('technician_profile',report,a.owner,invoice),null);
    assert.equal(await selected('company_technicians',invoice,a.owner),null,'Profile ID never ambiguously resolves a technician row ID');
    assert.equal((await selected('technician_detail',invoiceLink,a.owner)).email,`${invoice}@directory.example.invalid`);
    assert.equal(await selected('contact_detail',a.owner,null,invoice),null,'No new canonical contact authority for an invoice-only member');
    assert.equal((await selected('contact_detail',a.owner,null,admin)).id,a.owner);
  });
  await check('legacy directory keeps exact existing dispatcher-linked profile scope, without broadening work-order policies', async () => {
    const result = await page('legacy_team',{actor:legacy});
    assert.deepEqual(result.items.map(row=>row.id),[legacyChild]);
    assert.equal(await selected('legacy_team',a.owner,null,legacy),null);
    await denies(()=>page('legacy_team',{actor:report}));
    assert.equal((await selected('profile_labels',legacyChild,null,legacy)).id,legacyChild);
  });
  await check('assignable options and legacy own-team options both traverse beyond a page after eligibility filtering',async()=>{
    const children=[];
    for(let n=0;n<60;n++) children.push(await user(`Synthetic Assignable Legacy ${String(n).padStart(3,'0')}`,{dispatcher:legacy}));
    for(const [domain,actor] of [['assignable_contractors',actors.mgr],['legacy_team',legacy]]) {
      const seen=[];let cursor=null;
      do {
        const result=await page(domain,{query:'Synthetic Assignable Legacy',actor,limit:25,cursor});
        seen.push(...result.items.map(row=>row.id));cursor=result.nextCursor;
      } while(cursor);
      assert.deepEqual(seen,children);assert.equal(new Set(seen).size,60);
    }
  });
  await check('current organization and canonical account changes invalidate a company cursor', async () => {
    const first = await page('company_technicians',{company:a.owner,actor:admin,limit:1});
    assert.ok(first.nextCursor);
    await db.query('update public.profiles set contractor_access_level=\'report_only\' where id=$1',[admin]);
    await denies(()=>page('company_technicians',{company:a.owner,actor:admin,limit:1,cursor:first.nextCursor}));
    await db.query('update public.profiles set contractor_access_level=\'company_admin\' where id=$1',[admin]);
    await db.query('update public.organizations set active=false where id=$1',[a.id]);
    await denies(()=>page('company_technicians',{company:a.owner,actor:admin,limit:1,cursor:first.nextCursor}));
    await db.query('update public.organizations set active=true where id=$1',[a.id]);
  });
  await check('auto-assignment preserves city substring, exact trade membership, duplicate scoring, name tie and ID tie', async () => {
    const candidates = [];
    for (const [name,trades] of [['Synthetic Z Score',['ExactTrade','ExactTrade']],['Synthetic A Score',['ExactTrade']],
      ['Synthetic Z Score',['ExactTrade','ExactTrade']]]) {
      const id = await user(name); candidates.push(id);
      await db.query('update public.profiles set territory=$2,trades=$3 where id=$1',[id,'Syntheticville, YY',trades]);
    }
    const winner = [candidates[0],candidates[2]].sort()[0];
    assert.equal((await rpc('get_directory_auto_assignment_candidate_v1',['Syntheticville',['ExactTrade','ExactTrade']])).id,winner);
    assert.equal(await rpc('get_directory_auto_assignment_candidate_v1',['Syntheticville',['exacttrade']]),null);
    assert.equal((await rpc('get_directory_auto_assignment_candidate_v1',['theticville',['ExactTrade']])).id,winner);
    await db.query('update public.profiles set active=false where id=$1',[winner]);
    assert.notEqual((await rpc('get_directory_auto_assignment_candidate_v1',['Syntheticville',['ExactTrade']])).id,winner);
    await denies(()=>rpc('get_directory_auto_assignment_candidate_v1',['Syntheticville',['ExactTrade']],actors.controller));
  });
  await check('normalized search is literal, cursor-equivalent whitespace is stable, and later inserts are excluded',async()=>{
    const original=[];
    for(const n of [1,2,3]) original.push(await user(`Synthetic Mutation ${n}`));
    const first=await page('contractor_filter',{query:'  SYNTHETIC   MUTATION  ',limit:1});
    assert.equal((await page('contractor_filter',{query:'\u00a0SYNTHETIC\u2003MUTATION\ufeff',limit:1})).items[0].id,first.items[0].id);
    const added=await user('Synthetic Mutation 99');
    const snapshot=(await db.query('select public.portal_decode_cursor($1)->>\'snapshotAt\' value',[first.nextCursor])).rows[0].value;
    await db.query('update public.profiles set created_at=$2::timestamptz+interval \'1 microsecond\' where id=$1',[added,snapshot]);
    const seen=first.items.map(row=>row.id);let cursor=first.nextCursor;
    do {
      const result=await page('contractor_filter',{query:'synthetic mutation',limit:1,cursor});
      seen.push(...result.items.map(row=>row.id));cursor=result.nextCursor;
    } while(cursor);
    assert.deepEqual(new Set(seen),new Set(original));
    assert.equal((await page('contractor_filter',{query:'synthetic mutation'})).items.length,4);
    for(const query of ['%',"' OR 1=1 --",'_']) assert.deepEqual((await page('contractor_filter',{query})).items,[]);
    await db.query('update public.profiles set active=false where id=$1',[actors.mgr]);
    await denies(()=>page('contractor_filter',{query:'synthetic mutation',limit:1,cursor:first.nextCursor}));
    await db.query('update public.profiles set active=true where id=$1',[actors.mgr]);
  });
  await check('long display names and trade arrays retain identities with visible ellipsis while exact selections stay original',async()=>{
    const fullName='Synthetic Long '+ '😀'.repeat(400);
    const id=await user(fullName);
    const trades=Array.from({length:75},(_,n)=>`Trade ${n} ${'x'.repeat(205)}`);
    await db.query('update public.profiles set trades=$2,territory=$3,company=$4 where id=$1',
      [id,trades,'Longville','Synthetic '+ 'z'.repeat(650)]);
    const first=await page('contractor_directory',{query:'Synthetic Long',limit:1});
    assert.equal(first.items[0].id,id);assert.ok(first.items[0].name.endsWith('…'));assert.ok(first.items[0].name.length<=500);
    assert.ok(first.items[0].company.endsWith('…'));assert.equal(first.items[0].trades.length,50);
    assert.ok(first.items[0].trades.every(trade=>trade.length<=200));assert.equal(first.items[0].trades[49],'… 26 more trades');
    const detail=await selected('contractor_directory',id);
    assert.equal(detail.name,fullName);assert.deepEqual(detail.trades,trades);assert.ok(detail.company.length>500);
    const labels=await rpc('get_directory_profile_labels_v1',[[id]]);assert.equal(labels[0].id,id);assert.ok(labels[0].name.length<=500);
    const match=await rpc('get_directory_auto_assignment_candidate_v1',['Longville',[trades[74].slice(0,200)]]);
    assert.equal(match,null,'A truncated displayed trade never becomes a stored matching tag');
    const finalTrade='Beyond Display'; trades[74]=finalTrade;
    await db.query('update public.profiles set trades=$2 where id=$1',[id,trades]);
    assert.equal((await rpc('get_directory_auto_assignment_candidate_v1',['Longville',[finalTrade]])).id,id);
    assert.equal((await page('contractor_directory',{query:finalTrade})).items[0].id,id);
    await db.query('update public.profiles set name=$2 where id=$1',[invoice,fullName]);
    const techPage=await page('company_technicians',{company:a.owner,query:'Synthetic Long'});
    assert.equal(techPage.items[0].profileId,invoice);assert.ok(techPage.items[0].name.endsWith('…'));
    assert.equal((await selected('company_technicians',invoiceLink,a.owner,admin)).name,fullName);
    assert.equal((await selected('technician_profile',invoice,a.owner,invoice)).name,fullName);
    assert.equal((await selected('technician_detail',invoiceLink,a.owner)).name,fullName);
    const hugeIds=[];const hugePrefix='Synthetic Huge Cursor '+ 'a'.repeat(10000);
    for(const suffix of ['Z','A','M']) hugeIds.push(await user(hugePrefix+suffix));
    const seen=[];let cursor=null;
    do {
      const result=await page('contractor_filter',{query:'Synthetic Huge Cursor',limit:1,cursor});
      for(const item of result.items) {assert.ok(item.name.endsWith('…'));assert.ok(item.name.length<=500);seen.push(item.id);}
      cursor=result.nextCursor;if(cursor) assert.ok(cursor.length<=8192);
    } while(cursor);
    assert.deepEqual(seen,hugeIds.sort(),'Long-name prefix ties use UUID; no row makes the next page unreachable');
    assert.equal((await selected('contractor_filter',hugeIds[0])).name.length,hugePrefix.length+1);
  });
}
