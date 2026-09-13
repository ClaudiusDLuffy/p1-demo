import assert from 'node:assert/strict';

export async function verifyLegacyPartsSms(f, check) {
  await f.configure();
  const recipient = await f.recipient();
  const claim = signature => f.rpc('claim_p1_parts_alert_delivery', [recipient.id, '2026-09-08', signature]);
  let id;
  await check('legacy ambiguous acceptance completed failed is immediately reclaimable and overwrites digest', async () => {
    id = await claim('synthetic-signature-one');
    await f.rpc('complete_p1_parts_alert_delivery', [id, 'failed', null, 'Synthetic response lost after provider acceptance']);
    assert.equal(await claim('synthetic-signature-two'), id);
    const row = await f.row(id);
    assert.equal(row.attempt_count, 2); assert.equal(row.request_signature, 'synthetic-signature-two');
    assert.equal(row.provider_message_id, null); assert.equal(row.error_message, null);
  });
  await check('legacy expired claim is reused; stale original worker can complete new claimant', async () => {
    await f.as('service_role', null, tx => tx.query("update public.p1_parts_alert_deliveries set claimed_at=now()-interval '16 minutes' where id=$1", [id]));
    assert.equal(await claim('synthetic-signature-three'), id);
    await f.rpc('complete_p1_parts_alert_delivery', [id, 'sent', 'SM00000000000000000000000000000001', null]);
    assert.equal((await f.row(id)).status, 'sent');
    assert.equal(await claim('different-current-digest'), null, 'Daily sent suppression ignores changed digest');
  });
  await check('legacy raw service can erase delivery evidence and active recipient profile is not revalidated', async () => {
    await f.as('service_role', null, tx => tx.query('delete from public.p1_parts_alert_deliveries where id=$1', [id]));
    await f.db.query('update public.profiles set active=false where id=$1', [f.actors.mgr]);
    try { assert.ok(await claim('inactive-profile-still-claims')); }
    finally { await f.db.query('update public.profiles set active=true where id=$1', [f.actors.mgr]); }
  });
  await check('legacy service table grants include delete and truncate; browser cannot claim', async () => {
    const privileges = (await f.db.query("select has_table_privilege('service_role','public.p1_parts_alert_deliveries','TRUNCATE') allowed")).rows[0];
    assert.equal(privileges.allowed, true);
    await f.denied(() => f.rpc('claim_p1_parts_alert_delivery', [recipient.id, '2026-09-09', 'untrusted'], f.actors.mgr, 'authenticated'));
  });
}
