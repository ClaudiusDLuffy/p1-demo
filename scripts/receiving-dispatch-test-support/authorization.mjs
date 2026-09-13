import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { deliveryTable } from './fixtures.mjs';

export async function verifyCloseoutAuthorization(f, check) {
  const target = await f.outcome(await f.create());
  const reads = [
    ['get_receiving_dispatch_current_v1', [target.id, target.row.contractor_assignment_version]],
    ['list_receiving_dispatch_unresolved_v1', [null, '', null, 25]],
    ['get_receiving_dispatch_history_v1', [target.delivery.id, null, 20]],
  ];
  for (const name of ['mgr', 'dispatcher', 'backOffice', 'handoff']) {
    await check(`active ${name} can read safe current status, unresolved page, and bounded history`, async () => {
      for (const [rpc, args] of reads) {
        const result = await f.rpc('authenticated', f.actors[name], rpc, args);
        assert.ok(result && typeof result === 'object');
        const output = JSON.stringify(result);
        assert.doesNotMatch(output, /recipient_email|recipientEmail|provider_reference|providerReference|@|Synthetic fixture only|claim_token/);
      }
    });
  }
  for (const name of ['inactive', 'inactiveManager', 'inactiveBackOffice', 'controller', 'handoffOnly',
    'contractor', 'admin', 'report', 'invoice', 'canonical', 'unassigned', 'former', 'outsider', 'noProfile']) {
    await check(`${name} cannot read or reconcile receiving-dispatch records through direct RPC`, async () => {
      for (const [rpc, args] of reads) await f.denied(() => f.rpc('authenticated', f.actors[name], rpc, args), ['42501', 'PT403', 'PT401']);
      for (const kind of ['resend', 'manual']) await f.denied(() => f.action(kind, target, { actor: f.actors[name] }), ['42501', 'PT403', 'PT401']);
    });
  }
  for (const role of ['anon', 'service_role']) {
    await check(`${role} has no implicit operational-staff read or action authority`, async () => {
      for (const [rpc, args] of reads) await f.denied(() => f.rpc(role, null, rpc, args), ['42501', 'PT403', 'PT401']);
      for (const name of ['request_receiving_dispatch_resend_v1', 'resolve_receiving_dispatch_out_of_band_v1']) {
        await f.denied(() => f.rpc(role, null, name, [target.delivery.id, target.row.contractor_assignment_version, randomUUID(), 'Synthetic reason']), ['42501', 'PT403', 'PT401']);
      }
    });
  }
  await check('current database deactivation and role downgrade immediately override unchanged identity claims', async () => {
    await f.db.query('update public.profiles set active=false where id=$1', [f.actors.dispatcher]);
    await f.denied(() => f.current(target, f.actors.dispatcher));
    await f.db.query('update public.profiles set active=true,role=\'contractor\' where id=$1', [f.actors.dispatcher]);
    await f.denied(() => f.current(target, f.actors.dispatcher));
    await f.db.query('update public.profiles set role=\'dispatcher\' where id=$1', [f.actors.dispatcher]);
    assert.equal((await f.current(target, f.actors.dispatcher)).kind, 'current');
  });
  for (const role of ['anon', 'authenticated', 'service_role']) {
    await check(`${role} cannot mutate delivery identity, provider state, attempt history, or operation evidence directly`, async () => {
      const actor = role === 'authenticated' ? f.actors.mgr : null;
      const before = await f.snapshot();
      for (const table of [deliveryTable, 'receiving_dispatch_operations', 'receiving_dispatch_attempt_events']) {
        for (const sql of [`delete from public.${table}`, `truncate table public.${table}`,
          `insert into public.${table} default values`]) {
          await f.denied(() => f.as(role, actor, tx => tx.query(sql)), ['42501']);
        }
      }
      for (const sql of ["update public.receiving_dispatch_operations set reason='Forged reason'",
        "update public.receiving_dispatch_operations set actor_id='40000000-0000-4000-8000-000000000001'",
        "update public.receiving_dispatch_attempt_events set state='sent'"]) {
        await f.denied(() => f.as(role, actor, tx => tx.query(sql)), ['42501']);
      }
      for (const sql of [
        `update public.${deliveryTable} set status='sent' where id=$1`,
        `update public.${deliveryTable} set status='pending' where id=$1`,
        `update public.${deliveryTable} set resolution_reason='Forged actor' where id=$1`,
        `update public.${deliveryTable} set recipient_email_snapshot='forged@example.invalid' where id=$1`,
      ]) await f.denied(() => f.as(role, actor, tx => tx.query(sql, [target.delivery.id])), ['42501']);
      assert.deepEqual(await f.snapshot(), before);
    });
  }
  await check('command guard still denies a raw service update under accidentally restored table permission', async () => {
    const before = await f.row(target.delivery.id);
    await f.denied(() => f.db.transaction(async tx => {
      await tx.exec(`grant select,update on public.${deliveryTable} to service_role`);
      await tx.exec('set local role service_role');
      await tx.query("select set_config('request.jwt.claim.role','service_role',true),set_config('request.jwt.claim.sub','',true)");
      await tx.query(`update public.${deliveryTable} set status='pending' where id=$1`, [target.delivery.id]);
    }), ['42501']);
    assert.deepEqual(await f.row(target.delivery.id), before);
  });
  await check('worker claim/start/complete and private delivery routines remain service-only with pinned paths', async () => {
    for (const role of ['anon', 'authenticated']) {
      const actor = role === 'authenticated' ? f.actors.mgr : null;
      for (const [name, args] of [
        ['claim_receiving_dispatch_deliveries_v1', [1, 60, randomUUID()]],
        ['start_receiving_dispatch_delivery_v1', [target.delivery.id, randomUUID()]],
        ['prepare_receiving_dispatch_send_v1', [target.delivery.id, randomUUID()]],
        ['complete_receiving_dispatch_delivery_v1', [target.delivery.id, randomUUID(), 'sent', null, 202, null]],
      ]) await f.denied(() => f.rpc(role, actor, name, args), ['42501']);
    }
    const routines = (await f.db.query(`select p.proname,p.proconfig from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname like '%receiving%dispatch%' and p.prosecdef`)).rows;
    assert.ok(routines.length >= 9);
    for (const routine of routines) assert.ok(routine.proconfig?.some(setting => /^search_path=/.test(setting)), routine.proname);
  });
}
