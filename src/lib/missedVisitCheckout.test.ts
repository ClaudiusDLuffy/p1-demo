import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  canOfferMissedVisitCheckout,
  safeVisitCorrectionError,
} from "./visitCorrection";

const migration = readFileSync(
  new URL("../../supabase/migrations/0163_repair_stranded_field_visits.sql", import.meta.url),
  "utf8",
);
const verification = readFileSync(
  new URL("../../supabase/audits/0163_repair_stranded_field_visits_verification.sql", import.meta.url),
  "utf8",
);

test("missed checkout is offered only for authorized actors on stranded off-site visits", () => {
  const stranded = {
    workOrderStatus: "parts",
    functionalStatus: "Awaiting Parts",
    checkOutAt: null,
    checkedInBy: "tech-a",
    technicianProfileId: "tech-a",
  };

  assert.equal(canOfferMissedVisitCheckout({ ...stranded, userId: "tech-a", role: "contractor" }), true);
  assert.equal(canOfferMissedVisitCheckout({ ...stranded, userId: "lead", role: "contractor", canManageTeam: true }), true);
  assert.equal(canOfferMissedVisitCheckout({ ...stranded, userId: "staff", role: "dispatcher" }), true);
  assert.equal(canOfferMissedVisitCheckout({ ...stranded, userId: "other", role: "contractor" }), false);
  assert.equal(canOfferMissedVisitCheckout({ ...stranded, userId: "tech-a", role: "contractor", checkOutAt: "2026-09-13T04:30:00Z" }), false);
  assert.equal(canOfferMissedVisitCheckout({ ...stranded, userId: "tech-a", role: "contractor", functionalStatus: "Work in Progress" }), false);
  assert.equal(canOfferMissedVisitCheckout({ ...stranded, userId: "tech-a", role: "contractor", functionalStatus: "Pending Capital Completion" }), false);
  assert.equal(canOfferMissedVisitCheckout({ ...stranded, userId: "staff", role: "dispatcher", workOrderStatus: "closed" }), false);
});

test("missed-checkout server conflicts retain actionable messages", () => {
  assert.match(safeVisitCorrectionError({
    code: "PT409",
    message: "The checkout time overlaps another visit for this technician",
  }).message, /overlaps another visit/i);
  assert.match(safeVisitCorrectionError({
    code: "PT409",
    message: "This visit is already checked out",
  }).message, /already checked out/i);
});

test("migration installs audited recovery and a deferred off-site invariant", () => {
  assert.match(migration, /create table public\.work_order_visit_checkout_repairs/i);
  assert.match(migration, /create function public\.record_missed_work_order_visit_checkout_v1/i);
  assert.match(migration, /security definer[\s\S]*set search_path = public, pg_temp/i);
  assert.match(migration, /p_expected_assignment_version[\s\S]*p_expected_workflow_cycle[\s\S]*p_expected_lifecycle_version/i);
  assert.match(migration, /Only the visit technician, acting lead, or company admin can record this checkout/i);
  assert.match(migration, /insert into public\.activities[\s\S]*'visit_time_corrected'/i);
  assert.match(migration, /create constraint trigger work_orders_offsite_visit_closed[\s\S]*deferrable initially deferred/i);
  assert.match(migration, /create constraint trigger work_order_visits_offsite_parent_consistent[\s\S]*deferrable initially deferred/i);
  assert.match(migration, /revoke all on function public\.record_missed_work_order_visit_checkout_v1[\s\S]*from public, anon, authenticated, service_role/i);
  assert.match(migration, /grant execute on function public\.record_missed_work_order_visit_checkout_v1[\s\S]*to authenticated/i);
  assert.match(verification, /PASS_0163_INSTALLED/);
});
