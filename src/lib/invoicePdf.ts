// @ts-nocheck
// Invoice PDF generator — matches the layout of P1's real Invoice 6556 (QuickBooks-style).
// Uses jsPDF + autoTable. Zero server dependency, runs in the browser, downloads instantly.

import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";

const P1 = {
  legalName: "P Hospitality Repairs LLC",
  dba: "P1 Pros",
  addr1: "10181 Sample Rd #204",
  addr2: "Coral Springs, FL 33065",
  email: "eddie@phospitality.com",
  phone: "+1 (561) 421-1281",
  website: "www.p1pros.com",
};

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

export function generateInvoicePDF(inv: Invoice): jsPDF {
  const doc = new jsPDF({ unit: "pt", format: "letter" });
  const W = doc.internal.pageSize.getWidth();
  const M = 40; // margin
  let y = M;

  // ── Header bar
  doc.setFillColor(31, 30, 28); // T.ink
  doc.rect(0, 0, W, 6, "F");
  y += 8;

  // ── Top: Logo block + Invoice title
  doc.setFont("helvetica", "bold");
  doc.setFontSize(22);
  doc.setTextColor(31, 30, 28);
  doc.text(P1.dba, M, y + 16);

  doc.setFont("helvetica", "normal");
  doc.setFontSize(8);
  doc.setTextColor(120, 116, 108);
  doc.text(`(${P1.legalName})`, M, y + 30);

  doc.setFontSize(9);
  doc.setTextColor(60, 58, 54);
  doc.text(P1.addr1, M, y + 44);
  doc.text(P1.addr2, M, y + 56);
  doc.text(P1.email, M, y + 68);
  doc.text(P1.phone, M, y + 80);
  doc.text(P1.website, M, y + 92);

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
  doc.text("SHIP TO", M + 240, y);
  doc.text("WORK ORDER", W - M - 130, y);

  y += 14;
  doc.setFontSize(10);
  doc.setTextColor(31, 30, 28);
  doc.text(SEVEN.name, M, y);
  doc.text(`${SEVEN.name}`, M + 240, y);
  doc.setFont("helvetica", "bold");
  doc.text(inv.wot, W - M - 130, y);

  y += 13;
  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  doc.setTextColor(60, 58, 54);
  doc.text(`7-ELEVEN STORE - ${inv.store}`, M, y);
  doc.text(`7-ELEVEN STORE - ${inv.store}`, M + 240, y);
  doc.text(`Store #${inv.store}`, W - M - 130, y);

  y += 12;
  doc.text(SEVEN.apAddr1, M, y);
  if (inv.storeAddr) doc.text(inv.storeAddr.split(",")[0] || "", M + 240, y);
  if (inv.cme) doc.text(inv.cme, W - M - 130, y);

  y += 12;
  doc.text(SEVEN.apAddr2, M, y);
  if (inv.storeAddr) {
    const rest = inv.storeAddr.split(",").slice(1).join(",").trim();
    if (rest) doc.text(rest, M + 240, y);
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
