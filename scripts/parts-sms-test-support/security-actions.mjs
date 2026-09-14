import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { partsSmsOwnedTables, failPartsSmsWrite, partsSmsOwnerUpdate } from './candidate-fixtures.mjs';

export async function verifyPartsSmsSecurityActions(f, check) {
  await check('parts SMS service claims and private capabilities have exact grants and pinned search paths', async () => {
    const functions = (await f.db.query(`select p.proname,p.proconfig,p.oid from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and (p.proname like '%parts_sms%' or p.proname='guard_parts_sms_records')`)).rows;
    assert.ok(functions.length > 15);
    for (const fn of functions) {
      assert.ok(fn.proconfig?.some(value => /^search_path=pg_catalog, ?public$/.test(value)), `${fn.proname} safe search path`);
      const grants = (await f.db.query(`select has_function_privilege('anon',$1::oid,'EXECUTE') anon,
        has_function_privilege('authenticated',$1::oid,'EXECUTE') authenticated,
        has_function_privilege('service_role',$1::oid,'EXECUTE') service`, [fn.oid])).rows[0];
      assert.equal(grants.anon, false, `${fn.proname} anonymous execution denied`);
      if (!fn.proname.endsWith('_v1')) assert.deepEqual(grants, { anon: false, authenticated: false, service: false });
    }
    await f.denied(() => f.rpc('claim_p1_parts_alert_delivery', [f.recipientId(f.actors.mgr), '2026-09-10', 'synthetic']), ['PT409']);
    await f.denied(() => f.rpc('complete_p1_parts_alert_delivery', [randomUUID(), 'failed', null, 'synthetic']), ['PT409']);
  });
  for (const [name, actor] of Object.entries(f.actors).filter(([name]) => [
    'mgr', 'dispatcher', 'backOffice', 'controller', 'handoffOnly', 'contractor', 'admin', 'canonical',
    'report', 'invoice', 'former', 'outsider', 'inactive', 'inactiveManager', 'inactiveBackOffice', 'noProfile',
  ].includes(name))) {
    await check(`parts SMS read/reconcile role matrix ${name}`, async () => {
      const target = await f.make('unknown');
      const allowed = ['mgr', 'dispatcher', 'backOffice'].includes(name);
      if (allowed) {
        assert.equal((await f.current(target.id, actor)).id, target.id);
        assert.ok(Array.isArray((await f.page({ actor })).items));
        assert.ok(Array.isArray((await f.history(target.id, { actor })).items));
        assert.equal(typeof (await f.health(actor)).stale, 'boolean');
        assert.equal((await f.action('manual', target.id, { actor })).status, 'manually_resolved');
      } else {
        await f.denied(() => f.current(target.id, actor));
        await f.denied(() => f.page({ actor }));
        await f.denied(() => f.history(target.id, { actor }));
        await f.denied(() => f.health(actor));
        await f.denied(() => f.action('resend', target.id, { actor }));
        await f.denied(() => f.action('manual', target.id, { actor }));
      }
      await f.denied(() => f.rpc('claim_parts_sms_delivery_v1', [randomUUID(), false], actor, 'authenticated'), ['42501']);
    });
  }
  await check('parts SMS anonymous/no-profile/service-forgery callers cannot read or create worker evidence', async () => {
    const target = await f.make('unknown');
    await f.denied(() => f.current(target.id, null, 'anon'));
    await f.denied(() => f.page({ actor: f.actors.noProfile }));
    await f.denied(() => f.as('authenticated', f.actors.mgr, async tx => {
      await tx.query("select set_config('request.jwt.claim.role','service_role',true)");
      return tx.query('select public.claim_parts_sms_delivery_v1($1,false)', [randomUUID()]);
    }));
  });
  await check('parts SMS all worker/start/complete/status/heartbeat RPCs deny browser and anonymous authority', async () => {
    const cases = [
      ['enqueue_parts_sms_deliveries_v1', [false]],
      ['claim_parts_sms_delivery_v1', [randomUUID(), false]],
      ['prepare_parts_sms_send_v1', [randomUUID(), randomUUID(), false]],
      ['complete_parts_sms_delivery_v1', [randomUUID(), randomUUID(), 'unknown', 'TWILIO_UNKNOWN', null, null, null]],
      ['claim_parts_sms_status_v1', [randomUUID()]],
      ['complete_parts_sms_status_v1', [randomUUID(), randomUUID(), 'unknown', 'TWILIO_STATUS_UNAVAILABLE', null]],
      ['start_parts_sms_run_v1', [randomUUID(), 'synthetic-denied']],
      ['finish_parts_sms_run_v1', [randomUUID(), '{}', 'RUN_COMPLETE']],
    ];
    const before = await f.snapshot();
    for (const role of ['authenticated', 'anon']) {
      for (const [name, args] of cases) await f.denied(() => f.rpc(name, args, role === 'authenticated' ? f.actors.mgr : null, role), ['42501']);
    }
    for (const table of partsSmsOwnedTables) {
      for (const role of ['authenticated', 'anon', 'service_role']) {
        await f.denied(() => f.as(role, role === 'authenticated' ? f.actors.mgr : null, tx => tx.query(`select * from public.${table} limit 1`)), ['42501']);
      }
    }
    assert.deepEqual(await f.snapshot(), before);
  });
  await check('parts SMS raw event/attempt/run/resolution/capability mutations and truncate are denied', async () => {
    const target = await f.make('unknown');
    const before = await f.snapshot();
    const statements = [
      ["update public.p1_parts_alert_deliveries set status='delivered' where id=$1", [target.id]],
      ["insert into public.p1_parts_alert_deliveries(recipient_id,local_date,request_signature) values($1,current_date,'synthetic-forged')", [target.recipient.id]],
      ['delete from public.p1_parts_alert_deliveries where id=$1', [target.id]],
      ["insert into public.p1_parts_sms_attempt_events(delivery_id,sequence,phase,state) values($1,1,'completed','delivered')", [target.id]],
      ["insert into public.p1_parts_sms_runs(id,release) values($1,'synthetic-forged')", [randomUUID()]],
      ["insert into public.p1_parts_sms_operations(operation_id,delivery_id,action,actor_id,reason) values($1,$2,'manual_resolution',$3,'synthetic')", [randomUUID(), target.id, f.actors.mgr]],
      ["insert into public.p1_parts_sms_guards values(txid_current(),'p1_parts_alert_deliveries',$1)", [target.id]],
    ];
    for (const role of ['authenticated', 'service_role']) {
      for (const [sql, values] of statements) await f.denied(() => f.as(role, role === 'authenticated' ? f.actors.mgr : null, tx => tx.query(sql, values)), ['42501']);
      for (const table of partsSmsOwnedTables) await f.denied(() => f.as(role, role === 'authenticated' ? f.actors.mgr : null, tx => tx.exec(`truncate public.${table}`)), ['42501']);
    }
    assert.deepEqual(await f.snapshot(), before);
  });
  await check('parts SMS strict database settings reject malformed recipients atomically and cap twenty-five', async () => {
    const target = await f.scenario();
    const valid = { profileId: target.profileId, phoneE164: '+12025550123', active: true };
    for (const recipients of [
      [{ ...valid, active: 'false' }], [{ ...valid, active: 'true' }], [{ ...valid, active: 0 }], [{ ...valid, active: 1 }],
      [{ ...valid, profileId: 'not-a-uuid' }], [{ ...valid, phoneE164: 'invalid' }], [{ ...valid, unexpected: true }],
      [valid, valid], Array.from({ length: 26 }, () => valid),
    ]) {
      const before = await f.snapshot();
      await f.denied(() => f.configure({ recipients }), ['PT422']);
      assert.deepEqual(await f.snapshot(), before);
    }
    await f.denied(() => f.configure({ timezone: 'Invalid/Synthetic', recipients: [valid] }), ['PT422']);
    await f.denied(() => f.configure({ enabled: true, cutoff: null, recipients: [valid] }), ['PT422']);
    await f.denied(() => f.configure({ recipients: [] }), ['PT422']);
    assert.equal((await f.configure({ enabled: false, cutoff: null, recipients: [] })).enabled, false);
  });
  await check('parts SMS unknown explicit resend creates immutable child and operation replay is exact', async () => {
    const target = await f.make('unknown');
    const original = await f.delivery(target.id);
    const originalAttempts = await f.attempts(target.id);
    const operation = randomUUID();
    const result = await f.action('resend', target.id, { operation });
    assert.equal(result.status, 'queued');
    assert.notEqual(result.deliveryId, target.id);
    assert.equal((await f.delivery(result.deliveryId)).parent_delivery_id, target.id);
    assert.equal((await f.delivery(result.deliveryId)).root_delivery_id, target.id);
    assert.deepEqual(await f.delivery(target.id), original);
    assert.deepEqual(await f.attempts(target.id), originalAttempts);
    assert.equal((await f.action('resend', target.id, { operation })).deliveryId, result.deliveryId);
    assert.equal((await f.action('resend', target.id, { operation })).replayed, true);
    for (const patch of [{ reason: 'Different reason' }, { actor: f.actors.dispatcher }]) {
      await f.denied(() => f.action('resend', target.id, { operation, ...patch }), ['PT409']);
    }
    await f.denied(() => f.action('manual', target.id, { operation }), ['PT409']);
    await f.denied(() => f.action('resend', randomUUID(), { operation }), ['PT409']);
    await f.denied(() => f.action('resend', target.id), ['PT409']);
    const claim = await f.take(result.deliveryId);
    await f.prepare(result.deliveryId, claim.token);
    await f.complete(result.deliveryId, claim.token);
    assert.deepEqual(await f.delivery(target.id), original);
  });
  await check('parts SMS manual resolution preserves unknown provider outcome and immutable actor/reason/time', async () => {
    const target = await f.make('unknown');
    const original = await f.delivery(target.id);
    const operation = randomUUID();
    const result = await f.action('manual', target.id, { operation });
    assert.equal(result.status, 'manually_resolved');
    assert.deepEqual(await f.delivery(target.id), original);
    assert.equal((await f.current(target.id)).state, 'manually_resolved');
    const stored = (await f.db.query('select * from public.p1_parts_sms_operations where operation_id=$1', [operation])).rows[0];
    assert.equal(stored.actor_id, f.actors.mgr);
    assert.equal(stored.reason, 'Synthetic accountable staff contact');
    assert.ok(stored.created_at);
    assert.equal((await f.action('manual', target.id, { operation })).replayed, true);
    await f.denied(() => f.action('manual', target.id, { operation, reason: 'Changed' }), ['PT409']);
    assert.equal((await f.current(target.id)).canResend, false);
    assert.equal((await f.enqueue()).queued, 0);
  });
  await check('parts SMS resend/manual require bounded reason, active recipient and authoritative current source', async () => {
    const target = await f.make('unknown');
    for (const reason of [null, '', '   ', 'x'.repeat(501)]) {
      await f.denied(() => f.action('resend', target.id, { reason }), ['PT422']);
      await f.denied(() => f.action('manual', target.id, { reason }), ['PT422']);
    }
    await partsSmsOwnerUpdate(f.db, 'profiles', 'update public.profiles set active=false where id=$1', [target.profileId]);
    await f.denied(() => f.action('resend', target.id), ['PT409']);
    await partsSmsOwnerUpdate(f.db, 'profiles', 'update public.profiles set active=true where id=$1', [target.profileId]);
    await partsSmsOwnerUpdate(f.db, 'p1_parts_alert_deliveries', "update public.p1_parts_alert_deliveries set local_date=local_date-1 where id=$1", [target.id]);
    await f.denied(() => f.action('resend', target.id), ['PT409']);
    assert.equal((await f.current(target.id)).canResend, false);
    assert.equal((await f.action('manual', target.id)).status, 'manually_resolved', 'Historical unknown is still accountable without pretending to resend stale content');
  });
  await check('parts SMS pending/claimed/sending/accepted/delivered/superseded cannot be explicitly resent', async () => {
    for (const state of ['pending', 'claimed', 'sending', 'accepted', 'delivered', 'superseded']) {
      const target = await f.make();
      let claim;
      if (['claimed', 'sending', 'accepted', 'delivered'].includes(state)) claim = await f.take(target.id);
      if (['sending', 'accepted', 'delivered'].includes(state)) await f.prepare(target.id, claim.token);
      if (state === 'accepted' || state === 'delivered') await f.complete(target.id, claim.token, 'accepted', {
        sid: `SM${randomUUID().replaceAll('-', '')}`, providerStatus: state === 'accepted' ? 'queued' : 'delivered',
      });
      if (state === 'superseded') {
        await f.as('authenticated', f.actors.mgr, tx => tx.query("select public.set_p1_part_order_status($1,'ordered')", [target.part.id]));
        await f.claim();
      }
      await f.denied(() => f.action('resend', target.id), ['PT409']);
    }
  });
  await check('parts SMS resend and manual evidence failures rollback all new child/operation writes', async () => {
    const target = await f.make('unknown');
    for (const kind of ['resend', 'manual']) {
      const before = await f.snapshot();
      await failPartsSmsWrite(f.db, 'p1_parts_sms_operations', 'insert', async () => {
        await assert.rejects(() => f.action(kind, target.id), error => error.code === 'P0001');
      });
      assert.deepEqual(await f.snapshot(), before);
    }
    const before = await f.snapshot();
    await failPartsSmsWrite(f.db, 'p1_parts_alert_deliveries', 'insert', async () => {
      await assert.rejects(() => f.action('resend', target.id), error => error.code === 'P0001');
    });
    assert.deepEqual(await f.snapshot(), before);
  });
  await check('parts SMS safe projection excludes phone, SID, SMS body, provider payload and source descriptions', async () => {
    const target = await f.make('unknown');
    const values = [await f.current(target.id), await f.page(), await f.history(target.id), await f.health()];
    const serialized = JSON.stringify(values);
    assert.doesNotMatch(serialized, /\+1202555|SM[0-9a-f]{32}|phone_e164|phoneE164|phone_snapshot|providerMessageId|request_signature|Synthetic parts SMS request|TWILIO_AUTH_TOKEN/i);
    assert.ok((await f.history(target.id)).items.some(row => row.state === 'unknown'));
  });
  await check('parts SMS resolved provider state cannot be relabeled by manual action or forged reconciliation', async () => {
    const target = await f.make('accepted', { sid: `SM${randomUUID().replaceAll('-', '')}`, providerStatus: 'delivered' });
    const before = await f.snapshot();
    await f.denied(() => f.action('manual', target.id), ['PT409']);
    await f.denied(() => f.action('resend', target.id), ['PT409']);
    await f.denied(() => f.statusComplete(target.id, randomUUID(), 'failed', null, target.event.provider_message_id), ['PT409']);
    assert.deepEqual(await f.snapshot(), before);
  });
}
