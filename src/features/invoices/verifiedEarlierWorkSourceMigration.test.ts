import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync("supabase/migrations/0187_verified_email_intake_contractor_bills.sql", "utf8");
test("email intake extends both authoritative eligibility and save guard to the same explicit sources", () => {
  assert.ok(migration.includes("'public.get_prior_contractor_invoice_context_v1(text)'"));
  assert.ok(migration.includes("'public.save_verified_manual_contractor_invoice_v1(text,integer,integer,uuid,uuid,bigint,uuid,jsonb)'"));
  assert.ok(migration.includes("coalesce(w.source in (''manual'',''email_intake''),false)"));
  assert.ok(migration.includes("coalesce(w.source,'''') not in (''manual'',''email_intake'')"));
});
test("eligibility migration is bounded, fails on drift and preserves existing function contracts", () => {
  assert.ok(migration.includes("<>1 then"));
  assert.ok(migration.includes("execute replace(original,needle,replacement)"));
  assert.equal((migration.match(/needle:=/g) ?? []).length, 2);
  assert.doesNotMatch(migration, /\b(?:grant|revoke)\s+(?:all|execute)|\bupdate\s+public\.|\binsert\s+into\s+public\./i);
});
test("verified form describes earlier-work verification without claiming the WO was manually created", () => {
  const panel = readFileSync("src/features/invoices/PriorContractorInvoicePanel.tsx", "utf8");
  assert.doesNotMatch(panel, /This manually entered work order|This work order was entered manually/);
  assert.match(panel, /work orders created manually or received through email intake/);
  assert.match(panel, /context\.data\?\.manualIntake\?\.eligible/);
});
