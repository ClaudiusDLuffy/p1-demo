import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ownerFixtureUpdate } from './candidate-fixtures.mjs';

export async function verifyFinancialNotificationRecipients(f, check) {
  await f.settle();
  await check('review event preserves canonical contractor and eligible same-company invoice creator only', async () => {
    const target = await f.invoice({ owner: f.actors.canonical, creator: f.actors.invoice });
    await f.candidateReview(target);
    const event = (await f.events(target))[0];
    const recipients = await f.deliveries(event);
    assert.deepEqual(new Set(recipients.map(row => row.recipient_profile_id)),new Set([f.actors.canonical,f.actors.invoice]));
    assert.deepEqual(new Set(recipients.map(row => row.recipient_kind)),new Set(['contractor','creator']));
    assert.equal(event.creator_id,f.actors.invoice);
    const claim = await f.claim();
    for (const item of claim.rows) {
      const message = await f.prepare(item.id,claim.token);
      if (!message || message.status) continue;
      assert.equal(message.family,'invoice_rejected');
      assert.equal(message.invoice.rejectionReason,'Synthetic invoice correction');
      for (const key of ['previousContractor','assignmentHistory','staffNotes','providerReference','contractorHistory']) assert.ok(!Object.hasOwn(message,key));
      await f.complete(item.id,claim.token,'sent');
    }
  });
  for (const variation of ['inactive','report_only','unlinked','other_company']) {
    await check(`review creator becoming ${variation} is not sent a contractor financial message`, async () => {
      const target = await f.invoice({ owner: f.actors.canonical, creator: f.actors.invoice });
      const original = (await f.db.query('select * from public.profiles where id=$1',[f.actors.invoice])).rows[0];
      if (variation === 'inactive') await ownerFixtureUpdate(f.db,'profiles','update public.profiles set active=false where id=$1',[f.actors.invoice]);
      if (variation === 'report_only') await ownerFixtureUpdate(f.db,'profiles',"update public.profiles set contractor_access_level='report_only' where id=$1",[f.actors.invoice]);
      if (variation === 'other_company') {
        const company=randomUUID();
        await f.db.query('insert into public.organizations(id,name,slug,active) values($1,$2,$3,true)',[company,'Synthetic other financial company',`synthetic-financial-${company}`]);
        await ownerFixtureUpdate(f.db,'profiles','update public.profiles set contractor_organization_id=$2 where id=$1',[f.actors.invoice,company]);
      }
      if (variation === 'unlinked') await ownerFixtureUpdate(f.db,'contractor_technicians','update public.contractor_technicians set is_active=false where profile_id=$1',[f.actors.invoice]);
      try {
        await f.candidateReview(target);
        const deliveries = await f.deliveries((await f.events(target))[0]);
        assert.deepEqual(deliveries.map(row => row.recipient_profile_id),[f.actors.canonical]);
      } finally {
        await ownerFixtureUpdate(f.db,'profiles','update public.profiles set active=$2,contractor_access_level=$3,contractor_organization_id=$4 where id=$1',
          [f.actors.invoice,original.active,original.contractor_access_level,original.contractor_organization_id]);
        if (variation === 'unlinked') await ownerFixtureUpdate(f.db,'contractor_technicians','update public.contractor_technicians set is_active=true where profile_id=$1',[f.actors.invoice]);
      }
    });
  }
  await f.settle();
  await check('same-identity recipient email is reloaded at send time, deactivation after claim prevents send', async () => {
    const target = await f.invoice();
    await f.candidateReview(target);
    const event = (await f.events(target))[0];
    const item = (await f.deliveries(event))[0];
    const profile = (await f.db.query('select * from public.profiles where id=$1',[f.actors.contractor])).rows[0];
    const claim = await f.claim();
    assert.ok(claim.rows.some(row => row.id===item.id));
    try {
      await ownerFixtureUpdate(f.db,'profiles',"update public.profiles set email='changed-synthetic@financial.example.invalid' where id=$1",[f.actors.contractor]);
      const message = await f.prepare(item.id,claim.token);
      assert.equal(message.recipientEmail,'changed-synthetic@financial.example.invalid');
      assert.notEqual(item.recipient_email_snapshot,message.recipientEmail);
      await f.complete(item.id,claim.token,'sent');
      const another = await f.invoice();
      await f.candidateReview(another);
      const second = (await f.deliveries((await f.events(another))[0]))[0];
      const next = await f.claim();
      await ownerFixtureUpdate(f.db,'profiles','update public.profiles set active=false where id=$1',[f.actors.contractor]);
      assert.deepEqual(await f.prepare(second.id,next.token),{status:'not_deliverable'});
      assert.equal((await f.delivery(second.id)).state,'not_deliverable');
    } finally {
      await ownerFixtureUpdate(f.db,'profiles','update public.profiles set email=$2,active=$3 where id=$1',[f.actors.contractor,profile.email,profile.active]);
    }
  });
  await check('review revision/state supersedes outdated notice while work-order reassignment preserves the original invoice owner', async () => {
    const target = await f.invoice();
    await f.candidateReview(target);
    const rejected = (await f.deliveries((await f.events(target))[0]))[0];
    await f.candidateRetract(target);
    await f.settle();
    assert.equal((await f.delivery(rejected.id)).state,'superseded');
    const another = await f.invoice();
    await f.candidateReview(another);
    const item = (await f.deliveries((await f.events(another))[0]))[0];
    await ownerFixtureUpdate(f.db,'work_orders','update public.work_orders set contractor_assignment_version=contractor_assignment_version+1 where id=$1',[another.workOrderId]);
    await f.settle();
    assert.equal((await f.delivery(item.id)).state,'sent');
    assert.equal((await f.delivery(item.id)).recipient_profile_id,another.row.contractor_id);
  });
  await check('empty canonical address is visible not-deliverable rather than silently dropped', async () => {
    const target = await f.invoice();
    const profile = (await f.db.query('select * from public.profiles where id=$1',[f.actors.contractor])).rows[0];
    try {
      await ownerFixtureUpdate(f.db,'profiles',"update public.profiles set email='' where id=$1",[f.actors.contractor]);
      await f.candidateReview(target);
      const item = (await f.deliveries((await f.events(target))[0]))[0];
      assert.equal(item.state,'not_deliverable');
      assert.equal(item.last_error_code,'RECIPIENT_NOT_DELIVERABLE');
      const safe = (await f.status(target)).items[0];
      assert.equal(safe.canResend,false);
      assert.equal(safe.canResolve,true);
    } finally { await ownerFixtureUpdate(f.db,'profiles','update public.profiles set email=$2 where id=$1',[f.actors.contractor,profile.email]); }
  });
  await check('hold recipients require active current staff role plus handoff grant and normalized address deduplication', async () => {
    const target = await f.invoice();
    await f.candidateReview(target,{action:'approve'});
    const profile = (await f.db.query('select * from public.profiles where id=$1',[f.actors.handoffOnly])).rows[0];
    const handoff = (await f.db.query('select * from public.profiles where id=$1',[f.actors.handoff])).rows[0];
    const outsider = randomUUID();
    await f.db.query('insert into auth.users(id,email) values($1,$2)',[outsider,'downgraded-synthetic@financial.example.invalid']);
    await f.db.query("update public.profiles set role='contractor',active=true where id=$1",[outsider]);
    await f.db.query("insert into public.staff_permission_grants(profile_id,permission) values($1,'quickbooks_handoff')",[outsider]);
    try {
      await ownerFixtureUpdate(f.db,'profiles','update public.profiles set email=$2 where id=$1',[f.actors.handoffOnly,` ${handoff.email.toUpperCase()} `]);
      await f.candidateHold(target);
      const items = await f.deliveries((await f.events(target))[0]);
      assert.equal(items.filter(item=>[f.actors.handoff,f.actors.handoffOnly].includes(item.recipient_profile_id)).length,1,'Same normalized handoff address is sent once');
      assert.ok(items.every(item=>item.recipient_kind==='handoff'));
      assert.ok(!items.some(item=>item.recipient_profile_id===outsider),'Role-downgraded grant holder cannot receive internal hold reason');
    } finally { await ownerFixtureUpdate(f.db,'profiles','update public.profiles set email=$2 where id=$1',[f.actors.handoffOnly,profile.email]); }
  });
  await check('no eligible handoff recipient creates one explicit missing placeholder without invented fallback', async () => {
    const target = await f.invoice();
    await f.candidateReview(target,{action:'approve'});
    const eligible=(await f.db.query("select p.id,lower(btrim(p.email)) email from public.profiles p where public.profile_has_staff_permission(p.id,'quickbooks_handoff')")).rows;
    await ownerFixtureUpdate(f.db,'profiles','update public.profiles set active=false where id=any($1::uuid[])',[eligible.map(row=>row.id)]);
    try {
      const result = await f.candidateHold(target);
      assert.equal(result.notificationStatus,'not_deliverable');
      const event = (await f.events(target))[0];
      const items = await f.deliveries(event);
      assert.equal(items.length,1);
      assert.equal(items[0].recipient_profile_id,null);
      assert.equal(items[0].recipient_kind,'missing');
      assert.equal(items[0].last_error_code,'NO_ELIGIBLE_RECIPIENT');
      await f.denied(()=>f.action('manual',event,items[0]),['PT409']);
      await f.denied(()=>f.action('resend',event,items[0]),['PT409']);
    } finally { await ownerFixtureUpdate(f.db,'profiles','update public.profiles set active=true where id=any($1::uuid[])',[eligible.map(row=>row.id)]); }
    const event = (await f.events(target))[0];
    const original = (await f.deliveries(event))[0];
    const result = await f.action('resend',event,original);
    assert.equal(result.status,'queued');
    assert.equal(result.deliveryCount,new Set(eligible.map(row=>row.email)).size);
    assert.deepEqual(await f.delivery(original.id),original);
  });
  await check('legacy approved contractor invoice without a work order queues and prepares hold and release notices',async()=>{
    await f.settle();
    const target=await f.invoice();
    await f.candidateReview(target,{action:'approve'});
    // The existing schema and hold commands expressly support this legacy
    // shape. Owner-only fixture setup does not expose an application bypass.
    await ownerFixtureUpdate(f.db,'invoices','update public.invoices set work_order_id=null where id=$1',[target.id]);
    let source=null;
    for(const action of ['place','release']) {
      const result=await f.candidateHold(target,{action,source});
      assert.equal(result.applied,true);assert.equal(result.notificationStatus,'queued');
      const event=(await f.events(target)).at(-1);
      assert.equal(event.work_order_id,null);
      assert.equal(event.family,action==='place'?'payment_hold_placed':'payment_hold_released');
      assert.equal(event.source_kind,'hold_event');source=event.source_id;
      const items=await f.deliveries(event);assert.ok(items.length>0);
      const claim=await f.claim();
      assert.deepEqual(new Set(claim.rows.map(item=>item.id)),new Set(items.map(item=>item.id)));
      for(const item of claim.rows) {
        const message=await f.prepare(item.id,claim.token);
        assert.equal(message.family,event.family);
        assert.equal(message.invoice.workOrderId,null);
        assert.equal(message.invoice.externalWorkOrderId,null);
        assert.equal(message.invoice.num,target.row.num);
        assert.equal(message.reason,'Synthetic accounting contact');
        await f.complete(item.id,claim.token,'sent');
      }
      assert.ok((await f.status(target)).items.every(item=>item.workOrderId===null));
    }
    assert.equal((await f.events(target)).length,2);
  });
}
