import assert from "node:assert/strict";
import test from "node:test";
import { canManageNteApprovalWait, isNteApprovalSubmissionBlocked } from "./nteApprovalWait";

const manager = { active: true, role: "back_office", staffPermissions: [] };
const invoice = { invoiceType: "staff", documentKind: "invoice", state: "draft" };

test("NTE marker is available to active billing staff for a draft invoice", () => {
  assert.equal(canManageNteApprovalWait(invoice, manager), true);
  assert.equal(isNteApprovalSubmissionBlocked({ ...invoice, waitingOnNteApproval: true }), true);
});

test("NTE marker is hidden for unauthorized actors and non-invoice documents", () => {
  assert.equal(canManageNteApprovalWait(invoice, { ...manager, role: "contractor" }), false);
  assert.equal(canManageNteApprovalWait(invoice, { ...manager, active: false }), false);
  assert.equal(canManageNteApprovalWait(invoice, { ...manager, staffPermissions: ["invoice_controller"] }), false);
  assert.equal(canManageNteApprovalWait({ ...invoice, documentKind: "capital_quote" }, manager), false);
  assert.equal(canManageNteApprovalWait({ ...invoice, invoiceType: "contractor" }, manager), false);
});

test("NTE marker cannot newly be set after QBO sync, but an existing marker can be cleared", () => {
  const synced = { ...invoice, state: "approved", qboSyncedAt: "2026-10-01T00:00:00Z" };
  assert.equal(canManageNteApprovalWait(synced, manager), false);
  assert.equal(canManageNteApprovalWait({ ...synced, waitingOnNteApproval: true }, manager), true);
});
