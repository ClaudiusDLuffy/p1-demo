import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ownedTables } from './candidate-fixtures.mjs';

export async function verifyFinancialNotificationAuthorization(f, check) {
  const deniedActors = ['contractor','canonical','admin','invoice','report','former','outsider','inactive','inactiveManager','inactiveBackOffice','noProfile'];
  for (const actorName of deniedActors) {
    await check(`${actorName} denied financial notification status, unresolved queue, history, and actions`, async () => {
      const target = await f.invoice();
      await f.candidateReview(target);
      const event = (await f.events(target))[0];
      const item = (await f.deliveries(event))[0];
      const actor = f.actors[actorName];
      assert.ok(actor, 'Synthetic actor exists');
      await f.denied(() => f.status(target, null, 25, actor), ['42501']);
      await f.denied(() => f.page({ actor }), ['42501']);
      await f.denied(() => f.history(event, null, 20, actor), ['42501']);
      await f.denied(() => f.action('resend', event, item, { actor }), ['42501']);
      await f.denied(() => f.action('manual', event, item, { actor }), ['42501']);
      const untouched = await f.invoice();
      await f.denied(() => f.candidateReview(untouched, { actor }), ['42501']);
    });
  }
  await check('anonymous and service roles cannot impersonate staff-safe read or reconciliation RPCs', async () => {
    const target = await f.invoice();
    for (const role of ['anon','service_role']) {
      await f.denied(() => f.rpc('get_financial_notification_status_v1', [target.id,null,25], null, role), ['42501']);
      await f.denied(() => f.rpc('list_financial_notification_unresolved_v1', [null,null,'',null,25], null, role), ['42501']);
      await f.denied(() => f.rpc('request_financial_notification_resend_v1', [randomUUID(),randomUUID(),randomUUID(),'Synthetic reason'], null, role), ['42501']);
    }
    await f.denied(() => f.rpc('get_financial_notification_status_v1', [target.id,null,25], null, 'authenticated'), ['42501']);
  });
  for (const actorName of ['mgr','dispatcher','backOffice','handoff']) {
    await check(`${actorName} can review and read authorized current notification without recipient/provider payload`, async () => {
      const target = await f.invoice();
      await f.candidateReview(target, { actor: f.actors[actorName] });
      const result = await f.status(target, null, 25, f.actors[actorName]);
      assert.equal(result.items.length, 1);
      assert.equal(result.items[0].state, 'pending');
      for (const key of ['recipientEmail','recipient_email_snapshot','message_context','providerReference','provider_status','reason','description']) {
        assert.ok(!Object.hasOwn(result.items[0], key));
      }
      assert.equal(typeof result.items[0].canResend, 'boolean');
      assert.equal(typeof result.items[0].canResolve, 'boolean');
      assert.equal(result.items[0].canResend, false);
    });
  }
  await check('invoice-controller and controller-plus-handoff are denied contractor review family but retain hold visibility', async () => {
    const target = await f.invoice();
    await f.candidateReview(target);
    const review = (await f.events(target))[0];
    for (const actor of [f.actors.controller,f.actors.handoffOnly]) {
      await f.denied(() => f.candidateReview(target, { actor }), ['42501']);
      await f.denied(() => f.history(review,null,20,actor), ['42501']);
      await f.denied(() => f.page({ actor, family: 'invoice_rejected' }), ['42501']);
      assert.equal((await f.status(target,null,25,actor)).items.length, 0);
    }
    const approved = await f.invoice();
    await f.candidateReview(approved, { action: 'approve' });
    await f.candidateHold(approved, { actor: f.actors.controller });
    assert.ok((await f.status(approved,null,25,f.actors.controller)).items.length > 0);
    const source = (await f.holdEvents(approved)).at(-1).id;
    await f.denied(() => f.candidateHold(approved, { action: 'release',source,actor: f.actors.controller }), ['42501']);
    assert.equal((await f.candidateHold(approved, { action: 'release',source,actor: f.actors.handoffOnly })).applied, true);
  });
  await check('worker claim, prepare, and complete require real service role rather than a browser token', async () => {
    for (const actor of [f.actors.mgr,f.actors.handoff,f.actors.contractor]) {
      await f.denied(() => f.rpc('claim_financial_notification_deliveries_v1', [1,60,randomUUID()],actor), ['42501']);
      await f.denied(() => f.rpc('prepare_financial_notification_send_v1', [randomUUID(),randomUUID()],actor), ['42501']);
      await f.denied(() => f.rpc('complete_financial_notification_delivery_v1', [randomUUID(),randomUUID(),'sent',null,202,null,null],actor), ['42501']);
    }
    await f.denied(() => f.as('authenticated', f.actors.mgr, async tx => {
      await tx.query("select set_config('request.jwt.claim.role','service_role',true)");
      return tx.query('select public.claim_financial_notification_deliveries_v1(1,60,$1)',[randomUUID()]);
    }), ['42501']);
  });
  for (const role of ['authenticated','service_role']) {
    await check(`${role} cannot raw read, insert, update, delete, or truncate command-owned financial notification rows`, async () => {
      for (const table of [...ownedTables,'financial_notification_control','financial_notification_record_guards','financial_notification_source_guards','financial_notification_hold_heads']) {
        for (const sql of [`select * from public.${table}`,`insert into public.${table} default values`,`delete from public.${table}`,`truncate public.${table}`]) {
          await f.denied(() => f.as(role,role === 'authenticated' ? f.actors.mgr : null,tx => tx.query(sql)), ['42501']);
        }
      }
      await f.denied(() => f.as(role,role === 'authenticated' ? f.actors.mgr : null,tx => tx.query("update public.financial_notification_deliveries set state='sent'")), ['42501']);
      await f.denied(() => f.as(role,role === 'authenticated' ? f.actors.mgr : null,tx => tx.query("update public.financial_notification_operations set reason='forged'")), ['42501']);
    });
  }
  await check('all private financial-notification helpers are inaccessible and all definer search paths pinned', async () => {
    const routines = (await f.db.query(`select p.oid,p.proname,p.prosecdef,p.proconfig from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and (p.proname like 'financial_notification_%' or p.proname like '%financial_notification%_v1'
      or p.proname like '%_with_notification_v1' or p.proname like '%_pre_notification' or p.proname like 'require_financial_notification_%'
      or p.proname='execute_financial_notification_mutation')`)).rows;
    assert.ok(routines.length >= 20);
    for (const routine of routines) {
      if (routine.prosecdef) assert.ok(routine.proconfig.some(value => ['search_path=pg_catalog,public','search_path=pg_catalog,public,pg_temp'].includes(value.replaceAll(' ',''))),routine.proname);
      const grants = (await f.db.query(`select has_function_privilege('anon',$1::oid,'execute') anon,
        has_function_privilege('authenticated',$1::oid,'execute') authenticated,has_function_privilege('service_role',$1::oid,'execute') service`,[routine.oid])).rows[0];
      assert.equal(grants.anon,false);
      if (/^(financial_notification_|require_financial_notification_|execute_financial_notification_)|_pre_notification$/.test(routine.proname)) {
        assert.equal(grants.authenticated,false,routine.proname);
        assert.equal(grants.service,false,routine.proname);
      }
    }
  });
}
