"use client";
// @ts-nocheck

import { useCallback, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  insertInvoice,
  updateInvoiceWithLines,
  updateWorkOrder,
  uploadInvoicePdf,
  uploadInvoicePdfObject,
  downloadInvoicePdfBlob,
  deleteInvoice,
  deleteOwnContractorInvoice,
  reviewContractorInvoice,
  reviewContractorInvoices,
  resubmitRejectedContractorInvoice,
  retractContractorInvoiceRejection,
  insertActivity,
  nextInvoiceNumFromDb,
  correctContractorInvoiceTotal,
  loadInvoicesPage,
} from "../../lib/db";
import { P1_BUSINESS } from "../../lib/constants";
import { acquireInvoiceMutationLocks } from "../../lib/invoiceMutationGuard";
import { normalizeInvoiceLineNumbers } from "../../lib/invoiceMath";
import { isRpcConflict, rpcConflictMessage } from "../../lib/rpcConflict";
import {
  CONTRACTOR_WORKLOAD_SUMMARY_KEY,
  PORTAL_NAVIGATION_SUMMARY_KEY,
  WORK_ORDER_BY_ID_KEY,
  WORK_ORDER_DETAILS_KEY,
  WORK_ORDER_PAGES_KEY,
  WORK_ORDERS_KEY,
} from "../work-orders/queries";
import {
  CONTROLLER_INVOICE_HOLDS_KEY,
  INVOICE_BY_ID_KEY,
  INVOICE_PAGES_KEY,
  INVOICES_KEY,
} from "./queries";
import { supabase } from "../../lib/supabase/client";

const lineAmount = (l: any) => (parseFloat(l.qty) || 0) * (parseFloat(l.rate) || 0);
const invSubtotal = (lines: any[]) => lines.reduce((s, l) => s + lineAmount(l), 0);
const invTotal = (lines: any[], tax: number) => invSubtotal(lines) + (parseFloat(tax as any) || 0);

async function notifyInvoiceReview(
  invoiceId: string,
  event: "rejected" | "retraction",
) {
  const sb = supabase();
  const { data } = await sb.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error("Missing session");

  const response = await fetch("/api/notifications/invoice-review", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ invoiceId, event }),
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error || "Invoice notification failed");
  }
}

async function updateInvoicePaymentHold(
  invoiceId: string,
  action: "hold" | "release",
  reason: string,
) {
  const sb = supabase();
  const { data } = await sb.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error("Your session expired. Sign in again.");

  const response = await fetch("/api/contractor-invoice-holds", {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ invoiceId, action, reason }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || "Payment hold update failed");
  }
  return payload as { notificationWarning?: string | null };
}

