// @ts-nocheck
// Invoice PDF generator — matches the layout of P1's real Invoice 6556 (QuickBooks-style).
// Uses jsPDF + autoTable. Zero server dependency, runs in the browser, downloads instantly.

import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import { P1_BUSINESS } from "./constants";

// Single source of truth lives in constants.ts; aliased to P1 here so the
// existing PDF layout code reads the same. DO NOT reintroduce a local copy.
const P1 = P1_BUSINESS as typeof P1_BUSINESS & { legalName?: string };

const SEVEN = {
  name: "7-ELEVEN INC",
  apAddr1: "3200 Hackberry Rd",
  apAddr2: "Irving, TX 75063 USA",
};

const fmt = (n: number) => "$" + (Math.round(n * 100) / 100).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

export type InvoiceLine = {
  type: string;
  desc: string;
  qty: number;
  rate: number;
  amount: number;
};

export type Invoice = {
  num: string;
  wot: string;
  store: string;
  storeAddr?: string;
  invoiceDate: string;
  serviceDate?: string;
  terms?: string;
  cme?: string;
  lines: InvoiceLine[];
  subtotal: number;
  salesTax: number;
  total: number;
};

// Best-effort logo loader — fetches /p1-pros-logo.jpeg from public/ and
// converts to a data URL jsPDF can embed. Returns null on any failure so
// the PDF generator falls back to text-only branding.
export async function loadLogoDataUrl(path = "/p1-pros-logo.jpeg"): Promise<string | null> {
  try {
    const res = await fetch(path);
    if (!res.ok) return null;
    const blob = await res.blob();
    return await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}

// opts.perspective: "staff" (default) keeps the P1 Pros → 7-Eleven framing
// (the document P1 posts after review). "contractor" flips it to
// FROM = contractor (opts.fromName) → BILL TO = P1 Pros, since contractors
// have no 7-Eleven access.
type InvoicePdfOpts = { perspective?: "staff" | "contractor"; fromName?: string };
export function generateInvoicePDF(inv: Invoice, logoDataUrl?: string | null, opts: InvoicePdfOpts = {}): jsPDF {
  const isContractor = opts.perspective === "contractor";
  const fromName = opts.fromName || "Contractor";
  const doc = new jsPDF({ unit: "pt", format: "letter" });
  const W = doc.internal.pageSize.getWidth();
  const M = 40; // margin
  let y = M;

  // ── Header bar
  doc.setFillColor(31, 30, 28); // T.ink
  doc.rect(0, 0, W, 6, "F");
  y += 8;

  // ── Top: Logo block + Invoice title.
  // Staff/P1 perspective: paint the P1 Pros logo top-left and shift the
  // wordmark right. Contractor perspective: NO P1 logo — this is the
  // contractor's invoice to P1, so P1's branding doesn't belong on it; the
  // contractor's company name is the seller wordmark, rendered as text only.
  let textX = M;
  if (!isContractor && logoDataUrl) {
    try {
      doc.addImage(logoDataUrl, "JPEG", M, y, 56, 56, undefined, "FAST");
      textX = M + 68;
    } catch {
      textX = M;
    }
  }
  doc.setFont("helvetica", "bold");
  doc.setFontSize(22);
  doc.setTextColor(31, 30, 28);
  // Seller wordmark: contractor invoices are FROM the contractor.
  doc.text(isContractor ? fromName : P1.dba, textX, y + 16);

  doc.setFont("helvetica", "normal");
  doc.setFontSize(8);
  doc.setTextColor(120, 116, 108);
  if (isContractor) {
    doc.text("Invoice to P1 Pros", textX, y + 30);
  } else {
    // Legal-name parenthetical removed (Lindsay 2026-06-16). Contact rows
    // shift up to fill the line previously occupied by "(P Hospitality...)".
    doc.setFontSize(9);
    doc.setTextColor(60, 58, 54);
    doc.text(P1.addr1, textX, y + 32);
    doc.text(P1.addr2, textX, y + 44);
    doc.text(P1.email, textX, y + 56);
    doc.text(P1.phone, textX, y + 68);
    doc.text(P1.website, textX, y + 80);
  }

  // Invoice title (right side)
  doc.setFont("helvetica", "bold");
  doc.setFontSize(28);
  doc.setTextColor(193, 95, 60); // T.accent (terracotta)
  doc.text("INVOICE", W - M, y + 24, { align: "right" });

  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  doc.setTextColor(120, 116, 108);
  doc.text(`Invoice #`, W - M - 100, y + 50);
  doc.text(`Service date`, W - M - 100, y + 65);
  doc.text(`Invoice date`, W - M - 100, y + 80);
  doc.text(`Terms`, W - M - 100, y + 95);

  doc.setFont("helvetica", "bold");
  doc.setTextColor(31, 30, 28);
  doc.text(inv.num, W - M, y + 50, { align: "right" });
  doc.text(inv.serviceDate || "—", W - M, y + 65, { align: "right" });
  doc.text(inv.invoiceDate, W - M, y + 80, { align: "right" });
  doc.text(inv.terms || "Net 30", W - M, y + 95, { align: "right" });

  y += 120;

  // ── Bill to / Ship to
  doc.setDrawColor(232, 225, 213); // T.border
  doc.setLineWidth(0.5);
  doc.line(M, y, W - M, y);
  y += 16;

  doc.setFont("helvetica", "bold");
  doc.setFontSize(8);
  doc.setTextColor(120, 116, 108);
  doc.text("BILL TO", M, y);
  doc.text(isContractor ? "REFERENCE" : "SHIP TO", M + 240, y);
  doc.text("WORK ORDER", W - M - 130, y);

  y += 14;
  doc.setFontSize(10);
  doc.setTextColor(31, 30, 28);
  if (isContractor) {
    // Contractor invoice: bill to P1 Pros; middle column is store reference.
    doc.text(P1.dba, M, y);
    doc.text(`Store #${inv.store}`, M + 240, y);
  } else {
    doc.text(SEVEN.name, M, y);
    doc.text(`${SEVEN.name}`, M + 240, y);
  }
  doc.setFont("helvetica", "bold");
  doc.text(inv.wot, W - M - 130, y);

  y += 13;
  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  doc.setTextColor(60, 58, 54);
  // Legal-name parenthetical removed under Bill To (Lindsay 2026-06-16) —
  // P1 Pros address now starts on this row in the contractor perspective.
  if (isContractor) {
    doc.text(P1.addr1, M, y);
    if (inv.storeAddr) doc.text(inv.storeAddr.split(",")[0] || "", M + 240, y);
  } else {
    doc.text(`7-ELEVEN STORE - ${inv.store}`, M, y);
    doc.text(`7-ELEVEN STORE - ${inv.store}`, M + 240, y);
  }
  doc.text(`Store #${inv.store}`, W - M - 130, y);

  y += 12;
  doc.text(isContractor ? P1.addr2 : SEVEN.apAddr1, M, y);
  if (isContractor) {
    if (inv.storeAddr) {
      const rest = inv.storeAddr.split(",").slice(1).join(",").trim();
      if (rest) doc.text(rest, M + 240, y);
    }
  } else if (inv.storeAddr) {
    doc.text(inv.storeAddr.split(",")[0] || "", M + 240, y);
  }
  if (inv.cme) doc.text(inv.cme, W - M - 130, y);

  y += 12;
  if (!isContractor) {
    doc.text(SEVEN.apAddr2, M, y);
    if (inv.storeAddr) {
      const rest = inv.storeAddr.split(",").slice(1).join(",").trim();
      if (rest) doc.text(rest, M + 240, y);
    }
  }

  y += 24;

  // ── Line items table
  autoTable(doc, {
    startY: y,
    head: [["#", "Type", "Description", "Qty", "Rate", "Amount"]],
    body: inv.lines.map((l, i) => [
      String(i + 1),
      l.type,
      l.desc,
      l.qty.toString(),
      fmt(l.rate),
      fmt(l.amount),
    ]),
    theme: "plain",
    headStyles: {
      fillColor: [245, 240, 232], // T.bgWarm
      textColor: [120, 116, 108],
      fontStyle: "bold",
      fontSize: 8,
      cellPadding: 7,
      lineColor: [232, 225, 213],
      lineWidth: { bottom: 0.5 },
    },
    bodyStyles: {
      fontSize: 9,
      cellPadding: 7,
      textColor: [31, 30, 28],
      lineColor: [240, 234, 224], // T.borderSoft
      lineWidth: { bottom: 0.3 },
      valign: "top",
    },
    columnStyles: {
      0: { cellWidth: 22, halign: "right", textColor: [154, 149, 141] },
      1: { cellWidth: 80, fontStyle: "bold" },
      2: { cellWidth: "auto" },
      3: { cellWidth: 35, halign: "right" },
      4: { cellWidth: 60, halign: "right" },
      5: { cellWidth: 70, halign: "right", fontStyle: "bold" },
    },
    margin: { left: M, right: M },
  });

  // @ts-ignore — autoTable adds lastAutoTable
  let endY = (doc as any).lastAutoTable.finalY + 18;

  // ── Totals (right-aligned)
  const totalsX = W - M - 200;
  const labelX = W - M - 200;
  const valueX = W - M;

  doc.setFontSize(9);
  doc.setTextColor(120, 116, 108);
  doc.text("Subtotal", labelX, endY);
  doc.setTextColor(31, 30, 28);
  doc.text(fmt(inv.subtotal), valueX, endY, { align: "right" });

  endY += 14;
  doc.setTextColor(120, 116, 108);
  doc.text("Sales tax", labelX, endY);
  doc.setTextColor(31, 30, 28);
  doc.text(fmt(inv.salesTax), valueX, endY, { align: "right" });

  endY += 8;
  doc.setDrawColor(232, 225, 213);
  doc.setLineWidth(0.7);
  doc.line(totalsX, endY, W - M, endY);
  endY += 16;

  doc.setFont("helvetica", "bold");
  doc.setFontSize(13);
  doc.setTextColor(31, 30, 28);
  doc.text("Total", labelX, endY);
  doc.setTextColor(193, 95, 60); // T.accent
  doc.text(fmt(inv.total), valueX, endY, { align: "right" });

  // ── Footer
  endY += 50;
  if (endY < doc.internal.pageSize.getHeight() - 60) {
    doc.setDrawColor(232, 225, 213);
    doc.setLineWidth(0.5);
    doc.line(M, endY, W - M, endY);

    endY += 16;
    doc.setFont("helvetica", "bold");
    doc.setFontSize(8);
    doc.setTextColor(120, 116, 108);
    doc.text("WAYS TO PAY", M, endY);

    endY += 12;
    doc.setFont("helvetica", "normal");
    doc.setFontSize(9);
    doc.setTextColor(60, 58, 54);
    doc.text(`ACH or check (confirm preferred method with ${P1.email})`, M, endY);

    endY += 14;
    doc.setFontSize(8);
    doc.setTextColor(154, 149, 141);
    doc.text(`Questions? ${P1.email} · ${P1.phone}`, M, endY);
  }

  // ── Footer bar
  doc.setFillColor(31, 30, 28);
  doc.rect(0, doc.internal.pageSize.getHeight() - 4, W, 4, "F");

  return doc;
}

export function downloadInvoicePDF(inv: Invoice): void {
  const doc = generateInvoicePDF(inv);
  doc.save(`Invoice-${inv.num}-${inv.wot}.pdf`);
}

// Used when we want the raw bytes (e.g. to upload to Supabase Storage)
// rather than trigger a browser download.
export function generateInvoicePDFBlob(inv: Invoice, logoDataUrl?: string | null, opts: InvoicePdfOpts = {}): Blob {
  const doc = generateInvoicePDF(inv, logoDataUrl, opts);
  return doc.output("blob") as Blob;
}

// Trigger a download of an arbitrary blob (used when we pull the PDF
// back from Storage instead of regenerating it locally).
export function triggerBlobDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function invoiceFilename(inv: Pick<Invoice, "num" | "wot">): string {
  return `Invoice-${inv.num}-${inv.wot}.pdf`;
}
