import assert from "node:assert/strict";
import test from "node:test";
import { PORTAL_REALTIME_TABLES } from "../realtimeInvalidation";
import { normalizeRealtimeEvent } from "./realtimeEvent";
for (const table of PORTAL_REALTIME_TABLES) for (const eventType of ["INSERT", "UPDATE", "DELETE"]) {
  test(`normalization ${table} ${eventType} keeps bounded new/old identities only`, () => {
    const fields = { id: "row-a", work_order_id: "WOT-A", invoice_id: "invoice-a", email: "private-canary@example.invalid", notes: "private-canary", description: "private-canary" };
    const parsed = normalizeRealtimeEvent({ table, eventType, new: eventType === "DELETE" ? {} : fields, old: eventType === "DELETE" ? fields : {} });
    assert.ok(parsed); assert.equal(parsed.recordId, "row-a"); assert.equal(parsed.eventType, eventType);
    assert.doesNotMatch(JSON.stringify(parsed), /private-canary|description|email|notes/);
    assert.equal(parsed.workOrderId, table === "work_orders" ? "row-a" : "WOT-A");
  });
}
test("malformed, getter, unknown and oversized event data never crashes the callback", () => {
  for (const candidate of [null, [], false, {}, { table: "other", eventType: "DELETE" }, { table: "photos", eventType: "OTHER" }, { get table() { throw new Error("synthetic getter"); } }]) assert.equal(normalizeRealtimeEvent(candidate), null);
  const event = normalizeRealtimeEvent({ table: "photos", eventType: "DELETE", old: { id: "x".repeat(1000), work_order_id: "a b", private: "canary" } });
  assert.ok(event); assert.equal(event.recordId, null); assert.equal(event.workOrderId, null);
});
test("updated parent and company identities both survive without treating them as authority", () => {
  const event = normalizeRealtimeEvent({ table: "work_order_technician_assignments", eventType: "UPDATE", new: { id: "link-a", work_order_id: "WOT-B", contractor_id: "company-b" }, old: { work_order_id: "WOT-A", contractor_id: "company-a" } });
  assert.equal(event?.previousWorkOrderId, "WOT-A"); assert.equal(event?.workOrderId, "WOT-B");
  assert.equal(event?.previousCompanyId, "company-a"); assert.equal(event?.companyId, "company-b");
});
