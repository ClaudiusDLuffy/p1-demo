import assert from 'node:assert/strict';

// These are deterministic interleavings and stale-token checks, not genuine
// concurrent sessions. PGlite's single connection cannot certify lock races.
export async function verifyLifecycleInterleavings(fixture, check) {
  const { db, as, actors, workOrder, context, command, snapshot, rejection, rawDenied, time } = fixture;
  await check('private capability cannot be inserted or replaced by a caller-set session setting', async () => {
    const id = await workOrder();
    await rejection(() => as('authenticated', actors.contractor, tx => tx.query(`
      insert into public.work_order_lifecycle_transition_guards(
        transaction_id,work_order_id,actor_id,command_kind,parent_allowed,visit_allowed,event_key)
      values (txid_current(),$1,$2,'complete',true,true,'job_completed')`, [id, actors.contractor])), ['42501']);
    const before = await snapshot(id);
    await rejection(() => as('authenticated', actors.contractor, async tx => {
      await tx.exec("select set_config('p1.lifecycle_command','true',true),set_config('app.lifecycle_authorized','true',true)");
      return tx.query("update public.work_orders set status='completed',functional_status='Completed' where id=$1", [id]);
    }), ['42501']);
    assert.deepEqual(await snapshot(id), before);
  });

  await check('cleared JWT settings do not turn an authenticated SQL role into trusted maintenance', async () => {
    const id = await workOrder();
    const before = await snapshot(id);
    const result = await as('authenticated', actors.contractor, async tx => {
      await tx.exec("select set_config('request.jwt.claim.role','',true),set_config('request.jwt.claim.sub','',true)");
      return tx.query("update public.work_orders set status='completed',functional_status='Completed' where id=$1 returning id", [id]);
    });
    assert.equal(result.rows.length, 0, 'Without a user identity RLS must expose no mutable target');
    await rejection(() => as('authenticated', actors.contractor, async tx => {
      await tx.exec("select set_config('request.jwt.claim.role','',true)");
      return tx.query("update public.work_orders set status='completed',functional_status='Completed' where id=$1", [id]);
    }), ['42501']);
    assert.deepEqual(await snapshot(id), before);
  });

  await check('successful command capability cannot leak to another work order or subsequent raw write', async () => {
    const id = await workOrder();
    const other = await workOrder();
    const args = await context(id);
    const before = await snapshot(id);
    const otherBefore = await snapshot(other);
    await rejection(() => as('authenticated', actors.contractor, async tx => {
      await fixture.query(tx, 'start', args);
      return tx.query("update public.work_orders set status='completed',functional_status='Completed' where id=$1", [other]);
    }), ['42501']);
    assert.deepEqual(await snapshot(id), before, 'Caller transaction also rolls back its earlier valid command');
    assert.deepEqual(await snapshot(other), otherBefore);
  });

  await check('contracted direct visit creation/closure/deletion cannot contradict authoritative parent state', async () => {
    const id = await workOrder();
    for (const actor of [actors.contractor, actors.mgr]) await rejection(() => as('authenticated', actor, tx => tx.query(`
      insert into public.work_order_visits(work_order_id,contractor_id,checked_in_by,check_in_at)
      values ($1,$2,$3,$4)`, [id, actors.contractor, actor, time.start])), ['42501']);
    const result = await command('start', actors.contractor, await context(id));
    for (const actor of [actors.contractor, actors.mgr]) {
      await rawDenied(actor, 'update public.work_order_visits set check_out_at=$2,checked_out_by=$3 where id=$1 returning id',
        [result.visitId, time.pause, actor], id);
      await rawDenied(actor, 'delete from public.work_order_visits where id=$1 returning id', [result.visitId], id);
    }
  });

  await check('reassignment invalidates prior command tokens and former actor without losing outgoing notice', async () => {
    const id = await workOrder();
    await command('start', actors.contractor, await context(id));
    const oldContext = await context(id);
    // 0129's approved hybrid policy requires a real checkout before an ordinary
    // transfer. Keep this positive control valid both before and after 0129;
    // the assignment harness separately proves active-visit denial/override.
    await command('pause', actors.contractor, await context(id));
    const reassigned = (await as('authenticated', actors.mgr, tx => tx.query(
      'select public.transition_work_order_contractor($1,$2,$3) result', [id, actors.outsider, oldContext[1]],
    ))).rows[0].result;
    assert.equal(reassigned.applied, true);
    assert.ok(reassigned.deliveryId, 'Existing outgoing contractor notification must remain queued');
    const after = await snapshot(id);
    await rejection(() => command('complete', actors.contractor, oldContext), ['42501', 'PT409']);
    await rejection(() => command('complete', actors.mgr, oldContext), ['PT409']);
    assert.deepEqual(await snapshot(id), after);
    assert.equal(after.parent.contractor_id, actors.outsider);
  });

  await check('invoice status advancement makes stale completion conflict and fresh completion preserves queue', async () => {
    const id = await workOrder({ status: 'wip', functional: 'Work in Progress', visit: true });
    const oldContext = await context(id);
    // Controlled owner fixture simulates the existing separate invoice writer.
    // Batch 1C is responsible for that writer's financial authority.
    await db.query("update public.work_orders set status='pending_approval' where id=$1", [id]);
    const afterAdvancement = await snapshot(id);
    await rejection(() => command('complete', actors.contractor, oldContext), ['PT409']);
    assert.deepEqual(await snapshot(id), afterAdvancement);
    const completed = await command('complete', actors.contractor, await context(id));
    assert.equal(completed.workOrderStatus, 'pending_approval');
  });

  await check('technician reassignment invalidates a stale company-administrator lifecycle command', async () => {
    const id = await workOrder({ owner: actors.canonical, technician: actors.report });
    const stale = await context(id);
    await as('authenticated', actors.admin, tx => tx.query('select public.assign_contractor_technician($1,$2)', [id, actors.invoice]));
    const changed = await snapshot(id);
    assert.ok(Number(changed.parent.lifecycle_version) > stale[3]);
    await rejection(() => command('start', actors.admin, stale), ['PT409']);
    assert.deepEqual(await snapshot(id), changed);
    assert.equal((await command('start', actors.invoice, await context(id))).applied, true);
  });

  await check('7-Eleven synchronization uses a narrow staff command without rewriting lifecycle evidence', async () => {
    const id = await workOrder();
    const started = await command('start', actors.contractor, await context(id));
    await rawDenied(actors.mgr, 'update public.activities set synced_to_7eleven_at=now() where id=$1 returning id', [started.activityId], id);
    for (const actor of [actors.contractor, actors.outsider, actors.inactive]) await rejection(
      () => as('authenticated', actor, tx => tx.query('select public.mark_work_order_activity_synced_v1($1,true)', [started.activityId])), ['42501']);
    const before = (await snapshot(id)).activities.find(activity => activity.id === started.activityId);
    await as('authenticated', actors.mgr, tx => tx.query('select public.mark_work_order_activity_synced_v1($1,true)', [started.activityId]));
    const after = (await snapshot(id)).activities.find(activity => activity.id === started.activityId);
    assert.ok(after.synced_to_7eleven_at);
    assert.equal(after.synced_to_7eleven_by, actors.mgr);
    for (const key of ['event_key', 'text', 'author_id', 'author_name', 'lifecycle_operation_id', 'lifecycle_version']) {
      assert.deepEqual(after[key], before[key]);
    }
  });

  await check('staff contractor-attention and contractor acknowledgement preserve owned lifecycle evidence', async () => {
    const id = await workOrder();
    const started = await command('start', actors.mgr, await context(id));
    await as('authenticated', actors.mgr, tx => tx.query('select public.set_activity_contractor_attention($1,true)', [started.activityId]));
    await rejection(() => as('authenticated', actors.outsider, tx => tx.query('select public.acknowledge_contractor_attention($1)', [started.activityId])), ['42501']);
    await as('authenticated', actors.contractor, tx => tx.query('select public.acknowledge_contractor_attention($1)', [started.activityId]));
    const event = (await snapshot(id)).activities.find(activity => activity.id === started.activityId);
    assert.equal(event.event_key, 'check_in');
    assert.equal(event.author_id, actors.mgr);
    assert.ok(event.contractor_attention_acknowledged_at);
    assert.equal(event.contractor_attention_acknowledged_by, actors.contractor);
  });

  await check('capital flag and decline retain their operational behavior through guarded compatibility paths', async () => {
    const id = await workOrder();
    const args = await context(id);
    const flagged = (await as('authenticated', actors.mgr, tx => tx.query('select public.flag_work_order_capital_v1($1,$2,$3,$4) result', args.slice(0, 4)))).rows[0].result;
    assert.equal(flagged.status, 'capital');
    const capital = await snapshot(id);
    assert.equal(capital.parent.is_capital, true);
    const declined = (await as('authenticated', actors.mgr, tx => tx.query('select public.decline_capital_work_order($1,$2) result', [id, capital.parent.contractor_assignment_version]))).rows[0].result;
    assert.equal(declined.status, 'assigned');
  });

  await check('post-contraction priority escalation and DO NOT DISPATCH refresh preserve provenance and atomic state', async () => {
    const id = await workOrder();
    await db.query("update public.work_orders set priority='p4',sla_started_at='2026-09-01T00:00:00Z' where id=$1", [id]);
    const args = [id, 'p1', '<synthetic-contracted-priority@example.invalid>', '2026-09-08T12:00:00Z',
      `7-Eleven Priority P1 Work Order ${id} has been updated.`, '2026-09-01T00:00:00Z',
      '2026-09-01T04:00:00Z', '2026-09-02T00:00:00Z'];
    const query = (tx, values, patch) => tx.query('select public.refresh_email_work_order_dispatch($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) result', [...values, patch, null]);
    const first = (await as('service_role', null, tx => query(tx, args, { summary: 'Synthetic refreshed summary' }))).rows[0].result;
    assert.equal(first.applied, true);
    assert.equal(first.metadataRefreshed, true);
    const replay = (await as('service_role', null, tx => query(tx, args, { summary: 'Must not overwrite replay' }))).rows[0].result;
    assert.equal(replay.replayed, true);
    const row = (await snapshot(id)).parent;
    assert.equal(row.priority, 'p1');
    assert.equal(row.summary, 'Synthetic refreshed summary');
    const billingOnlyId = await workOrder();
    await db.query("update public.work_orders set priority='p4' where id=$1", [billingOnlyId]);
    const dndArgs = [billingOnlyId, 'p4', '<synthetic-contracted-dnd@example.invalid>', '2026-09-08T13:00:00Z',
      '7-Eleven Priority P4 DO NOT DISPATCH', null, null, null];
    await as('service_role', null, tx => query(tx, dndArgs, {
      summary: 'DO NOT DISPATCH synthetic fixture', billing_only: true,
      status: 'pending_invoice', functional_status: 'Completed', contractor_id: null,
    }));
    const dnd = (await snapshot(billingOnlyId)).parent;
    assert.equal(dnd.status, 'pending_invoice');
    assert.equal(dnd.functional_status, 'Completed');
    assert.equal(dnd.contractor_id, null);
    assert.equal(dnd.billing_only, true);
  });

  await check('capital-pending intake keeps its exact parent changes behind a service-only command', async () => {
    const id = await workOrder();
    const before = await snapshot(id);
    for (const [role, actor] of [['anon', null], ['authenticated', actors.contractor], ['authenticated', actors.mgr]]) {
      await rejection(() => as(role, actor, tx => tx.query('select public.record_email_capital_pending_v1($1)', [id])), ['42501']);
    }
    await db.exec(`create or replace function pg_temp.reject_capital_activity_fixture()
      returns trigger language plpgsql as $$ begin
        raise exception 'Synthetic capital activity failure' using errcode='P0001';
      end $$;
      create trigger lifecycle_capital_fixture_fail after insert on public.activities
        for each row execute function pg_temp.reject_capital_activity_fixture();`);
    try {
      await rejection(() => as('service_role', null, tx => tx.query('select public.record_email_capital_pending_v1($1)', [id])), ['P0001']);
      assert.deepEqual(await snapshot(id), before, 'Capital event failure must roll back its parent update');
      assert.equal((await db.query('select count(*)::int count from public.work_order_lifecycle_transition_guards')).rows[0].count, 0);
    } finally {
      await db.exec('drop trigger lifecycle_capital_fixture_fail on public.activities');
    }
    await as('service_role', null, tx => tx.query('select public.record_email_capital_pending_v1($1)', [id]));
    const after = await snapshot(id);
    assert.equal(after.parent.status, 'capital');
    assert.equal(after.parent.is_capital, true);
    for (const key of ['priority', 'sla_started_at', 'response_breach_at', 'resolution_breach_at', 'contractor_id', 'functional_status']) {
      assert.deepEqual(after.parent[key], before.parent[key], `Intake capital marker must not change ${key}`);
    }
    assert.equal(after.activities.length, before.activities.length + 1);
  });

  await check('REVIEW GATE: legacy capital intake can still move a closed order to capital without a reopen event', async () => {
    const id = await workOrder();
    await command('start', actors.contractor, await context(id));
    await command('complete', actors.contractor, await context(id));
    for (const activity of (await snapshot(id)).activities.filter(row => row.requires_7eleven_sync)) {
      await as('authenticated', actors.mgr, tx => tx.query(
        'select public.mark_work_order_activity_synced_v1($1,true)', [activity.id],
      ));
    }
    const row = (await db.query(`select workflow_cycle,contractor_assignment_version,updated_at::text
      from public.work_orders where id=$1`, [id])).rows[0];
    await as('authenticated', actors.mgr, tx => tx.query(
      'select public.close_work_order_without_invoice($1,$2,$3,$4)',
      [id, row.workflow_cycle, row.contractor_assignment_version, row.updated_at],
    ));
    const closed = await snapshot(id);
    assert.equal(closed.parent.status, 'closed');
    // Characterizes an existing trusted intake rule, not an accepted lifecycle
    // closure invariant. Release owner must review this deferred policy before
    // promotion; this scoped batch must not silently invent a capital rule.
    await as('service_role', null, tx => tx.query('select public.record_email_capital_pending_v1($1)', [id]));
    const capital = await snapshot(id);
    assert.equal(capital.parent.status, 'capital');
    assert.equal(capital.parent.functional_status, closed.parent.functional_status);
    assert.equal(capital.parent.closed_at, closed.parent.closed_at);
    assert.equal(capital.parent.workflow_cycle, closed.parent.workflow_cycle);
    assert.equal(capital.activities.filter(activity => activity.event_key === 'work_order_reopened').length, 0);
  });

  await check('contraction revokes unversioned completion and combined RPCs from every gateway role', async () => {
    const id = await workOrder({ status: 'wip', functional: 'Work in Progress', visit: true });
    const before = await snapshot(id);
    for (const name of ['complete_work_order_once', 'complete_contractor_work_and_invoicing']) {
      for (const [role, actor] of [
        ['anon', null], ['authenticated', actors.contractor], ['authenticated', actors.mgr],
        ['authenticated', actors.admin], ['authenticated', actors.report],
        ['authenticated', actors.controller], ['service_role', actors.contractor],
      ]) await rejection(() => as(role, actor, tx => tx.query(`select public.${name}(
        $1,$2,'Fixture Make','Fixture Model','Fixture Serial',2020,'Current Asset Repaired',null,'Stale browser payload')`,
      [id, time.complete])), ['42501']);
    }
    assert.deepEqual(await snapshot(id), before);
    assert.equal((await command('complete', actors.contractor, await context(id))).applied, true,
      'Current versioned completion remains available after old entry points are retired');
  });

  await check('private legacy combined body preserves atomic work/invoicing composition without a public proxy', async () => {
    const id = await workOrder({ status: 'pending_approval', functional: 'Work in Progress', visit: true });
    const invokePrivate = target => db.transaction(async tx => {
      // Test database owner invokes a private body with synthetic actor claims.
      // No production proxy/grant is added and no browser role is used here.
      await tx.query("select set_config('request.jwt.claim.role','authenticated',true),set_config('request.jwt.claim.sub',$1,true)", [actors.contractor]);
      return (await tx.query(`select public.complete_contractor_work_and_invoicing(
        $1,$2,'Fixture Make','Fixture Model','Fixture Serial',2020,'Current Asset Repaired',null,'Ignored caller text') result`,
      [target, time.complete])).rows[0].result;
    });
    const before = await snapshot(id);
    await rejection(() => invokePrivate(id), ['22023']);
    assert.deepEqual(await snapshot(id), before, 'Invoice-phase failure rolls back completion, visit, event and operation');
    await db.query(`insert into public.invoices(num,work_order_id,contractor_id,invoice_type,state,invoice_date,subtotal,sales_tax,total)
      values ($1,$2,$3,'contractor','submitted',current_date,100,0,100)`, [`Synthetic-${id}`, id, actors.contractor]);
    const completed = await invokePrivate(id);
    assert.equal(completed.workCompletionApplied, true);
    assert.equal(completed.invoicingCompletionApplied, true);
    const after = await snapshot(id);
    assert.equal(after.parent.functional_status, 'Completed');
    assert.ok(after.parent.contractor_invoicing_completed_at);
    assert.equal(after.visits.filter(visit => !visit.check_out_at).length, 0);
    assert.equal(after.activities.filter(activity => activity.event_key === 'job_completed' && activity.lifecycle_operation_id).length, 1);
  });

  await check('guarded close/reopen still work after contracted authoritative completion', async () => {
    const id = await workOrder();
    await command('start', actors.contractor, await context(id));
    await command('complete', actors.contractor, await context(id));
    const activities = (await snapshot(id)).activities.filter(activity => activity.requires_7eleven_sync);
    for (const activity of activities) await as('authenticated', actors.mgr, tx => tx.query(
      'select public.mark_work_order_activity_synced_v1($1,true)', [activity.id],
    ));
    const row = (await db.query(`select workflow_cycle,contractor_assignment_version,updated_at::text
      from public.work_orders where id=$1`, [id])).rows[0];
    await as('authenticated', actors.mgr, tx => tx.query(
      'select public.close_work_order_without_invoice($1,$2,$3,$4)',
      [id, row.workflow_cycle, row.contractor_assignment_version, row.updated_at],
    ));
    const closed = await snapshot(id);
    assert.equal(closed.parent.status, 'closed');
    await as('authenticated', actors.mgr, tx => tx.query(
      "select public.reopen_work_order($1,'resume_work','Synthetic authorized follow-up')", [id],
    ));
    const reopened = await snapshot(id);
    assert.equal(reopened.parent.status, 'assigned');
    assert.equal(reopened.parent.workflow_cycle, row.workflow_cycle + 1);
    assert.equal(reopened.activities.filter(activity => activity.event_key === 'job_completed').length, 1);
  });
}
