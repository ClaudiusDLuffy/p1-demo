// Local PostgreSQL regression coverage for the pending 0185 installer.
// Every DDL/data probe is rolled back on the guarded synthetic fixture DB.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {linkedBillingSql as sql} from './linked-billing-test-support.mjs';
import {
  partPriceBaselineSql, partPriceFunctionNamesSql, partPriceFunctionUpgradeSql,
  partPriceMigrationSql, partPricePatchHelperSql,
} from './part-price-migration-compatibility.mjs';

assert.equal(sql("select count(*) from auth.users where email not like '%@p1.invalid'"), '0');
assert.equal(sql("select to_regclass('public.invoice_part_price_audit') is not null"), 't');
const q = value => value == null ? 'null' : `'${value.replaceAll("'", "''")}'`;
const unwrapped = source => source.replace(/^begin;\s*$/m, '').replace(/commit;\s*$/, '');
const inventory = `select jsonb_agg(jsonb_build_object('name',proname,
  'definition',replace(pg_get_functiondef(oid),E'\\r\\n',E'\\n'),
  'owner',proowner,'acl',proacl,'configuration',proconfig,'securityDefiner',prosecdef,
  'volatility',provolatile) order by proname) from pg_proc
  where pronamespace='public'::regnamespace and proname in (${partPriceFunctionNamesSql})`;
const checksum = value => createHash('sha256').update(value).digest('hex');
const before = checksum(sql(inventory));
const results = [];
const pass = label => {results.push({label, status: 'PASS'}); console.log(`PASS ${label}`);};
const legacyHelper = `create function pg_temp.patch_part_price_function(p_signature text,p_old text,p_new text)
returns void language plpgsql as $$
declare v_oid oid:=to_regprocedure(p_signature); v_definition text;
begin
  if v_oid is null then raise exception 'Required function missing: %',p_signature; end if;
  v_definition:=pg_get_functiondef(v_oid);
  if length(v_definition)-length(replace(v_definition,p_old,''))<>length(p_old) then
    raise exception 'Unexpected function shape in %; review required',p_signature;
  end if;
  execute replace(v_definition,p_old,p_new);
end;
$$;`;

assert.throws(() => sql('begin;' + partPriceBaselineSql('operator_mixed') +
  partPriceFunctionUpgradeSql().replace(partPricePatchHelperSql, () => legacyHelper) + 'rollback;'),
error => /Unexpected function shape in public\.normalize_staff_invoice_payload\(jsonb\)/.test(String(error.stderr)));
pass('original matcher reproduces the reported normalizer failure on all seven exact operator fingerprints');

for (const variant of ['lf', 'operator_mixed', 'crlf_all']) {
  for (const crlfMigration of [false, true]) {
    const after = sql('begin;' + partPriceBaselineSql(variant) + partPriceFunctionUpgradeSql({crlfMigration}) + inventory + ';rollback;');
    assert.equal(checksum(after), before, 'Upgrade changed function behavior, ownership, permissions or configuration');
    pass(`all function patches preserve tested definitions and security: ${variant}, ${crlfMigration ? 'CRLF' : 'LF'} migration`);
  }
}

// Exercise the complete unmodified installer, including new table/column DDL,
// from an absent-feature baseline. Only this disposable feature's objects are
// temporarily removed, never CASCADE; the transaction restores them afterward.
for (const variant of ['lf', 'operator_mixed']) {
  const prepare = `drop table public.invoice_part_price_audit;
    alter table public.invoice_lines drop column price_correction;
    drop function public.corrected_part_billing_rate(numeric,jsonb);
    drop function public.corrected_part_markup(jsonb);
    drop function public.normalize_part_price_correction(jsonb);`;
  const after = sql('begin;' + partPriceBaselineSql(variant) + prepare + unwrapped(partPriceMigrationSql) +
    `select jsonb_build_object('inventory',(${inventory}),
      'auditTable',to_regclass('public.invoice_part_price_audit') is not null,
      'columnExists',exists(select 1 from information_schema.columns where table_schema='public'
        and table_name='invoice_lines' and column_name='price_correction'));rollback;`);
  const parsed = JSON.parse(after);
  assert.equal(checksum(JSON.stringify(parsed.inventory)), checksum(JSON.stringify(JSON.parse(sql(inventory)))));
  assert.equal(parsed.auditTable, true);
  assert.equal(parsed.columnExists, true);
  pass(`complete migration installs missing feature objects: ${variant}`);
}

