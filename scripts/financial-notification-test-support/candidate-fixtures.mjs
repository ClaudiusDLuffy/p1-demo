import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';

const functions = new Set([
  'review_contractor_invoice_with_notification_v1', 'review_contractor_invoices_with_notification_v1',
  'retract_contractor_invoice_rejection_with_notification_v1', 'set_contractor_invoice_payment_hold_with_notification_v1',
  'get_financial_notification_status_v1', 'list_financial_notification_unresolved_v1',
  'get_financial_notification_history_v1', 'request_financial_notification_resend_v1',
  'resolve_financial_notification_out_of_band_v1', 'claim_financial_notification_deliveries_v1',
  'prepare_financial_notification_send_v1', 'complete_financial_notification_delivery_v1',
  'annotate_financial_notification_history_v1',
]);
export const ownedTables = ['financial_notification_events', 'financial_notification_deliveries',
  'financial_notification_attempt_events', 'financial_notification_operations', 'financial_notification_mutation_operations'];

export function candidateFixtures(f) {
  const { db, actors, as } = f;
  const measurements=new Map();
  const rpc = (name, args, actor = actors.mgr, role = 'authenticated') => {
    assert.ok(functions.has(name));
    const started=performance.now();
    return as(role, actor, tx => tx.query(`select to_jsonb(public.${name}(${args.map((_, index) => `$${index + 1}`).join(',')})) result`, args))
      .then(result => {
        const values=measurements.get(name)||[];values.push(performance.now()-started);measurements.set(name,values);
        return result.rows[0]?.result;
      });
  };
  const events = target => db.query('select * from public.financial_notification_events where invoice_id=$1 order by created_at,id', [target.id]).then(r => r.rows);
  const deliveries = event => db.query('select * from public.financial_notification_deliveries where event_id=$1 order by created_at,id', [event.id]).then(r => r.rows);
  const delivery = id => db.query('select * from public.financial_notification_deliveries where id=$1', [id]).then(r => r.rows[0]);
  const review = (target, options = {}) => rpc('review_contractor_invoice_with_notification_v1',
    [target.id, options.action || 'reject', options.action === 'approve' ? null : options.reason ?? 'Synthetic invoice correction',
      options.operation || randomUUID(), options.revision ?? target.row.review_revision], options.actor || actors.mgr, options.role || 'authenticated');
  const batch = (targets, options = {}) => rpc('review_contractor_invoices_with_notification_v1',
    [targets.map(target => target.id), options.action || 'reject', options.reason ?? 'Synthetic batch correction', options.operation || randomUUID(),
      JSON.stringify(options.revisions || Object.fromEntries(targets.map(target => [target.id, target.row.review_revision])))], options.actor || actors.mgr);
  const retract = (target, options = {}) => rpc('retract_contractor_invoice_rejection_with_notification_v1',
    [target.id, options.operation || randomUUID(), options.revision ?? target.row.review_revision], options.actor || actors.mgr);
  const hold = (target, options = {}) => rpc('set_contractor_invoice_payment_hold_with_notification_v1',
    [target.id, options.action || 'place', options.reason ?? 'Synthetic accounting contact', options.operation || randomUUID(), options.source || null],
    options.actor || (options.action === 'release' ? actors.handoff : actors.mgr));
  const status = (target, cursor = null, limit = 25, actor = actors.mgr) => rpc('get_financial_notification_status_v1',
    [target.id, cursor === null ? null : JSON.stringify(cursor), limit], actor);
  const page = (options = {}) => rpc('list_financial_notification_unresolved_v1',
    [options.family || null, options.state || null, options.search || '', options.cursor === undefined || options.cursor === null ? null : JSON.stringify(options.cursor), options.limit ?? 25], options.actor || actors.mgr);
  const history = (event, cursor = null, limit = 20, actor = actors.mgr) => rpc('get_financial_notification_history_v1',
    [event.id, cursor === null ? null : JSON.stringify(cursor), limit], actor);
  const action = (kind, event, item, options = {}) => rpc(kind === 'resend' ? 'request_financial_notification_resend_v1' : 'resolve_financial_notification_out_of_band_v1',
    [event.id, item.id, options.operation || randomUUID(), options.reason ?? 'Synthetic reasoned operator contact'], options.actor || actors.mgr);
  const claim = (limit = 25, token = randomUUID(), lease = 60) => rpc('claim_financial_notification_deliveries_v1', [limit, lease, token], null, 'service_role').then(result => ({ token, rows: result.claims, summary:result }));
  const prepare = (id, token) => rpc('prepare_financial_notification_send_v1', [id, token], null, 'service_role');
  const complete = (id, token, state, code = null, providerStatus = state === 'sent' ? 202 : null, retryAfter = null) => rpc('complete_financial_notification_delivery_v1',
    [id, token, state, code, providerStatus, null, retryAfter], null, 'service_role');
  async function settle(targetId = null, state = 'sent', code = state === 'unknown' ? 'GRAPH_OUTCOME_UNKNOWN' : null) {
    let found = targetId === null;
    for (let count = 0; count < 100; count++) {
      const pending = await claim();
      assert.ok(Array.isArray(pending.rows), 'Claim returns a bounded JSON array');
      if (!pending.rows.length) {
        if (pending.summary.superseded || pending.summary.notDeliverable) continue;
        break;
      }
      for (const row of pending.rows) {
        const message = await prepare(row.id, pending.token);
        if (!message || message.status) continue;
        await complete(row.id, pending.token, row.id === targetId ? state : 'sent', row.id === targetId ? code : null);
        if (row.id === targetId) found = true;
      }
    }
    assert.ok(found, 'Expected synthetic delivery reaches the existing worker pipeline');
  }
  async function snapshot(target) {
    const result = { financial: await f.financial.snapshot(target.workOrderId) };
    for (const table of [...ownedTables, 'financial_notification_source_guards', 'financial_notification_record_guards',
      'contractor_invoice_payment_holds', 'contractor_invoice_payment_hold_events','financial_notification_hold_heads']) {
      result[table] = (await db.query(`select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text),'[]') rows from public.${table} t`)).rows[0].rows;
    }
    if ((await db.query("select to_regclass('public.financial_notification_hold_supersessions') present")).rows[0].present) {
      result.financial_notification_hold_supersessions = (await db.query("select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text),'[]') rows from public.financial_notification_hold_supersessions t")).rows[0].rows;
    }
    return result;
  }
  const denied = (run, codes = ['42501','PT409','PT422','PT404','22023','55000','40001','23514']) => assert.rejects(run, error => {
    assert.ok(codes.includes(error.code),`Expected ${codes.join('/')} but received ${error.code}: ${error.message}`);
    return true;
  }, 'Unauthorized, invalid, or stale command must fail');
  return { ...f, rpc, events, deliveries, delivery, candidateReview: review, batch, candidateRetract: retract,
    candidateHold: hold, status, page, history, action, claim, prepare, complete, settle, snapshot, denied,measurements };
}

