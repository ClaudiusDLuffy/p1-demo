import assert from 'node:assert/strict';
import { RESERVED_EVENTS, LIFECYCLE_FUNCTIONS } from './command-fixtures.mjs';

export async function verifyLifecycleCommands(fixture, check) {
  const { db, as, actors, workOrder, context, payloads, command, snapshot, rejection, rawDenied } = fixture;
  const positive = [
    ['standalone contractor', actors.contractor, {}],
    ['operational staff', actors.mgr, {}],
    ['company administrator', actors.admin, { owner: actors.canonical }],
    ['current report-only technician', actors.report, { owner: actors.canonical, technician: actors.report }],
    ['current invoice-capable technician', actors.invoice, { owner: actors.canonical, technician: actors.invoice }],
  ];
  for (const [name, actor, scope] of positive) {
    await check(`contracted lifecycle ${name}: ETA/correction/start/pause/resume/completion and replay`, async () => {
      const id = await workOrder(scope);
      for (const kind of ['eta', 'eta', 'start', 'pause', 'resume', 'complete']) {
        const args = await context(id);
        const payload = payloads[kind]();
        if (kind === 'eta') payload[0] = new Date(new Date(payload[0]).getTime() + args[3] * 60_000).toISOString();
        const result = await command(kind, actor, args, payload);
        assert.equal(result.applied, true);
        assert.equal(result.reason, 'applied');
        assert.equal(result.workOrderId, id);
        assert.equal(result.operationId, args[4]);
        assert.equal(Number(result.lifecycleVersion), args[3] + 1);
        const after = await snapshot(id);
        const replay = await command(kind, actor, args, payload);
        assert.equal(replay.applied, false);
        assert.equal(replay.reason, 'already_applied');
        assert.equal(replay.activityId, result.activityId);
        assert.deepEqual(await snapshot(id), after, 'Replay must not change parent, visit, parts, event or ledger');
      }
      const final = await snapshot(id);
      assert.equal(final.parent.functional_status, 'Completed');
      assert.equal(final.parent.status, 'completed');
      assert.equal(final.visits.length, 2);
      assert.ok(final.visits.every(visit => visit.check_out_at));
      assert.equal(final.parts.length, 1);
      assert.equal(final.parts[0].qty, 2);
      assert.equal(final.activities.filter(activity => activity.event_key === 'job_completed').length, 1);
      for (const event of final.activities.filter(activity => RESERVED_EVENTS.includes(activity.event_key))) {
        assert.equal(event.author_id, actor);
        assert.ok(event.lifecycle_operation_id);
        assert.equal(event.requires_7eleven_sync, event.event_key !== 'eta_updated');
      }
    });
  }

  await check('contracted raw protected fields deny every browser role while scoped notes remain writable', async () => {
    const id = await workOrder({ owner: actors.canonical, technician: actors.report });
    const standalone = await workOrder();
    const inactiveOwned = await workOrder({ owner: actors.inactiveContractor });
    const roleCases = [
      [actors.contractor, standalone], [actors.admin, id], [actors.report, id],
      [actors.invoice, id], [actors.unassigned, id], [actors.former, id],
      [actors.outsider, id], [actors.inactiveContractor, inactiveOwned],
      [actors.inactive, id], [actors.mgr, id], [actors.controller, id],
    ];
    const patches = [
      "status='completed',functional_status='Completed'",
      "status='wip',functional_status='Work in Progress'",
      "status='parts',functional_status='Awaiting Parts'",
      "eta=now()", "end_time=now(),resolution_code='Other'", "start_time=now()",
      "asset_make='Forged Make'", 'lifecycle_version=lifecycle_version+1',
    ];
    for (const [actor, target] of roleCases) for (const patch of patches) {
      await rawDenied(actor, `update public.work_orders set ${patch} where id=$1 returning id`, [target], target);
    }
    await rawDenied(null, "update public.work_orders set status='completed' where id=$1 returning id", [id], id, 'anon');
    const updated = await as('authenticated', actors.mgr, tx => tx.query(
      "update public.work_orders set summary='Synthetic editable header' where id=$1 returning summary", [id],
    ));
    assert.equal(updated.rows[0].summary, 'Synthetic editable header');
  });

  await check('contracted reserved event insert, reclassification, content update and deletion are denied', async () => {
    const id = await workOrder();
    for (const actor of [actors.contractor, actors.mgr, actors.controller]) {
      for (const eventKey of RESERVED_EVENTS) await rejection(() => as('authenticated', actor, tx => tx.query(`
        insert into public.activities(work_order_id,author_id,author_name,text,type,event_key)
        values ($1,$2,'Synthetic impostor','Forged lifecycle','note',$3)
      `, [id, actor, eventKey])), ['42501']);
    }
    const started = await command('start', actors.contractor, await context(id));
    for (const actor of [actors.contractor, actors.mgr]) {
      for (const patch of ["text='Altered evidence'", 'deleted_at=now()', "event_key='note'", "author_name='Impostor'"]) {
        await rawDenied(actor, `update public.activities set ${patch} where id=$1 returning id`, [started.activityId], id);
      }
      await rawDenied(actor, 'delete from public.activities where id=$1 returning id', [started.activityId], id);
    }
    const ordinary = (await as('authenticated', actors.contractor, tx => tx.query(`
      insert into public.activities(work_order_id,author_id,author_name,text,type,event_key,activity_channel)
      values ($1,$2,'Synthetic caller','Ordinary note','note','note','contractor_message') returning id
    `, [id, actors.contractor]))).rows[0];
    for (const eventKey of RESERVED_EVENTS) await rawDenied(actors.mgr,
      'update public.activities set event_key=$2 where id=$1 returning id', [ordinary.id, eventKey], id);
  });

  await check('contracted ordinary field/internal/contractor messages retain channel visibility and identity', async () => {
    const id = await workOrder();
    for (const [actor, channel] of [[actors.contractor, 'field_note'], [actors.contractor, 'contractor_message'], [actors.mgr, 'internal_note'], [actors.mgr, 'contractor_message']]) {
      const event = (await as('authenticated', actor, tx => tx.query(`
        insert into public.activities(work_order_id,author_id,author_name,text,type,event_key,activity_channel)
        values ($1,$2,'Caller-controlled display name','Synthetic ordinary communication','note','note',$3)
        returning id,activity_channel,is_staff_only,requires_7eleven_sync,author_name
      `, [id, actor, channel]))).rows[0];
      assert.equal(event.activity_channel, channel);
      assert.equal(event.requires_7eleven_sync, channel === 'field_note');
      assert.equal(event.is_staff_only, channel === 'internal_note');
      assert.notEqual(event.author_name, 'Caller-controlled display name');
      const visible = await as('authenticated', actors.contractor, tx => tx.query('select id from public.activities where id=$1', [event.id]));
      assert.equal(visible.rows.length, channel === 'internal_note' ? 0 : 1);
      for (const [column, value] of [['author_id', actors.outsider], ['author_name', 'Synthetic impostor'], ['entered_by_role', 'system']]) {
        await rawDenied(actor, `update public.activities set ${column}=$2 where id=$1 returning id`, [event.id, value], id);
      }
      const edited = await as('authenticated', actor, tx => tx.query(
        'update public.activities set text=$2 where id=$1 returning text', [event.id, 'Synthetic edited communication'],
      ));
      assert.equal(edited.rows[0].text, 'Synthetic edited communication');
      const deleted = await as('authenticated', actor, tx => tx.query(
        'update public.activities set deleted_at=now() where id=$1 returning deleted_at', [event.id],
      ));
      assert.ok(deleted.rows[0].deleted_at, 'Ordinary communication retains supported soft deletion');
    }
    await rejection(() => as('authenticated', actors.contractor, tx => tx.query(`
      insert into public.activities(work_order_id,author_id,author_name,text,type,event_key,activity_channel)
      values ($1,$2,'Synthetic caller','Unauthorized internal note','note','note','internal_note')
    `, [id, actors.contractor])), ['42501']);
  });

  await check('contracted command role matrix denies anonymous/inactive/controller/cross-company/former actors', async () => {
    for (const kind of Object.keys(LIFECYCLE_FUNCTIONS)) {
      const options = kind === 'resume'
        ? { status: 'parts', functional: 'Awaiting Parts' }
        : ['pause', 'complete'].includes(kind)
          ? { status: 'wip', functional: 'Work in Progress', visit: true }
          : {};
      const id = await workOrder({ ...options, owner: actors.canonical, technician: actors.report });
      await db.query(`insert into public.work_order_technician_assignments(work_order_id,technician_profile_id,assigned_at,ended_at)
        values ($1,$2,now()-interval '2 days',now()-interval '1 day')`, [id, actors.former]);
      const before = await snapshot(id);
      const args = await context(id);
      for (const actor of [actors.controller, actors.inactive, actors.inactiveContractor, actors.outsider, actors.contractor, actors.unassigned, actors.former, actors.invoice]) {
        await rejection(() => command(kind, actor, args), ['42501']);
        assert.deepEqual(await snapshot(id), before);
      }
      await rejection(() => command(kind, null, args, payloads[kind](), 'anon'), ['42501']);
    }
  });

  await check('contracted stale assignment/cycle/version and invalid transitions never partially commit', async () => {
    const id = await workOrder();
    const args = await context(id);
    const before = await snapshot(id);
    for (const index of [1, 2, 3]) {
      const stale = [...args]; stale[index] += 1;
      await rejection(() => command('eta', actors.contractor, stale), ['PT409']);
      assert.deepEqual(await snapshot(id), before);
    }
    for (const kind of ['pause', 'resume', 'complete']) {
      await rejection(() => command(kind, actors.contractor, args), ['PT409', '23514']);
      assert.deepEqual(await snapshot(id), before);
    }
    await rejection(() => command('eta', actors.contractor, args, [null]), ['22023']);
    await rejection(() => command('eta', actors.contractor, args, ['not-a-date']), ['22007']);
    await command('eta', actors.contractor, args);
    const currentArgs = await context(id);
    await rejection(() => command('start', actors.contractor, [...args.slice(0, 4), currentArgs[4]]), ['PT409']);
  });

  await check('contracted operation UUID cannot be reused for changed payload, target or command family', async () => {
    const id = await workOrder();
    const args = await context(id);
    await command('eta', actors.contractor, args);
    const after = await snapshot(id);
    await rejection(() => command('eta', actors.contractor, args, [new Date(Date.now() + 240_000).toISOString()]), ['PT409', '22023']);
    await rejection(() => command('start', actors.contractor, args), ['PT409', '22023']);
    await rejection(() => command('eta', actors.mgr, args), ['PT409', '42501']);
    const other = await workOrder();
    const otherArgs = await context(other, args[4]);
    await rejection(() => command('eta', actors.contractor, otherArgs), ['PT409', '22023']);
    assert.deepEqual(await snapshot(id), after);
  });

  await check('company administrator cannot manipulate target identity and inactive assigned technicians fail closed', async () => {
    const other = await workOrder();
    const otherArgs = await context(other);
    await rejection(() => command('start', actors.admin, otherArgs), ['42501']);
    const own = await workOrder({ owner: actors.canonical, technician: actors.report });
    const args = await context(own);
    const before = await snapshot(own);
    await db.query('update public.profiles set active=false where id=$1', [actors.report]);
    try {
      await rejection(() => command('start', actors.report, args), ['42501']);
      await rawDenied(actors.report, "update public.work_orders set status='completed',functional_status='Completed' where id=$1 returning id", [own], own);
    } finally {
      await db.query('update public.profiles set active=true where id=$1', [actors.report]);
    }
    assert.deepEqual(await snapshot(own), before);
  });

  await check('contracted duplicate starts are rejected and advanced invoice status survives completion', async () => {
    const id = await workOrder();
    await command('start', actors.contractor, await context(id));
    const started = await snapshot(id);
    const duplicateArgs = await context(id);
    await rejection(() => command('start', actors.contractor, duplicateArgs), ['PT409', '22023', '23514']);
    assert.deepEqual(await snapshot(id), started);
    for (const status of ['pending_invoice', 'pending_approval', 'pending_payment']) {
      const target = await workOrder({ status, functional: 'Work in Progress', visit: true });
      const result = await command('complete', actors.contractor, await context(target));
      assert.equal(result.workOrderStatus, status);
      const row = await snapshot(target);
      assert.equal(row.parent.functional_status, 'Completed');
      assert.equal(row.visits.filter(visit => !visit.check_out_at).length, 0);
    }
  });

  await check('historical advanced-invoice completion eligibility remains status-based without inventing a visit requirement', async () => {
    // Preserve 0113 behavior. Authority of raw financial queue promotion is
    // explicitly deferred to DB-003/Batch 1C; this is not a start-policy proof.
    for (const status of ['pending_invoice', 'pending_approval', 'pending_payment']) {
      const id = await workOrder({ status, functional: 'Dispatched' });
      const result = await command('complete', actors.contractor, await context(id));
      assert.equal(result.applied, true);
      assert.equal(result.workOrderStatus, status);
      const final = await snapshot(id);
      assert.equal(final.parent.functional_status, 'Completed');
      assert.equal(final.visits.length, 0);
    }
  });
}
