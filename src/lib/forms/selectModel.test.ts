import assert from "node:assert/strict";
import test from "node:test";
import { nextEnabledOption, typeaheadOption, MAX_SELECT_SEARCH, SELECT_TYPEAHEAD_MS, type SelectOption } from "./selectModel";
const options: SelectOption[] = ["Alpha", "Beta", "Alpine", "Charlie", "Delta"].map((label, index) => ({
  index, label, value: index < 2 ? "duplicate-value" : String(index), sub: "", search: label, disabled: index === 1,
}));
test("selection movement wraps and skips disabled options; Home/End are deterministic", () => {
  assert.equal(nextEnabledOption(options, 0, "next"), 2);
  assert.equal(nextEnabledOption(options, 0, "previous"), 4);
  assert.equal(nextEnabledOption(options, 4, "next"), 0);
  assert.equal(nextEnabledOption(options, 2, "first"), 0);
  assert.equal(nextEnabledOption(options, 2, "last"), 4);
  assert.equal(nextEnabledOption(options, -1, "previous"), 4);
});
test("empty/all-disabled options never select an invalid item", () => {
  for (const direction of ["next", "previous", "first", "last"] as const) {
    assert.equal(nextEnabledOption([], 0, direction), -1);
    assert.equal(nextEnabledOption(options.map(option => ({ ...option, disabled: true })), 0, direction), -1);
  }
});
test("typeahead handles repeated characters, searches forward, and retains current when absent", () => {
  assert.equal(typeaheadOption(options, 0, "a"), 2);
  assert.equal(typeaheadOption(options, 2, "aa"), 0);
  assert.equal(typeaheadOption(options, 0, "alpI"), 2);
  assert.equal(typeaheadOption(options, 0, "b"), 0);
  assert.equal(typeaheadOption(options, 2, "not-found"), 2);
  assert.equal(typeaheadOption([], -1, "a"), -1);
});
test("selection identity remains source-index based even duplicate values/labels", () => {
  const repeated = options.map(option => ({ ...option, value: "same", label: "Same", disabled: false }));
  assert.equal(nextEnabledOption(repeated, 0, "next"), 1);
  assert.equal(new Set(repeated.map(option => `list-option-${option.index}`)).size, repeated.length);
  assert.equal(MAX_SELECT_SEARCH, 200); assert.equal(SELECT_TYPEAHEAD_MS, 700);
});
