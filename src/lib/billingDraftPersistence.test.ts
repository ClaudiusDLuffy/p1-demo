import assert from "node:assert/strict";
import test from "node:test";
import {
  BILLING_DRAFT_MAX_AGE_MS,
  billingDraftStorageKey,
  createBillingDraftPayload,
  readBillingDraft,
  writeBillingDraft,
} from "./billingDraftPersistence";

const memoryStorage = () => {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
};

test("new and existing billing drafts use user-scoped keys", () => {
  assert.equal(
    billingDraftStorageKey({ userId: "staff-1" }),
    "p1:staff-billing-draft:v1:staff-1:new",
  );
  assert.equal(
    billingDraftStorageKey({ userId: "staff-1", editingInvoiceId: "inv/2" }),
    "p1:staff-billing-draft:v1:staff-1:edit:inv%2F2",
  );
});

test("a partial draft round-trips without requiring valid invoice lines", () => {
  const storage = memoryStorage();
  const key = billingDraftStorageKey({ userId: "lynzy" });
  const payload = createBillingDraftPayload({
    savedAt: "2026-08-06T01:00:00.000Z",
    form: {
      num: "P1-L-1234",
      workOrderId: "WOT100",
      storeNumber: "123",
      invoiceDate: "2026-08-06",
      lines: [{ type: "Labor", desc: "Half-entered", qty: 1, rate: "" }],
    },
    selectedSourceIds: ["source-1"],
    partsMarkup: "25",
    numberEdited: true,
  });
  writeBillingDraft(storage, key, payload);
  const restored = readBillingDraft(storage, key, Date.parse("2026-08-06T01:05:00.000Z"));
  assert.equal(restored?.form.num, "P1-L-1234");
  assert.equal(restored?.form.workOrderId, "WOT100");
  assert.deepEqual(restored?.selectedSourceIds, ["source-1"]);
  assert.equal(restored?.numberEdited, true);
  assert.equal((restored?.form.lines as Array<{ rate: unknown }>)[0].rate, "");
});

test("expired or malformed browser drafts are removed", () => {
  const storage = memoryStorage();
  const key = billingDraftStorageKey({ userId: "staff-2" });
  const payload = createBillingDraftPayload({
    savedAt: "2026-01-01T00:00:00.000Z",
    form: { num: "old" },
  });
  writeBillingDraft(storage, key, payload);
  const now = Date.parse("2026-01-01T00:00:00.000Z") + BILLING_DRAFT_MAX_AGE_MS + 1;
  assert.equal(readBillingDraft(storage, key, now), null);
  assert.equal(storage.getItem(key), null);

  storage.setItem(key, "not-json");
  assert.equal(readBillingDraft(storage, key), null);
  assert.equal(storage.getItem(key), null);
});
