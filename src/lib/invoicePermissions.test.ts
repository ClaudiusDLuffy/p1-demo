import assert from "node:assert/strict";
import test from "node:test";
import {
  canDeleteOwnContractorInvoice,
  canEditRejectedContractorInvoice,
} from "./invoicePermissions";

test("allows an invoice-capable company member to correct its rejected invoice", () => {
  assert.equal(canEditRejectedContractorInvoice(
    { contractor: "canonical-company", state: "rejected" },
    { id: "member", contractorAccountId: "canonical-company", canInvoice: true },
    false,
  ), true);
});

test("allows a direct contractor to correct its own rejected invoice", () => {
  assert.equal(canEditRejectedContractorInvoice(
    { contractor: "direct-contractor", state: "rejected" },
    { id: "direct-contractor", canInvoice: true },
    false,
  ), true);
});

test("keeps other states, other companies, report-only users, and staff out", () => {
  const rejected = { contractor: "canonical-company", state: "rejected" };

  assert.equal(canEditRejectedContractorInvoice(
    { ...rejected, state: "revised" },
    { contractorAccountId: "canonical-company", canInvoice: true },
    false,
  ), false);
  assert.equal(canEditRejectedContractorInvoice(
    rejected,
    { contractorAccountId: "other-company", canInvoice: true },
    false,
  ), false);
  assert.equal(canEditRejectedContractorInvoice(
    rejected,
    { contractorAccountId: "canonical-company", canInvoice: false },
    false,
  ), false);
  assert.equal(canEditRejectedContractorInvoice(
    rejected,
    { contractorAccountId: "canonical-company", canInvoice: true },
    true,
  ), false);
});

test("contractors may delete only their own draft or rejected invoices", () => {
  const viewer = {
    id: "member",
    contractorAccountId: "canonical-company",
    canInvoice: true,
  };

  assert.equal(canDeleteOwnContractorInvoice(
    { contractor: "canonical-company", state: "draft" },
    viewer,
    false,
  ), true);
  assert.equal(canDeleteOwnContractorInvoice(
    { contractor: "canonical-company", state: "rejected" },
    viewer,
    false,
  ), true);
  for (const state of ["submitted", "revised", "approved", "paid"]) {
    assert.equal(canDeleteOwnContractorInvoice(
      { contractor: "canonical-company", state },
      viewer,
      false,
    ), false);
  }
  assert.equal(canDeleteOwnContractorInvoice(
    { contractor: "other-company", state: "draft" },
    viewer,
    false,
  ), false);
  assert.equal(canDeleteOwnContractorInvoice(
    { contractor: "canonical-company", state: "draft" },
    viewer,
    true,
  ), false);
});