export async function failWrite(db, table, run) {
  assert.ok([...ownedTables, 'activities', 'contractor_invoice_payment_hold_events', 'contractor_invoice_payment_holds', 'invoices','financial_notification_hold_heads','financial_notification_hold_supersessions'].includes(table));
  await db.exec(`create or replace function pg_temp.fail_financial_notification_fixture_write() returns trigger language plpgsql
    as $$ begin raise exception 'Synthetic post-write failure' using errcode='P0001'; end $$;
    create trigger financial_notification_fixture_failure after insert or update or delete on public.${table}
      for each row execute function pg_temp.fail_financial_notification_fixture_write();`);
  try { await run(); }
  finally { await db.exec(`drop trigger financial_notification_fixture_failure on public.${table}`); }
}

export async function ownerFixtureUpdate(db, table, sql, values = []) {
  assert.ok([...ownedTables, 'profiles', 'organizations', 'invoices', 'work_orders', 'contractor_technicians',
    'contractor_invoice_payment_hold_events', 'contractor_invoice_payment_holds', 'financial_notification_hold_heads'].includes(table));
  await db.transaction(async tx => {
    await tx.exec(`alter table public.${table} disable trigger user`);
    await tx.query(sql, values);
    await tx.exec(`alter table public.${table} enable trigger user`);
  });
}
