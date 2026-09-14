import assert from 'node:assert/strict';

// Execute these only against the committed 0001–0121 upgrade baseline. They
// establish the original failures, not acceptance of the post-cutover policy.
// Every fixture is rolled back so later upgrade and anomaly checks see no
// intentionally inconsistent historical records.
export async function reproduceLegacyLifecycleFindings({ db, check, contractor }) {
  async function rolledBackFixture(workOrderId, status, functionalStatus, inspect) {
    const rollback = new Error('Expected rollback of synthetic legacy reproduction');
    await assert.rejects(() => db.transaction(async tx => {
      await tx.query(`
        insert into public.work_orders (
          id, status, functional_status, contractor_id,
          contractor_assignment_started_at, start_time
        ) values ($1, $2::public.wo_status, $3, $4,
          now() - interval '1 day',
          case when $2 = 'wip' then now() - interval '1 hour' else null end)
      `, [workOrderId, status, functionalStatus, contractor]);
      await tx.exec('set local role authenticated');
      await tx.query(`
        select set_config('request.jwt.claim.role', 'authenticated', true),
          set_config('request.jwt.claim.sub', $1, true)
      `, [contractor]);
      await inspect(tx);
      throw rollback;
    }), error => error === rollback);
    assert.equal((await db.query(
      'select count(*)::int count from public.work_orders where id = $1',
      [workOrderId],
    )).rows[0].count, 0, 'Legacy reproduction must leave no fixture behind');
  }

  await check('BASELINE DB-001 reproduces assigned-contractor direct completion without evidence', async () => {
    await rolledBackFixture('WOT9100001', 'assigned', 'Dispatched', async tx => {
      const result = await tx.query(`
        update public.work_orders
        set status = 'completed', functional_status = 'Completed'
        where id = 'WOT9100001'
        returning status, functional_status, end_time, asset_make, asset_model, asset_serial
      `);
      assert.deepEqual(result.rows, [{
        status: 'completed',
        functional_status: 'Completed',
        end_time: null,
        asset_make: null,
        asset_model: null,
        asset_serial: null,
      }]);
      const related = (await tx.query(`
        select
          (select count(*)::int from public.work_order_visits
            where work_order_id = 'WOT9100001') as visits,
          (select count(*)::int from public.activities
            where work_order_id = 'WOT9100001' and event_key = 'job_completed') as completions
      `)).rows[0];
      assert.deepEqual(related, { visits: 0, completions: 0 });
    });
  });

  await check('BASELINE SEC-001 reproduces forged completion preplay suppressing the real command', async () => {
    await rolledBackFixture('WOT9100002', 'wip', 'Work in Progress', async tx => {
      await tx.query(`
        insert into public.work_order_visits (
          work_order_id, contractor_id, checked_in_by, check_in_at
        ) values ('WOT9100002', $1, $1, now() - interval '30 minutes')
      `, [contractor]);
      const forged = (await tx.query(`
        insert into public.activities (
          work_order_id, author_id, author_name, text, type, event_key
        ) values ('WOT9100002', $1, 'Synthetic forged display identity',
          'Synthetic caller-precreated completion', 'note', 'job_completed')
        returning id, author_name, activity_channel, requires_7eleven_sync
      `, [contractor])).rows[0];
      assert.equal(forged.author_name, 'Synthetic forged display identity');
      assert.equal(forged.activity_channel, 'field_note');
      assert.equal(forged.requires_7eleven_sync, true);
      const completion = (await tx.query(`
        select public.complete_work_order_once(
          'WOT9100002', now(), 'Fixture Make', 'Fixture Model', 'Fixture Serial',
          2020, 'Current Asset Repaired', 'Synthetic completion notes',
          'Synthetic legitimate completion'
        ) as result
      `)).rows[0].result;
      assert.equal(completion.applied, false);
      assert.equal(completion.reason, 'already_completed');
      assert.equal(completion.activityId, forged.id);
      const parent = (await tx.query(`
        select status, functional_status, end_time from public.work_orders
        where id = 'WOT9100002'
      `)).rows[0];
      assert.deepEqual(parent, {
        status: 'wip', functional_status: 'Work in Progress', end_time: null,
      });
      assert.equal((await tx.query(`
        select count(*)::int count from public.work_order_visits
        where work_order_id = 'WOT9100002' and check_out_at is null
      `)).rows[0].count, 1);
    });
  });

  for (const [index, eventKey] of ['check_in', 'check_out', 'job_paused', 'eta_updated'].entries()) {
    await check(`BASELINE SEC-001 reproduces caller-created ${eventKey} evidence`, async () => {
      const workOrderId = `WOT910001${index}`;
      await rolledBackFixture(workOrderId, 'wip', 'Work in Progress', async tx => {
        const event = (await tx.query(`
          insert into public.activities (
            work_order_id, author_id, author_name, text, type, event_key
          ) values ($1, $2, 'Synthetic caller', 'Synthetic forged lifecycle event', 'note', $3)
          returning id, activity_channel, requires_7eleven_sync
        `, [workOrderId, contractor, eventKey])).rows[0];
        assert.ok(event.id);
        assert.equal(event.requires_7eleven_sync, eventKey !== 'eta_updated');
        const edited = await tx.query(`
          update public.activities set text = 'Synthetic altered lifecycle evidence'
          where id = $1 returning id
        `, [event.id]);
        assert.equal(edited.rows.length, 1);
        const deleted = await tx.query(`
          update public.activities set deleted_at = now()
          where id = $1 returning deleted_at is not null as deleted
        `, [event.id]);
        assert.equal(deleted.rows[0].deleted, true);
      });
    });
  }
}
