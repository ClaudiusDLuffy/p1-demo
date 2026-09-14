import assert from 'node:assert/strict';

export async function reproduceLegacyPartsSms(f, check) {
  const { db, as, actors, recipientId, legacyClaim, legacyComplete, delivery } = f;
  const recipient = recipientId(actors.mgr);
  await check('legacy parts delivery identity is per recipient/local date, not per signature', async () => {
    const id = await legacyClaim(recipient, '2026-08-01');
    assert.ok(id);
    await legacyComplete(id, 'sent', `SM${'1'.repeat(32)}`);
    assert.equal(await legacyClaim(recipient, '2026-08-01', 'synthetic-new-signature'), null);
    assert.equal((await delivery(id)).request_signature, 'synthetic-original-signature');
    f.legacyIds.push(id);
  });
  await check('legacy provider acceptance then transport loss is failed and automatically reclaimed', async () => {
    const id = await legacyClaim(recipient, '2026-08-02');
    // Fake-provider acceptance is outside SQL. The old route persists only the
    // caught transport error, so the database has no unknown/send-start evidence.
    await legacyComplete(id, 'failed', null, 'Synthetic accepted before connection loss');
    assert.equal(await legacyClaim(recipient, '2026-08-02'), id);
    const row = await delivery(id);
    assert.equal(row.status, 'claimed');
    assert.equal(row.attempt_count, 2);
    assert.equal(row.provider_message_id, null);
    assert.equal(row.error_message, null);
    f.legacyIds.push(id);
  });
  await check('legacy failed reclaim overwrites prior signature and provider evidence', async () => {
    const id = await legacyClaim(recipient, '2026-08-03');
    await legacyComplete(id, 'failed', `SM${'2'.repeat(32)}`, 'Synthetic uncertain failure');
    assert.equal(await legacyClaim(recipient, '2026-08-03', 'synthetic-different-signature'), id);
    const row = await delivery(id);
    assert.equal(row.request_signature, 'synthetic-different-signature');
    assert.equal(row.provider_message_id, null);
    assert.equal(row.error_message, null);
    f.legacyIds.push(id);
  });
  await check('legacy database completion failure after SID falls back to reclaimable failed without SID', async () => {
    const id = await legacyClaim(recipient, '2026-08-04');
    await db.exec(`create function pg_temp.parts_legacy_completion_failure() returns trigger language plpgsql as $$
      begin if new.status='sent' then raise exception 'Synthetic database completion failure' using errcode='P0001'; end if; return new; end $$;
      create trigger parts_legacy_completion_failure after update on public.p1_parts_alert_deliveries
      for each row execute function pg_temp.parts_legacy_completion_failure();`);
    try {
      await assert.rejects(() => legacyComplete(id, 'sent', `SM${'3'.repeat(32)}`), error => error.code === 'P0001');
      assert.equal((await delivery(id)).status, 'claimed');
      await legacyComplete(id, 'failed', null, 'Synthetic completion failure after provider accepted');
      assert.equal((await delivery(id)).provider_message_id, null);
      assert.equal(await legacyClaim(recipient, '2026-08-04'), id);
    } finally { await db.exec('drop trigger parts_legacy_completion_failure on public.p1_parts_alert_deliveries'); }
    f.legacyIds.push(id);
  });
  await check('legacy expired claim is reclaimed using the same ID with no attempt claim token', async () => {
    const id = await legacyClaim(recipient, '2026-08-05');
    await db.query("update public.p1_parts_alert_deliveries set claimed_at=now()-interval '16 minutes' where id=$1", [id]);
    assert.equal(await legacyClaim(recipient, '2026-08-05'), id);
    assert.equal((await delivery(id)).attempt_count, 2);
    // A first worker's completion is indistinguishable from the new owner.
    await legacyComplete(id, 'sent', `SM${'4'.repeat(32)}`);
    assert.equal((await delivery(id)).status, 'sent');
    f.legacyIds.push(id);
  });
  await check('legacy claim trusts recipient ID after configured recipient and profile deactivate', async () => {
    const target = recipientId(actors.dispatcher);
    await db.query('update public.p1_parts_alert_recipients set active=false where id=$1', [target]);
    await db.query('update public.profiles set active=false where id=$1', [actors.dispatcher]);
    try {
      const id = await legacyClaim(target, '2026-08-06');
      assert.ok(id);
      await legacyComplete(id, 'failed', null, 'Synthetic inactive target');
      f.legacyIds.push(id);
    } finally {
      await db.query('update public.p1_parts_alert_recipients set active=true where id=$1', [target]);
      await db.query('update public.profiles set active=true where id=$1', [actors.dispatcher]);
    }
  });
  await check('legacy service role may raw-forge, mutate and delete a parts delivery', async () => {
    const id = await legacyClaim(recipient, '2026-08-07');
    await as('service_role', null, tx => tx.query("update public.p1_parts_alert_deliveries set status='sent',provider_message_id=$2,request_signature='synthetic-forged' where id=$1", [id, `SM${'5'.repeat(32)}`]));
    assert.equal((await delivery(id)).request_signature, 'synthetic-forged');
    await as('service_role', null, tx => tx.query('delete from public.p1_parts_alert_deliveries where id=$1', [id]));
    assert.equal(await delivery(id), undefined);
  });
  await check('legacy service-only claims and active operational settings positive control remain', async () => {
    await f.denied(() => f.rpc('claim_p1_parts_alert_delivery', [recipient, '2026-08-08', 'synthetic-signature'], actors.mgr, 'authenticated'));
    await f.denied(() => f.configureLegacy({ actor: actors.controller }));
    await f.denied(() => f.configureLegacy({ actor: actors.inactive }));
    assert.equal((await f.configureLegacy()).enabled, true);
  });
  await check('legacy schema has no immutable attempt, run-heartbeat or unknown state', async () => {
    const tables = (await db.query(`select to_regclass('public.p1_parts_sms_attempts') attempts,
      to_regclass('public.p1_parts_alert_worker_runs') runs`)).rows[0];
    assert.deepEqual(tables, { attempts: null, runs: null });
    const checks = (await db.query(`select pg_get_constraintdef(oid) definition from pg_constraint
      where conrelid='public.p1_parts_alert_deliveries'::regclass and contype='c'`)).rows.map(row => row.definition).join('\n');
    assert.doesNotMatch(checks, /unknown|send_started|delivered/);
    const id = await legacyClaim(recipient, '2026-08-09');
    await legacyComplete(id, 'failed', null, 'Synthetic historical ambiguous failure for migration review');
    f.legacyIds.push(id);
  });
}
