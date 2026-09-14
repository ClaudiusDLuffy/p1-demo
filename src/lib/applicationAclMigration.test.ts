import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { integritySnapshot } from '../../scripts/acl-test-support/assertions.mjs';

const root = new URL('../../', import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), 'utf8');
function record(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  return Object.fromEntries(Object.entries(value));
}
const model = record(JSON.parse(read('scripts/acl-test-support/expected-grants.json')));
const migration = read('supabase/migrations/0149_harden_application_table_capabilities.sql');
const audit = read('supabase/audits/0149_application_table_capabilities_verification.sql');

test('ACL model covers the complete observed 98-table application inventory exactly once', () => {
  assert.equal(model.version, 149);
  assert.ok(Array.isArray(model.applicationTables));
  assert.equal(model.applicationTables.length, 98);
  assert.equal(new Set(model.applicationTables).size, 98);
  assert.deepEqual(Object.keys(record(model.tablePrivileges)).sort(), [...model.applicationTables].sort());
  for (const table of model.applicationTables) {
    assert.equal(typeof table, 'string');
    assert.match(table, /^[a-z][a-z0-9_]*$/);
    assert.ok(migration.includes(`'${table}'`));
  }
});

test('every application client loses maintenance/DDL capabilities while intended DML has an explicit allowlist', () => {
  for (const [table, raw] of Object.entries(record(model.tablePrivileges))) {
    const roles = record(raw);
    assert.deepEqual(Object.keys(roles).sort(), ['anon', 'authenticated', 'service_role']);
    for (const role of ['anon', 'authenticated']) {
      const grants = roles[role]; assert.ok(Array.isArray(grants));
      for (const privilege of ['TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN']) assert.ok(!grants.includes(privilege), `${table}.${role}.${privilege}`);
      if (role === 'anon') assert.ok(grants.every(privilege => privilege === 'SELECT'));
    }
  }
  assert.deepEqual(record(record(model.tablePrivileges).contractor_technicians).authenticated, ['DELETE', 'INSERT', 'SELECT', 'UPDATE']);
  for (const table of ['private_object_bindings', 'invoice_financial_operations', 'financial_operation_claims']) {
    assert.deepEqual(record(record(model.tablePrivileges)[table]).service_role, []);
  }
});

test('read-only audit uses the exact reviewed table and worker-function allowlists', () => {
  const tableJson = audit.match(/\$p1_expected\$([\s\S]*?)\$p1_expected\$/)?.[1];
  const functionJson = audit.match(/\$p1_functions\$([\s\S]*?)\$p1_functions\$/)?.[1];
  assert.ok(tableJson && functionJson);
  assert.deepEqual(JSON.parse(tableJson), model.tablePrivileges);
  assert.deepEqual(JSON.parse(functionJson), model.requiredServiceFunctions);
  assert.ok(Array.isArray(model.requiredServiceFunctions));
  assert.equal(model.requiredServiceFunctions.length, 214);
  assert.match(audit, /begin;\s*set transaction read only;/);
  assert.match(audit, /rollback;\s*$/);
  assert.doesNotMatch(audit, /^\s*(?:insert|update|delete|truncate|alter|grant|revoke|create|drop)\s/im);
});

test('forward ACL correction is narrow, owner-derived, public-only and fails closed on unreviewed authority', () => {
  assert.doesNotMatch(migration, /revoke\s+all\s+on\s+all/i);
  assert.doesNotMatch(migration, /^\s*(?:grant|insert|update|delete|truncate|create\s+(?:policy|function|table)|alter\s+(?:policy|function|table))\s/im);
  assert.match(migration, /select relowner into strict v_owner/);
  assert.match(migration, /global owner defaults exceed public-only repair authority/);
  assert.match(migration, /in schema public revoke truncate,references,trigger,maintain on tables/);
  assert.match(migration, /v_after is distinct from v_preserved/);
  assert.match(migration, /pg_has_role\(v_role,r.oid,'SET'\)/);
});

test('integrity evidence emits hashes/counts only and rejects non-allowlisted SQL identifiers', async () => {
  const queries: string[] = [];
  const db = { query: async (sql: string) => { queries.push(sql); return { rows: [{ count: 2, hash: 'synthetic-hash' }] }; }, exec: async () => undefined };
  assert.deepEqual(await integritySnapshot(db, ['profiles']), [{ table: 'profiles', count: 2, hash: 'synthetic-hash' }]);
  assert.equal(queries.length, 1);
  assert.match(queries[0], /md5\(/);
  await assert.rejects(() => integritySnapshot(db, ['profiles; truncate work_orders']), assert.AssertionError);
  assert.equal(queries.length, 1);
});
