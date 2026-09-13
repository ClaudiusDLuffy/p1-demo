import "server-only";
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { PrivateObjectError, type PrivateObjectServerDatabase } from "../privateObjectContracts";
import { objectRpcResult } from "./privateObjectRepository";

/** Service exports cannot use service-role Storage access as parent proof. */
export async function verifiedInvoiceObject(client: SupabaseClient<PrivateObjectServerDatabase>, invoiceId: string, expectedPath: string) {
  const binding = await objectRpcResult(client.rpc("get_verified_invoice_object_v1", { p_invoice_id: invoiceId }),
    z.object({ bindingId: z.uuid(), bucket: z.literal("invoice-pdfs"), objectPath: z.string().min(1).max(512) }));
  if (binding.objectPath !== expectedPath) throw new PrivateObjectError("INVOICE_OBJECT_CHANGED", "The invoice source document changed. Refresh the export and try again.");
  return binding;
}
