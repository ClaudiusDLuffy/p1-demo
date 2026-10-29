import type { SupabaseClient } from "@supabase/supabase-js";
import type { Json } from "../../lib/supabase/database.types";
import type { createServerClient } from "../../lib/supabase/server";
import { parseCommittedBillingSummary } from "./billingPostCommitResult";
import { loadStaffInvoiceNteWaitFlags, type NteApprovalWaitReadClient } from "./nteApprovalWaitFlags";

type SummaryDatabase = { public: { Tables: Record<string, never>; Views: Record<string, never>;
  Functions: { get_invoice_summary_v1: { Args: { p_invoice_id: string }; Returns: Json } } } };

/** Exactly one existing bounded header-summary RPC. Never loads line pages. */
export async function loadStaffInvoiceById(
  session: ReturnType<typeof createServerClient>,
  invoiceId: string,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  // Migration 0146 defines this RPC; the checked-in generated schema predates
  // it. This assertion extends the client schema, never the untrusted result.
  const client = session as unknown as SupabaseClient<SummaryDatabase>;
  const { data, error } = await client.rpc("get_invoice_summary_v1", { p_invoice_id: invoiceId }).abortSignal(signal);
  signal.throwIfAborted();
  if (error !== null) throw new Error("Committed detail refresh unavailable", { cause: error });
  const invoice = parseCommittedBillingSummary(data, invoiceId);
  const flags = await loadStaffInvoiceNteWaitFlags(
    session as unknown as NteApprovalWaitReadClient,
    [invoice.id],
    signal,
  );
  return { ...invoice, waitingOnNteApproval: flags.get(invoice.id.toLowerCase()) ?? false };
}
