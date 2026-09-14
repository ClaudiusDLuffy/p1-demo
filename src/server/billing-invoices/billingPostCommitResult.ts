import { z } from "zod";
import { invoiceReadRecord, parseInvoiceSummary, parseInvoiceSummaryDto, type InvoiceSummary } from "../../features/invoices/invoiceReadContracts";
import { FINANCIAL_MAX_LINES, FINANCIAL_MAX_SOURCES } from "../../lib/staffInvoiceContracts";
import type { BillingSaveCommandResult } from "./billingSaveCommandRepository";

const state = z.enum(["draft", "submitted", "approved", "rejected", "revised", "paid"]);
const version = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const identity = z.object({ id: z.string().uuid(), invoiceType: z.literal("staff"), state,
  workOrderId: z.string().min(1).nullable(), invoiceVersion: version,
  contractorAssignmentVersion: version.nullable(), workflowCycle: version.nullable() });
const counts = z.object({
  lineCount: z.number().int().nonnegative().max(FINANCIAL_MAX_LINES),
  sourceCount: z.number().int().nonnegative().max(FINANCIAL_MAX_SOURCES),
});

/** SQL count fields are required integer JSON numbers. Validate before the
 * shared legacy-compatible mapper can normalize strings or default NULL. */
export function parseCommittedBillingSummary(value: unknown, invoiceId: string): InvoiceSummary {
  const row = invoiceReadRecord(value);
  counts.parse({ lineCount: row.line_count, sourceCount: row.source_count });
  return validateCommittedBillingSummary(parseInvoiceSummary(row), invoiceId);
}

export function validateCommittedBillingSummary(value: unknown, invoiceId: string): InvoiceSummary {
  counts.parse(value);
  const invoice = parseInvoiceSummaryDto(value);
  identity.parse(invoice);
  if (invoice.id.toLowerCase() !== invoiceId.toLowerCase()) throw new Error("Committed detail identity mismatch");
  for (const source of invoice.sourceInvoices ?? []) {
    z.object({ id: z.string().uuid(), state, invoiceVersion: version }).parse(source);
  }
  for (const id of invoice.sourceInvoiceIds ?? []) z.string().uuid().parse(id);
  const sources = invoice.sourceInvoices ?? [];
  const sourceIds = new Set(invoice.sourceInvoiceIds?.map(id => id.toLowerCase()));
  if (new Set(sources.map(source => source.id.toLowerCase())).size !== sources.length
    || (invoice.sourceInvoiceIds !== undefined && (invoice.sourceCount !== invoice.sourceInvoiceIds.length
      || sourceIds.size !== invoice.sourceInvoiceIds.length
      || sources.some(source => !sourceIds.has(source.id.toLowerCase()))))) {
    throw new Error("Committed detail source identity mismatch");
  }
  return invoice;
}

export type BillingPostCommitRefresh =
  | { status: "available"; invoice: InvoiceSummary }
  | { status: "unavailable"; warning: "BILLING_REFRESH_UNAVAILABLE" }
  | { status: "not_attempted" };

type CommittedReadExpectation = Pick<BillingSaveCommandResult,
  "invoiceId" | "invoiceVersion" | "invoiceNum" | "state" | "workOrderId"
  | "subtotal" | "salesTax" | "total" | "lineCount" | "sourceInvoiceCount">;

export type BillingPostCommitDetailBinding = "accepted" | "stale" | "inconsistent" | "newer_current_state";

/** Pure binding of already validated detail and authoritative mutation
 * evidence. A newer revision is current-state feedback, not this receipt. */
export function validateBillingPostCommitDetail(
  receipt: CommittedReadExpectation, detail: InvoiceSummary,
): BillingPostCommitDetailBinding {
  if (detail.id.toLowerCase() !== receipt.invoiceId.toLowerCase()) return "inconsistent";
  if (detail.invoiceVersion < receipt.invoiceVersion) return "stale";
  if (detail.invoiceVersion > receipt.invoiceVersion) return "newer_current_state";
  if (detail.num !== receipt.invoiceNum || detail.state !== receipt.state
    || detail.workOrderId !== receipt.workOrderId || detail.subtotal !== receipt.subtotal
    || detail.salesTax !== receipt.salesTax || detail.total !== receipt.total
    || detail.lineCount !== receipt.lineCount || detail.sourceCount !== receipt.sourceInvoiceCount) {
    return "inconsistent";
  }
  // Parent assignment/workflow may advance without changing invoice version.
  return "accepted";
}

/** A secondary read can never revoke an already validated command receipt. */
export async function refreshCommittedBillingInvoice(
  invoiceId: string,
  signal: AbortSignal | null,
  load: (id: string) => Promise<unknown>,
  receipt?: CommittedReadExpectation,
): Promise<BillingPostCommitRefresh> {
  if (signal?.aborted) return { status: "not_attempted" };
  try {
    const invoice = await load(invoiceId);
    if (invoice === null || invoice === undefined) return { status: "unavailable", warning: "BILLING_REFRESH_UNAVAILABLE" };
    const detail = validateCommittedBillingSummary(invoice, invoiceId);
    const binding = receipt ? validateBillingPostCommitDetail(receipt, detail) : "accepted";
    if (binding === "stale" || binding === "inconsistent") {
      return { status: "unavailable", warning: "BILLING_REFRESH_UNAVAILABLE" };
    }
    // A later validated revision may represent a concurrent edit. Never replace
    // a committed receipt with an older or contradictory same-version detail.
    return { status: "available", invoice: detail };
  } catch {
    return { status: "unavailable", warning: "BILLING_REFRESH_UNAVAILABLE" };
  }
}
