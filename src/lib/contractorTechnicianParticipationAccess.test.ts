import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const migration = readFileSync(
  resolve(
    process.cwd(),
    "supabase/migrations/0081_restore_linked_technician_participation_scope.sql",
  ),
  "utf8",
);

type AccessCase = {
  sameCompany?: boolean;
  linkedTechnician?: boolean;
  activeTechnician?: boolean;
  assigned?: boolean;
  assignedToAnotherTechnician?: boolean;
  anotherActiveParticipant?: boolean;
  participated?: boolean;
};

function linkedTechnicianCanAccess(value: AccessCase) {
  return Boolean(
    value.sameCompany
      && value.linkedTechnician
      && value.activeTechnician
      && (
        value.assigned
        || (
          !value.assignedToAnotherTechnician
          && !value.anotherActiveParticipant
          && value.participated
        )
      ),
  );
}

test("authenticated participation restores existing technician scope", () => {
  assert.equal(linkedTechnicianCanAccess({
    sameCompany: true,
    linkedTechnician: true,
    activeTechnician: true,
    participated: true,
  }), true);
  assert.equal(linkedTechnicianCanAccess({
    sameCompany: true,
    linkedTechnician: true,
    activeTechnician: true,
    assigned: true,
  }), true);
});

test("a new unassigned technician receives no historical scope", () => {
  assert.equal(linkedTechnicianCanAccess({
    sameCompany: true,
    linkedTechnician: true,
    activeTechnician: true,
    assigned: false,
    participated: false,
  }), false);
  assert.equal(linkedTechnicianCanAccess({
    sameCompany: false,
    linkedTechnician: true,
    activeTechnician: true,
    participated: true,
  }), false);
  assert.equal(linkedTechnicianCanAccess({
    sameCompany: true,
    linkedTechnician: true,
    activeTechnician: false,
    participated: true,
  }), false);
});

test("a current structured assignment overrides historical participation", () => {
  assert.equal(linkedTechnicianCanAccess({
    sameCompany: true,
    linkedTechnician: true,
    activeTechnician: true,
    assignedToAnotherTechnician: true,
    participated: true,
  }), false);
  assert.equal(linkedTechnicianCanAccess({
    sameCompany: true,
    linkedTechnician: true,
    activeTechnician: true,
    assigned: true,
    participated: false,
  }), true);
  assert.match(
    migration,
    /work_order\.assigned_technician_profile_id is null[\s\S]+work_order_technician_assignments/,
  );
});

test("ambiguous participation remains blocked for human confirmation", () => {
  assert.equal(linkedTechnicianCanAccess({
    sameCompany: true,
    linkedTechnician: true,
    activeTechnician: true,
    anotherActiveParticipant: true,
    participated: true,
  }), false);
  assert.match(
    migration,
    /select count\(distinct participant\.profile_id\)[\s\S]+\) = 1/,
  );
  assert.match(
    migration,
    /participant_technician\.contractor_id = work_order\.contractor_id/,
  );
  assert.match(migration, /participant_profile\.active = true/);
});

test("migration relies only on durable authenticated field evidence", () => {
  assert.match(migration, /work_order_technician_assignments/);
  assert.match(migration, /assignment\.technician_profile_id = viewer\.id/);
  assert.match(migration, /work_order_visits/);
  assert.match(migration, /visit\.checked_in_by = viewer\.id/);
  assert.match(migration, /visit\.checked_out_by = viewer\.id/);
  assert.match(migration, /photos/);
  assert.match(migration, /photo\.uploader_id = viewer\.id/);
  assert.doesNotMatch(migration, /technician_on_job/);
  assert.doesNotMatch(migration, /from public\.activities/);
  assert.doesNotMatch(migration, /from public\.invoices/);
});

test("restore is tenant-agnostic and does not rewrite production rows", () => {
  assert.match(migration, /work_order\.contractor_id = case/);
  assert.match(migration, /technician\.contractor_id = work_order\.contractor_id/);
  assert.match(migration, /visit\.contractor_id = work_order\.contractor_id/);
  assert.doesNotMatch(migration, /update public\.(?:work_orders|profiles|contractor_technicians)/i);
  assert.doesNotMatch(migration, /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i);
  assert.doesNotMatch(migration, /WOT[0-9]+/i);
});
