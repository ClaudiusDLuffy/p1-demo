import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { canOfferVisitCorrection } from "./visitCorrection";

const migration = readFileSync(
  "supabase/migrations/0156_remove_contractor_visit_correction_window.sql",
  "utf8",
);

test("contractor visit correction UI has no age cutoff on open work orders", () => {
  const oldCheckout = "2024-01-15T13:00:00.000Z";
  assert.equal(canOfferVisitCorrection({
    role: "contractor",
    workOrderStatus: "pending_invoice",
    checkOutAt: oldCheckout,
  }), true);
  assert.equal(canOfferVisitCorrection({
    role: "contractor",
    workOrderStatus: "closed",
    checkOutAt: oldCheckout,
  }), false);
  assert.equal(canOfferVisitCorrection({
    role: "manager",
    workOrderStatus: "closed",
    checkOutAt: oldCheckout,
  }), true);
  assert.equal(canOfferVisitCorrection({
    role: "contractor",
    workOrderStatus: "wip",
    checkOutAt: null,
  }), false);
});

test("migration removes only the contractor age window from the private lifecycle core", () => {
  assert.match(migration, /create or replace function public\.correct_work_order_visit_lc_core/i);
  assert.doesNotMatch(migration, /create or replace function public\.correct_work_order_visit\s*\(/i);
  assert.doesNotMatch(migration, /24 hours|VISIT_CORRECTION_WINDOW_CLOSED/i);

  assert.match(migration, /work_order\.status::text = 'closed'/i);
  assert.match(migration, /can_access_contractor_work_order\(visit\.work_order_id\)/i);
  assert.match(migration, /visit\.checked_in_by <> actor\.id[\s\S]*can_manage_contractor_company\(\)/i);
  assert.match(migration, /correction reason of at least 5 characters/i);
  assert.match(migration, /overlaps another visit for this technician/i);
  assert.match(migration, /locked after the P1 invoice is approved/i);

  assert.match(migration, /insert into public\.work_order_visit_corrections/i);
  assert.match(migration, /old_check_in_at,[\s\S]*old_check_out_at,[\s\S]*new_check_in_at,[\s\S]*new_check_out_at,[\s\S]*reason/i);
  assert.match(migration, /'visit_time_corrected'/i);
  assert.match(migration, /'before'[\s\S]*'after'[\s\S]*'reason'/i);
  assert.match(migration, /revoke all on function public\.correct_work_order_visit_lc_core[\s\S]*from public, anon, authenticated, service_role/i);
});
