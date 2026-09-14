import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createDatabase, applyThrough, partsSmsFixtures } from './fixtures.mjs';
import { partsSmsCandidateFixtures } from './candidate-fixtures.mjs';

export async function verifyPartsSmsAudit(check) {
  const db = await createDatabase();
  try {
    await applyThrough(db, 139);
    const f = partsSmsCandidateFixtures(await partsSmsFixtures(db));
    const sql = readFileSync(new URL('../../supabase/audits/0139_bounded_parts_sms_integrity_verification.sql', import.meta.url), 'utf8');
    const withoutComments = sql.replace(/--[^\n]*/g, '').replace(/'(?:''|[^'])*'/g, "''");
    assert.doesNotMatch(withoutComments, /\b(insert|update|delete|truncate|alter|drop|grant|revoke)\b/i);
    await check('parts SMS clean filename-order install and read-only empty audit expose missed heartbeat without mutation', async () => {
      const before = await f.snapshot();
      const result = await db.exec(sql);
      assert.deepEqual(result[0].rows, []);
      assert.equal(result[1].rows[0].worker_silent_over_two_intervals, true);
      assert.deepEqual(await f.snapshot(), before);
      for (const row of result[2].rows) {
        assert.equal(row.grantee, 'service_role');
        assert.equal(row.privilege_type, 'SELECT');
        assert.ok(['p1_parts_alert_settings', 'p1_parts_alert_recipients'].includes(row.table_name));
      }
      assert.ok(result[3].rows.every(row => !row.anonymous_execute));
      const pages = result.find(item => item.rows[0] && 'bounded_page_cap' in item.rows[0]);
      assert.equal(pages.rows.length, 2);
      assert.ok(pages.rows.every(row => row.bounded_page_cap && row.stable_timestamp_order && row.stable_unique_tie_breaker && row.insertion_snapshot_boundary));
      const legacy = result.find(item => item.rows[0] && 'direct_send_claim_fails_closed' in item.rows[0]);
      assert.ok(legacy.rows.every(row => row.direct_send_claim_fails_closed));
    });
    await check('parts SMS audit separates unresolved operational facts from corrupt evidence and exposes safe samples only', async () => {
      const target = await f.make('unknown');
      const runId = randomUUID();
      await f.rpc('start_parts_sms_run_v1', [runId, 'synthetic-audit']);
      await f.rpc('finish_parts_sms_run_v1', [runId, JSON.stringify({ claimed: 1, unknown: 1 }), 'RUN_COMPLETE']);
      const before = await f.snapshot();
      let results = await db.exec(sql);
      assert.ok(results[0].rows.some(row => row.finding === 'unknown_requires_review' && row.sample_record_ids.includes(target.id)));
      assert.equal(results[1].rows[0].worker_silent_over_two_intervals, false);
      assert.doesNotMatch(JSON.stringify(results), /\+1202555|phone_snapshot|Synthetic parts SMS request|TWILIO_AUTH_TOKEN/);
      assert.deepEqual(await f.snapshot(), before);
      await f.action('manual', target.id);
      results = await db.exec(sql);
      assert.ok(!results[0].rows.some(row => row.finding === 'unknown_requires_review'));
      assert.equal((await f.delivery(target.id)).status, 'unknown');
    });
  } finally { await db.close(); }
}
