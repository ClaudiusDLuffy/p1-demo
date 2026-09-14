export type InvoiceTotalExtraction = {
  total: number | null;
  confidence: "high" | "medium" | "none";
  matchedLabel: string | null;
};

export type InvoiceLineExtraction = {
  type: "Truck Charge" | "Labor" | "Parts/Hardware" | "Shipping" | "Other";
  desc: string;
  qty: number;
  rate: number;
  amount: number;
  confidence: "high" | "medium";
};

export type InvoiceNumberExtraction = {
  invoiceNumber: string | null;
  invoiceNumberConfidence: "high" | "medium" | "none";
  matchedNumberLabel: string | null;
};

export type InvoicePdfExtraction = InvoiceTotalExtraction & InvoiceNumberExtraction & {
  lines: InvoiceLineExtraction[];
  lineConfidence: "high" | "medium" | "none";
};

export type PositionedText = {
  text: string;
  x: number;
  y: number;
  width: number;
};