export default function useInvoices({ currentUser, profiles = [], fire }: any) {
  const qc = useQueryClient();
  const [selectedInvoice, setSelectedInvoice] = useState<string | null>(null);
  const [submittedInvoiceNum, setSubmittedInvoiceNum] = useState<string | null>(null);
  const [pdfBusy, setPdfBusy] = useState(false);
  const invalidateWorkOrderData = () => Promise.all([
    qc.invalidateQueries({ queryKey: WORK_ORDERS_KEY }),
    qc.invalidateQueries({ queryKey: WORK_ORDER_PAGES_KEY }),
    qc.invalidateQueries({ queryKey: WORK_ORDER_BY_ID_KEY }),
    qc.invalidateQueries({ queryKey: WORK_ORDER_DETAILS_KEY }),
    qc.invalidateQueries({ queryKey: PORTAL_NAVIGATION_SUMMARY_KEY }),
    qc.invalidateQueries({ queryKey: CONTRACTOR_WORKLOAD_SUMMARY_KEY }),
  ]);
  const invalidateInvoiceData = () => Promise.all([
    qc.invalidateQueries({ queryKey: INVOICES_KEY }),
    qc.invalidateQueries({ queryKey: INVOICE_PAGES_KEY }),
    qc.invalidateQueries({ queryKey: INVOICE_BY_ID_KEY }),
  ]);
  const invalidateWorkflowData = () => Promise.all([
    invalidateWorkOrderData(),
    invalidateInvoiceData(),
  ]);
  const hasLiveSiblingInvoice = async (invoice: any) => {
    if (!invoice?.wot) return true;
    let cursor: string | null = null;
    do {
      const page = await loadInvoicesPage({
        state: "all",
        workOrderId: invoice.wot,
        sort: "recent",
        direction: "desc",
        limit: 100,
        cursor,
      });
      if (page.items.some((candidate: any) =>
        candidate.id !== invoice.id && candidate.state !== "draft"
      )) return true;
      cursor = page.hasMore ? page.nextCursor : null;
    } while (cursor);
    return false;
  };

  const contractorProfileFor = (invoice: any) => {
    const contractorId = invoice?.contractor || invoice?.contractorId;
    return (profiles || []).find((profile: any) => profile.id === contractorId)
      || (currentUser?.role === "contractor" ? currentUser : null)
      || null;
  };
  const contractorPdfOptions = (invoice: any) => {
    const profile = contractorProfileFor(invoice);
    return {
      perspective: "contractor" as const,
      fromName: profile?.company || profile?.name || "Contractor",
      fromEmail: profile?.email || "",
      fromPhone: profile?.phone || "",
    };
  };

  // Contractors explicitly add only the line types they need.
  const defaultInvLines = () => [];
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

  // Persist + upload the system-generated PDF. Shared by submit-new and
  // submit-existing-draft so both paths produce the same artifact in storage.
  const generateAndUploadPdf = async (header: any, draft: any, wo: any, mappedLines: any[], subtotal: number, tax: number, total: number, fullStoreAddr: string) => {
    try {
      const { generateInvoicePDFBlob } = await import("../../lib/invoicePdf");
      const blob = generateInvoicePDFBlob({
        num: draft.num, wot: wo.id, store: wo.store, storeAddr: fullStoreAddr,
        invoiceDate: draft.invoiceDate, serviceDate: draft.serviceDate, terms: draft.terms,
        cme: draft.cme, lines: mappedLines, subtotal, salesTax: tax, total,
      }, null, contractorPdfOptions({ contractor: wo.contractor }));
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
    const uploadOnly = !!draft.uploadOnly;
    const hasUploadedPdf = !!draft.pdfFile || !!draft.hasExistingPdf;
    if (uploadOnly && !hasUploadedPdf) {
      fire("Attach the contractor invoice PDF"); return null;
    }
    const candidateLines = requireFullLines
      ? (draft.lines || []).filter((l: any) =>
          (l.desc || /^(travel|truck charge)$/i.test(String(l.type || "")))
          && Number(l.qty) > 0
          && Number.isFinite(Number(l.rate))
          && Number(l.rate) >= 0,
        )
      : (draft.lines || []).filter((l: any) => l.desc || l.qty || l.rate);
    const validLines = candidateLines.map((line: any) =>
      normalizeInvoiceLineNumbers(line),
    );
    if (!uploadOnly && requireFullLines && validLines.length === 0) {
      fire("Add at least one line item with qty and rate. Travel descriptions are optional."); return null;
    }
    const uploadedTotal = Number(draft.uploadedTotal || 0);
    if (uploadOnly && requireFullLines && (!Number.isFinite(uploadedTotal) || uploadedTotal <= 0)) {
      fire("Enter the total shown on the uploaded invoice"); return null;
    }
    const tax = uploadOnly ? 0 : parseFloat(draft.tax) || 0;
    const subtotal = uploadOnly ? Math.max(uploadedTotal, 0) : invSubtotal(validLines);
    const total = uploadOnly ? Math.max(uploadedTotal, 0) : subtotal + tax;
    const mappedLines = validLines.map((l: any) => ({
      ...l,
      amount: lineAmount(l),
    }));
    const woCity = (wo.city || "").trim();
    const woAddr = (wo.addr || "").trim();
    const fullStoreAddr = !woCity || (woAddr && woAddr.includes(woCity))
      ? woAddr
      : [woAddr, woCity].filter(Boolean).join(", ");
    return { validLines, subtotal, tax, total, mappedLines, fullStoreAddr, uploadOnly };
  };

  // Save (or re-save) an invoice as a DRAFT — does not advance the WO or
  // upload a generated PDF. Resuming a draft and saving again hits the same
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
    const { validLines, tax, total, fullStoreAddr, uploadOnly } = payload;
    const userTypedNum = !!draft.userTypedNum;
    try {
      let result: any;
      if (existingInvoiceId) {
        result = await updateInvoiceWithLines(
          existingInvoiceId,
          { num: draft.num, userTypedNum, cme: draft.cme || null, invoiceDate: draft.invoiceDate, serviceDate: draft.serviceDate || null, terms: draft.terms, storeAddr: fullStoreAddr, state: "draft", salesTax: tax, totalOverride: uploadOnly ? total : undefined },
          validLines,
        );
        await insertActivity(wo.id, currentUser.name, `Invoice #${result.num} draft updated.`, "system", { eventKey: "invoice_draft" });
      } else {
        result = await insertInvoice(
          { ...draft, userTypedNum, wot: wo.id, store: wo.store, storeAddr: fullStoreAddr, contractor: wo.contractor, state: "draft", totalOverride: uploadOnly ? total : undefined },
          validLines,
          currentUser.name,
        );
      }
      if (draft.pdfFile) {
        try {
          await uploadInvoicePdf(result.id, result.num, draft.pdfFile);
          await insertActivity(
            wo.id,
            currentUser.name,
            `PDF attached to invoice #${result.num} draft: ${draft.pdfFile.name}.`,
            "system",
            { eventKey: "invoice_uploaded", eventData: { invoiceId: result.id, invoiceNum: result.num, fileName: draft.pdfFile.name, fileSize: draft.pdfFile.size } },
          );
        } catch (e: any) {
          fire(`Draft saved, but PDF upload failed: ${e.message || e}`);
        }
      }
      invalidateWorkOrderData();
      invalidateInvoiceData();
      announceSavedNum("draft saved", result, draft.num || null);
      resetNewInv();
      return true;
    } catch (e: any) {
      invalidateWorkOrderData();
      invalidateInvoiceData();
      if (e?.code === "INVOICE_NUM_CONFLICT") {
        fire(e.message || "That invoice number already exists for this contractor.");
      } else {
        fire(`Draft save failed: ${e.message || e}`);
      }
      return false;
    }
  };

  const doSubmitInvoice = async (wo: any, formData?: any, existingInvoiceId?: string | null) => {
    const draft = formData ?? newInv;
    const payload = buildInvoicePayload(wo, draft, /* requireFullLines */ true);
    if (!payload) return false;
    const { validLines, subtotal, tax, total, mappedLines, fullStoreAddr, uploadOnly } = payload;
    const userTypedNum = !!draft.userTypedNum;
    let releaseInvoiceLock: (() => void) | null = null;
    if (existingInvoiceId && draft.resubmittingRejected) {
      releaseInvoiceLock = acquireInvoiceMutationLocks([existingInvoiceId]);
      if (!releaseInvoiceLock) {
        fire("This invoice already has an update in progress");
        return false;
      }
    }
    try {
      let header: any;
      let finalNum: string = draft.num || "";
      let collidedFrom: string | null = null;
      let pdfHandled = false;
      if (existingInvoiceId && draft.resubmittingRejected) {
        let replacementPdfPath: string | null = null;
        if (draft.pdfFile) {
          replacementPdfPath = await uploadInvoicePdfObject(
            existingInvoiceId,
            finalNum,
            draft.pdfFile,
          );
        } else if (!draft.hasExistingOriginalPdf) {
          try {
            const { generateInvoicePDFBlob } = await import("../../lib/invoicePdf");
            const blob = generateInvoicePDFBlob({
              num: finalNum,
              wot: wo.id,
              store: wo.store,
              storeAddr: fullStoreAddr,
              invoiceDate: draft.invoiceDate,
              serviceDate: draft.serviceDate,
              terms: draft.terms,
              cme: draft.cme,
              lines: mappedLines,
              subtotal,
              salesTax: tax,
              total,
            }, null, contractorPdfOptions({ contractor: wo.contractor }));
            replacementPdfPath = await uploadInvoicePdfObject(
              existingInvoiceId,
              finalNum,
              blob,
            );
          } catch (error: any) {
            // Line-item invoices remain valid without a cached generated PDF;
            // the normal download path can regenerate it later.
            fire(`PDF upload skipped: ${error.message || error}`);
          }
        }

        const result = await resubmitRejectedContractorInvoice(
          existingInvoiceId,
          {
            cme: draft.cme || null,
            storeAddr: fullStoreAddr,
            invoiceDate: draft.invoiceDate,
            serviceDate: draft.serviceDate || null,
            terms: draft.terms,
            salesTax: tax,
            totalOverride: uploadOnly ? total : null,
            pdfStoragePath: replacementPdfPath,
          },
          validLines,
        );
        header = { id: result.invoiceId };
        finalNum = result.invoiceNum || finalNum;
        pdfHandled = true;
      } else if (existingInvoiceId) {
        // Promote an existing draft to a real submission. Lines are replaced
        // wholesale; state flips to 'submitted'. WO is then nudged into
        // pending_approval (matches the brand-new submit path below).
        const res = await updateInvoiceWithLines(
          existingInvoiceId,
          { num: draft.num, userTypedNum, cme: draft.cme || null, invoiceDate: draft.invoiceDate, serviceDate: draft.serviceDate || null, terms: draft.terms, storeAddr: fullStoreAddr, state: "submitted", salesTax: tax, totalOverride: uploadOnly ? total : undefined },
          validLines,
        );
        header = { id: res.id };
        finalNum = res.num || finalNum;
        collidedFrom = res.collidedFrom;
        await updateWorkOrder(wo.id, { status: "pending_approval", invoiceTotal: total });
        await insertActivity(wo.id, currentUser.name, `Invoice ${finalNum} submitted. Total: $${total.toFixed(2)}.`, "system");
      } else {
        header = await insertInvoice(
          { ...draft, userTypedNum, wot: wo.id, store: wo.store, storeAddr: fullStoreAddr, contractor: wo.contractor, state: "submitted", totalOverride: uploadOnly ? total : undefined },
          validLines,
          currentUser.name,
        );
        finalNum = header.num || finalNum;
        collidedFrom = header._collidedFrom || null;
      }
      // Use the RESOLVED number for the PDF too — otherwise the stored bytes
      // would label the file with the colliding number the user originally
      // typed, which would be wrong on download.
      const draftForPdf = { ...draft, num: finalNum };
      if (!pdfHandled && draft.pdfFile) {
        try {
          await uploadInvoicePdf(header.id, finalNum, draft.pdfFile);
          await insertActivity(
            wo.id,
            currentUser.name,
            `Contractor invoice PDF uploaded for #${finalNum}: ${draft.pdfFile.name}.`,
            "system",
            { eventKey: "invoice_uploaded", eventData: { invoiceId: header.id, invoiceNum: finalNum, fileName: draft.pdfFile.name, fileSize: draft.pdfFile.size } },
          );
        } catch (e: any) {
          fire(`Invoice saved, but PDF upload failed: ${e.message || e}`);
        }
      } else if (!pdfHandled && !draft.hasExistingPdf) {
        await generateAndUploadPdf(header, draftForPdf, wo, mappedLines, subtotal, tax, total, fullStoreAddr);
      }
      invalidateWorkOrderData();
      invalidateInvoiceData();
      setSubmittedInvoiceNum(finalNum);
      if (collidedFrom && collidedFrom !== finalNum) {
        fire(`Invoice #${collidedFrom} already exists — saved as #${finalNum} instead.`);
      }
      resetNewInv();
      return true;
    } catch (e: any) {
      invalidateWorkOrderData();
      invalidateInvoiceData();
      if (e?.code === "INVOICE_NUM_CONFLICT") {
        fire(e.message || "That invoice number already exists for this contractor.");
      } else if (isRpcConflict(e)) {
        fire(rpcConflictMessage("Invoice"));
      } else {
        fire(`Invoice save failed: ${e.message || e}`);
      }
      return false;
    } finally {
      releaseInvoiceLock?.();
    }
  };

  // Original uploads stay byte-for-byte intact. Generated contractor invoices
  // are rendered from the contractor perspective, including legacy rows whose
  // cached artifact predates the branding fix.
  const doDownloadInvoice = async (inv: any) => {
    if (pdfBusy) return;
    setPdfBusy(true);
    try {
      const { triggerBlobDownload, generateInvoicePDFBlob, invoiceFilename } = await import("../../lib/invoicePdf");
      const filename = invoiceFilename(inv);
      if (!inv.pdfStoragePath && (inv.lines || []).length === 0) {
        fire(`Original PDF is unavailable for invoice ${inv.num}. Reattach the contractor invoice before downloading.`);
        return;
      }
      // Externally uploaded PDFs are the source document even when a legacy
      // invoice also has saved line items. Zero-line invoices are retained as
      // a fallback for uploads created before upload audit metadata existed.
      const hasOriginalPdf = inv.pdfStoragePath
        && (inv.pdfIsOriginal || (inv.lines || []).length === 0);
      if (hasOriginalPdf) {
        const blob = await downloadInvoicePdfBlob(inv.pdfStoragePath);
        triggerBlobDownload(blob, inv.originalPdfName || filename);
        fire(`Invoice ${inv.num} downloaded`);
        return;
      }
      // Every generated contractor invoice uses contractor framing for every
      // viewer. This also bypasses legacy cached PDFs that were generated with
      // a P1 header; original contractor-uploaded PDFs remain untouched above.
      const blob = generateInvoicePDFBlob(inv, null, contractorPdfOptions(inv));
      if (inv.id) {
        try {
          if (!inv.pdfStoragePath) {
            await uploadInvoicePdf(inv.id, inv.num, blob);
            void invalidateInvoiceData();
          }
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

  // Staff cleanup retains its service endpoint. Contractors use a narrower,
  // atomic RPC that permits only their own current draft/rejected invoice and
  // writes the audit entry in the same transaction.
  // Deleted invoices vanish from every list/stat because loadInvoices
  // filters deleted_at at the source. Per Gustavo's call, we do NOT
  // auto-revert WO status — if deleting the last non-draft invoice leaves
  // the WO stuck, surface a toast prompting staff to move it manually.
  const doDeleteInvoice = async (inv: any) => {
    try {
      if (currentUser?.role === "contractor") {
        await deleteOwnContractorInvoice(inv.id);
      } else {
        await deleteInvoice(inv.id);
      }
      // The shell no longer owns a global invoice cache. Check only this work
      // order's cursor pages before claiming that its final live invoice was
      // removed; a scoped read preserves the old warning without a full-table
      // bootstrap query.
      let hasLiveSibling: boolean | null = null;
      try {
        hasLiveSibling = await hasLiveSiblingInvoice(inv);
      } catch (loadError) {
        console.error("Could not verify invoice siblings after deletion", loadError);
      }
      await invalidateWorkflowData();
      if (hasLiveSibling === false && inv.wot) {
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

  // Staff-only rejection is atomic with the work-order status and structured
  // activity entry. Email is deliberately after commit: delivery failure must
  // not roll back an otherwise valid review decision.
  const doRejectInvoice = async (inv: any, reason: string) => {
    const trimmed = (reason || "").trim();
    if (!trimmed) { fire("Enter a rejection reason"); return false; }
    const releaseInvoiceLock = acquireInvoiceMutationLocks([inv.id]);
    if (!releaseInvoiceLock) {
      fire("This invoice already has a review in progress");
      return false;
    }
    try {
      await reviewContractorInvoice(inv.id, "reject", trimmed);
      invalidateInvoiceData();
      invalidateWorkOrderData();
      try {
        await notifyInvoiceReview(inv.id, "rejected");
        fire(`Invoice #${inv.num} rejected — contractor notified`);
      } catch (notificationError: any) {
        console.error("Invoice rejection notification failed", notificationError);
        fire(`Invoice #${inv.num} rejected, but the email notification failed`);
      }
      return true;
    } catch (e: any) {
      if (isRpcConflict(e)) {
        await invalidateWorkflowData();
        fire(rpcConflictMessage("Invoice"));
      } else {
        fire(`Reject failed: ${e.message || e}`);
      }
      return false;
    } finally {
      releaseInvoiceLock();
    }
  };

  const doBatchReviewInvoices = async (
    invoiceIds: string[],
    action: "approve" | "reject",
    reason?: string,
  ) => {
    const normalizedIds = [...new Set((invoiceIds || []).filter(Boolean))];
    const reasonText = (reason || "").trim();
    if (normalizedIds.length === 0) {
      fire("Select at least one invoice");
      return false;
    }
    if (normalizedIds.length > 100) {
      fire("Select no more than 100 invoices at a time");
      return false;
    }
    if (action === "reject" && !reasonText) {
      fire("Enter a rejection reason");
      return false;
    }

    const releaseInvoiceLocks = acquireInvoiceMutationLocks(normalizedIds);
    if (!releaseInvoiceLocks) {
      fire("One or more selected invoices already have a review in progress");
      return false;
    }
    try {
      const result = await reviewContractorInvoices(
        normalizedIds,
        action,
        reasonText,
      );
      await invalidateWorkflowData();

      const reviewedCount = Number(result?.count || normalizedIds.length);
      if (action === "approve") {
        fire(`${reviewedCount} invoice${reviewedCount === 1 ? "" : "s"} approved`);
        return true;
      }

      // Review decisions are already committed atomically. Notifications are
      // deliberately independent so a mail outage cannot undo staff work.
      const notifications = await Promise.allSettled(
        normalizedIds.map(invoiceId =>
          notifyInvoiceReview(invoiceId, "rejected"),
        ),
      );
      const failedNotifications = notifications.filter(
        notification => notification.status === "rejected",
      ).length;
      if (failedNotifications > 0) {
        console.error(
          "Batch invoice rejection notifications failed",
          notifications.filter(notification => notification.status === "rejected"),
        );
        fire(`${reviewedCount} invoices rejected, but ${failedNotifications} notification${failedNotifications === 1 ? "" : "s"} failed`);
      } else {
        fire(`${reviewedCount} invoice${reviewedCount === 1 ? "" : "s"} rejected — contractors notified`);
      }
      return true;
    } catch (error: any) {
      if (isRpcConflict(error)) {
        await invalidateWorkflowData();
        fire(rpcConflictMessage("One or more invoices"));
      } else {
        fire(`Batch ${action === "approve" ? "approval" : "rejection"} failed: ${error.message || error}`);
      }
      return false;
    } finally {
      releaseInvoiceLocks();
    }
  };

  const doRetractInvoiceRejection = async (inv: any) => {
    const releaseInvoiceLock = acquireInvoiceMutationLocks([inv.id]);
    if (!releaseInvoiceLock) {
      fire("This invoice already has an update in progress");
      return false;
    }
    try {
      await retractContractorInvoiceRejection(inv.id);
      await invalidateWorkflowData();
      try {
        await notifyInvoiceReview(inv.id, "retraction");
        fire(`Invoice #${inv.num} rejection retracted and approved — contractor notified`);
      } catch (notificationError: any) {
        console.error("Invoice rejection retraction notification failed", notificationError);
        fire(`Invoice #${inv.num} approved, but the correction email failed`);
      }
      return true;
    } catch (error: any) {
      if (isRpcConflict(error)) {
        await invalidateWorkflowData();
        fire(rpcConflictMessage("Invoice"));
      } else {
        fire(`Could not retract rejection: ${error.message || error}`);
      }
      return false;
    } finally {
      releaseInvoiceLock();
    }
  };

  const doCorrectInvoiceTotal = async (
    inv: any,
    correctedTotal: number,
    reason?: string,
  ) => {
    if (!Number.isFinite(correctedTotal) || correctedTotal <= 0) {
      fire("Enter a corrected total greater than zero");
      return false;
    }

    try {
      await correctContractorInvoiceTotal(inv.id, correctedTotal, reason);
      await invalidateWorkflowData();
      fire(`Invoice #${inv.num} total corrected to $${correctedTotal.toFixed(2)}`);
      return true;
    } catch (e: any) {
      fire(`Total correction failed: ${e.message || e}`);
      return false;
    }
  };

  const doPlaceInvoicePaymentHold = async (inv: any, reason: string) => {
    const cleanReason = String(reason || "").trim();
    if (!cleanReason) {
      fire("Enter a reason for the payment hold");
      return false;
    }
    try {
      const result = await updateInvoicePaymentHold(inv.id, "hold", cleanReason);
      await invalidateWorkflowData();
      await qc.invalidateQueries({ queryKey: CONTROLLER_INVOICE_HOLDS_KEY });
      fire(result.notificationWarning
        ? `Invoice #${inv.num} placed on hold. ${result.notificationWarning}`
        : `Invoice #${inv.num} placed on hold — accounting notified`);
      return true;
    } catch (error: any) {
      await invalidateWorkflowData();
      fire(`Payment hold failed: ${error.message || error}`);
      return false;
    }
  };

  const doReleaseInvoicePaymentHold = async (inv: any, reason: string) => {
    const cleanReason = String(reason || "").trim();
    if (!cleanReason) {
      fire("Enter a reason for releasing the payment hold");
      return false;
    }
    try {
      const result = await updateInvoicePaymentHold(inv.id, "release", cleanReason);
      await invalidateWorkflowData();
      await qc.invalidateQueries({ queryKey: CONTROLLER_INVOICE_HOLDS_KEY });
      fire(result.notificationWarning
        ? `Payment hold released for invoice #${inv.num}. ${result.notificationWarning}`
        : `Payment hold released for invoice #${inv.num} — accounting notified`);
      return true;
    } catch (error: any) {
      await invalidateWorkflowData();
      fire(`Could not release payment hold: ${error.message || error}`);
      return false;
    }
  };

  return {
    newInv, setNewInv,
    selectedInvoice, setSelectedInvoice,
    submittedInvoiceNum, setSubmittedInvoiceNum,
    pdfBusy, setPdfBusy,
    nextInvNum, nextInvNumFromDb, defaultInvLines, blankNewInv, resetNewInv,
    doSubmitInvoice, doSaveDraftInvoice, doDownloadInvoice, doDeleteInvoice, doRejectInvoice, doBatchReviewInvoices, doRetractInvoiceRejection, doCorrectInvoiceTotal, doPlaceInvoicePaymentHold, doReleaseInvoicePaymentHold,
    lineAmount, invSubtotal, invTotal,
  };
}
