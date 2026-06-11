"use client";
// @ts-nocheck

import { useCallback, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  insertInvoice,
  updateWorkOrder,
  uploadInvoicePdf,
  downloadInvoicePdfBlob,
  deleteInvoice,
} from "../../lib/db";
import { P1_BUSINESS, SEVEN_BILL_TO, LINE_TYPES, MONTHS } from "../../lib/constants";
import { WORK_ORDERS_KEY } from "../work-orders/queries";
import { INVOICES_KEY } from "./queries";

const lineAmount = (l: any) => (parseFloat(l.qty) || 0) * (parseFloat(l.rate) || 0);
const invSubtotal = (lines: any[]) => lines.reduce((s, l) => s + lineAmount(l), 0);
const invTotal = (lines: any[], tax: number) => invSubtotal(lines) + (parseFloat(tax as any) || 0);

export default function useInvoices({ currentUser, fire }: any) {
  const qc = useQueryClient();
  const [selectedInvoice, setSelectedInvoice] = useState<string | null>(null);
  const [submittedInvoiceNum, setSubmittedInvoiceNum] = useState<string | null>(null);
  const [pdfBusy, setPdfBusy] = useState(false);

  // Rates start empty (contractor enters their own); Truck Charge is the one
  // exception — editable default of 60.
  const defaultInvLines = () => [
    { type: "Truck Charge", desc: "Truck charge", qty: 1, rate: P1_BUSINESS.defaultTruckCharge, amount: P1_BUSINESS.defaultTruckCharge },
    { type: "Labor", desc: "", qty: 1, rate: "", amount: 0 },
  ];
  const nextInvNum = useCallback(() => {
    const invoices = (qc.getQueryData(INVOICES_KEY) as any[]) ?? [];
    const maxNum = invoices.reduce((m, i) => { const n = parseInt(i.num) || 0; return n > m ? n : m; }, 6500);
    return String(maxNum + 1);
  }, [qc]);
  const blankNewInv = () => ({
    num: "",
    cme: "",
    terms: P1_BUSINESS.defaultTerms,
    serviceDate: new Date().toISOString().slice(0, 10),
    invoiceDate: new Date().toISOString().slice(0, 10),
    tax: "",
    hasPdf: false,
    lines: defaultInvLines(),
  });
  const [newInv, setNewInv] = useState<any>(blankNewInv());
  const resetNewInv = () => setNewInv(blankNewInv());

  const doSubmitInvoice = async (wo: any, formData?: any) => {
    const draft = formData ?? newInv;
    if (!draft.num) { fire("Enter an invoice number"); return false; }
    const validLines = (draft.lines || []).filter((l: any) => l.desc && l.qty && l.rate);
    if (validLines.length === 0) { fire("Add at least one line item with description, qty, and rate"); return false; }
    // DEMO-SAFE SOFTENING (pending client decision on generate-vs-upload):
    // the PDF attachment is intentionally NOT blocking submission. The
    // QuickBooks upload field + labeling stay in place; when no PDF is
    // attached the post-submit "Download PDF" still offers the generated one.
    // Restore the hard block once the client confirms the invoice source.
    const subtotal = invSubtotal(validLines);
    const tax = parseFloat(draft.tax) || 0;
    const total = subtotal + tax;
    const mappedLines = validLines.map((l: any) => ({ ...l, qty: parseFloat(l.qty), rate: parseFloat(l.rate), amount: lineAmount(l) }));
    // Full service-location for the PDF "ship to". The WO keeps street in
    // `addr` and city/state in `city`; combine them so the state reaches the
    // invoice. Avoid duplicating when addr already contains the city/state.
    const woCity = (wo.city || "").trim();
    const woAddr = (wo.addr || "").trim();
    const fullStoreAddr = !woCity || (woAddr && woAddr.includes(woCity))
      ? woAddr
      : [woAddr, woCity].filter(Boolean).join(", ");
    // NTE early-warning flag: if this invoice total reaches the WO's flag
    // threshold (default $900), flag the WO so it lands in Mandy's "NTE
    // Approval Needed" queue. Dollar-based, separate from the actual-NTE
    // overage highlight. Only ever sets the flag on (never auto-clears).
    const flagThreshold = wo.nteFlagThreshold != null ? wo.nteFlagThreshold : 900;
    const shouldFlag = total >= flagThreshold;
    try {
      const header: any = await insertInvoice(
        { ...draft, wot: wo.id, store: wo.store, storeAddr: fullStoreAddr, contractor: wo.contractor, state: "submitted" },
        validLines,
        currentUser.name,
      );
      if (shouldFlag) {
        try { await updateWorkOrder(wo.id, { nteFlagged: true, nteFlagAmount: total }); }
        catch (e: any) { fire(`NTE flag not saved: ${e.message || e}`); }
      }
      // Generate + upload PDF so manager + contractor can pull the same bytes later.
      try {
        const { generateInvoicePDFBlob, loadLogoDataUrl } = await import("../../lib/invoicePdf");
        const logoDataUrl = await loadLogoDataUrl();
        const blob = generateInvoicePDFBlob({
          num: draft.num, wot: wo.id, store: wo.store, storeAddr: fullStoreAddr,
          invoiceDate: draft.invoiceDate, serviceDate: draft.serviceDate, terms: draft.terms,
          cme: draft.cme, lines: mappedLines, subtotal, salesTax: tax, total,
        }, logoDataUrl);
        await uploadInvoicePdf(header.id, draft.num, blob);
      } catch (e: any) {
        // Non-fatal - PDF can be (re)generated on first download via the same path.
        fire(`PDF upload skipped: ${e.message || e}`);
      }
      qc.invalidateQueries({ queryKey: WORK_ORDERS_KEY });
      qc.invalidateQueries({ queryKey: INVOICES_KEY });
      setSubmittedInvoiceNum(draft.num);
      resetNewInv();
      return true;
    } catch (e: any) {
      qc.invalidateQueries({ queryKey: WORK_ORDERS_KEY });
      qc.invalidateQueries({ queryKey: INVOICES_KEY });
      fire(`Invoice save failed: ${e.message || e}`);
      return false;
    }
  };

  // Storage-first download with lazy-backfill: if the invoice already has a
  // stored PDF, pull bytes directly; otherwise generate, upload, persist the
  // path, then trigger the download. Either way the user gets a file.
  const doDownloadInvoice = async (inv: any) => {
    if (pdfBusy) return;
    setPdfBusy(true);
    try {
      const { triggerBlobDownload, generateInvoicePDFBlob, invoiceFilename, loadLogoDataUrl } = await import("../../lib/invoicePdf");
      const filename = invoiceFilename(inv);
      if (inv.pdfStoragePath) {
        const blob = await downloadInvoicePdfBlob(inv.pdfStoragePath);
        triggerBlobDownload(blob, filename);
        fire(`Invoice ${inv.num} downloaded`);
        return;
      }
      // Lazy backfill - covers the seeded invoice + any pre-existing rows.
      const logoDataUrl = await loadLogoDataUrl();
      const blob = generateInvoicePDFBlob(inv, logoDataUrl);
      if (inv.id) {
        try {
          await uploadInvoicePdf(inv.id, inv.num, blob);
          qc.invalidateQueries({ queryKey: INVOICES_KEY });
        } catch (e: any) {
          fire(`PDF cache failed: ${e.message || e}`);
        }
      }
      triggerBlobDownload(blob, filename);
      fire(`Invoice ${inv.num} downloaded`);
    } catch (e: any) {
      fire(`Download failed: ${e.message || e}`);
    } finally {
      setPdfBusy(false);
    }
  };

  // Staff-only soft delete (the UI gates visibility; RLS backs it up).
  // Deleted invoices vanish from every list/stat because loadInvoices
  // filters deleted_at at the source.
  const doDeleteInvoice = async (inv: any) => {
    try {
      await deleteInvoice(inv.id, inv.num, inv.wot || null, currentUser.name);
      qc.invalidateQueries({ queryKey: INVOICES_KEY });
      qc.invalidateQueries({ queryKey: WORK_ORDERS_KEY });
      fire(`Invoice #${inv.num} deleted`);
      return true;
    } catch (e: any) {
      fire(`Delete failed: ${e.message || e}`);
      return false;
    }
  };

  return {
    newInv, setNewInv,
    selectedInvoice, setSelectedInvoice,
    submittedInvoiceNum, setSubmittedInvoiceNum,
    pdfBusy, setPdfBusy,
    nextInvNum, defaultInvLines, blankNewInv, resetNewInv,
    doSubmitInvoice, doDownloadInvoice, doDeleteInvoice,
    lineAmount, invSubtotal, invTotal,
  };
}
