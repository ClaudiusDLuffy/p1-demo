import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initializeSupabaseFixtureDatabase, applyFixtureMigration,
  initializeLifecycleActors, actorTransactions } from '../lifecycle-test-support/engine-fixtures.mjs';
import { migrationStatements } from '../invoice-test-support/migration-statements.mjs';
import { createAssignmentFixtures } from '../assignment-test-support/command-fixtures.mjs';

export const repo = fileURLToPath(new URL('../../', import.meta.url));
export const deliveryTable = 'contractor_receiving_dispatch_deliveries';
const allowedFunctions = new Set([
  'get_receiving_dispatch_current_v1', 'list_receiving_dispatch_unresolved_v1',
  'get_receiving_dispatch_history_v1', 'request_receiving_dispatch_resend_v1',
  'resolve_receiving_dispatch_out_of_band_v1', 'claim_receiving_dispatch_deliveries_v1',
  'start_receiving_dispatch_delivery_v1', 'prepare_receiving_dispatch_send_v1',
  'complete_receiving_dispatch_delivery_v1', 'resolve_receiving_dispatch_delivery_v1',
]);

export async function createDatabase() {
  assert.ok(process.env.P1_SQL_TEST_ENGINE_DIR, 'Use the approved existing isolated SQL engine');
  const requireEngine = createRequire(resolve(process.env.P1_SQL_TEST_ENGINE_DIR, 'package.json'));
  const { PGlite } = requireEngine('@electric-sql/pglite');
  const { pg_trgm } = requireEngine('@electric-sql/pglite/contrib/pg_trgm');
  const { pgcrypto } = requireEngine('@electric-sql/pglite/contrib/pgcrypto');
  const db = new PGlite({ extensions: { pg_trgm, pgcrypto } });
  await initializeSupabaseFixtureDatabase(db);
  await db.exec(`grant select on storage.buckets to anon, authenticated, service_role;
    grant select, insert, update, delete on storage.objects to anon, authenticated, service_role;
    alter table storage.objects add constraint synthetic_storage_object_identity unique(bucket_id,name);`);
  return db;
}

export async function applyThrough(db, maximum, minimum = 0) {
  const names = readdirSync(`${repo}/supabase/migrations`).filter(name => /^\d+.*\.sql$/.test(name))
    .filter(name => { const number = Number(name.match(/^\d+/)[0]); return number <= maximum && number >= minimum; }).sort();
  assert.ok(names.some(name => Number(name.match(/^\d+/)[0]) === maximum));
  for (const name of names) await applyFixtureMigration({ db, repo, name, statements: migrationStatements });
}

