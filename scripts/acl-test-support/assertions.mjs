// @ts-check
// Synthetic-only diagnostic assertions. No credentials or row contents are emitted.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

/** @typedef {{query(sql:string, parameters?:unknown[]):Promise<{rows:Record<string,unknown>[]}>,exec(sql:string):Promise<unknown>}} DatabasePort */
/** @param {unknown} value */
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const forbidden = ['TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN'];
/** @param {string} name */
function identifier(name) { assert.match(name, /^[a-z][a-z0-9_]*$/); return `"${name}"`; }

/** @param {DatabasePort} db @param {readonly string[]} tables */
export async function integritySnapshot(db, tables) {
  const result = [];
  for (const table of tables) {
    const rows = (await db.query(`select count(*)::integer count,
      md5(coalesce(string_agg(to_jsonb(t)::text,E'\n' order by to_jsonb(t)::text),'')) hash
      from public.${identifier(table)} t`)).rows;
    assert.equal(rows.length, 1);
    assert.equal(typeof rows[0].count, 'number'); assert.equal(typeof rows[0].hash, 'string');
    result.push({ table, count: rows[0].count, hash: rows[0].hash });
  }
  return result;
}

/** @param {DatabasePort} db */
export async function unchangedContractSnapshot(db) {
  const queries = {
    policies: `select schemaname,tablename,policyname,permissive,roles,cmd,qual,with_check from pg_policies order by schemaname,tablename,policyname`,
    functions: `select p.oid::regprocedure::text signature,pg_get_userbyid(p.proowner) owner,p.proacl::text acl,
      md5(pg_get_functiondef(p.oid)) definition_hash from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where p.prokind='f' and n.nspname='public' order by signature`,
    platformTables: `select n.nspname,c.relname,c.relowner,c.relacl::text,c.relrowsecurity from pg_class c
      join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('auth','storage','extensions','realtime') order by n.nspname,c.relname`,
    platformDefaults: `select d.defaclrole,d.defaclnamespace,d.defaclobjtype,d.defaclacl::text from pg_default_acl d
      where not (d.defaclrole=(select relowner from pg_class where oid='public.work_orders'::regclass)
        and d.defaclnamespace='public'::regnamespace and d.defaclobjtype='r') order by 1,2,3`,
    memberships: 'select roleid,member,grantor,admin_option,inherit_option,set_option from pg_auth_members order by roleid,member,grantor',
    ownership: `select n.nspname,c.relname,c.relowner from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where n.nspname='public' order by c.relname`,
  };
  const result = {};
  for (const [name, sql] of Object.entries(queries)) {
    const rows = (await db.query(sql)).rows;
    Object.assign(result, { [name]: { count: rows.length, sha256: digest(rows) } });
  }
  return result;
}

/** @param {DatabasePort} db @param {string} role @param {string} sql */
async function permissionDenied(db, role, sql) {
  await db.exec(`begin; set local role ${identifier(role)};`);
  try { await assert.rejects(() => db.exec(sql), error => error !== null && typeof error === 'object' && 'code' in error && error.code === '42501', `${role}: ${sql}`); }
  finally { await db.exec('rollback;'); }
}

/** @param {DatabasePort} db @param {readonly string[]} tables */
export async function assertDirectCapabilities(db, tables) {
  const results = [];
  for (const role of ['anon', 'authenticated']) {
    for (const table of tables) {
      for (const capability of forbidden) {
        assert.equal((await db.query('select has_table_privilege($1,$2,$3) allowed', [role, `public.${table}`, capability])).rows[0].allowed, false,
          `${role}.${table}.${capability}`);
      }
      await permissionDenied(db, role, `truncate table public.${identifier(table)};`);
    }
    await permissionDenied(db, role, 'create table public.p1_acl_forbidden_create(id integer);');
    // SET ROLE authorization uses session_user. A migration-owner connection
    // cannot model client escalation by switching its current role alone.
    assert.equal((await db.query("select pg_has_role($1,'postgres','SET') allowed", [role])).rows[0].allowed, false);
    // Effective REFERENCES is tested on every target above. Clients also lack
    // public CREATE and own no application table. Do not grant either merely
    // to manufacture a foreign-key test; temp-to-permanent FKs are invalid SQL.
    await permissionDenied(db, role, `create trigger p1_acl_forbidden_trigger before update on public.contractor_technicians
      for each row execute function public.touch_updated_at();`);
    results.push({ role, effectiveCapabilityDenials: tables.length * forbidden.length,
      executedTruncateDenials: tables.length, schemaCreateDenied: true, ownerRoleMembershipDenied: true,
      referencesEffectiveDenied: true, executedTriggerDenied: true });
  }
  await db.exec('begin; create table public.p1_acl_default_probe(id integer);');
  try {
    for (const role of ['anon', 'authenticated']) for (const capability of forbidden) {
      assert.equal((await db.query('select has_table_privilege($1,$2,$3) allowed', [role, 'public.p1_acl_default_probe', capability])).rows[0].allowed, false);
    }
    assert.equal((await db.query(`select count(*)::integer count from pg_class c cross join lateral aclexplode(c.relacl) a
      where c.oid='public.p1_acl_default_probe'::regclass and a.grantee=0
      and a.privilege_type in ('TRUNCATE','REFERENCES','TRIGGER','MAINTAIN')`)).rows[0].count, 0);
    assert.equal((await db.query("select has_table_privilege(current_user,'public.p1_acl_default_probe','TRUNCATE') allowed")).rows[0].allowed, true);
  } finally { await db.exec('rollback;'); }
  return { results, actualOwnerDefaultProbe: 'PASS', syntheticProbeCleanup: 'ROLLED_BACK' };
}

/** @param {DatabasePort} db */
export async function runReadOnlyAclAudit(db) {
  const sql = await readFile(new URL('../../supabase/audits/0149_application_table_capabilities_verification.sql', import.meta.url), 'utf8');
  try { await db.exec(sql); } finally { await db.exec('rollback;'); }
  return { audit: '0149_application_table_capabilities_verification.sql', sha256: createHash('sha256').update(sql).digest('hex'), passed: true };
}
