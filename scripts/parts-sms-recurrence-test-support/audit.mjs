import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createDatabase, applyThrough, partsSmsFixtures } from '../parts-sms-test-support/fixtures.mjs';
import { recurrenceFixtures } from './fixtures.mjs';

const source = name => readFileSync(new URL(`../../supabase/audits/${name}`, import.meta.url), 'utf8');
const audit = source('0140_unsent_parts_sms_source_recurrence_verification.sql');
const historicalAudit = source('0139_bounded_parts_sms_integrity_verification.sql');

export async function verifyPartsRecurrenceAudit(check) {
  const withoutComments = audit.replace(/--[^\n]*/g, '').replace(/'(?:''|[^'])*'/g, "''");
  assert.doesNotMatch(withoutComments, /\b(insert|update|delete|truncate|alter|drop|grant|revoke)\b/i);
  const db = await createDatabase();
  try {
    await applyThrough(db, 140);
    const f = recurrenceFixtures(await partsSmsFixtures(db));
    const target = await f.begin();
    const away = await f.depart(target);
    await f.returnTo(target, away);
    const child = await f.newestChild(target);
    assert.ok(child);
    await check('clean139 filename-order install and origin-aware read-only audit accept genuine system recovery without fake staff operation', async () => {
      const before = await f.snapshot();
      const { result, old } = await db.transaction(async tx => {
        await tx.exec('set transaction read only');
        return { result: await tx.exec(audit), old: await tx.exec(historicalAudit) };
      });
      const rowsFor = field => {
        const resultSet = result.find(item => item.fields?.some(column => column.name === field));
        assert.ok(resultSet, `Required audit projection ${field}`);
        return resultSet.rows;
      };
      assert.deepEqual(rowsFor('finding'), []);
      assert.deepEqual(rowsFor('stale_recurrence_delivery_id'), []);
      assert.deepEqual(rowsFor('review_category'), []);
      assert.equal(Number(rowsFor('historical_0138_staff_operation_check_expected_system_children')[0].historical_0138_staff_operation_check_expected_system_children), 1);
      assert.deepEqual(rowsFor('grantee'), []);
      assert.ok(rowsFor('function_signature').every(row => row.pinned_safe_search_path && !row.anonymous_execute && !row.authenticated_execute));
      assert.ok(rowsFor('relname').every(row => row.relrowsecurity && row.immutable_command_guard && !row.unexpected_browser_mutation && !row.unexpected_service_raw_mutation));
      assert.equal(rowsFor('indexname').length, 4);
      assert.ok(old[0].rows.some(row => row.finding === 'child_missing_reasoned_operation' && row.sample_record_ids.includes(child.id)));
      assert.equal((await db.query('select count(*)::int count from public.p1_parts_sms_operations')).rows[0].count, 0);
      assert.deepEqual(await f.snapshot(), before);
      assert.doesNotMatch(JSON.stringify(result), /\+1202555|phone_snapshot|Synthetic parts SMS request|TWILIO_AUTH_TOKEN/);
    });

    const corruptions = [
      ['p1_parts_alert_deliveries', 'recurrence_missing_or_mismatched_proof',
        'update public.p1_parts_alert_deliveries set prior_same_generation_id=intervening_generation_id where id=$1', [child.id]],
      ['p1_parts_sms_attempt_events', 'recurrence_without_immutable_queued_evidence',
        "delete from public.p1_parts_sms_attempt_events where delivery_id=$1 and phase='source_recurrence'", [child.id]],
      ['p1_parts_sms_attempt_events', 'recurrence_after_prior_send_start',
        `insert into public.p1_parts_sms_attempt_events(delivery_id,sequence,phase,claim_token,state,created_at)
          values($1,1,'send_started',$2,'sending',$3)`, [target.id, randomUUID(), target.event.created_at]],
      ['p1_parts_alert_deliveries', 'cached_provider_reference_without_journal_proof',
        'update public.p1_parts_alert_deliveries set provider_message_id=$2,completed_at=created_at where id=$1', [target.id, `SM${randomUUID().replaceAll('-', '')}`], target.id],
      ['p1_parts_sms_operations', 'recurrence_after_daily_outcome_or_legacy',
        `insert into public.p1_parts_sms_operations(operation_id,delivery_id,action,actor_id,reason,created_at)
          values($1,$2,'manual_resolution',$3,'Synthetic historical no-send review',$4)`, [randomUUID(), target.id, f.actors.mgr, target.event.created_at]],
    ];
    for (const [table, finding, sql, values, expectedId = child.id] of corruptions) {
      await check(`read-only recurrence audit detects ${finding} and bounded safe evidence samples`, async () => {
        const before = await f.snapshot();
        await assert.rejects(db.transaction(async tx => {
          await tx.exec(`alter table public.${table} disable trigger user`);
          await tx.query(sql, values);
          await tx.exec(`alter table public.${table} enable trigger user`);
          const results = await tx.exec(audit);
          assert.ok(results[0].rows.some(row => row.finding === finding && row.sample_record_ids.includes(expectedId)), finding);
          assert.ok(results[0].rows.every(row => row.sample_record_ids.length <= 25));
          throw new Error('SYNTHETIC_AUDIT_ROLLBACK');
        }), /^Error: SYNTHETIC_AUDIT_ROLLBACK$/);
        assert.deepEqual(await f.snapshot(), before);
      });
    }
  } finally { await db.close(); }
}