export async function createFixtures(db) {
  const baseActors = await initializeLifecycleActors(db);
  const as = actorTransactions(db);
  const assignment = await createAssignmentFixtures({ db, as, actors: baseActors });
  const actors = assignment.actors;
  for (const [name, role] of [['inactiveManager', 'manager'], ['inactiveBackOffice', 'back_office']]) {
    const id = randomUUID();
    await db.query('insert into auth.users(id,email) values ($1,$2)', [id, `${name}@closeout.example.invalid`]);
    await db.query('update public.profiles set role=$2,active=false,name=$3 where id=$1', [id, role, `Synthetic ${name}`]);
    actors[name] = id;
  }
  actors.noProfile = randomUUID();
  actors.handoffOnly = randomUUID();
  await db.query('insert into auth.users(id,email) values ($1,$2)', [actors.handoffOnly, 'handoff-only@closeout.example.invalid']);
  await db.query("update public.profiles set role='back_office',active=true where id=$1", [actors.handoffOnly]);
  await db.query("insert into public.staff_permission_grants(profile_id,permission) values($1,'invoice_controller'),($1,'quickbooks_handoff')", [actors.handoffOnly]);
  let sequence = 0;
  const rpc = (role, actor, name, args = []) => {
    assert.ok(allowedFunctions.has(name), 'Only focused delivery functions may be invoked');
    return as(role, actor, tx => tx.query(`select to_jsonb(public.${name}(${args.map((_, i) => `$${i + 1}`).join(',')})) result`, args))
      .then(result => result.rows[0]?.result);
  };
  async function create(options = {}) {
    const id = options.id || `WOT97${String(++sequence).padStart(5, '0')}`;
    const email = options.email === true;
    const operation = options.operation || randomUUID();
    const payload = { id, source: email ? 'email_intake' : 'manual', priority: 'p3',
      status: options.owner === null ? 'unassigned' : 'assigned',
      functional_status: email || options.owner === null ? 'New' : 'Dispatched',
      contractor_id: options.owner === undefined ? actors.contractor : options.owner,
      nte: 1000, summary: 'Synthetic receiving dispatch', description: 'Synthetic fixture only' };
    const name = email ? 'create_email_work_order_with_assignment_v1' : 'create_work_order_with_assignment_v1';
    await as(email ? 'service_role' : 'authenticated', email ? null : actors.mgr,
      tx => tx.query(`select public.${name}($1,$2) result`, [operation, JSON.stringify(payload)]));
    return { id, operation, payload, row: await parent(id), delivery: await delivery(id) };
  }
  const parent = async id => (await db.query('select * from public.work_orders where id=$1', [id])).rows[0];
  const delivery = async id => (await db.query(`select to_regclass('public.${deliveryTable}') present`)).rows[0].present
    ? (await db.query(`select * from public.${deliveryTable} where work_order_id=$1 order by created_at desc,id desc`, [id])).rows[0] : undefined;
  const row = async id => (await db.query(`select * from public.${deliveryTable} where id=$1`, [id])).rows[0];
  const current = (target, actor = actors.mgr) => rpc('authenticated', actor, 'get_receiving_dispatch_current_v1', [target.id, target.row.contractor_assignment_version]);
  const page = (state = null, search = '', cursor = null, limit = 25, actor = actors.mgr) =>
    rpc('authenticated', actor, 'list_receiving_dispatch_unresolved_v1', [state, search, cursor === null ? null : JSON.stringify(cursor), limit]);
  const history = (id, cursor = null, limit = 20, actor = actors.mgr) =>
    rpc('authenticated', actor, 'get_receiving_dispatch_history_v1', [id, cursor === null ? null : JSON.stringify(cursor), limit]);
  const action = (kind, target, options = {}) => rpc(options.role || 'authenticated', options.actor || actors.mgr,
    kind === 'resend' ? 'request_receiving_dispatch_resend_v1' : 'resolve_receiving_dispatch_out_of_band_v1',
    [options.deliveryId || target.delivery.id, options.version ?? target.row.contractor_assignment_version,
      options.operation || randomUUID(), options.reason === undefined ? 'Synthetic reasoned staff contact' : options.reason]);
  const claim = async (limit = 25, token = randomUUID()) => ({ token, rows: (await as('service_role', null,
    tx => tx.query('select * from public.claim_receiving_dispatch_deliveries_v1($1,$2,$3)', [limit, 60, token]))).rows });
  const start = (id, token) => rpc('service_role', null, 'start_receiving_dispatch_delivery_v1', [id, token]);
  const complete = (id, token, state, code = null) => rpc('service_role', null,
    'complete_receiving_dispatch_delivery_v1', [id, token, state, code, state === 'sent' ? 202 : null, null]);
  async function outcome(target, state = 'unknown') {
    let found = false;
    for (let pageNumber = 0; pageNumber < 100 && !found; pageNumber++) {
      const pending = await claim(25);
      for (const item of pending.rows) {
        const started = await start(item.id, pending.token);
        if (!started) continue;
        await complete(item.id, pending.token, item.id === target.delivery.id ? state : 'sent',
          item.id === target.delivery.id && state === 'unknown' ? 'GRAPH_OUTCOME_UNKNOWN' : null);
        if (item.id === target.delivery.id) found = true;
      }
    }
    assert.ok(found, 'Synthetic target must be claimed');
    target.delivery = await row(target.delivery.id);
    return target;
  }
  const snapshot = async () => {
    const result = {};
    for (const table of [deliveryTable, 'receiving_dispatch_operations', 'receiving_dispatch_attempt_events']) {
      result[table] = (await db.query(`select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text),'[]') data from public.${table} t`)).rows[0].data;
    }
    return result;
  };
  const denied = (run, codes = ['42501', 'PT409', 'PT422', '22023', '23514', 'P0002', 'PT404', 'PT403', 'PT401']) =>
    assert.rejects(run, error => codes.includes(error.code), 'The unauthorized, stale, or invalid command must fail');
  return { db, as, actors, assignment, rpc, create, parent, delivery, row, current, page, history,
    action, claim, start, complete, outcome, snapshot, denied };
}

// Owner-only mutations are isolated fixture controls, never application/RPC capabilities.
export async function mutateFixture(db, table, sql, values = []) {
  assert.ok([deliveryTable, 'work_orders', 'profiles', 'receiving_dispatch_attempt_events'].includes(table));
  await db.transaction(async tx => {
    await tx.exec(`alter table public.${table} disable trigger user`);
    await tx.query(sql, values);
    await tx.exec(`alter table public.${table} enable trigger user`);
  });
}

export async function withWriteFailure(db, table, operation, run) {
  assert.ok([deliveryTable, 'receiving_dispatch_operations', 'receiving_dispatch_attempt_events'].includes(table));
  assert.ok(['insert', 'update'].includes(operation));
  await db.exec(`create or replace function pg_temp.fail_receiving_dispatch_fixture_write()
    returns trigger language plpgsql as $$ begin raise exception 'Synthetic post-write failure' using errcode='P0001'; end $$;
    create trigger receiving_dispatch_fixture_failure after ${operation} on public.${table}
      for each row execute function pg_temp.fail_receiving_dispatch_fixture_write();`);
  try { await run(); }
  finally { await db.exec(`drop trigger receiving_dispatch_fixture_failure on public.${table}`); }
}
