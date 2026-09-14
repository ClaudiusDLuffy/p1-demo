import assert from "node:assert/strict";
import test from "node:test";
import { legacyInvoicePdfAdmission } from "./pdf/test-fixtures/legacyInvoicePdfAdmission";

const actorId = "71000000-0000-4000-8000-000000000001";
const token = `synthetic.${Buffer.from(JSON.stringify({ sub: actorId })).toString("base64url")}.signature`;
const headers = new Headers({ Authorization: `Bearer ${token}` });
test("legacy reproduction: own-profile visibility admitted inactive and report-only identities", async () => {
  for (const profile of [{ id: actorId, active: false }, { id: actorId, active: true, contractor_access_level: "report_only" }]) {
    const form = new FormData(); form.append("file", new File(["not PDF bytes"], "declared.pdf"));
    const result = await legacyInvoicePdfAdmission({ headers, formData: async () => form }, async () => [profile]);
    assert.equal(result.status, 200, "The old route never selected active status or invoice capability");
  }
});
test("legacy reproduction: spoofed PDF declaration and extra fields reached extraction", async () => {
  const form = new FormData();
  form.append("file", new File(["plain text pretending to be PDF"], "claimed.pdf", { type: "text/plain" }));
  form.append("unbounded-extra", "synthetic unrelated content");
  form.append("file", new File(["ignored duplicate"], "duplicate.pdf"));
  let bodyWasParsed = false;
  const result = await legacyInvoicePdfAdmission({ headers, formData: async () => { bodyWasParsed = true; return form; } },
    async () => [{ id: actorId }]);
  assert.equal(bodyWasParsed, true);
  assert.equal(result.status, 200);
  assert.equal(new TextDecoder().decode(result.bytes), "plain text pretending to be PDF");
});
