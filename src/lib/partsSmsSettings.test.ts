import assert from "node:assert/strict";
import test from "node:test";
import { partsSettingsCommandSchema } from "../features/parts-sms/settingsContract";
import { partsModuleHarness } from "./partsSmsOperatorTestHarness";

const actor = "81000000-0000-4000-8000-000000000001";
const recipient = { profileId: "81000000-0000-4000-8000-000000000002", phoneE164: "+12025550101", active: true };
const valid = () => ({ enabled: true, timezone: "America/New_York", cutoffTime: "17:00", recipients: [recipient] });
function route(options: { denied?: number; rpcError?: unknown; authThrows?: boolean; readError?: boolean; recipientCount?: number } = {}) {
  const calls: { name: string; args: unknown }[] = [];
  const reads: { method: string; value: unknown }[] = [];
  const query = (table: string) => {
    const chain = { select: () => chain, eq: () => chain,
      order: (value: unknown) => { reads.push({ method: "order", value }); return chain; },
      limit: (value: unknown) => { reads.push({ method: "limit", value }); return chain; }, maybeSingle: () => chain,
      then: (resolveResult: (value: unknown) => unknown) => Promise.resolve(resolveResult({ error: options.readError ? { message: "private database detail" } : null,
        data: table === "p1_parts_alert_settings" ? { enabled: true, timezone: "America/New_York", cutoff_time: "17:00:00", updated_at: "2026-09-10T00:00:00Z" }
          : Array.from({ length: options.recipientCount ?? 1 }, () => ({ id: recipient.profileId, profile_id: recipient.profileId, phone_e164: recipient.phoneE164, active: true, profiles: { name: "Synthetic Staff", email: null } })) })) };
    return chain;
  };
  const sb = { from: query, rpc: async (name: string, args: unknown) => { calls.push({ name, args }); return { error: options.rpcError || null }; } };
  const harness = partsModuleHarness("src/app/api/parts-order-settings/route.ts", { "../../../lib/server/staffAuthorization": {
    requireStaffRequest: async () => { if (options.authThrows) throw new Error("private auth detail"); return options.denied
      ? { error: Response.json({ error: "private auth detail" }, { status: options.denied }) } : { sb, profile: { id: actor } }; },
  } });
  const patch = async (body: unknown) => harness.call("PATCH", new Request("https://synthetic.invalid/api/parts-order-settings", {
    method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  })) as Promise<Response>;
  return { calls, reads, patch, harness };
}
test("parts settings baseline coercion reproduces string-false enabling and numeric-active acceptance", () => {
  assert.equal(Boolean("false"), true);
  const oldActive = (value: unknown) => value !== false;
  for (const value of ["false", "true", "0", "1", 0, 1]) assert.equal(oldActive(value), true);
});
for (const value of ["false", "true", "0", "1", 0, 1, null, {}, []]) test(`parts settings rejects nonboolean enabled ${JSON.stringify(value)} with zero writes`, async () => {
  const h = route(); const response = await h.patch({ ...valid(), enabled: value }); assert.equal(response.status, 400); assert.equal(h.calls.length, 0);
});
for (const value of ["false", "true", "0", "1", 0, 1, null]) test(`parts recipient active rejects ${JSON.stringify(value)} with zero writes`, async () => {
  const h = route(); assert.equal((await h.patch({ ...valid(), recipients: [{ ...recipient, active: value }] })).status, 400); assert.equal(h.calls.length, 0);
});
test("parts settings valid true/false preserve response and only validated authority fields reach RPC", async () => {
  for (const enabled of [true, false]) {
    const h = route(); const response = await h.patch({ ...valid(), enabled, recipients: [{ ...recipient, name: "Synthetic label", email: "synthetic@example.invalid", id: recipient.profileId }] });
    assert.equal(response.status, 200); assert.equal(h.calls.length, 1); assert.equal(h.calls[0].name, "configure_p1_parts_alerts");
    assert.deepEqual(JSON.parse(JSON.stringify(h.calls[0].args)), { p_actor_id: actor, p_enabled: enabled, p_timezone: "America/New_York", p_cutoff_time: "17:00", p_recipients: [recipient] });
    const body = await response.json(); assert.equal(body.recipients[0].profileId, recipient.profileId); assert.equal(body.cutoffTime, "17:00");
  }
});
test("settings reject malformed shape, metadata, timezone, cutoff, duplicate profiles and excessive recipients", async () => {
  const invalid: unknown[] = [null, [], {}, { ...valid(), action: "send" }, { ...valid(), timezone: "Invalid/Nowhere" },
    { ...valid(), timezone: "x".repeat(101) }, { ...valid(), cutoffTime: "24:00" }, { ...valid(), cutoffTime: "1:00" },
    { ...valid(), cutoffTime: null }, { ...valid(), recipients: [] }, { ...valid(), recipients: "wrong" },
    { ...valid(), recipients: [recipient, recipient] }, { ...valid(), recipients: [{ ...recipient, profileId: "wrong" }] },
    { ...valid(), recipients: [{ ...recipient, phoneE164: "2025550101" }] }, { ...valid(), recipients: [{ ...recipient, name: "x".repeat(201) }] },
    { ...valid(), recipients: [{ ...recipient, providerSid: "forged" }] }, { ...valid(), recipients: Array.from({ length: 26 }, () => recipient) }];
  for (const body of invalid) { const h = route(); assert.equal((await h.patch(body)).status, 400); assert.equal(h.calls.length, 0); }
});
test("recipient cap is 25 profiles, phone formatting preserved and same phone on separate staff remains allowed", () => {
  const recipients = Array.from({ length: 25 }, (_, index) => ({ ...recipient, profileId: `81000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}` }));
  assert.equal(partsSettingsCommandSchema.safeParse({ ...valid(), recipients }).success, true);
  const parsed = partsSettingsCommandSchema.parse({ ...valid(), recipients: [{ ...recipient, phoneE164: "+1 (202) 555-0101" }] });
  assert.equal(parsed.recipients[0].phoneE164, recipient.phoneE164);
  assert.equal(partsSettingsCommandSchema.safeParse({ ...valid(), recipients: [{ ...recipient, active: false }] }).success, true);
});
test("settings reader is deterministically bounded and corrupt capacity fails closed", async () => {
  const h = route({ recipientCount: 26 }); const response = await h.harness.call("GET", new Request("https://synthetic.invalid")) as Response;
  assert.equal(response.status, 503); assert.equal(h.calls.length, 0);
  assert.deepEqual(h.reads, [{ method: "order", value: "created_at" }, { method: "order", value: "id" }, { method: "limit", value: 26 }]);
  assert.doesNotMatch(await response.text(), /phone|private|Synthetic/);
});
test("malformed JSON is not converted into a disabling settings write", async () => {
  const h = route(); const response = await h.harness.call("PATCH", new Request("https://synthetic.invalid", { method: "PATCH", body: "{" })) as Response;
  assert.equal(response.status, 400); assert.equal(h.calls.length, 0);
});
test("settings authorization fails before body consumption and safely sanitizes current auth failure", async () => {
  for (const status of [401, 403, 500]) {
    const h = route({ denied: status }); let consumed = false;
    const request = new Request("https://synthetic.invalid/api/parts-order-settings", { method: "PATCH", body: JSON.stringify(valid()), headers: { "Content-Type": "application/json" } });
    Object.defineProperty(request, "json", { value: () => { consumed = true; throw new Error("body consumed"); } });
    const response = await h.harness.call("PATCH", request) as Response;
    assert.equal(response.status, status === 500 ? 503 : status); assert.equal(consumed, false); assert.equal(h.calls.length, 0);
    assert.equal(request.bodyUsed, false);
    assert.match(response.headers.get("X-Request-ID") || "", /^[0-9a-f-]{36}$/);
    assert.doesNotMatch(await response.text(), /private auth detail/);
  }
});
test("settings return only safe error contracts for database/auth failures", async () => {
  for (const options of [{ rpcError: { message: "private provider detail", code: "XX000" } }, { authThrows: true }, { readError: true }]) {
    const h = route(options); const response = await h.patch(valid()); assert.equal(response.status, 503);
    assert.doesNotMatch(await response.text(), /private|provider detail/);
  }
});
