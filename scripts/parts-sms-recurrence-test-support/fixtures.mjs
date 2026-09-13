import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { partsSmsCandidateFixtures, partsSmsOwnedTables } from '../parts-sms-test-support/candidate-fixtures.mjs';

export function recurrenceFixtures(base) {
  const f = partsSmsCandidateFixtures(base);
  const order = part => f.as('authenticated', f.actors.mgr,
    tx => tx.query("select public.set_p1_part_order_status($1,'ordered')", [part.id]));
  async function begin() {
    const target = await f.make();
    const signature = target.event.request_signature;
    return { ...target, signature };
  }
  async function depart(target) {
    const partB = await f.source();
    const evaluation = await f.enqueue();
    const events = await f.deliveries(target.recipient.id);
    const opposite = events.find(row => row.request_signature !== target.signature && row.status !== 'superseded');
    return { partB, evaluation, opposite };
  }
  async function returnTo(target, departure) {
    await order(departure.partB);
    const evaluation = await f.enqueue();
    return { evaluation, rows: await f.deliveries(target.recipient.id) };
  }
  const generations = () => f.db.query('select * from public.p1_parts_sms_source_generations order by observed_at,id').then(result => result.rows);
  async function snapshot() {
    const result = await f.snapshot();
    const present = (await f.db.query("select to_regclass('public.p1_parts_sms_source_generations') present")).rows[0].present;
    if (present) result.p1_parts_sms_source_generations = await generations();
    return result;
  }
  async function freeze(target) {
    return {
      delivery: await f.delivery(target.id),
      attempts: await f.attempts(target.id),
      operations: (await f.db.query('select * from public.p1_parts_sms_operations where delivery_id=$1 order by operation_id', [target.id])).rows,
    };
  }
  async function unchanged(target, original, oldColumnsOnly = false) {
    const after = await freeze(target);
    if (oldColumnsOnly) {
      after.delivery = Object.fromEntries(Object.keys(original.delivery).map(key => [key, after.delivery[key]]));
    }
    assert.deepEqual(after, original, 'Original delivery identity, state and all historical evidence must remain unchanged');
  }
  async function newestChild(target) {
    const rows = await f.deliveries(target.recipient.id);
    const children = rows.filter(row => row.parent_delivery_id && row.request_signature === target.signature);
    return children.find(row => !children.some(child => child.parent_delivery_id === row.id));
  }
  async function legacyBarrier(target) {
    const id = randomUUID();
    await f.db.transaction(async tx => {
      await tx.exec('alter table public.p1_parts_alert_deliveries disable trigger user');
      await tx.query(`insert into public.p1_parts_alert_deliveries
        (id,recipient_id,local_date,request_signature,status,provenance,claimed_at,created_at)
        values($1,$2,$3,'synthetic-legacy-barrier','failed','legacy',now(),now())`, [id, target.recipient.id, target.event.local_date]);
      await tx.exec('alter table public.p1_parts_alert_deliveries enable trigger user');
    });
    return id;
  }
  return { ...f, order, begin, depart, returnTo, generations, snapshot, freeze, unchanged, newestChild, legacyBarrier };
}

export async function injectRecurrenceFailure(db, table, operation, run, phase = null) {
  assert.ok([...partsSmsOwnedTables, 'p1_parts_sms_source_generations'].includes(table));
  assert.ok(['insert', 'update'].includes(operation));
  assert.ok(phase === null || (phase === 'source_recurrence' && table === 'p1_parts_sms_attempt_events'));
  await db.exec(`create or replace function pg_temp.parts_recurrence_test_failure() returns trigger language plpgsql as $$
    begin ${phase ? "if new.phase<>'source_recurrence' then return new;end if;" : ''}
    raise exception 'Synthetic recurrence persistence failure' using errcode='P0001';end $$;
    create trigger parts_recurrence_test_failure after ${operation} on public.${table}
    for each row execute function pg_temp.parts_recurrence_test_failure();`);
  try { await run(); }
  finally { await db.exec(`drop trigger parts_recurrence_test_failure on public.${table}`); }
}
