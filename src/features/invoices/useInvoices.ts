"use client";
// @ts-nocheck

import { useCallback, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  insertInvoice,
  updateInvoiceWithLines,
  updateInvoiceState,
  updateWorkOrder,
  uploadInvoicePdf,
  downloadInvoicePdfBlob,
  deleteInvoice,
  rejectInvoice,
  insertActivity,
  nextInvoiceNumFromDb,
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
  // Cache-derived "best guess" for prefilling the form instantly when the
  // modal opens. NOT trusted at write time — that's what nextInvoiceNumFromDb
  // + the retry loop in insertInvoice are for. Two clients prefilling the
  // same number is fine: whichever inserts first wins; the loser retries.
  const nextInvNum = useCallback(() => {
    const invoices = (qc.getQueryData(INVOICES_KEY) as any[]) ?? [];
    const maxNum = invoices.reduce((m, i) => { const n = parseInt(i.num) || 0; return n > m ? n : m; }, 6500);
    return String(maxNum + 1);
  }, [qc]);
  // Authoritative version — reads from the DB. Use this to hydrate the
  // editable field when the modal opens so the prefill matches what's
  // actually in the table at this instant.
  const nextInvNumFromDb = useCallback(async () => {
    try { return await nextInvoiceNumFromDb(); }
    catch { return nextInvNum(); }
  }, [nextInvNum]);
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

  // Shared status-recompute used after delete (and as a backstop after
  // submit-existing of a previously-rejected revision). Same rule as the WO
  // hook: WO advances only when ALL non-draft, non-rejected invoices are
  // approved/paid; closes only when all are paid. Returns the new status
  // (or null to leave the WO alone).
  const computeWoStatusFromInvoices = (woId: string, all: any[]) => {
    const list = all.filter((i: any) => i.wot === woId && i.state !== "draft" && i.state !== "rejected");
    if (list.length === 0) return null;
    if (list.every((i: any) => i.state === "paid")) return "closed";
    if (list.every((i: any) => i.state === "approved" || i.state === "paid")) return "pending_payment";
    return "pending_approval";
  };

  // Persist + upload the system-generated PDF. Shared by submit-new and
  // submit-existing-draft so both paths produce the same artifact in storage.
  const generateAndUploadPdf = async (header: any, draft: any, wo: any, mappedLines: any[], subtotal: number, tax: number, total: number, fullStoreAddr: string) => {
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
      // Non-fatal — PDF regenerates on first download via the same path.
      fire(`PDF upload skipped: ${e.message || e}`);
    }
  };

  // Validates + assembles the submit payload. Returns null when the form
  // can't be persisted; the caller surfaced the user-facing error.
  const buildInvoicePayload = (wo: any, draft: any, requireFullLines = true) => {
    if (!draft.num) { fire("Enter an invoice number"); return null; }
    const validLines = requireFullLines
      ? (draft.lines || []).filter((l: any) => l.desc && l.qty && l.rate)
      : (draft.lines || []).filter((l: any) => l.desc || l.qty || l.rate);
    if (requireFullLines && validLines.length === 0) {
      fire("Add at least one line item with description, qty, and rate"); return null;
    }
    const subtotal = invSubtotal(validLines);
    const tax = parseFloat(draft.tax) || 0;
    const total = subtotal + tax;
    const mappedLines = validLines.map((l: any) => ({ ...l, qty: parseFloat(l.qty), rate: parseFloat(l.rate), amount: lineAmount(l) }));
    const woCity = (wo.city || "").trim();
    const woAddr = (wo.addr || "").trim();
    const fullStoreAddr = !woCity || (woAddr && woAddr.includes(woCity))
      ? woAddr
      : [woAddr, woCity].filter(Boolean).join(", ");
    return { validLines, subtotal, tax, total, mappedLines, fullStoreAddr };
  };

  // Save (or re-save) an invoice as a DRAFT — does NOT advance the WO, skips
  // PDF upload + NTE flag. Resuming a draft and saving again hits the same
  // path with `existingInvoiceId` set so we update in place.
  // Collision-aware toast. `result` is what the db layer returned, which
  // carries the resolved num and (if the user typed a colliding one) the
  // number they tried to use. Falls through to the original num cleanly.
  const announceSavedNum = (verb: string, result: any, attemptedNum: string | null) => {
    const finalNum = result?.num || attemptedNum || "?";
    const collidedFrom = result?._collidedFrom || result?.collidedFrom || null;
    if (collidedFrom && collidedFrom !== finalNum) {
      fire(`Invoice #${collidedFrom} already exists — saved as #${finalNum} instead.`);
    } else {
      fire(`Invoice #${finalNum} ${verb}`);
    }
  };

  const doSaveDraftInvoice = async (wo: any, formData?: any, existingInvoiceId?: string | null) => {
    const draft = formData ?? newInv;
    const payload = buildInvoicePayload(wo, draft, /* requireFullLines */ false);
    if (!payload) return false;
    const { validLines, subtotal, tax, total, fullStoreAddr } = payload;
    const userTypedNum = !!draft.num;
    try {
      let result: any;
      if (existingInvoiceId) {
        result = await updateInvoiceWithLines(
          existingInvoiceId,
          { num: draft.num, userTypedNum, cme: draft.cme || null, invoiceDate: draft.invoiceDate, serviceDate: draft.serviceDate || null, terms: draft.terms, storeAddr: fullStoreAddr, state: "draft", salesTax: tax },
          validLines,
        );
        await insertActivity(wo.id, currentUser.name, `Invoice #${result.num} draft updated.`, "system");
      } else {
        result = await insertInvoice(
          { ...draft, userTypedNum, wot: wo.id, store: wo.store, storeAddr: fullStoreAddr, contractor: wo.contractor, state: "draft" },
          validLines,
          currentUser.name,
        );
      }
      qc.invalidateQueries({ queryKey: WORK_ORDERS_KEY });
      qc.invalidateQueries({ queryKey: INVOICES_KEY });
      announceSavedNum("draft saved", result, draft.num || null);
      resetNewInv();
      return true;
    } catch (e: any) {
      qc.invalidateQueries({ queryKey: WORK_ORDERS_KEY });
      qc.invalidateQueries({ queryKey: INVOICES_KEY });
      if (e?.code === "INVOICE_NUM_CONFLICT") {
        fire("Couldn't allocate an unused invoice number. Try again.");
      } else {
        fire(`Draft save failed: ${e.message || e}`);
      }
      return false;
    }
  };

  const doSubmitInvoice = async (wo: any, formData?: any, existingInvoiceId?: string | null) => {
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
    const userTypedNum = !!draft.num;
    try {
      let header: any;
      let finalNum: string = draft.num || "";
      let collidedFrom: string | null = null;
      if (existingInvoiceId) {
        // Promote an existing draft to a real submission. Lines are replaced
        // wholesale; state flips to 'submitted'. WO is then nudged into
        // pending_approval (matches the brand-new submit path below).
        const res = await updateInvoiceWithLines(
          existingInvoiceId,
          { num: draft.num, userTypedNum, cme: draft.cme || null, invoiceDate: draft.invoiceDate, serviceDate: draft.serviceDate || null, terms: draft.terms, storeAddr: fullStoreAddr, state: "submitted", salesTax: tax },
          validLines,
        );
        header = { id: res.id };
        finalNum = res.num || finalNum;
        collidedFrom = res.collidedFrom;
        await updateWorkOrder(wo.id, { status: "pending_approval", invoiceTotal: total });
        await insertActivity(wo.id, currentUser.name, `Invoice ${finalNum} submitted. Total: $${total.toFixed(2)}.`, "system");
      } else {
        header = await insertInvoice(
          { ...draft, userTypedNum, wot: wo.id, store: wo.store, storeAddr: fullStoreAddr, contractor: wo.contractor, state: "submitted" },
          validLines,
          currentUser.name,
        );
        finalNum = header.num || finalNum;
        collidedFrom = header._collidedFrom || null;
      }
      if (shouldFlag) {
        try { await updateWorkOrder(wo.id, { nteFlagged: true, nteFlagAmount: total }); }
        catch (e: any) { fire(`NTE flag not saved: ${e.message || e}`); }
      }
      // Use the RESOLVED number for the PDF too — otherwise the stored bytes
      // would label the file with the colliding number the user originally
      // typed, which would be wrong on download.
      const draftForPdf = { ...draft, num: finalNum };
      await generateAndUploadPdf(header, draftForPdf, wo, mappedLines, subtotal, tax, total, fullStoreAddr);
      qc.invalidateQueries({ queryKey: WORK_ORDERS_KEY });
      qc.invalidateQueries({ queryKey: INVOICES_KEY });
      setSubmittedInvoiceNum(finalNum);
      if (collidedFrom && collidedFrom !== finalNum) {
        fire(`Invoice #${collidedFrom} already exists — saved as #${finalNum} instead.`);
      }
      resetNewInv();
      return true;
    } catch (e: any) {
      qc.invalidateQueries({ queryKey: WORK_ORDERS_KEY });
      qc.invalidateQueries({ queryKey: INVOICES_KEY });
      if (e?.code === "INVOICE_NUM_CONFLICT") {
        fire("Couldn't allocate an unused invoice number after several attempts. Please try again.");
      } else {
        fire(`Invoice save failed: ${e.message || e}`);
      }
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
  // filters deleted_at at the source. Per Gustavo's call, we do NOT
  // auto-revert WO status — if deleting the last non-draft invoice leaves
  // the WO stuck, surface a toast prompting staff to move it manually.
  const doDeleteInvoice = async (inv: any) => {
    try {
      await deleteInvoice(inv.id, inv.num, inv.wot || null, currentUser.name);
      // After delete: check whether the WO has any non-draft, non-rejected
      // siblings left at all. If not, surface the manual-move prompt.
      const all = ((qc.getQueryData(INVOICES_KEY) as any[]) ?? []);
      const remaining = all.filter((i: any) => i.id !== inv.id && i.wot === inv.wot && i.state !== "draft" && i.state !== "rejected");
      qc.invalidateQueries({ queryKey: INVOICES_KEY });
      qc.invalidateQueries({ queryKey: WORK_ORDERS_KEY });
      if (remaining.length === 0 && inv.wot) {
        fire(`Invoice #${inv.num} deleted — no live invoices left on ${inv.wot}; move the WO manually if needed.`);
      } else {
        fire(`Invoice #${inv.num} deleted`);
      }
      return true;
    } catch (e: any) {
      fire(`Delete failed: ${e.message || e}`);
      return false;
    }
  };

  // Staff-only reject with a reason. Same gating pattern as delete. Does
  // NOT advance the WO — rejected invoices are simply excluded from the
  // "is everything approved?" check, which means a WO with one rejected +
  // one approved invoice will sit at pending_payment (per the billing rule).
  const doRejectInvoice = async (inv: any, reason: string) => {
    const trimmed = (reason || "").trim();
    if (!trimmed) { fire("Enter a rejection reason"); return false; }
    try {
      await rejectInvoice(inv.id, inv.num, inv.wot || null, trimmed, currentUser.name);
      qc.invalidateQueries({ queryKey: INVOICES_KEY });
      qc.invalidateQueries({ queryKey: WORK_ORDERS_KEY });
      fire(`Invoice #${inv.num} rejected`);
      return true;
    } catch (e: any) {
      fire(`Reject failed: ${e.message || e}`);
      return false;
    }
  };

  return {
    newInv, setNewInv,
    selectedInvoice, setSelectedInvoice,
    submittedInvoiceNum, setSubmittedInvoiceNum,
    pdfBusy, setPdfBusy,
    nextInvNum, nextInvNumFromDb, defaultInvLines, blankNewInv, resetNewInv,
    doSubmitInvoice, doSaveDraftInvoice, doDownloadInvoice, doDeleteInvoice, doRejectInvoice,
    lineAmount, invSubtotal, invTotal,
  };
}
