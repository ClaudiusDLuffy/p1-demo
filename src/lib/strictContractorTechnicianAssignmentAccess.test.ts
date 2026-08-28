import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");
const migration = read(
  "supabase/migrations/0091_strict_contractor_technician_assignment_scope.sql",
);
const policies = read(
  "supabase/migrations/0058_individual_contractor_technician_scope.sql",
);
const cursorReads = read(
  "supabase/migrations/0076_cursor_pagination_and_portal_indexes.sql",
);
const tableReads = read("supabase/migrations/0086_work_order_table_sorting.sql");
const detailReads = read("supabase/migrations/0087_portal_queue_readiness.sql");

const functionStart = migration.indexOf(
  "create or replace function public.can_access_contractor_work_order",
);
const revokeStart = migration.indexOf(
  "revoke all on function public.can_access_contractor_work_order",
);
const accessFunction = migration.slice(functionStart, revokeStart);

type AccessCase = {
  staff?: boolean;
  sameCompany?: boolean;
  standalone?: boolean;
  accessLevel?: "company_admin" | "invoice" | "report_only";
  linkedTechnician?: boolean;
  activeTechnician?: boolean;
  assigned?: boolean;
  participated?: boolean;
};

function canAccessWorkOrder(value: AccessCase): boolean {
  if (value.staff) return true;
  if (!value.sameCompany) return false;
  if (value.standalone) return true;
  if (value.accessLevel === "company_admin") return true;
  if (value.accessLevel === "invoice" && !value.linkedTechnician) return true;
  return Boolean(
    value.linkedTechnician
      && value.activeTechnician
      && value.assigned
      && ["invoice", "report_only"].includes(value.accessLevel || ""),
  );
}

test("linked technicians require the current explicit assignment", () => {
  for (const accessLevel of ["invoice", "report_only"] as const) {
    assert.equal(canAccessWorkOrder({
      sameCompany: true,
      accessLevel,
      linkedTechnician: true,
      activeTechnician: true,
      assigned: true,
    }), true);
    assert.equal(canAccessWorkOrder({
      sameCompany: true,
      accessLevel,
      linkedTechnician: true,
      activeTechnician: true,
      assigned: false,
      participated: true,
    }), false);
  }
});

test("strict scope preserves company walls and deliberate company roles", () => {
  assert.equal(canAccessWorkOrder({ staff: true }), true);
  assert.equal(canAccessWorkOrder({
    sameCompany: false,
    accessLevel: "company_admin",
  }), false);
  assert.equal(canAccessWorkOrder({
    sameCompany: true,
    accessLevel: "company_admin",
  }), true);
  assert.equal(canAccessWorkOrder({
    sameCompany: true,
    accessLevel: "invoice",
    linkedTechnician: false,
  }), true);
  assert.equal(canAccessWorkOrder({
    sameCompany: true,
    accessLevel: "report_only",
    linkedTechnician: false,
  }), false);
});

test("the effective function cannot authorize from historical participation", () => {
  assert.ok(functionStart >= 0);
  assert.ok(revokeStart > functionStart);
  assert.match(
    accessFunction,
    /work_order\.assigned_technician_profile_id = viewer\.id/,
  );
  assert.match(accessFunction, /technician\.is_active = true/);
  assert.doesNotMatch(accessFunction, /work_order_technician_assignments/);
  assert.doesNotMatch(accessFunction, /work_order_visits/);
  assert.doesNotMatch(accessFunction, /from public\.photos/);
  assert.doesNotMatch(
    accessFunction,
    /work_order\.assigned_technician_profile_id is null/,
  );
});

test("the migration changes authorization only and preserves production rows", () => {
  assert.doesNotMatch(
    migration,
    /(?:update|insert into|delete from|truncate) public\.(?:work_orders|activities|photos|work_order_visits|invoices)/i,
  );
  assert.match(
    migration,
    /revoke all on function public\.can_access_contractor_work_order\(text\)[\s\S]*from public, anon/,
  );
  assert.match(
    migration,
    /grant execute on function public\.can_access_contractor_work_order\(text\)[\s\S]*to authenticated, service_role/,
  );
});

test("all work-order read surfaces continue through the shared RLS boundary", () => {
  assert.match(
    policies,
    /create policy wo_read[\s\S]*can_access_contractor_work_order\(id\)/,
  );
  for (const source of [cursorReads, tableReads, detailReads]) {
    assert.match(source, /security invoker/);
  }
});
