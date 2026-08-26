import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const migration = readFileSync(
  resolve(process.cwd(), "supabase/migrations/0088_editable_billing_tax_rules.sql"),
  "utf8",
);

test("taxability rules are ordered configuration rather than person-specific code", () => {
  assert.match(migration, /create table if not exists public\.billing_tax_rules/);
  assert.match(migration, /priority integer not null/);
  assert.match(migration, /equipment_keywords text\[\]/);
  assert.match(migration, /line_types text\[\]/);
  assert.doesNotMatch(migration, /@[a-z0-9.-]+\.[a-z]{2,}/i);
});

test("rule mutations are staff-only, controller-restricted, and audited", () => {
  assert.match(migration, /billing_tax_rules_insert[\s\S]*public\.is_staff\(\)[\s\S]*not public\.is_invoice_controller\(\)/);
  assert.match(migration, /billing_tax_rules_update[\s\S]*public\.is_staff\(\)[\s\S]*not public\.is_invoice_controller\(\)/);
  assert.match(migration, /create table if not exists public\.billing_tax_rule_audit/);
  assert.match(migration, /after insert or update on public\.billing_tax_rules/);
  assert.doesNotMatch(migration, /grant delete on public\.billing_tax_rules/);
});

test("the supplied starter matrix remains editable and deterministic", () => {
  assert.match(migration, /'vault_exempt'[\s\S]*10/);
  assert.match(migration, /'labor_travel_exempt'[\s\S]*20/);
  assert.match(migration, /'parts_taxable'[\s\S]*30/);
  assert.match(migration, /'slurpee_taxable'[\s\S]*40/);
  assert.match(migration, /on conflict \(rule_key\) do nothing/);
});
