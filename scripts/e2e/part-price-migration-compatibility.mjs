// Reconstruct only repository-owned functions inside a caller's rollback-only
// transaction. No hosted connection, customer data, or persisted schema changes.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const read = name => readFileSync(new URL(`../../supabase/migrations/${name}`, import.meta.url), 'utf8');
export const partPriceBaselineFunctions = [
  ['0125_expand_authoritative_invoice_financial_writes.sql', 'normalize_staff_invoice_payload', '6cc40dcca42672d55db3e0ca57d4d99a', 13634, true],
  ['0125_expand_authoritative_invoice_financial_writes.sql', 'save_staff_billing_invoice_v4', 'f4c6d40fc182f9364636641194b29dcf', 19256, true],
  ['0063_atomic_staff_billing_invoice_save.sql', 'save_staff_billing_invoice', 'ae3f2e15cd7f26f7b2643265b7c910bc', 13440, false],
  ['0092_p1_part_costs_and_billing.sql', 'save_staff_billing_invoice_v2', '11811145ebc8768427048daa094cd451', 4115, false],
  ['0092_p1_part_costs_and_billing.sql', 'protect_invoice_line_billing_metadata', '0a3ebad755a462ca0be248c42308bb6e', 3984, false],
  ['0147_compact_invoice_reads_and_line_pages.sql', 'list_invoice_lines_page_v1', 'f15e82824dde295fdc733fd4b4a9bd9d', 4736, true],
  ['0125_expand_authoritative_invoice_financial_writes.sql', 'invoice_financial_line_snapshot', 'daf979ff369e69ccb3351a1045de72c8', 183, true],
];
export const partPriceFunctionNamesSql = partPriceBaselineFunctions.map(([, name]) => `'${name}'`).join(',');
const unwrapped = source => source.replace(/^begin;\s*$/m, '').replace(/commit;\s*$/, '');

function baselineDefinition(file, name) {
  const source = read(file);
  const start = source.search(new RegExp(`create (?:or replace )?function public\\.${name}\\(`));
  assert.ok(start >= 0, `Missing baseline ${name}`);
  const body = source.indexOf('as $$', start);
  const end = source.indexOf('$$;', body + 5);
  assert.ok(body > start && end > body, `Invalid baseline ${name}`);
  return source.slice(start, end + 3).replace(/^create function/, 'create or replace function');
}

export function partPriceBaselineSql(variant = 'lf') {
  assert.ok(['lf', 'operator_mixed', 'crlf_all'].includes(variant), 'Unknown compatibility variant');
  const definitions = partPriceBaselineFunctions.map(([file, name]) => baselineDefinition(file, name)).join('\n');
  const warranty = unwrapped(read('0122_allow_zero_rate_staff_warranty_lines.sql'));
  const crlfNames = partPriceBaselineFunctions.filter(([, , , , crlf]) => variant === 'crlf_all' || (variant === 'operator_mixed' && crlf))
    .map(([, name]) => `'${name}'`);
  const convert = crlfNames.length ? `do $line_endings$
    declare f record; definition text;
    begin
      for f in select oid,prosrc from pg_proc where pronamespace='public'::regnamespace
        and proname in (${crlfNames.join(',')}) loop
        if position(E'\\r' in f.prosrc)>0 then raise exception 'Baseline already contains CR'; end if;
        definition:=pg_get_functiondef(f.oid);
        if length(definition)-length(replace(definition,f.prosrc,''))<>length(f.prosrc) then
          raise exception 'Baseline body is not unique';
        end if;
        execute replace(definition,f.prosrc,replace(f.prosrc,E'\\n',E'\\r\\n'));
      end loop;
    end $line_endings$;` : '';
  const fingerprint = variant === 'operator_mixed' ? `do $fingerprints$ begin
    if (select count(*) from pg_proc where pronamespace='public'::regnamespace and proname in (${partPriceFunctionNamesSql}))<>7
      or exists(select 1 from (values ${partPriceBaselineFunctions.map(([, name, md5, chars]) => `('${name}','${md5}',${chars})`).join(',')})
      expected(name,body_md5,characters) left join pg_proc f on f.pronamespace='public'::regnamespace and f.proname=expected.name
      where md5(f.prosrc) is distinct from expected.body_md5 or length(f.prosrc) is distinct from expected.characters) then
      raise exception 'Reconstructed baseline differs from operator function fingerprints';
    end if;
  end $fingerprints$;` : '';
  return definitions + warranty + convert + fingerprint;
}

export const partPriceMigrationSql = read('0185_audited_invoice_part_price_corrections.sql');
export const partPricePatchHelperSql = partPriceMigrationSql.match(/create function pg_temp\.patch_part_price_function[\s\S]*?\n\$\$;/)?.[0];
assert.ok(partPricePatchHelperSql, 'Missing temporary patch helper');

// The feature DDL already exists on this disposable fixture DB. Only rebuild
// functions, then run the real migration's patches; caller always rolls back.
export function partPriceFunctionUpgradeSql({crlfMigration = false} = {}) {
  let source = unwrapped(partPriceMigrationSql)
    .replace('alter table public.invoice_lines add column price_correction jsonb;', '')
    .replace(/create table public\.invoice_part_price_audit \([\s\S]*?create index invoice_part_price_audit_invoice[^;]*;/, '')
    .replace(/create function public\.(normalize_part_price_correction|corrected_part_billing_rate|corrected_part_markup)/g, 'create or replace function public.$1');
  if (crlfMigration) source = source.replaceAll('\n', '\r\n');
  return source;
}

export function partPriceCompatibilityPrelude(variant) {
  return partPriceBaselineSql(variant) + partPriceFunctionUpgradeSql();
}
