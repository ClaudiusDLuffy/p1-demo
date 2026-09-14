import assert from 'node:assert/strict';
import { bucketTable, guardTable, command, signature, profileKey } from './fixtures.mjs';

export async function verifyDiagnosticSecurity(f, check) {
  const activeActors = ['mgr', 'dispatcher', 'backOffice', 'controller', 'handoff', 'handoffOnly',
    'contractor', 'canonical', 'admin', 'report', 'invoice', 'former', 'outsider'];
  for (const key of activeActors) {
    assert.ok(f.actors[key], `Required synthetic actor ${key} exists`);
    await check(`diagnostic service admits active ${key} without granting browser limiter authority`, async () => {
      await f.reset();
      assert.equal((await f.consume(f.actors[key])).allowed, true);
      const before = await f.snapshot();
      await f.denied(() => f.consume(f.actors.mgr, 'authenticated', f.actors[key]), ['42501']);
      assert.deepEqual(await f.snapshot(), before);
    });
  }
  for (const role of ['anon', 'authenticated', 'service_role']) {
    for (const table of [bucketTable, guardTable]) {
      await check(`diagnostic ${role} cannot read/insert/update/delete/truncate ${table}`, async () => {
        const before = await f.snapshot();
        const key = profileKey(f.actors.mgr);
        const statements = table === bucketTable ? [
          `select * from public.${table}`,
          `insert into public.${table} values('${key}',now(),1)`,
          `update public.${table} set accepted_count=0`,
          `delete from public.${table}`, `truncate public.${table}`,
        ] : [
          `select * from public.${table}`,
          `insert into public.${table} values(txid_current(),'${bucketTable}','${key}')`,
          `update public.${table} set bucket_key='global'`,
          `delete from public.${table}`, `truncate public.${table}`,
        ];
        for (const sql of statements) await f.denied(() => f.as(role, role === 'authenticated' ? f.actors.mgr : null, tx => tx.exec(sql)), ['42501']);
        assert.deepEqual(await f.snapshot(), before);
      });
    }
  }
  await check('diagnostic public/anonymous/user execution revoked and private helpers inaccessible to service', async () => {
    const rows = (await f.db.query(`select p.proname,p.prosecdef,p.proconfig,
      has_function_privilege('anon',p.oid,'EXECUTE') anon,
      has_function_privilege('authenticated',p.oid,'EXECUTE') browser,
      has_function_privilege('service_role',p.oid,'EXECUTE') service,
      exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a where a.grantee=0) public
      from pg_proc p where p.pronamespace='public'::regnamespace and p.proname in
      ('${command}','client_diagnostic_admission_cap','guard_client_diagnostic_admission') order by p.proname`)).rows;
    assert.equal(rows.length, 3);
    for (const row of rows) {
      assert.equal(row.prosecdef, true);
      assert.deepEqual(row.proconfig, row.proname === command
        ? ['search_path=pg_catalog, public', 'lock_timeout=2s'] : ['search_path=pg_catalog, public']);
      assert.equal(row.anon, false); assert.equal(row.browser, false); assert.equal(row.public, false);
      assert.equal(row.service, row.proname === command);
    }
    for (const role of ['anon', 'authenticated', 'service_role']) {
      await f.denied(() => f.as(role, role === 'authenticated' ? f.actors.mgr : null,
        tx => tx.query('select public.client_diagnostic_admission_cap($1)', ['global'])), ['42501']);
    }
  });
  await check('diagnostic JWT role and database role independently fail closed if mismatched', async () => {
    const before = await f.snapshot();
    await f.denied(() => f.as('service_role', null, async tx => {
      await tx.exec("select set_config('request.jwt.claim.role','authenticated',true)");
      return tx.query(`select public.${command}($1)`, [f.actors.mgr]);
    }), ['42501']);
    // Temporarily grant only inside a rollback-only owner fixture to reach the
    // inner database-role guard independently of the usual EXECUTE denial.
    await f.db.exec('begin');
    try {
      await f.db.exec(`grant execute on function ${signature} to authenticated;set local role authenticated;`);
      await f.db.query("select set_config('request.jwt.claim.role','service_role',true),set_config('request.jwt.claim.sub',$1,true)", [f.actors.mgr]);
      await assert.rejects(() => f.db.query(`select public.${command}($1)`, [f.actors.mgr]), error => error.code === '42501');
    } finally { await f.db.exec('rollback'); }
    assert.deepEqual(await f.snapshot(), before);
  });
  await check('diagnostic raw writes remain command-guarded despite temporary service DML grants or GUCs', async () => {
    const before = await f.snapshot();
    for (const sql of [
      `update public.${bucketTable} set accepted_count=0 where bucket_key='global'`,
      `insert into public.${bucketTable} values('profile:${'0'.repeat(64)}',now(),1)`,
      `delete from public.${bucketTable} where bucket_key='global'`,
      `truncate public.${bucketTable}`, `truncate public.${guardTable}`,
    ]) {
      await f.db.exec('begin');
      try {
        await f.db.exec(`grant select,insert,update,delete,truncate on public.${bucketTable},public.${guardTable} to service_role;
          set local role service_role;set local p1.diagnostic_command='true';`);
        await f.db.query("select set_config('request.jwt.claim.role','service_role',true)");
        await assert.rejects(() => f.db.exec(sql), error => error.code === '42501');
      } finally { await f.db.exec('rollback'); }
      assert.deepEqual(await f.snapshot(), before);
    }
  });
  await check('diagnostic private capability binds transaction, relation and exact bucket; identity never changes', async () => {
    const before = await f.snapshot();
    for (const key of ['profile:' + '0'.repeat(64), 'global']) {
      await f.db.exec('begin');
      try {
        await f.db.query('select public.client_diagnostic_admission_cap($1)', [key]);
        const sql = key === 'global'
          ? `update public.${bucketTable} set bucket_key='profile:${'1'.repeat(64)}' where bucket_key='global'`
          : `update public.${bucketTable} set accepted_count=0 where bucket_key='global'`;
        await assert.rejects(() => f.db.exec(sql), error => error.code === '42501');
      } finally { await f.db.exec('rollback'); }
    }
    await f.db.exec('begin');
    try {
      await f.db.query(`insert into public.${guardTable} values(txid_current()-1,$1,'global')`, [bucketTable]);
      await assert.rejects(() => f.db.exec(`update public.${bucketTable} set accepted_count=0 where bucket_key='global'`), error => error.code === '42501');
    } finally { await f.db.exec('rollback'); }
    assert.deepEqual(await f.snapshot(), before);
  });
  await check('diagnostic limiter cannot accept caller-specified cap, clock, body, role or actor parameters', async () => {
    const args = (await f.db.query('select pg_get_function_identity_arguments($1::regprocedure) arguments', [signature])).rows[0].arguments;
    assert.equal(args, 'p_profile_id uuid');
    const before = await f.snapshot();
    await assert.rejects(() => f.as('service_role', null,
      tx => tx.query(`select public.${command}($1,$2)`, [f.actors.mgr, 100_000])), error => error.code === '42883');
    assert.deepEqual(await f.snapshot(), before);
  });
  await f.reset();
}
