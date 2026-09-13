import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { bucketTable, profileKey, command, withDiagnosticFailure } from './fixtures.mjs';

const allowed = result => assert.deepEqual(result, { allowed: true, retryAfterSeconds: 0 });
function limited(result) {
  assert.deepEqual(Object.keys(result).sort(), ['allowed', 'retryAfterSeconds']);
  assert.equal(result.allowed, false);
  assert.ok(Number.isInteger(result.retryAfterSeconds) && result.retryAfterSeconds >= 1 && result.retryAfterSeconds <= 60);
}

export async function verifyDiagnosticAdmission(f, check) {
  await check('diagnostic accepted result is content-free and stores only UUID hash plus server minute/count', async () => {
    allowed(await f.consume());
    const rows = await f.buckets();
    assert.equal(rows.length, 2);
    const own = rows.find(row => row.bucket_key === profileKey(f.actors.mgr));
    assert.ok(own);
    assert.equal(own.accepted_count, 1);
    assert.deepEqual(Object.keys(own).sort(), ['accepted_count', 'bucket_key', 'window_started_at']);
    const clock = (await f.db.query("select date_trunc('minute',clock_timestamp() at time zone 'UTC') at time zone 'UTC' current_minute")).rows[0].current_minute;
    assert.equal(own.window_started_at.getTime(), clock.getTime());
    assert.equal(JSON.stringify(rows).includes(f.actors.mgr), false);
    assert.deepEqual(await f.guards(), []);
  });
  await check('diagnostic ten accepted user admissions are capped and rejection changes neither bucket', async () => {
    await f.reset();
    // Owner-only synthetic future window prevents wall-clock rollover from
    // weakening this deterministic cap assertion; no caller can set a window.
    await f.ownerChange(`update public.${bucketTable} set window_started_at=window_started_at+interval '1 minute'`);
    for (let index = 0; index < 10; index++) allowed(await f.consume());
    const before = await f.snapshot();
    for (let index = 0; index < 20; index++) limited(await f.consume());
    assert.deepEqual(await f.snapshot(), before);
    assert.equal(before.buckets.find(row => row.bucket_key === 'global').accepted_count, 10);
  });
  await check('diagnostic different active profiles have independent user buckets', async () => {
    await f.reset();
    for (let index = 0; index < 10; index++) allowed(await f.consume());
    limited(await f.consume());
    allowed(await f.consume(f.actors.contractor));
    assert.equal((await f.buckets()).find(row => row.bucket_key === profileKey(f.actors.contractor)).accepted_count, 1);
  });
  await check('diagnostic global 100 cap is atomic and blocks new actor bucket allocation', async () => {
    await f.reset();
    await f.ownerChange(`update public.${bucketTable} set window_started_at=window_started_at+interval '1 minute'`);
    const profiles = [];
    for (let index = 0; index < 11; index++) profiles.push(await f.profile());
    for (const id of profiles.slice(0, 10)) {
      allowed(await f.consume(id));
      await f.ownerChange(`update public.${bucketTable} set window_started_at=window_started_at+interval '1 minute' where bucket_key=$1`, [profileKey(id)]);
      for (let index = 1; index < 10; index++) allowed(await f.consume(id));
    }
    const before = await f.snapshot();
    assert.equal(before.buckets.find(row => row.bucket_key === 'global').accepted_count, 100);
    for (let index = 0; index < 25; index++) limited(await f.consume(profiles[10]));
    assert.deepEqual(await f.snapshot(), before);
    assert.equal(before.buckets.some(row => row.bucket_key === profileKey(profiles[10])), false);
  });
  await check('diagnostic expired fixed windows reuse existing rows with no historical window growth', async () => {
    const before = await f.buckets();
    await f.ownerChange(`update public.${bucketTable} set window_started_at=window_started_at-interval '1 day'`);
    allowed(await f.consume());
    const after = await f.buckets();
    assert.deepEqual(after.map(row => row.bucket_key), before.map(row => row.bucket_key));
    assert.equal(after.find(row => row.bucket_key === 'global').accepted_count, 1);
    assert.equal(after.find(row => row.bucket_key === profileKey(f.actors.mgr)).accepted_count, 1);
  });
  await check('diagnostic user expiry and global expiry are evaluated independently', async () => {
    await f.reset();
    await f.ownerChange(`update public.${bucketTable} set accepted_count=case when bucket_key='global' then 5 else 10 end,
      window_started_at=case when bucket_key='global' then window_started_at else window_started_at-interval '1 day' end`);
    allowed(await f.consume());
    assert.equal((await f.buckets()).find(row => row.bucket_key === 'global').accepted_count, 6);
    assert.equal((await f.buckets()).find(row => row.bucket_key === profileKey(f.actors.mgr)).accepted_count, 1);
    await f.ownerChange(`update public.${bucketTable} set accepted_count=case when bucket_key='global' then 100 else 10 end,
      window_started_at=case when bucket_key='global' then clock_timestamp()-interval '1 day' else date_trunc('minute',clock_timestamp())+interval '1 minute' end`);
    const before = await f.snapshot();
    limited(await f.consume());
    assert.deepEqual(await f.snapshot(), before, 'Rejected user does not write an expired global reset');
  });
  await check('diagnostic fixed-minute buckets are invariant to session timezone and client timestamp GUC', async () => {
    await f.reset();
    const result = await f.as('service_role', null, async tx => {
      await tx.exec("set local timezone='Pacific/Chatham';set local p1.diagnostic_client_timestamp='2099-01-01';set local p1.diagnostic_limit='100000';");
      return (await tx.query(`select public.${command}($1) result`, [f.actors.mgr])).rows[0].result;
    });
    allowed(result);
    const own = (await f.buckets()).find(row => row.bucket_key === profileKey(f.actors.mgr));
    assert.equal(own.window_started_at.getUTCSeconds(), 0);
    assert.equal(own.window_started_at.getUTCMilliseconds(), 0);
    assert.ok(Math.abs(Date.now() - own.window_started_at.getTime()) < 60_000);
  });
  await check('diagnostic profile/global counter failures roll back all admission writes and capabilities', async () => {
    await f.reset();
    for (const failure of ['profile', 'global']) {
      const id = await f.profile();
      const before = await f.snapshot();
      await withDiagnosticFailure(f.db, failure, () => assert.rejects(() => f.consume(id), error => error.code === 'P0001'));
      assert.deepEqual(await f.snapshot(), before);
      assert.equal((await f.buckets()).some(row => row.bucket_key === profileKey(id)), false);
    }
  });
  await check('diagnostic surrounding transaction rollback does not spend admission budget', async () => {
    await f.reset();
    const before = await f.snapshot();
    await assert.rejects(() => f.as('service_role', null, async tx => {
      allowed((await tx.query(`select public.${command}($1) result`, [f.actors.mgr])).rows[0].result);
      throw new Error('Synthetic request transaction aborted');
    }), /Synthetic request transaction aborted/);
    assert.deepEqual(await f.snapshot(), before);
  });
  await check('diagnostic inactive or missing identity rejects without global/user writes', async () => {
    await f.reset();
    const before = await f.snapshot();
    for (const id of [f.actors.inactive, f.actors.inactiveManager, f.actors.inactiveBackOffice, f.actors.noProfile, null, randomUUID()]) {
      await f.denied(() => f.consume(id), ['PT403']);
    }
    assert.deepEqual(await f.snapshot(), before);
  });
  await check('diagnostic current profile activation is authoritative at every admission', async () => {
    await f.reset();
    const id = await f.profile();
    allowed(await f.consume(id));
    await f.db.query('update public.profiles set active=false where id=$1', [id]);
    const before = await f.snapshot();
    await f.denied(() => f.consume(id), ['PT403']);
    assert.deepEqual(await f.snapshot(), before);
    await f.db.query('update public.profiles set active=true where id=$1', [id]);
    allowed(await f.consume(id));
    assert.equal((await f.buckets()).find(row => row.bucket_key === profileKey(id)).accepted_count, 2);
  });
  await check('diagnostic overlapping PGlite calls preserve caps; independent sessions remain unverified', async () => {
    await f.reset();
    await f.ownerChange(`update public.${bucketTable} set window_started_at=window_started_at+interval '1 minute'`);
    const results = [];
    // Two bounded concurrent callers share the synthetic single-session engine;
    // this is scheduling/replay coverage, not independent PostgreSQL certification.
    for (let index = 0; index < 15; index++) results.push(...await Promise.all([f.consume(), f.consume()]));
    assert.equal(results.filter(row => row.allowed).length, 10);
    assert.equal(results.filter(row => !row.allowed).length, 20);
    assert.equal((await f.buckets()).find(row => row.bucket_key === 'global').accepted_count, 10);
    assert.deepEqual(await f.guards(), []);
  });
  await f.reset();
}
