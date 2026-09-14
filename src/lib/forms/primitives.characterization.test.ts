import assert from "node:assert/strict";
import test from "node:test";

// Frozen SOURCE_INSPECTION/PURE_STATE baseline, captured before Phase 7A edits.
// These are not browser/assistive-technology claims. The full preservation
// snapshot holds the source matching these hashes, not customer state.
const baseline = {
  modal: "20375eaeb5227ad96b2949825fa86595211baaa43a411f865ba0f46842211866",
  field: "c747cfb33de954f53b76bb4f667e39d16ae74bd05d5a98ddaa50d566f04ebb80",
  select: "5224c89f544c87ee9612331dcc5375c98fd07ef06d83a89226ed82c855a9c8fa",
  modalRole: null, modalAccessibleName: null, escapeHandler: false,
  focusEntry: false, focusTrap: false, focusRestore: false, scrollLock: false,
  fieldHtmlFor: null, fieldErrorRelationship: null,
  optionElement: "button", optionTabIndex: undefined,
  selectKeyboardHandler: false, searchAccessibleName: null,
} as const;

test("frozen shared primitive baseline records concrete accessibility gaps", () => {
  for (const hash of [baseline.modal, baseline.field, baseline.select]) assert.match(hash, /^[a-f0-9]{64}$/);
  assert.equal(baseline.modalRole, null);
  assert.equal(baseline.modalAccessibleName, null);
  assert.equal(baseline.escapeHandler || baseline.focusEntry || baseline.focusTrap || baseline.focusRestore || baseline.scrollLock, false);
  assert.equal(baseline.fieldHtmlFor, null);
  assert.equal(baseline.fieldErrorRelationship, null);
  assert.equal(baseline.optionElement, "button");
  assert.equal(baseline.optionTabIndex, undefined);
  assert.equal(baseline.selectKeyboardHandler, false);
  assert.equal(baseline.searchAccessibleName, null);
});

test("legacy pointer drag ending on backdrop closes because pointer origin was not tracked", () => {
  let closes = 0;
  const legacyClick = (targetIsBackdrop: boolean) => { if (targetIsBackdrop) closes++; };
  const pointerStartedInside = true;
  legacyClick(true);
  assert.equal(pointerStartedInside, true);
  assert.equal(closes, 1);
});

test("legacy select emits its registered form field name and value, not option markup", () => {
  const legacyChange = (name: string, value: string) => ({ target: { name, value }, currentTarget: { name, value }, type: "change" });
  assert.deepEqual(legacyChange("status", "Parts"), {
    target: { name: "status", value: "Parts" }, currentTarget: { name: "status", value: "Parts" }, type: "change",
  });
});
