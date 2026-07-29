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
  if (file.size === 0) throw new Error("PDF file is empty");
  if (file.size > 5 * 1024 * 1024) throw new Error("PDF must be 5 MB or smaller");
  if (file.type !== "application/pdf" && !file.name.toLowerCase().endsWith(".pdf")) {
    throw new Error("File must be a PDF");
  }

  const { extractInvoiceDataFromPdf } = await import("./invoicePdfParser");
  return extractInvoiceDataFromPdf(new Uint8Array(await file.arrayBuffer()));
}

export async function parseStoredInvoicePdf(storagePath: string): Promise<ParsedInvoicePdf> {
  const { data: pdf, error } = await supabase()
    .storage
    .from("invoice-pdfs")
    .download(storagePath);

  if (error) {
    throw new Error(`Could not download the stored invoice PDF: ${error.message}`);
  }
  if (!pdf) {
    throw new Error("The stored invoice PDF was empty");
  }

  const name = storagePath.split("/").pop() || "invoice.pdf";
  return parseInvoicePdf(new File([pdf], name, {
    type: pdf.type || "application/pdf",
  }));
}

export const parseInvoicePdfTotal = parseInvoicePdf;
