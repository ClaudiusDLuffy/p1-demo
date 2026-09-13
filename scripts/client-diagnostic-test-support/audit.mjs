import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { bucketTable, guardTable } from './fixtures.mjs';

const sql = readFileSync(new URL('../../supabase/audits/0140_bounded_client_diagnostic_admission_verification.sql', import.meta.url), 'utf8');

export async function verifyDiagnosticAudit(f, check) {
  await check('diagnostic audit executes under actual READ ONLY and returns no sensitive bucket keys', async () => {
    const before = await f.snapshot();
    const results = await f.db.transaction(async tx => {
      await tx.exec('set transaction read only');
      return tx.exec(sql);
    });
    assert.equal(results.length, 5);
    assert.deepEqual(results[0].rows, []);
    assert.equal(results[1].rows.length, 6);
    for (const row of results[1].rows) {
      assert.equal(row.rls_enabled, true);
      assert.equal(row.unexpected_raw_privilege, false);
      assert.equal(row.public_privilege, false);
    }
    assert.equal(results[2].rows.length, 3);
    for (const row of results[2].rows) {
      assert.equal(row.security_definer, true);
      assert.equal(row.pinned_safe_search_path, true);
      assert.equal(row.public_execute, false);
      assert.equal(row.anonymous_execute, false);
      assert.equal(row.authenticated_execute, false);
      assert.equal(row.service_execute, row.function_signature.includes('consume_client_diagnostic'));
    }
    for (const value of Object.values(results[3].rows[0])) assert.equal(value, true);
    const encoded = JSON.stringify(results.map(result => result.rows));
    assert.equal(encoded.includes('profile:'), false);
    for (const id of Object.values(f.actors)) assert.equal(encoded.includes(id), false);
    assert.deepEqual(await f.snapshot(), before);
  });
  await check('diagnostic read-only audit exposes future-window and leaked-capability fixture corruption', async () => {
    const before = await f.snapshot();
    await f.db.exec('begin');
    try {
      await f.db.exec(`alter table public.${bucketTable} disable trigger user;
        update public.${bucketTable} set window_started_at=clock_timestamp()+interval '1 day' where bucket_key='global';
        alter table public.${bucketTable} enable trigger user;
        insert into public.${guardTable} values(txid_current(),'${bucketTable}','global');`);
      const results = await f.db.exec(sql);
      assert.deepEqual(results[0].rows.map(row => row.finding), ['lingering_transaction_capability', 'noncanonical_or_future_window']);
    } finally { await f.db.exec('rollback'); }
    assert.deepEqual(await f.snapshot(), before);
  });
  await check('diagnostic audit detects grant drift without admitting requests or resetting windows', async () => {
    const before = await f.snapshot();
    await f.db.exec('begin');
    try {
      await f.db.exec(`grant update on public.${bucketTable} to authenticated`);
      const results = await f.db.exec(sql);
      assert.equal(results[1].rows.find(row => row.relation_name === bucketTable && row.role_name === 'authenticated').unexpected_raw_privilege, true);
    } finally { await f.db.exec('rollback'); }
    assert.deepEqual(await f.snapshot(), before);
  });
}
