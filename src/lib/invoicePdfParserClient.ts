import { supabase } from "./supabase/client";

export type ParsedInvoiceLine = {
  type: "Truck Charge" | "Labor" | "Parts/Hardware" | "Shipping" | "Other";
  desc: string;
  qty: number;
  rate: number;
  amount: number;
  confidence: "high" | "medium";
};

export type ParsedInvoicePdf = {
  total: number | null;
  confidence: "high" | "medium" | "none";
  matchedLabel: string | null;
  invoiceNumber: string | null;
  invoiceNumberConfidence: "high" | "medium" | "none";
  matchedNumberLabel: string | null;
  lines: ParsedInvoiceLine[];
  lineConfidence: "high" | "medium" | "none";
};

export async function parseInvoicePdf(file: File): Promise<ParsedInvoicePdf> {
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
    throw new Error(payload.error || "Could not read the invoice");
  }

  return payload as ParsedInvoicePdf;
}

export const parseInvoicePdfTotal = parseInvoicePdf;
