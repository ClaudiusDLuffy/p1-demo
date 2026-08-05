import assert from "node:assert/strict";
import test from "node:test";
import { sortInvoices } from "./invoiceSort";

const invoices = [
  { id: "a", num: "99", wot: "WOT10", contractor: "b", state: "submitted", invoiceDateRaw: "2026-08-01", store: "42", lines: [{}, {}], total: 10, createdAt: "2026-08-05T01:00:00Z" },
  { id: "b", num: "100", wot: "WOT2", contractor: "a", state: "draft", invoiceDateRaw: "2026-08-04", store: "7", lines: [{}], total: 200, createdAt: "2026-08-05T03:00:00Z" },
  { id: "c", num: "8", wot: "WOT1", contractor: "c", state: "approved", invoiceDateRaw: "2026-08-03", store: "100", lines: [], total: 50, createdAt: "2026-08-05T02:00:00Z" },
];

const names: Record<string, string> = { a: "Archer", b: "Beard", c: "SCRC" };
const contractorName = (id: string | null | undefined) => names[String(id)] || "";

test("recently added is based on creation time, not invoice date", () => {
  assert.deepEqual(
    sortInvoices(invoices, "recent", "desc", contractorName).map(invoice => invoice.id),
    ["b", "c", "a"],
  );
});

test("invoice, work order, and store use natural numeric ordering", () => {
  assert.deepEqual(sortInvoices(invoices, "invoice", "asc", contractorName).map(invoice => invoice.num), ["8", "99", "100"]);
  assert.deepEqual(sortInvoices(invoices, "work_order", "asc", contractorName).map(invoice => invoice.wot), ["WOT1", "WOT2", "WOT10"]);
  assert.deepEqual(sortInvoices(invoices, "store", "asc", contractorName).map(invoice => invoice.store), ["7", "42", "100"]);
});

test("all remaining requested columns sort in both directions", () => {
  for (const key of ["contractor", "status", "date", "lines", "total"] as const) {
    const ascending = sortInvoices(invoices, key, "asc", contractorName).map(invoice => invoice.id);
    const descending = sortInvoices(invoices, key, "desc", contractorName).map(invoice => invoice.id);
    assert.deepEqual(descending, [...ascending].reverse(), key);
  }
});
