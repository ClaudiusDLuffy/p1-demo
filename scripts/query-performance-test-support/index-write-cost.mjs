// Isolated synthetic key-only lower-bound index write-cost comparison. This is
// not a production workload/WAL claim: actual workflow triggers and business
// fields are intentionally outside this focused storage/index measurement.
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';

const summarize = samples => {
  const ordered = [...samples].sort((a, b) => a - b);
  return { iterations: ordered.length, p50Ms: ordered[Math.ceil(ordered.length * .5) - 1],
    p95Ms: ordered[Math.ceil(ordered.length * .95) - 1], maxMs: ordered.at(-1), samples: ordered };
};

export async function measureIndexWriteCost(db, contractorId) {
  const sourceCount = (await db.query('select count(*) count from public.work_orders')).rows[0].count;
  assert.ok(sourceCount >= 50000);
  for (const table of ['index_write_baseline', 'index_write_candidate']) {
    await db.exec(`create temporary table ${table} as select id,contractor_id,created_at,deleted_at from public.work_orders`);
    await db.exec(`create unique index ${table}_id on ${table}(id)`);
    await db.exec(`create index ${table}_existing on ${table}(contractor_id,created_at desc,id desc) where deleted_at is null`);
  }
  await db.exec("create index index_write_candidate_added on index_write_candidate(contractor_id,coalesce(created_at,'epoch'::timestamptz) desc,id desc) where deleted_at is null");
  const results = { evidence: 'PGLITE_LOCAL', sourceRows: sourceCount, rowsPerWrite: 1000,
    warmups: 2, iterations: 20, limitations: 'Key-only synthetic tables; not full workflow, WAL, disk, hosted latency, or write amplification certification.', distributions: [] };
  for (const table of ['index_write_baseline', 'index_write_candidate']) {
    const inserts = []; const updates = [];
    for (let iteration = 0; iteration < 22; iteration++) {
      await db.exec('begin');
      try {
        let started = performance.now();
        await db.query(`insert into ${table}(id,contractor_id,created_at) select
          'SYNTHETIC-INDEX-WRITE-'||g::text,$1,'2026-09-10T00:00:00Z'::timestamptz+g*interval '1 second'
          from generate_series(1,1000) g`, [contractorId]);
        if (iteration >= 2) inserts.push(performance.now() - started);
        started = performance.now();
        await db.exec(`update ${table} set created_at=created_at+interval '1 day'
          where id like 'SYNTHETIC-INDEX-WRITE-%'`);
        if (iteration >= 2) updates.push(performance.now() - started);
      } finally { await db.exec('rollback'); }
    }
    results.distributions.push({ table, insert: summarize(inserts), indexedColumnUpdate: summarize(updates) });
  }
  results.indexes = (await db.query(`select c.relname,pg_relation_size(c.oid) bytes,pg_get_indexdef(c.oid) definition
    from pg_class c where c.oid in ('public.work_orders_contractor_created_key_cursor_idx'::regclass,
      'public.work_orders_contractor_created_cursor_idx'::regclass)`)).rows;
  return results;
}
