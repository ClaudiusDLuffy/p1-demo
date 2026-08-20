import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const migration = readFileSync(
  resolve(
    process.cwd(),
    "supabase/migrations/0079_assignment_scoped_contractor_technicians.sql",
  ),
  "utf8",
);

type AccessCase = {
  staff?: boolean;
  sameCompany?: boolean;
  accessLevel?: "company_admin" | "invoice" | "report_only";
  linkedTechnician?: boolean;
  activeTechnician?: boolean;
  assigned?: boolean;
};

function expectedWorkOrderAccess(value: AccessCase) {
  if (value.staff) return true;
  if (!value.sameCompany) return false;
  if (value.accessLevel === "company_admin") return true;
  if (value.accessLevel === "invoice" && !value.linkedTechnician) return true;
  return Boolean(
    value.linkedTechnician
      && value.activeTechnician
      && value.assigned
      && ["invoice", "report_only"].includes(value.accessLevel || ""),
  );
}

test("contractor authorization matrix separates capability from row scope", () => {
  assert.equal(expectedWorkOrderAccess({ staff: true }), true);
  assert.equal(expectedWorkOrderAccess({ sameCompany: false, accessLevel: "company_admin" }), false);
  assert.equal(expectedWorkOrderAccess({ sameCompany: true, accessLevel: "company_admin" }), true);
  assert.equal(expectedWorkOrderAccess({ sameCompany: true, accessLevel: "invoice" }), true);
  assert.equal(expectedWorkOrderAccess({
    sameCompany: true,
    accessLevel: "invoice",
    linkedTechnician: true,
    activeTechnician: true,
    assigned: false,
  }), false);
  assert.equal(expectedWorkOrderAccess({
    sameCompany: true,
    accessLevel: "invoice",
    linkedTechnician: true,
    activeTechnician: true,
    assigned: true,
  }), true);
  assert.equal(expectedWorkOrderAccess({
    sameCompany: true,
    accessLevel: "report_only",
    linkedTechnician: true,
    activeTechnician: true,
    assigned: true,
  }), true);
  assert.equal(expectedWorkOrderAccess({
    sameCompany: true,
    accessLevel: "report_only",
    linkedTechnician: true,
    activeTechnician: false,
    assigned: true,
  }), false);
});

test("migration scopes linked invoice technicians without downgrading capability", () => {
  assert.match(migration, /is_linked_contractor_technician/);
  assert.match(migration, /viewer\.contractor_access_level = 'company_admin'/);
  assert.match(
    migration,
    /viewer\.contractor_access_level = 'invoice'[\s\S]*?not public\.is_linked_contractor_technician/,
  );
  assert.match(
    migration,
    /viewer\.contractor_access_level in \('invoice', 'report_only'\)[\s\S]*?assigned_technician_profile_id = viewer\.id[\s\S]*?technician\.is_active = true/,
  );
  assert.doesNotMatch(
    migration,
    /update public\.profiles[\s\S]*?contractor_access_level\s*=/i,
  );
});

test("legacy assignment repair is exact, unambiguous, and tenant scoped", () => {
  assert.match(migration, /technician\.contractor_id = work_order\.contractor_id/);
  assert.match(migration, /work_order\.assigned_technician_profile_id is null/);
  assert.match(migration, /regexp_replace\(trim\(work_order\.technician_on_job\)/);
  assert.match(migration, /having count\(distinct technician\.profile_id\) = 1/);
  assert.doesNotMatch(migration, /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i);
});

test("invoice writes enforce the same work-order scope", () => {
  assert.match(
    migration,
    /not public\.can_access_contractor_work_order\(new\.work_order_id\)/,
  );
  assert.match(
    migration,
    /create trigger enforce_contractor_invoice_identity_trigger[\s\S]*?before insert or update/i,
  );
  assert.match(migration, /new\.created_by is distinct from actor_id/);
});
