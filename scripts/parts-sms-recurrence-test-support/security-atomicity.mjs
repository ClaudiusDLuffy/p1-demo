import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { injectRecurrenceFailure } from './fixtures.mjs';

export async function verifyPartsRecurrenceSecurity(f, check) {
  const target = await f.begin();
  const departure = await f.depart(target);
  await f.returnTo(target, departure);
  const child = await f.newestChild(target);
  assert.ok(child);

  await check('source generations and recurrence delivery evidence deny raw browser and service writes and truncate', async () => {
    for (const role of ['anon', 'authenticated', 'service_role']) {
      for (const table of ['p1_parts_sms_source_generations', 'p1_parts_alert_deliveries', 'p1_parts_sms_attempt_events', 'p1_parts_sms_operations']) {
        for (const statement of [`insert into public.${table} select * from public.${table} limit 1`,
          `update public.${table} set id=id`, `delete from public.${table}`, `truncate public.${table} cascade`]) {
          const columnSafe = table === 'p1_parts_sms_operations' ? statement.replace('set id=id', 'set operation_id=operation_id') : statement;
          await f.denied(() => f.as(role, role === 'authenticated' ? f.actors.mgr : null,
            tx => tx.exec(columnSafe)), ['42501', 'PT403']);
        }
      }
    }
  });

  await check('recurrence private helpers and source generations have no browser authority or mutable service grant', async () => {
    const grants = (await f.db.query(`select grantee,privilege_type from information_schema.role_table_grants
      where table_schema='public' and table_name='p1_parts_sms_source_generations'
      and grantee in ('anon','authenticated','service_role','PUBLIC')`)).rows;
    assert.deepEqual(grants, []);
    const routines = (await f.db.query(`select p.oid::regprocedure::text name,p.proconfig,
      has_function_privilege('anon',p.oid,'execute') anonymous,
      has_function_privilege('authenticated',p.oid,'execute') browser
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and (p.proname like 'parts_sms%recurrence%' or p.proname like 'parts_sms%generation%')`)).rows;
    assert.ok(routines.length > 0);
    assert.ok(routines.every(row => !row.anonymous && !row.browser));
    assert.ok(routines.every(row => row.proconfig?.some(value => value.startsWith('search_path=') && !value.includes('pg_temp'))));
  });

  await check('recurrence reads preserve operational role policy and reject all inactive, controller and contractor variants', async () => {
    for (const actor of [f.actors.mgr, f.actors.dispatcher, f.actors.backOffice]) {
      assert.equal((await f.current(child.id, actor)).id, child.id);
      assert.ok((await f.history(child.id, { actor })).items.length > 0);
    }
    const denied = ['controller', 'handoffOnly', 'contractor', 'admin', 'canonical', 'report', 'invoice', 'former', 'outsider',
      'inactive', 'inactiveManager', 'inactiveBackOffice', 'noProfile'];
    for (const key of denied) {
      assert.ok(f.actors[key], `Required ${key} authorization fixture must exist`);
      await f.denied(() => f.current(child.id, f.actors[key]));
      await f.denied(() => f.history(child.id, { actor: f.actors[key] }));
      await f.denied(() => f.page({ actor: f.actors[key] }));
      await f.denied(() => f.action('resend', child.id, { actor: f.actors[key] }));
      await f.denied(() => f.action('manual', child.id, { actor: f.actors[key] }));
    }
    await f.denied(() => f.current(child.id, null, 'anon'));
  });

  await check('no caller-supplied actor, signature, recipient, generation or source-recovery operation is accepted by enqueue', async () => {
    for (const role of ['anon', 'authenticated']) {
      await f.denied(() => f.rpc('enqueue_parts_sms_deliveries_v1', [false], f.actors.mgr, role), ['42501']);
      await f.denied(() => f.as(role, f.actors.mgr, async tx => {
        await tx.query("select set_config('request.jwt.claim.role','service_role',true)");
        return tx.query('select public.enqueue_parts_sms_deliveries_v1(false)');
      }), ['42501']);
    }
    for (const role of ['anon', 'authenticated', 'service_role']) {
      await f.denied(() => f.as(role, role === 'authenticated' ? f.actors.mgr : null,
        tx => tx.query("select public.parts_sms_cap('p1_parts_sms_source_generations',$1)", [randomUUID()])), ['42501']);
      await f.denied(() => f.as(role, role === 'authenticated' ? f.actors.mgr : null,
        tx => tx.query('select public.parts_sms_append_generation($1,current_date,$2,\'UTC\',1,null)', [target.recipient.id, 'f'.repeat(64)])), ['42501']);
    }
    assert.equal((await f.enqueue()).recurrenceQueued, 0);
    await f.denied(() => f.action('resend', target.id), ['PT409']);
    await f.denied(() => f.action('resend', child.id), ['PT409']);
    assert.equal((await f.db.query('select count(*)::int count from public.p1_parts_sms_operations where delivery_id in($1,$2)', [target.id, child.id])).rows[0].count, 0);
  });

  await check('generation ordinal and child-parent uniqueness enforce collision denial with full rollback', async () => {
    const before = await f.snapshot();
    for (const [table, transformation] of [
      ['p1_parts_sms_source_generations', "jsonb_build_object('id',gen_random_uuid())"],
      ['p1_parts_alert_deliveries', "jsonb_build_object('id',gen_random_uuid())"],
    ]) {
      await assert.rejects(f.db.transaction(async tx => {
        await tx.exec(`alter table public.${table} disable trigger user`);
        const condition = table === 'p1_parts_alert_deliveries' ? 'where id=$1' : 'where recipient_id=$1';
        await tx.query(`insert into public.${table} select (jsonb_populate_record(null::public.${table},to_jsonb(t)||${transformation})).*
          from public.${table} t ${condition} limit 1`, [table === 'p1_parts_alert_deliveries' ? child.id : target.recipient.id]);
        await tx.exec(`alter table public.${table} enable trigger user`);
      }), error => error.code === '23505');
      assert.deepEqual(await f.snapshot(), before);
    }
  });

  for (const [table, operation] of [['p1_parts_sms_source_generations', 'insert'], ['p1_parts_alert_deliveries', 'insert'],
    ['p1_parts_alert_deliveries', 'update'], ['p1_parts_sms_attempt_events', 'insert']]) {
    await check(`recurrence ${table} ${operation} failure rolls back generation, child, supersession and evidence atomically`, async () => {
      const current = await f.begin();
      const away = await f.depart(current);
      await f.order(away.partB);
      const before = await f.snapshot();
      await injectRecurrenceFailure(f.db, table, operation, async () => {
        await assert.rejects(f.enqueue(), error => error.code === 'P0001');
      });
      assert.deepEqual(await f.snapshot(), before);
      assert.equal((await f.enqueue()).recurrenceQueued, 1);
      assert.ok(await f.newestChild(current));
    });
  }

  await check('lost enqueue response and repeated overlapping synthetic calls retain one recovery child and creation journal', async () => {
    const current = await f.begin();
    const away = await f.depart(current);
    await f.order(away.partB);
    // PGlite serializes transactions; this proves final unique/replay behavior,
    // not independent PostgreSQL connection concurrency certification.
    const results = await Promise.all([f.enqueue(), f.enqueue()]);
    assert.equal(results.reduce((sum, row) => sum + row.recurrenceQueued, 0), 1);
    const newest = await f.newestChild(current);
    const original = await f.freeze({ id: newest.id });
    assert.equal((await f.enqueue()).recurrenceQueued, 0);
    await f.unchanged({ id: newest.id }, original);
    assert.equal((await f.attempts(newest.id)).filter(row => row.phase === 'source_recurrence').length, 1);
    const first = await f.take(newest.id);
    const second = await f.claim(randomUUID());
    assert.notEqual(second.claim?.id, newest.id);
    assert.ok(first.token);
  });

  await check('failure specifically after new child insertion while writing recurrence evidence rolls back the whole admission transaction', async () => {
    const current = await f.begin();
    const away = await f.depart(current);
    await f.order(away.partB);
    const before = await f.snapshot();
    await injectRecurrenceFailure(f.db, 'p1_parts_sms_attempt_events', 'insert', async () => {
      await assert.rejects(f.enqueue(), error => error.code === 'P0001');
    }, 'source_recurrence');
    assert.deepEqual(await f.snapshot(), before);
    assert.equal((await f.enqueue()).recurrenceQueued, 1);
    assert.ok(await f.newestChild(current));
  });

  await check('heartbeat completion failure after committed recurrence leaves the child durable and replay-safe', async () => {
    const current = await f.begin();
    const away = await f.depart(current);
    await f.order(away.partB);
    const runId = randomUUID();
    await f.rpc('start_parts_sms_run_v1', [runId, 'synthetic-recurrence-heartbeat']);
    assert.equal((await f.enqueue()).recurrenceQueued, 1);
    const newest = await f.newestChild(current);
    const before = await f.snapshot();
    await injectRecurrenceFailure(f.db, 'p1_parts_sms_runs', 'update', async () => {
      await assert.rejects(f.rpc('finish_parts_sms_run_v1', [runId, JSON.stringify({ recurrenceQueued: 1 }), 'RUN_COMPLETE']), error => error.code === 'P0001');
    });
    assert.deepEqual(await f.snapshot(), before);
    assert.equal((await f.delivery(newest.id)).status, 'pending');
    assert.equal((await f.health()).currentRunIncomplete, true);
    assert.equal((await f.enqueue()).recurrenceQueued, 0);
    await f.rpc('finish_parts_sms_run_v1', [runId, JSON.stringify({ recurrenceQueued: 1 }), 'RUN_COMPLETE']);
    assert.equal((await f.health()).lastRunRecurrenceQueued, 1);
  });
}
