import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createDatabase, applyThrough, createFixtures } from '../receiving-dispatch-test-support/fixtures.mjs';

export { createDatabase, applyThrough };

export async function partsSmsFixtures(db) {
  const base = await createFixtures(db);
  const { actors, as } = base;
  const measurements = new Map();
  const rpc = async (name, args = [], actor = null, role = 'service_role') => {
    assert.match(name, /^(?:configure_p1_parts_alerts|claim_p1_parts_alert_delivery|complete_p1_parts_alert_delivery|[a-z_]+parts_sms[a-z_]*_v1)$/);
    const started = performance.now();
    try {
      return (await as(role, actor, tx => tx.query(`select to_jsonb(public.${name}(${args.map((_, index) => `$${index + 1}`).join(',')})) result`, args))).rows[0]?.result;
    } finally {
      if (!measurements.has(name)) measurements.set(name, []);
      measurements.get(name).push(performance.now() - started);
    }
  };
  const recipients = [actors.mgr, actors.dispatcher, actors.backOffice].map((profileId, index) => ({
    profileId, phoneE164: `+120255501${String(index + 10).padStart(2, '0')}`, active: true,
  }));
  const configureLegacy = (patch = {}) => rpc('configure_p1_parts_alerts', [
    patch.actor || actors.mgr, patch.enabled ?? true, patch.timezone || 'America/New_York',
    patch.cutoff === undefined ? '17:00' : patch.cutoff, JSON.stringify(patch.recipients ?? recipients),
  ]);
  await configureLegacy();
  const configured = (await db.query('select id,profile_id from public.p1_parts_alert_recipients order by profile_id')).rows;
  const recipientId = actor => configured.find(row => row.profile_id === actor)?.id;
  const legacyClaim = (recipient, date, signature = 'synthetic-original-signature') =>
    rpc('claim_p1_parts_alert_delivery', [recipient, date, signature]);
  const legacyComplete = (id, state, sid = null, code = null) =>
    rpc('complete_p1_parts_alert_delivery', [id, state, sid, code]);
  const delivery = async id => (await db.query('select * from public.p1_parts_alert_deliveries where id=$1', [id])).rows[0];
  const denied = (run, codes = ['42501','PT401','PT403','PT404','PT409','PT422','22023','23514','P0002']) =>
    assert.rejects(run, error => codes.includes(error.code), 'Unsafe or stale operation must be rejected');
  return { ...base, rpc, measurements, configureLegacy, configure: configureLegacy,
    recipients, configured, recipientId, recipient: async (actor = actors.mgr) =>
      (await db.query('select * from public.p1_parts_alert_recipients where profile_id=$1', [actor])).rows[0],
    legacyClaim, legacyComplete, delivery, row: delivery, denied, operation: randomUUID, legacyIds: [] };
}
