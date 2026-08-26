import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const migration = readFileSync(
  resolve(process.cwd(), "supabase/migrations/0089_verified_location_sales_tax.sql"),
  "utf8",
);

test("local tax rates require exact addresses and never infer from ZIP alone", () => {
  assert.match(migration, /Exact street address is mandatory/);
  assert.match(migration, /rate\.normalized_address = v_address/);
  assert.match(migration, /char_length\(regexp_replace\(v_address/);
  assert.doesNotMatch(migration, /where\s+rate\.postal_code\s*=\s*v_postal/i);
});

test("official location rates are effective-dated and retain reporting provenance", () => {
  assert.match(migration, /create table if not exists public\.tax_rate_import_batches/);
  assert.match(migration, /source_file_sha256/);
  assert.match(migration, /create table if not exists public\.sales_tax_location_rates/);
  assert.match(migration, /jurisdictions jsonb not null/);
  assert.match(migration, /effective_from date not null/);
  assert.match(migration, /tax_jurisdiction_snapshot/);
  assert.match(migration, /tax_rate_reference_id/);
});

test("unverified Texas rates remain manual and no guessed rate is seeded", () => {
  assert.match(migration, /new\.tax_state <> 'TX'/);
  assert.match(migration, /new\.tax_rate_source := 'manual_override'/);
  assert.doesNotMatch(migration, /insert into public\.sales_tax_location_rates/i);
});

test("rate imports are read-only to authenticated clients", () => {
  assert.match(migration, /grant select on public\.tax_rate_import_batches to authenticated/);
  assert.match(migration, /grant select on public\.sales_tax_location_rates to authenticated/);
  assert.doesNotMatch(migration, /grant (?:insert|update|delete)[^;]*sales_tax_location_rates[^;]*authenticated/i);
});
