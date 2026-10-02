import { supabase } from "../../lib/supabase/client";
import { externalBillingReceiptSchema } from "./externalBillingContracts";
import type { createExternalBillingAttempt } from "./externalBillingCommands";

export async function loadExternalBilling(workOrderId: string, signal?: AbortSignal) {
  const request = supabase().rpc("get_work_order_external_billing_v1", { p_work_order_id: workOrderId });
  const { data, error } = await (signal ? request.abortSignal(signal) : request);
  if (error) throw new Error("External billing history could not be loaded.");
  if (data === null) return null;
  const receipt = externalBillingReceiptSchema.parse(data);
  if (receipt.workOrderId !== workOrderId) throw new Error("External billing history did not match this work order.");
  return receipt;
}

export const runExternalBillingAttempt = (attempt: ReturnType<typeof createExternalBillingAttempt>) =>
  attempt((name, args) => supabase().rpc(name, args));
