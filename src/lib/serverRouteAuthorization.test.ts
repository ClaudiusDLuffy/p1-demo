import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { controllerBoundaryHarness } from "../server/controller-exports/testing/boundaryHarness";
import { controllerTestIds } from "../server/controller-exports/testing/authorizationPorts";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

const serviceBackedStaffRoutes = [
  "src/app/api/billing-invoices/route.ts",
  "src/app/api/contractor-invoices/route.ts",
  "src/app/api/controller-exports/route.ts",
  "src/app/api/notifications/contractor-attention/route.ts",
  "src/app/api/notifications/dispatch/route.ts",
];

test("service-role-backed staff routes reject inactive profiles", async () => {
  for (const path of serviceBackedStaffRoutes) {
    if (path === "src/app/api/controller-exports/route.ts") {
      const h = controllerBoundaryHarness({ authorization: { active: false } });
      const response = await h.route("GET", new Request("https://synthetic.invalid/api/controller-exports", { headers: { Authorization: "Bearer synthetic-controller" } }));
      assert.equal(response.status, 403); assert.equal(h.service.calls.length, 0);
      assert.equal(h.ports.calls.filter(call => call.name === "getUser").length, 1);
      assert.equal(h.ports.calls.find(call => call.name === "select:profiles")?.value, "id,name,role,active");
      assert.equal(h.ports.calls.filter(call => call.name === "read:staff_permission_grants").length, 0);
      continue;
    }
    const route = read(path);
    assert.match(route, /auth\.getUser\(/, `${path} must validate the bearer token`);
    assert.match(route, /\.select\("[^"]*active[^"]*"\)/, `${path} must load profile.active`);
    assert.match(route, /!profile\?\.active/, `${path} must reject an inactive profile`);
  }
  const financialRoute = read("src/app/api/notifications/invoice-review/route.ts");
  const financialAuthorization = read("src/lib/server/financialNotificationHttp.ts");
  assert.match(financialRoute, /await authorizeFinancialRequest\(request, false\)/);
  assert.ok(financialRoute.indexOf("await authorizeFinancialRequest") < financialRoute.indexOf("await readFinancialRequest"));
  assert.match(financialAuthorization, /caller\.auth\.getUser\(token\)/);
  assert.match(financialAuthorization, /\.select\("id,role,active"\)/);
  assert.match(financialAuthorization, /!profile\.active/);
});

test("shared staff authorization rejects inactive profiles before returning the service client", () => {
  const authorization = read("src/lib/server/staffAuthorization.ts");
  assert.match(authorization, /\.select\("id,name,email,role,active"\)/);
  assert.match(authorization, /!profile\?\.active/);

  const holdRoute = read("src/app/api/contractor-invoice-holds/route.ts");
  assert.match(holdRoute, /authorizeFinancialRequest\(request, true\)/);
  const financialAuthorization = read("src/lib/server/financialNotificationHttp.ts");
  assert.match(financialAuthorization, /caller\.auth\.getUser\(token\)/);
  assert.match(financialAuthorization, /\.select\("id,role,active"\)/);
  assert.match(financialAuthorization, /!profile\.active/);
});

test("QuickBooks archive downloads require the handoff capability", async () => {
  for (const permissions of [[], ["invoice_controller"], ["quickbooks_export"], ["quickbooks_handoff"]]) {
    const h = controllerBoundaryHarness({ authorization: { permissions } });
    const response = await h.route("GET", new Request(`https://synthetic.invalid/api/controller-exports?batch=${controllerTestIds.batch}`, { headers: { Authorization: "Bearer synthetic-controller" } }));
    assert.equal(response.status, permissions.includes("quickbooks_handoff") ? 200 : 403);
    assert.equal(h.service.calls.length, permissions.includes("quickbooks_handoff") ? 1 : 0);
  }
});

test("contractor notifications stay bound to validated contractor identities", () => {
  const dispatchRoute = read("src/app/api/notifications/dispatch/route.ts");
  assert.match(
    dispatchRoute,
    /overrideContractorId\s*&&\s*overrideContractorId !== wo\.contractor_id/,
  );
  assert.match(dispatchRoute, /const contractorId = wo\.contractor_id/);
  // Receiving compatibility now reads the current event. The service prepare
  // command revalidates the recipient immediately before the actual send.
  assert.match(dispatchRoute, /auth\.caller\.rpc\("get_receiving_dispatch_current_v1"/);
  assert.match(dispatchRoute, /p_assignment_version: wo\.contractor_assignment_version/);
  assert.doesNotMatch(dispatchRoute, /sendEmail|sendDispatchNotification/);
  const receivingBoundary = read("supabase/migrations/0135_receiving_dispatch_staff_closeout.sql");
  assert.match(receivingBoundary, /perform public\.require_assignable_contractor\(v\.recipient_profile_id\)/);

  const attentionRoute = read(
    "src/app/api/notifications/contractor-attention/route.ts",
  );
  assert.match(attentionRoute, /\.select\("email,role,active"\)/);
  assert.match(
    attentionRoute,
    /contractor\?\.role !== "contractor" \|\| !contractor\.active/,
  );
  assert.match(
    attentionRoute,
    /activity\.contractor_assignment_version !== workOrder\.contractor_assignment_version/,
  );
  assert.match(
    attentionRoute,
    /activityCreatedAt < assignmentStartedAt/,
  );
  assert.match(
    attentionRoute,
    /claim_contractor_activity_alert_delivery/,
  );
  assert.match(
    attentionRoute,
    /p_actor_id: auth\.profile\.id/,
  );

  const reviewRoute = read(
    "src/app/api/notifications/invoice-review/route.ts",
  );
  assert.match(reviewRoute, /get_financial_notification_review_compatibility_v1/);
  assert.doesNotMatch(reviewRoute, /sendEmail|sendInvoiceReviewNotification/);
  const financialBoundary = read("supabase/migrations/0136_expand_financial_notification_delivery.sql");
  assert.match(financialBoundary, /p\.role='contractor' and p\.active/);
  assert.match(financialBoundary, /public\.contractor_account_id_for_profile\(p\.id\)=p\.id/);
  assert.match(financialBoundary, /not public\.financial_notification_recipient_valid\(d\)[\s\S]*RECIPIENT_NOT_DELIVERABLE/);
});

test("the service key remains server-only and is never exposed as a public variable", () => {
  const serverClient = read("src/lib/supabase/server.ts");
  assert.match(serverClient, /getServerSupabaseConfig/);
  const configuration = read("src/lib/config/server/supabase.ts");
  assert.match(configuration, /SUPABASE_SECRET_KEY/);
  assert.match(configuration, /node:process/);
  assert.doesNotMatch(read("src/lib/config/public.ts"), /process\.env\.SUPABASE_SECRET_KEY/);
  assert.doesNotMatch(serverClient, /NEXT_PUBLIC_SUPABASE_SECRET_KEY/);
});
