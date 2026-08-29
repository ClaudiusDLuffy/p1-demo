import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

const serviceBackedStaffRoutes = [
  "src/app/api/billing-invoices/route.ts",
  "src/app/api/contractor-invoices/route.ts",
  "src/app/api/controller-exports/route.ts",
  "src/app/api/notifications/contractor-attention/route.ts",
  "src/app/api/notifications/dispatch/route.ts",
  "src/app/api/notifications/invoice-review/route.ts",
];

test("service-role-backed staff routes reject inactive profiles", () => {
  for (const path of serviceBackedStaffRoutes) {
    const route = read(path);
    assert.match(route, /auth\.getUser\(/, `${path} must validate the bearer token`);
    assert.match(route, /\.select\("[^"]*active[^"]*"\)/, `${path} must load profile.active`);
    assert.match(route, /!profile\?\.active/, `${path} must reject an inactive profile`);
  }
});

test("shared staff authorization rejects inactive profiles before returning the service client", () => {
  const authorization = read("src/lib/server/staffAuthorization.ts");
  assert.match(authorization, /\.select\("id,name,email,role,active"\)/);
  assert.match(authorization, /!profile\?\.active/);

  const holdRoute = read("src/app/api/contractor-invoice-holds/route.ts");
  assert.match(holdRoute, /requireStaffRequest\(request/);
});

test("QuickBooks archive downloads require the handoff capability", () => {
  const route = read("src/app/api/controller-exports/route.ts");
  const batchBranch = route.slice(
    route.indexOf("if (batchId)"),
    route.indexOf('if (request.nextUrl.searchParams.get("history")'),
  );
  assert.match(batchBranch, /if \(!auth\.canHandoff\)/);
  assert.match(batchBranch, /status: 403|, 403\)/);
});

test("contractor notifications stay bound to validated contractor identities", () => {
  const dispatchRoute = read("src/app/api/notifications/dispatch/route.ts");
  assert.match(
    dispatchRoute,
    /overrideContractorId\s*&&\s*overrideContractorId !== wo\.contractor_id/,
  );
  assert.match(dispatchRoute, /const contractorId = wo\.contractor_id/);
  assert.match(
    dispatchRoute,
    /contractor\?\.role !== "contractor" \|\| !contractor\.active/,
  );

  const attentionRoute = read(
    "src/app/api/notifications/contractor-attention/route.ts",
  );
  assert.match(attentionRoute, /\.select\("email,role,active"\)/);
  assert.match(
    attentionRoute,
    /contractor\?\.role !== "contractor" \|\| !contractor\.active/,
  );

  const reviewRoute = read(
    "src/app/api/notifications/invoice-review/route.ts",
  );
  assert.match(
    reviewRoute,
    /\.select\("id,name,email,company,role,active,contractor_organization_id"\)/,
  );
  assert.match(
    reviewRoute,
    /contractor\.role !== "contractor" \|\| !contractor\.active/,
  );
});

test("the service key remains server-only and is never exposed as a public variable", () => {
  const serverClient = read("src/lib/supabase/server.ts");
  assert.match(serverClient, /SUPABASE_SECRET_KEY/);
  assert.doesNotMatch(serverClient, /NEXT_PUBLIC_SUPABASE_SECRET_KEY/);
});