const lfAnchor = '  -- price anchor A\n  -- price anchor B';
const crlfAnchor = lfAnchor.replaceAll('\n', '\r\n');
const replacement = '  -- updated anchor A\n  -- updated anchor B';
const fixture = comments => `create function pg_temp.part_price_match_fixture() returns text language plpgsql as $fixture$
begin
${comments}
  return 'preserved\r\nSQL literal';
end;
$fixture$;`;
const signature = 'pg_temp.part_price_match_fixture()';
const probes = [
  {label: 'LF match preserves unrelated CRLF SQL literal bytes', body: lfAnchor, old: lfAnchor, next: replacement},
  {label: 'CRLF match preserves unrelated CRLF SQL literal bytes', body: crlfAnchor, old: lfAnchor, next: replacement},
  {label: 'CRLF pasted templates match an LF function', body: lfAnchor, old: crlfAnchor, next: replacement.replaceAll('\n', '\r\n')},
  {label: 'single-line anchor is counted once', body: '  -- one anchor', old: '-- one anchor', next: '-- one replacement'},
  {label: 'missing anchor fails closed', body: '  -- no match', old: lfAnchor, next: replacement, reject: true},
  {label: 'duplicate LF anchors fail closed', body: lfAnchor + '\n' + lfAnchor, old: lfAnchor, next: replacement, reject: true},
  {label: 'duplicate CRLF anchors fail closed', body: crlfAnchor + '\r\n' + crlfAnchor, old: lfAnchor, next: replacement, reject: true},
  {label: 'one LF plus one CRLF anchor fails closed', body: lfAnchor + '\n' + crlfAnchor, old: lfAnchor, next: replacement, reject: true},
  {label: 'standalone CR endings fail closed', body: lfAnchor.replaceAll('\n', '\r'), old: lfAnchor, next: replacement, reject: true},
  {label: 'empty anchor fails closed', body: lfAnchor, old: '', next: replacement, reject: true},
  {label: 'null anchor fails closed', body: lfAnchor, old: null, next: replacement, reject: true},
  {label: 'null replacement fails closed', body: lfAnchor, old: lfAnchor, next: null, reject: true},
  {label: 'unknown function fails closed', body: lfAnchor, old: lfAnchor, next: replacement, reject: true, signature: 'pg_temp.missing_part_price_function()'},
];
for (const probe of probes) {
  const call = `select pg_temp.patch_part_price_function(${q(probe.signature ?? signature)},${q(probe.old)},${q(probe.next)});`;
  const prefix = 'begin;' + partPricePatchHelperSql + fixture(probe.body);
  if (probe.reject) {
    assert.throws(() => sql(prefix + call + 'rollback;'), error =>
      /Unexpected function shape|Invalid patch template|Required function missing/.test(String(error.stderr)));
  } else {
    // DO avoids an extra empty row from the void-returning helper.
    const result = JSON.parse(sql(prefix + call.replace(/^select /, 'do $probe$ begin perform ').replace(/;$/, '; end $probe$;') +
      `select jsonb_build_object('body',prosrc,'value',pg_temp.part_price_match_fixture()) from pg_proc
        where oid=to_regprocedure('${signature}');rollback;`));
    assert.equal(result.value, 'preserved\r\nSQL literal');
    const normalizedOld = probe.old.replaceAll('\r\n', '\n');
    const normalizedNew = probe.next.replaceAll('\r\n', '\n');
    const actualOld = probe.body.includes(normalizedOld) ? normalizedOld : normalizedOld.replaceAll('\n', '\r\n');
    const actualNew = actualOld === normalizedOld ? normalizedNew : normalizedNew.replaceAll('\n', '\r\n');
    const expectedBody = `\nbegin\n${probe.body}\n  return 'preserved\r\nSQL literal';\nend;\n`.replace(actualOld, actualNew);
    assert.equal(result.body, expectedBody, 'Matcher altered bytes outside the exact anchor');
  }
  pass(probe.label);
}
assert.equal(checksum(sql(inventory)), before, 'Rollback did not preserve installed function state');
pass('all probes rolled back; installed function definitions and security unchanged');
console.log(JSON.stringify({passed: results.length, tests: results}, null, 2));
