import { supabase } from "../../lib/supabase/client";
import { linkedBillingCandidatesSchema, linkedBillingHistorySchema, type LinkedBillingCursor } from "./linkedBillingContracts";
import type { createLinkedBillingAttempt } from "./linkedBillingCommands";

export async function loadLinkedBillingCandidates(workOrderId: string, invoiceNumber: string, signal?: AbortSignal) {
  const request = supabase().rpc("list_linked_billing_candidates_v1", { p_work_order_id: workOrderId, p_invoice_number: invoiceNumber });
  const { data, error } = await (signal ? request.abortSignal(signal) : request);
  if (error) throw new Error("Eligible invoices could not be loaded. Retry the search.");
  const result = linkedBillingCandidatesSchema.parse(data);
  if (result.workOrderId !== workOrderId || result.items.some(item => item.workOrderId !== workOrderId)) {
    throw new Error("Invoice results did not match this work order.");
  }
  return result;
}

export async function loadLinkedBillingHistory(workOrderId: string, cursor: LinkedBillingCursor, signal?: AbortSignal) {
  const request = supabase().rpc("get_work_order_billing_links_v1", {
    p_work_order_id: workOrderId, p_before: cursor?.closedAt ?? null, p_before_id: cursor?.operationId ?? null,
  });
  const { data, error } = await (signal ? request.abortSignal(signal) : request);
  if (error) throw new Error("Linked billing history could not be loaded.");
  const result = linkedBillingHistorySchema.parse(data);
  if (result.workOrderId !== workOrderId || result.items.some(({ receipt }) =>
    receipt.workOrderId !== workOrderId && receipt.billingWorkOrderId !== workOrderId)) {
    throw new Error("Linked billing history did not match this work order.");
  }
  return result;
}

export const runLinkedBillingAttempt = (attempt: ReturnType<typeof createLinkedBillingAttempt>) =>
  attempt((name, args) => supabase().rpc(name, args));
