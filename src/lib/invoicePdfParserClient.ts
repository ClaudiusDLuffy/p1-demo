import { supabase } from "./supabase/client";

export type ParsedInvoiceTotal = {
  total: number | null;
  confidence: "high" | "medium" | "none";
  matchedLabel: string | null;
};

export async function parseInvoicePdfTotal(file: File): Promise<ParsedInvoiceTotal> {
  const { data: { session } } = await supabase().auth.getSession();
  if (!session?.access_token) throw new Error("Your session has expired. Sign in again.");

  const formData = new FormData();
  formData.append("file", file);

  const response = await fetch("/api/invoice-pdf/parse-total", {
    method: "POST",
    headers: { Authorization: `Bearer ${session.access_token}` },
    body: formData,
  });
  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(payload.error || "Could not read the invoice total");
  }

  return payload as ParsedInvoiceTotal;
}
