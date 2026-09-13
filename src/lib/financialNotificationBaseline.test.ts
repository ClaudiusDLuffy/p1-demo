import assert from "node:assert/strict";
import test from "node:test";
import { installSyntheticAppEnvironment } from "./config-test-support/syntheticAppEnvironment";

installSyntheticAppEnvironment();
import { baselineFinancialRoute } from "./financial-notification-test-support/baselineRouteHarness";

test("pre-fix real rejection route can send twice after provider acceptance with a lost response", async () => {
  const h = baselineFinancialRoute("review");
  h.failAfterAcceptance();
  assert.equal((await h.request()).status, 500);
  assert.equal((await h.request()).status, 500);
  assert.equal(h.accepted.length, 2);
  assert.deepEqual(h.accepted[0], h.accepted[1]);
  assert.equal(h.rpcCalls.length, 0, "Direct route never creates or claims a durable provider attempt");
});

test("pre-fix real retraction route repeats the approved-correction message without an event claim", async () => {
  const h = baselineFinancialRoute("review");
  h.rows.invoices[0].state = "approved";
  for (let index = 0; index < 2; index++) assert.equal((await h.request({ event: "retraction" })).status, 200);
  assert.equal(h.accepted.length, 2);
  assert.match(h.accepted[0].body, /invoice is now approved; no correction or resubmission is needed/);
  assert.equal(h.rpcCalls.length, 0);
});

test("pre-fix actual review route selects only canonical contractor and eligible same-company creator", async () => {
  for (const [access, active, linked, sameCompany, expected] of [
    ["invoice", true, true, true, 2], ["company_admin", true, false, true, 2],
    ["report_only", true, true, true, 1], ["invoice", false, true, true, 1],
    ["invoice", true, false, true, 1], ["invoice", true, true, false, 1],
  ] as const) {
    const h = baselineFinancialRoute("review");
    h.companyCreator(access, active, linked, sameCompany);
    assert.equal((await h.request()).status, 200);
    assert.equal(h.accepted[0].recipients.length, expected);
    assert.deepEqual(h.accepted[0].recipients, expected === 2 ? ["contractor@example.invalid", "creator@example.invalid"] : ["contractor@example.invalid"]);
  }
});

test("pre-fix review route checks current invoice revision activity and active canonical company before direct send", async () => {
  for (const scenario of ["missing_activity", "inactive_contractor", "inactive_company", "wrong_canonical"] as const) {
    const h = baselineFinancialRoute("review");
    h.companyCreator();
    if (scenario === "missing_activity") h.rows.activities = [];
    if (scenario === "inactive_contractor") h.rows.profiles[1].active = false;
    if (scenario === "inactive_company") h.rows.organizations[0].active = false;
    if (scenario === "wrong_canonical") h.rows.organizations[0].canonical_contractor_id = "other-synthetic-profile";
    assert.equal((await h.request()).status, 409);
    assert.equal(h.accepted.length, 0);
  }
});

test("pre-fix rejected notification still requires auth before body processing", async () => {
  const anonymous = baselineFinancialRoute("review");
  assert.equal((await anonymous.request({}, false)).status, 401);
  assert.equal(anonymous.bodyReads(), 0);
  const invalid = baselineFinancialRoute("review");
  invalid.invalidSession();
  assert.equal((await invalid.request()).status, 401);
  assert.equal(invalid.bodyReads(), 0);
});

test("pre-fix hold route sends after an already-held no-op and emails changed request reason", async () => {
  const h = baselineFinancialRoute("holds");
  assert.equal((await h.request()).status, 200);
  const second = await h.request({ reason: "Synthetic changed request reason" });
  assert.equal(second.status, 200);
  assert.equal(h.holdEvents.length, 1);
  assert.equal(h.getCurrentHold(), "Synthetic original hold reason");
  assert.equal(h.accepted.length, 2);
  assert.match(h.accepted[1].body, /Synthetic changed request reason/);
  assert.equal((await second.json()).result.applied, false);
});

test("pre-fix release route sends again despite no remaining hold and no new release event", async () => {
  const h = baselineFinancialRoute("holds");
  h.setCurrentHold("Synthetic active hold");
  assert.equal((await h.request({ action: "release", reason: "Synthetic release" })).status, 200);
  assert.equal((await h.request({ action: "release", reason: "Synthetic release" })).status, 200);
  assert.equal(h.holdEvents.length, 1);
  assert.equal(h.accepted.length, 2);
  assert.match(h.accepted[0].body, /eligible for the payables handoff queue again/);
});

test("pre-fix hold commit survives a provider timeout but retry sends the accepted message again", async () => {
  const h = baselineFinancialRoute("holds");
  h.failAfterAcceptance();
  for (let index = 0; index < 2; index++) {
    const response = await h.request();
    assert.equal(response.status, 200);
    assert.match((await response.json()).notificationWarning, /change was saved/);
  }
  assert.equal(h.holdEvents.length, 1);
  assert.equal(h.accepted.length, 2);
  assert.ok(h.getCurrentHold());
});

test("pre-fix handoff recipient selection has no owner fallback and absent recipients leave only a warning", async () => {
  const h = baselineFinancialRoute("holds");
  h.rows.staff_permission_grants = [];
  const response = await h.request();
  assert.equal(response.status, 200);
  assert.equal(h.accepted.length, 0);
  assert.equal(h.holdEvents.length, 1);
  assert.ok((await response.json()).notificationWarning);
});

test("pre-fix handoff recipient lookup checks active state but does not exclude a role-downgraded grant holder", async () => {
  const h = baselineFinancialRoute("holds");
  h.rows.profiles[2].role = "contractor";
  assert.equal((await h.request()).status, 200);
  assert.deepEqual(h.accepted[0].recipients, ["handoff@example.invalid"]);
  assert.match(h.accepted[0].body, /Synthetic original hold reason/);
});
