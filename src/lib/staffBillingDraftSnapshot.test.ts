import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { createBillingDraftPayload } from "./billingDraftPersistence";

function draftSave(snapshot: unknown) {
  const source = readFileSync(resolve("src/features/billing/BillingInvoiceCreateModal.tsx"), "utf8");
  const start = source.indexOf("const persistBillingDraft = useCallback(");
  const end = source.indexOf("\n\n  useEffect(", start);
  assert.ok(start >= 0 && end > start);
  const saves: unknown[] = [];
  const states: string[] = [];
  const context = {
    useCallback: (fn: () => boolean) => fn,
    latestDirty: { current: true },
    modal: "createBillingInvoice",
    draftHydrated: { current: true },
    window: {},
    financialSnapshot: { current: snapshot },
    financialContextKey: "new:E2E-SYNTHETIC",
    financialContextReady: Boolean(snapshot),
    getValues: () => ({ workOrderId: "E2E-SYNTHETIC", lines: [] }),
    selectedSourceIds: [], sourceSnapshots: {}, partsMarkup: "25",
    customTerritory: false, numberEdited: false, createBillingDraftPayload,
    draftLease: { current: { save: (payload: unknown) => {
      saves.push(payload);
      return { status: "persisted", savedAt: "2026-11-18T00:00:00.000Z" };
    } } },
    setDraftState: (state: string) => states.push(state),
    setDraftSavedAt: () => undefined,
  };
  const save = new Function(...Object.keys(context), `${source.slice(start, end)}\nreturn persistBillingDraft;`)(...Object.values(context)) as () => boolean;
  return { save, saves, states };
}

test("pending financial revalidation cannot overwrite a recoverable draft with a missing snapshot", () => {
  const h = draftSave(null);
  assert.equal(h.save(), false);
  assert.equal(h.saves.length, 0);
});

test("a snapshot for a previous work order cannot be persisted with newly selected form values", () => {
  const h = draftSave({ key: "new:E2E-OLD", value: { workOrderId: "E2E-OLD", expectedInvoiceVersion: null, expectedAssignmentVersion: 2, expectedWorkflowCycle: 0 } });
  assert.equal(h.save(), false);
  assert.equal(h.saves.length, 0);
});

test("ready draft recovery retains its captured versions rather than creating new write authority", () => {
  const snapshot = { key: "new:E2E-SYNTHETIC", value: { workOrderId: "E2E-SYNTHETIC", expectedInvoiceVersion: null, expectedAssignmentVersion: 2, expectedWorkflowCycle: 0 } };
  const h = draftSave(snapshot);
  assert.equal(h.save(), true);
  assert.deepEqual((h.saves[0] as { financialSnapshot: unknown }).financialSnapshot, snapshot);
});
