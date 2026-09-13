import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createDatabase, applyThrough, createFixtures } from '../receiving-dispatch-test-support/fixtures.mjs';

export { createDatabase, applyThrough };
export const bucketTable = 'client_diagnostic_rate_limit_buckets';
export const guardTable = 'client_diagnostic_rate_limit_guards';
export const command = 'consume_client_diagnostic_rate_limit_v1';
export const signature = `public.${command}(uuid)`;
export const profileKey = id => `profile:${createHash('sha256').update(id).digest('hex')}`;

export async function diagnosticFixtures(db) {
  const base = await createFixtures(db);
  const timings = [];
  const consume = async (id = base.actors.mgr, role = 'service_role', actor = null) => {
    const started = performance.now();
    try {
      return (await base.as(role, actor, tx => tx.query(`select public.${command}($1) result`, [id]))).rows[0].result;
    } finally { timings.push(performance.now() - started); }
  };
  const buckets = () => db.query(`select * from public.${bucketTable} order by bucket_key`).then(result => result.rows);
  const guards = () => db.query(`select * from public.${guardTable} order by transaction_id,relation_name,bucket_key`).then(result => result.rows);
  async function snapshot() { return { buckets: await buckets(), guards: await guards() }; }
  async function ownerChange(sql, values = []) {
    await db.transaction(async tx => {
      await tx.exec(`alter table public.${bucketTable} disable trigger user`);
      await tx.query(sql, values);
      await tx.exec(`alter table public.${bucketTable} enable trigger user`);
    });
  }
  const reset = () => ownerChange(`update public.${bucketTable} set accepted_count=0,
    window_started_at=date_trunc('minute',clock_timestamp() at time zone 'UTC') at time zone 'UTC'`);
  async function profile(role = 'contractor', active = true) {
    const id = randomUUID();
    await db.query('insert into auth.users(id,email) values($1,$2)', [id, `${id}@diagnostics.example.invalid`]);
    await db.query('update public.profiles set role=$2,active=$3 where id=$1', [id, role, active]);
    return id;
  }
  const denied = (run, codes = ['42501', 'PT403']) => assert.rejects(run, error => codes.includes(error.code));
  return { ...base, consume, buckets, guards, snapshot, ownerChange, reset, profile, denied, timings };
}

export async function withDiagnosticFailure(db, condition, run) {
  assert.ok(['global', 'profile'].includes(condition));
  const clause = condition === 'global' ? "new.bucket_key='global'" : "new.bucket_key like 'profile:%'";
  await db.exec(`create function pg_temp.diagnostic_test_failure() returns trigger language plpgsql as $$
    begin if ${clause} then raise exception 'Synthetic limiter persistence failure' using errcode='P0001';end if;return new;end $$;
    create trigger diagnostic_test_failure after insert or update on public.${bucketTable}
      for each row execute function pg_temp.diagnostic_test_failure();`);
  try { await run(); }
  finally { await db.exec(`drop trigger diagnostic_test_failure on public.${bucketTable};drop function pg_temp.diagnostic_test_failure()`); }
}
