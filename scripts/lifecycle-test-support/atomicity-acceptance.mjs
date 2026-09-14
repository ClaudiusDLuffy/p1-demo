import assert from 'node:assert/strict';

// Test-only failure triggers are installed only in the in-memory engine and
// always dropped. No production function receives a debug/failure parameter.
export async function verifyLifecycleAtomicity(fixture, check) {
  const { db, actors, workOrder, context, command, snapshot, rejection, time } = fixture;
  const steps = {
    eta: [['work_orders', 'update'], ['activities', 'insert']],
    start: [['work_orders', 'update'], ['work_order_visits', 'insert'], ['activities', 'insert']],
    pause: [['work_orders', 'update'], ['work_order_visits', 'update'], ['wo_parts', 'insert'], ['activities', 'insert']],
    complete: [['work_orders', 'update'], ['work_order_visits', 'update'], ['activities', 'insert']],
  };
  for (const [kind, writes] of Object.entries(steps)) {
    for (const [table, operation] of writes) {
      await check(`atomic ${kind}: failure after ${table} ${operation} rolls back every write`, async () => {
        const id = await workOrder(['pause', 'complete'].includes(kind)
          ? { status: 'wip', functional: 'Work in Progress', visit: true }
          : {});
        const args = await context(id);
        const before = await snapshot(id);
        await db.exec(`create or replace function pg_temp.reject_lifecycle_fixture_write()
          returns trigger language plpgsql as $$ begin
            raise exception 'Synthetic post-write failure' using errcode='P0001';
          end $$;
          create trigger lifecycle_fixture_fail after ${operation} on public.${table}
            for each row execute function pg_temp.reject_lifecycle_fixture_write();`);
        try {
          await rejection(() => command(kind, actors.contractor, args), ['P0001']);
          assert.deepEqual(await snapshot(id), before, 'Injected failure must roll back all parent/related/ledger rows');
        } finally {
          await db.exec(`drop trigger lifecycle_fixture_fail on public.${table}`);
        }
        assert.equal((await command(kind, actors.contractor, args)).applied, true,
          'The same operation must work after a fully rolled-back failure');
      });
    }
  }

  await check('pause validation rejects missing reason, invalid parts and impossible visit timing atomically', async () => {
    const id = await workOrder({ status: 'wip', functional: 'Work in Progress', visit: true });
    const before = await snapshot(id);
    const args = await context(id);
    for (const payload of [
      [time.pause, '', '[]', '', null, null],
      [time.pause, 'Awaiting parts', '[]', '', null, null],
      [time.pause, 'Awaiting parts', '[{"description":"","qty":1}]', '', null, null],
      [time.pause, 'Awaiting parts', '[{"description":"Synthetic part","qty":-1}]', '', null, null],
      [time.pause, 'Awaiting parts', '{"not":"an array"}', '', null, null],
      [new Date(new Date(time.start).getTime() - 60_000).toISOString(), 'Temporary fix', '[]', '', null, null],
    ]) {
      await rejection(() => command('pause', actors.contractor, args, payload), ['22023', '23514', 'PT409']);
      assert.deepEqual(await snapshot(id), before);
    }
    const temporary = await command('pause', actors.contractor, args, [time.pause, 'Temporary fix', '[]', 'Synthetic temporary repair', null, null]);
    assert.equal(temporary.applied, true);
    assert.equal((await snapshot(id)).parts.length, 0);
  });

  await check('completion required asset fields reject missing input with no parent/visit/evidence writes', async () => {
    const id = await workOrder({ status: 'wip', functional: 'Work in Progress', visit: true });
    const before = await snapshot(id);
    const args = await context(id);
    for (const index of [1, 2, 3]) {
      const payload = [time.complete, 'Fixture Make', 'Fixture Model', 'Fixture Serial', null, null, null];
      payload[index] = ' ';
      await rejection(() => command('complete', actors.contractor, args, payload), ['22023']);
      assert.deepEqual(await snapshot(id), before);
    }
  });

  await check('inconsistent authoritative completion cannot produce false successful replay', async () => {
    const id = await workOrder({ status: 'wip', functional: 'Work in Progress', visit: true });
    const args = await context(id);
    await command('complete', actors.contractor, args);
    // This simulates legacy/admin corruption using the isolated database owner,
    // not a browser privilege. It is intentionally left visible to the anomaly
    // audit until the surrounding savepoint rolls back.
    const rollback = new Error('Rollback inconsistent replay fixture');
    await assert.rejects(() => db.transaction(async tx => {
      await tx.query("update public.work_orders set end_time=null where id=$1", [id]);
      const before = (await tx.query('select to_jsonb(w) value from public.work_orders w where id=$1', [id])).rows[0].value;
      await tx.exec('savepoint replay_denial');
      await tx.exec('set local role authenticated');
      await tx.query("select set_config('request.jwt.claim.role','authenticated',true),set_config('request.jwt.claim.sub',$1,true)", [actors.contractor]);
      await rejection(() => fixture.query(tx, 'complete', args), ['PT409']);
      await tx.exec('rollback to savepoint replay_denial');
      assert.deepEqual((await tx.query('select to_jsonb(w) value from public.work_orders w where id=$1', [id])).rows[0].value, before);
      throw rollback;
    }), error => error === rollback);
  });

  await check('legacy caller-forged completion event does not suppress real authoritative completion', async () => {
    const id = await workOrder({ status: 'wip', functional: 'Work in Progress', visit: true });
    await db.query(`insert into public.activities(work_order_id,author_id,author_name,text,type,event_key)
      values ($1,$2,'Synthetic legacy caller','Legacy forged completion fixture','note','job_completed')`, [id, actors.contractor]);
    const result = await command('complete', actors.contractor, await context(id));
    assert.equal(result.applied, true);
    const final = await snapshot(id);
    assert.equal(final.parent.functional_status, 'Completed');
    assert.equal(final.visits.filter(visit => !visit.check_out_at).length, 0);
    assert.equal(final.activities.filter(activity => activity.event_key === 'job_completed' && activity.lifecycle_operation_id).length, 1);
    assert.equal(final.activities.filter(activity => activity.event_key === 'job_completed' && !activity.lifecycle_operation_id).length, 1,
      'Historical evidence must remain unmodified rather than silently repaired');
  });

  await check('pause replay checks required structured parts and cannot hide deletion or changed quantities', async () => {
    const id = await workOrder({ status: 'wip', functional: 'Work in Progress', visit: true });
    const args = await context(id);
    await command('pause', actors.contractor, args);
    for (const mutation of [
      'delete from public.wo_parts where work_order_id=$1',
      'update public.wo_parts set qty=qty+1 where work_order_id=$1',
    ]) {
      const rollback = new Error('Rollback structured-parts inconsistency fixture');
      await assert.rejects(() => db.transaction(async tx => {
        await tx.query(mutation, [id]);
        await tx.exec('savepoint replay_denial');
        await tx.exec('set local role authenticated');
        await tx.query("select set_config('request.jwt.claim.role','authenticated',true),set_config('request.jwt.claim.sub',$1,true)", [actors.contractor]);
        await rejection(() => fixture.query(tx, 'pause', args), ['PT409']);
        await tx.exec('rollback to savepoint replay_denial');
        throw rollback;
      }), error => error === rollback);
    }
    assert.equal((await command('pause', actors.contractor, args)).reason, 'already_applied');
  });
}
