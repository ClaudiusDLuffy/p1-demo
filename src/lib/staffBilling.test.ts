import assert from "node:assert/strict";
import test from "node:test";
import {
  applyStaffBillingPartsMarkup,
  importedStaffBillingRate,
  normalizeImportedStaffBillingLineType,
  normalizeStaffBillingLineType,
  roundStaffBillingMarkupPercent,
  staffBillingDescriptionPlaceholder,
  staffBillingMarkupPercent,
} from "./staffBilling";

test("normalizes overtime labor before generic labor", () => {
  assert.equal(normalizeStaffBillingLineType("OT Labor"), "OT Labor");
  assert.equal(normalizeStaffBillingLineType("overtime labor"), "OT Labor");
});

test("recognizes overtime wording in imported descriptions", () => {
  assert.equal(
    normalizeImportedStaffBillingLineType("Labor", "Overtime labor - emergency call"),
    "OT Labor",
  );
  assert.equal(
    normalizeImportedStaffBillingLineType("Labor", "OT labour after hours"),
    "OT Labor",
  );
  assert.equal(
    normalizeImportedStaffBillingLineType("Labor", "Labor overtime hours"),
    "OT Labor",
  );
  assert.equal(
    normalizeImportedStaffBillingLineType("Labor", "Regular labor"),
    "Labor",
  );
  assert.equal(
    normalizeImportedStaffBillingLineType("Parts/Hardware", "Overtime labor relay"),
    "Parts/Hardware",
  );
});

test("recognizes parts mislabeled as Other without overriding labor or travel", () => {
  assert.equal(
    normalizeImportedStaffBillingLineType("Other", "Replacement compressor"),
    "Parts/Hardware",
  );
  assert.equal(
    normalizeImportedStaffBillingLineType("Other", "Contactor and capacitor"),
    "Parts/Hardware",
  );
  assert.equal(
    normalizeImportedStaffBillingLineType("Other", "Labor to replace compressor"),
    "Labor",
  );
  assert.equal(
    normalizeImportedStaffBillingLineType("Other", "Travel to pick up replacement motor"),
    "Travel",
  );
  assert.equal(
    normalizeImportedStaffBillingLineType("Other", "Freight for control board"),
    "Shipping",
  );
  assert.equal(
    normalizeImportedStaffBillingLineType("Other", "General contracted service"),
    "Other",
  );
});

test("imports fixed labor and travel rates without markup", () => {
  assert.equal(importedStaffBillingRate("Labor", 80), 110);
  assert.equal(importedStaffBillingRate("Travel", 45), 110);
  assert.equal(importedStaffBillingRate("OT Labor", 120), 165);
});

test("applies the adjustable markup only to imported parts", () => {
  assert.equal(importedStaffBillingRate("Parts/Hardware", 200, 25), 250);
  assert.equal(importedStaffBillingRate("Other", 200, 25), 200);
});

test("manual parts establish their cost when markup is first applied", () => {
  assert.deepEqual(applyStaffBillingPartsMarkup(null, 200, 25), {
    sourceUnitCost: 200,
    markupPercent: 25,
    rate: 250,
  });
  assert.deepEqual(applyStaffBillingPartsMarkup(80, 100, 50), {
    sourceUnitCost: 80,
    markupPercent: 50,
    rate: 120,
  });
  assert.equal(applyStaffBillingPartsMarkup(null, 0, 25), null);
});

test("manual final-rate edits keep the displayed parts markup accurate", () => {
  assert.equal(staffBillingMarkupPercent(80, 120), 50);
  assert.equal(staffBillingMarkupPercent(80, 100), 25);
  assert.equal(staffBillingMarkupPercent(100, 244.23), 144.2);
  assert.equal(staffBillingMarkupPercent(80, 79), null);
});

test("parts markup is normalized to the UI's one-decimal increment", () => {
  assert.equal(roundStaffBillingMarkupPercent(144.23), 144.2);
  assert.deepEqual(applyStaffBillingPartsMarkup(100, 244.23, 144.23), {
    sourceUnitCost: 100,
    markupPercent: 144.2,
    rate: 244.2,
  });
});

test("labor prompts for job notes while travel remains optional", () => {
  assert.equal(staffBillingDescriptionPlaceholder("Labor"), "Enter job notes");
  assert.equal(staffBillingDescriptionPlaceholder("OT Labor"), "Enter job notes");
  assert.equal(staffBillingDescriptionPlaceholder("Travel"), "Description (optional)");
  assert.equal(staffBillingDescriptionPlaceholder("Parts/Hardware"), "Description");
});
