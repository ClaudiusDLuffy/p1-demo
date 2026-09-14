import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

export const partsSmsOwnedTables = ['p1_parts_alert_deliveries', 'p1_parts_sms_attempt_events',
  'p1_parts_sms_operations', 'p1_parts_sms_runs', 'p1_parts_sms_guards'];

export function partsSmsCandidateFixtures(f) {
  const { db, actors, as, rpc } = f;
  const createdParts = [];
  const source = async (options = {}) => {
    const target = await f.create({ owner: null });
    const id = randomUUID();
    await db.query(`insert into public.wo_parts(id,work_order_id,description,qty,created_by)
      values($1,$2,'Synthetic parts SMS request',$3,$4)`, [id, target.id, options.qty ?? 1, actors.mgr]);
    await as('authenticated', actors.mgr, tx => tx.query('select public.request_p1_part_order($1)', [id]));
    createdParts.push(id);
    return { id, workOrderId: target.id };
  };
  async function scenario(options = {}) {
    for (const id of createdParts.splice(0)) {
      const existing = (await db.query('select p1_order_status from public.wo_parts where id=$1', [id])).rows[0];
      if (existing?.p1_order_status === 'requested') {
        await as('authenticated', actors.mgr, tx => tx.query("select public.set_p1_part_order_status($1,'cancelled')", [id]));
      }
    }
    const profileId = randomUUID();
    await db.query('insert into auth.users(id,email) values($1,$2)', [profileId, `${profileId}@parts-sms.example.invalid`]);
    await db.query("update public.profiles set role='back_office',active=true,name='Synthetic parts recipient' where id=$1", [profileId]);
    const configuredRecipients = options.recipients ?? [{ profileId, phoneE164: '+12025550123', active: true }];
    await configure({ recipients: configuredRecipients });
    const recipient = (await db.query('select * from public.p1_parts_alert_recipients where profile_id=$1', [configuredRecipients[0]?.profileId || profileId])).rows[0];
    const part = options.noParts ? null : await source();
    return { recipient, profileId, part };
  }
  const configure = (options = {}) => rpc('configure_p1_parts_alerts', [
    options.actor ?? actors.mgr, options.enabled ?? true, options.timezone ?? 'UTC',
    options.cutoff === undefined ? '00:00' : options.cutoff,
    JSON.stringify(options.recipients ?? [{ profileId: actors.mgr, phoneE164: '+12025550124', active: true }]),
  ]);
  const enqueue = (force = false) => rpc('enqueue_parts_sms_deliveries_v1', [force]);
  const claim = async (token = randomUUID(), force = false) => ({ token, ...await rpc('claim_parts_sms_delivery_v1', [token, force]) });
  const prepare = (id, token, force = false) => rpc('prepare_parts_sms_send_v1', [id, token, force]);
  const complete = (id, token, outcome = 'unknown', options = {}) => rpc('complete_parts_sms_delivery_v1', [
    id, token, outcome, options.code === undefined ? outcome === 'unknown' ? 'TWILIO_UNKNOWN'
      : outcome === 'known_unsent_retryable' ? 'TWILIO_BEFORE_SEND_CANCELLED'
      : outcome === 'known_unsent_terminal' ? 'TWILIO_NOT_CONFIGURED' : null : options.code,
    options.sid ?? null, options.providerStatus ?? null, options.retryAfter ?? null,
  ]);
  const deliveries = (recipientId = null) => db.query(`select * from public.p1_parts_alert_deliveries
    where provenance='owned_v1' and ($1::uuid is null or recipient_id=$1) order by created_at,id`, [recipientId]).then(result => result.rows);
  const attempts = id => db.query('select * from public.p1_parts_sms_attempt_events where delivery_id=$1 order by created_at,id', [id]).then(result => result.rows);
  async function take(targetId) {
    for (let index = 0; index < 200; index++) {
      const current = await claim();
      if (current.claim?.id === targetId) return current;
      if (current.claim) {
        const prepared = await prepare(current.claim.id, current.token);
        if (prepared && !prepared.status) await complete(current.claim.id, current.token);
      } else if (!current.superseded && !current.notDeliverable) break;
    }
    throw new Error('Current synthetic target was not claimable');
  }
  async function make(outcome = null, options = {}) {
    const target = await scenario(options);
    const result = await enqueue();
    assert.equal(result.status, 'queued');
    const event = (await deliveries(target.recipient.id)).at(-1);
    assert.ok(event);
    if (outcome) {
      const current = await take(event.id);
      const prepared = await prepare(event.id, current.token);
      assert.equal(prepared.id, event.id);
      await complete(event.id, current.token, outcome, options);
    }
    return { ...target, id: event.id, event: await f.delivery(event.id) };
  }
  const statusClaim = async (token = randomUUID()) => ({ token, ...await rpc('claim_parts_sms_status_v1', [token]) });
  const statusComplete = (id, token, status, code = null, sid = null) => rpc('complete_parts_sms_status_v1', [id, token, status, code, sid]);
  const page = (options = {}) => rpc('list_parts_sms_unresolved_v1', [options.state ?? null, options.search ?? '',
    options.cursor === undefined || options.cursor === null ? null : JSON.stringify(options.cursor), options.limit ?? 25], options.actor ?? actors.mgr, options.role ?? 'authenticated');
  const current = (id, actor = actors.mgr, role = 'authenticated') => rpc('get_parts_sms_delivery_v1', [id], actor, role);
  const history = (id, options = {}) => rpc('get_parts_sms_history_v1', [id,
    options.cursor === undefined || options.cursor === null ? null : JSON.stringify(options.cursor), options.limit ?? 20], options.actor ?? actors.mgr, options.role ?? 'authenticated');
  const action = (kind, id, options = {}) => rpc(kind === 'resend' ? 'request_parts_sms_resend_v1' : 'resolve_parts_sms_out_of_band_v1',
    [id, options.operation ?? randomUUID(), options.reason === undefined ? 'Synthetic accountable staff contact' : options.reason], options.actor ?? actors.mgr, options.role ?? 'authenticated');
  const health = (actor = actors.mgr, role = 'authenticated') => rpc('get_parts_sms_worker_health_v1', [], actor, role);
  const snapshot = async () => {
    const result = {};
    for (const table of [...partsSmsOwnedTables, 'p1_parts_alert_settings', 'p1_parts_alert_recipients']) {
      result[table] = (await db.query(`select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text),'[]') rows from public.${table} t`)).rows[0].rows;
    }
    return result;
  };
  return { ...f, source, scenario, configure, enqueue, claim, prepare, complete, deliveries,
    attempts, take, make, statusClaim, statusComplete, page, current, history, action, health, snapshot };
}

export async function partsSmsOwnerUpdate(db, table, statement, values = []) {
  assert.ok([...partsSmsOwnedTables, 'p1_parts_alert_settings', 'p1_parts_alert_recipients', 'profiles', 'work_orders', 'wo_parts'].includes(table));
  await db.transaction(async tx => {
    await tx.exec(`alter table public.${table} disable trigger user`);
    await tx.query(statement, values);
    await tx.exec(`alter table public.${table} enable trigger user`);
  });
}

export async function failPartsSmsWrite(db, table, operation, run) {
  assert.ok([...partsSmsOwnedTables, 'p1_parts_alert_settings', 'p1_parts_alert_recipients'].includes(table));
  assert.ok(['insert', 'update'].includes(operation));
  await db.exec(`create or replace function pg_temp.parts_sms_test_failure() returns trigger language plpgsql as $$
    begin raise exception 'Synthetic post-write failure' using errcode='P0001';end $$;
    create trigger parts_sms_test_failure after ${operation} on public.${table} for each row execute function pg_temp.parts_sms_test_failure();`);
  try { await run(); }
  finally { await db.exec(`drop trigger parts_sms_test_failure on public.${table}`); }
}
