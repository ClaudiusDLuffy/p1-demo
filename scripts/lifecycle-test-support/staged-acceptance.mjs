import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createLifecycleFixtures, LIFECYCLE_FUNCTIONS } from './command-fixtures.mjs';
import { verifyLifecycleCommands } from './command-acceptance.mjs';
import { verifyLifecycleAtomicity } from './atomicity-acceptance.mjs';
import { verifyLifecycleInterleavings } from './concurrency-compatibility.mjs';
import { applyFixtureMigration, initializeLifecycleActors, actorTransactions } from './engine-fixtures.mjs';

export async function verifyStagedLifecycleRelease(input) {
  const { db, as, files, repo, statements, check, contractor } = input;
  const expansion = files.find(name => name.startsWith('0122_'));
  const contraction = files.find(name => name.startsWith('0123_'));
  assert.ok(expansion, 'Batch 1B expansion migration is required');
  assert.ok(contraction, 'Batch 1B contraction migration is required');
  async function apply(name) {
    for (const statement of statements(readFileSync(`${repo}/supabase/migrations/${name}`, 'utf8'))) {
      try { await db.exec(statement); }
      catch (error) {
        console.error(`Migration statement failed in ${name}: ${statement.match(/(?:create|alter|revoke|grant|drop|do)\b[^\n]*/i)?.[0] || 'statement'}; position ${error.position || error.internalPosition || 'unknown'}`);
        throw error;
      }
    }
    console.log(`applied staged ${name}`);
  }
  await check('populated committed baseline accepts expansion migration', () => apply(expansion));
  const fixture = await createLifecycleFixtures(input);

  await check('expansion alone preserves deployed raw ETA/start/activity and legacy completion callers', async () => {
    const id = await fixture.workOrder();
    await as('authenticated', contractor, tx => tx.query('update public.work_orders set eta=$2 where id=$1', [id, fixture.time.eta]));
    await as('authenticated', contractor, tx => tx.query(`update public.work_orders set status='wip',
      functional_status='Work in Progress',start_time=$2 where id=$1`, [id, fixture.time.start]));
    await as('authenticated', contractor, tx => tx.query(`insert into public.work_order_visits(
      work_order_id,contractor_id,checked_in_by,check_in_at) values ($1,$2,$2,$3)`, [id, contractor, fixture.time.start]));
    await as('authenticated', contractor, tx => tx.query(`insert into public.activities(
      work_order_id,author_id,author_name,text,type,event_key)
      values ($1,$2,'Synthetic deployed caller','Synthetic legacy check-in','note','check_in')`, [id, contractor]));
    const result = (await as('authenticated', contractor, tx => tx.query(`select public.complete_work_order_once(
      $1,$2,'Fixture Make','Fixture Model','Fixture Serial',null,null,null,'Synthetic legacy completion') result`,
    [id, fixture.time.complete]))).rows[0].result;
    assert.equal(result.applied, true);
    assert.equal((await fixture.snapshot(id)).parent.functional_status, 'Completed');
    const replay = (await as('authenticated', contractor, tx => tx.query(`select public.complete_work_order_once(
      $1,$2,'Fixture Make','Fixture Model','Fixture Serial',null,null,null,'Ignored caller text') result`,
    [id, fixture.time.complete]))).rows[0].result;
    assert.equal(replay.applied, false);
    assert.equal(replay.reason, 'already_completed');
    for (const changed of [
      [fixture.time.complete, 2021, null],
      [fixture.time.complete, null, 'Other'],
      [new Date(new Date(fixture.time.complete).getTime() + 60_000).toISOString(), null, null],
    ]) await fixture.rejection(() => as('authenticated', contractor, tx => tx.query(`select public.complete_work_order_once(
      $1,$2,'Fixture Make','Fixture Model','Fixture Serial',$3,$4,null,'Ignored text')`, [id, ...changed])), ['PT409']);
  });
  await check('expansion new typed commands apply and replay before contraction', async () => {
    const id = await fixture.workOrder();
    const args = await fixture.context(id);
    assert.equal((await fixture.command('eta', contractor, args)).applied, true);
    assert.equal((await fixture.command('eta', contractor, args)).reason, 'already_applied');
  });
  await check('populated expansion state accepts contraction migration', () => apply(contraction));
  await verifyLifecycleCommands(fixture, check);
  await verifyLifecycleAtomicity(fixture, check);
  await verifyLifecycleInterleavings(fixture, check);

  await check('lifecycle routines pin search paths and expose only intended authenticated RPCs', async () => {
    const expected = Object.values(LIFECYCLE_FUNCTIONS);
    const rows = (await db.query(`select p.proname,p.prosecdef,p.proconfig,
      has_function_privilege('anon',p.oid,'execute') anonymous,
      has_function_privilege('authenticated',p.oid,'execute') authenticated
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname=any($1::text[])`, [expected])).rows;
    assert.equal(rows.length, expected.length);
    for (const row of rows) {
      assert.equal(row.prosecdef, true, row.proname);
      assert.ok(row.proconfig.some(config => config.startsWith('search_path=')), row.proname);
      assert.equal(row.anonymous, false, row.proname);
      assert.equal(row.authenticated, true, row.proname);
    }
    for (const table of ['work_order_lifecycle_operations', 'work_order_lifecycle_transition_guards', 'work_order_lifecycle_control']) {
      for (const role of ['anon', 'authenticated']) await fixture.rejection(
        () => as(role, contractor, tx => tx.exec(`select * from public.${table}`)), ['42501']);
    }
    for (const name of ['begin_work_order_lifecycle_command', 'finish_work_order_lifecycle_command', 'insert_work_order_lifecycle_activity', 'require_work_order_lifecycle_actor', 'begin_work_order_visit_command']) {
      const grant = (await db.query(`select bool_or(has_function_privilege('authenticated',p.oid,'execute')) allowed
        from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname=$1`, [name])).rows[0];
      assert.equal(grant.allowed, false, name);
    }
    assert.equal((await db.query('select count(*)::int count from public.work_order_lifecycle_transition_guards')).rows[0].count, 0);
  });
  const auditSource = readFileSync(`${repo}/supabase/audits/0123_authoritative_work_order_lifecycle_verification.sql`, 'utf8');
  await check('new lifecycle verification audit runs read-only and separates legacy review from structural protection', async () => {
    const audited = await db.transaction(async tx => {
      await tx.exec('set transaction read only');
      return (await tx.query(auditSource)).rows[0];
    });
    assert.equal(audited.all_checks_pass, true, JSON.stringify(audited));
    assert.ok(Number(audited.legacy_events_requiring_review_count) > 0,
      'Preserved legacy events must remain visible for separate review, not silently repaired');
    assert.equal(Number(audited.unresolved_capability_count), 0);
    assert.equal(Number(audited.unfinished_operation_count), 0);
    assert.equal(Number(audited.owned_event_identity_issue_count), 0);
  });
  const clean = await input.createDatabase();
  try {
    await check('second clean synthetic engine applies all migrations through contraction before workflow fixtures', async () => {
      for (const name of files.filter(name => Number(name.match(/^\d+/)[0]) <= 123)) {
        await applyFixtureMigration({ db: clean, repo, name, statements });
      }
    });
    const cleanActors = await initializeLifecycleActors(clean);
    const cleanFixture = await createLifecycleFixtures({ db: clean, as: actorTransactions(clean), ...cleanActors });
    await verifyLifecycleCommands(cleanFixture, (name, run) => check(`clean engine: ${name}`, run));
    await check('clean engine final lifecycle verification audit passes', async () => {
      const audited = (await clean.query(auditSource)).rows[0];
      assert.equal(audited.all_checks_pass, true, JSON.stringify(audited));
    });
  } finally {
    await clean.close();
  }
  return fixture;
}
