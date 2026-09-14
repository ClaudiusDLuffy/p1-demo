import assert from "node:assert/strict";
import test from "node:test";
import {
  initialStaffBillingTerms, nextStaffBillingDueDate, staffBillingDueDate,
  NEW_STAFF_BILLING_TERMS, LEGACY_STAFF_BILLING_TERMS, STAFF_BILLING_TERMS_OPTIONS,
} from "./staffBillingTerms";
import { createBillingDraftPayload, parseBillingDraft } from "./billingDraftPersistence";

test("only new P1 billing forms default to Net 60 and a 60-calendar-day due date", () => {
  assert.equal(NEW_STAFF_BILLING_TERMS, "Net 60");
  assert.equal(LEGACY_STAFF_BILLING_TERMS, "Net 30");
  assert.deepEqual(STAFF_BILLING_TERMS_OPTIONS, ["Net 60", "Net 30", "Net 15", "Due on receipt"]);
  assert.deepEqual(initialStaffBillingTerms({ invoiceDate: "2026-09-09" }), {
    terms: "Net 60", dueDate: "2026-11-08",
  });
  assert.deepEqual(initialStaffBillingTerms({ invoiceDate: "2026-09-09", editing: true }), {
    terms: "Net 30", dueDate: "2026-10-09",
  });
});

test("existing explicit terms and due dates are retained, including custom terms", () => {
  for (const terms of ["Net 30", "Net 15", "Due on receipt", "Net 45", "Net 60"]) {
    assert.deepEqual(initialStaffBillingTerms({
      invoiceDate: "2026-09-09", editing: true, terms, dueDate: "2027-01-31",
    }), { terms, dueDate: "2027-01-31" });
  }
});

test("supported terms use calendar days across months, leap years and DST dates", () => {
  assert.equal(staffBillingDueDate("2026-09-09", "Net 30"), "2026-10-09");
  assert.equal(staffBillingDueDate("2026-09-09", "Net 15"), "2026-09-24");
  assert.equal(staffBillingDueDate("2026-09-09", "Due on receipt"), "2026-09-09");
  assert.equal(staffBillingDueDate("2028-01-01", "Net 60"), "2028-03-01");
  assert.equal(staffBillingDueDate("2026-11-01", "Net 60"), "2026-12-31");
  assert.equal(staffBillingDueDate("2026-03-08", "Net 60"), "2026-05-07");
  for (const date of ["", "2026-02-30", "2026-13-01", "not-a-date", "2026-9-09", "9999-12-31"]) {
    assert.equal(staffBillingDueDate(date, "Net 60"), null);
  }
  assert.equal(staffBillingDueDate("2026-09-09", "Net 45"), null);
});

test("terms changes recalculate due dates, while date-only edits preserve manual dates", () => {
  const previous = { invoiceDate: "2026-09-09", terms: "Net 30", dueDate: "2026-10-09",
    previousInvoiceDate: "2026-09-09", previousTerms: "Net 30" };
  assert.equal(nextStaffBillingDueDate(previous), null);
  assert.equal(nextStaffBillingDueDate({ ...previous, terms: "Net 60" }), "2026-11-08");
  assert.equal(nextStaffBillingDueDate({ ...previous, terms: "Net 15" }), "2026-09-24");
  assert.equal(nextStaffBillingDueDate({ ...previous, terms: "Due on receipt" }), "2026-09-09");
  assert.equal(nextStaffBillingDueDate({ ...previous, invoiceDate: "2026-09-10" }), "2026-10-10");
  assert.equal(nextStaffBillingDueDate({ ...previous, invoiceDate: "2026-09-10", dueDate: "2027-01-31" }), null);
  assert.equal(nextStaffBillingDueDate({ ...previous, invoiceDate: "2026-09-10", dueDate: "" }), "2026-10-10");
  assert.equal(nextStaffBillingDueDate({ ...previous, terms: "Net 45" }), null);
});

test("restored browser drafts preserve saved Net 30/manual dates and round-trip new Net 60", () => {
  for (const terms of ["Net 30", "Net 60"]) {
    const saved = createBillingDraftPayload({ savedAt: "2026-09-09T00:00:00Z",
      form: { invoiceDate: "2026-09-09", terms, dueDate: "2027-01-31" } });
    const restored = parseBillingDraft(JSON.stringify(saved), Date.parse("2026-09-09T01:00:00Z"));
    assert.equal(restored?.form.terms, terms);
    assert.equal(restored?.form.dueDate, "2027-01-31");
    assert.equal(nextStaffBillingDueDate({ invoiceDate: "2026-09-09", terms, dueDate: "2027-01-31",
      previousInvoiceDate: "2026-09-09", previousTerms: terms }), null);
  }
});
