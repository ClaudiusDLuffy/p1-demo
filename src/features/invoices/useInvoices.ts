"use client";
// @ts-nocheck

import { safeErrorMessage } from "../../lib/errors/normalizeUnknown";
import { reportClientFailure } from "../../lib/clientDiagnostics";
import { useCallback, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  insertInvoice,
  updateInvoiceWithLines,
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
import { contractorInvoiceContextSchema } from "../../lib/contractorInvoiceCommandContracts";
import { invoiceDeletionSnapshotFor, type InvoiceDeletionSnapshot } from "../../lib/contractorInvoiceDraftAdapter";
import { createContractorInvoiceAttempts } from "../../lib/contractorInvoiceAttempts";
import { createGeneratedInvoicePdfAttempts } from "./generatedInvoicePdfAttempts";
import { updateInvoicePaymentHold } from "../../lib/financialNotificationCommands";
import { financialNotificationFeedback, safeFinancialNotificationCommandError } from "../../lib/financialNotificationCommandContracts";
import { financialNoticeKeys } from "../financial-notifications/queries";
import { noticeOperator } from "../financial-notifications/contracts";
import { loadDirectorySelection } from "../directory/api";
import { directoryActorScope, workOrderCountKey, invoiceCountKey } from "../../lib/counts/queryKeys";
import { useInvoiceDocumentAction } from "./useInvoiceDocumentAction";
import { rejectPartialInvoiceDocument } from "./invoiceDocumentRead";

const lineAmount = (l: any) => (parseFloat(l.qty) || 0) * (parseFloat(l.rate) || 0);
const invSubtotal = (lines: any[]) => lines.reduce((s, l) => s + lineAmount(l), 0);
const invTotal = (lines: any[], tax: number) => invSubtotal(lines) + (parseFloat(tax as any) || 0);

export default function useInvoices({ currentUser, fire }: any) {
  const qc = useQueryClient();
  const readScope = directoryActorScope(currentUser);
  const readCompleteDocument = useInvoiceDocumentAction(currentUser);
  const invalidateFinancialNotificationData = async (invoiceIds: string[]) => {
    const operator = noticeOperator(currentUser);
    if (!operator) return;
    const scope = financialNoticeKeys.scope(operator);
    await Promise.all([
      ...invoiceIds.map(id => qc.invalidateQueries({ queryKey: [...scope, "status", id] })),
      qc.invalidateQueries({ queryKey: [...scope, "unresolved"] }),
    ]);
  };
  const [selectedInvoice, setSelectedInvoice] = useState<string | null>(null);
  const [submittedInvoiceNum, setSubmittedInvoiceNum] = useState<string | null>(null);
  const [pdfBusy, setPdfBusy] = useState(false);
  const deletionContexts = useRef(new Map<string, InvoiceDeletionSnapshot>());
  const invoiceAttempts = useRef(createContractorInvoiceAttempts());
  const generatedPdfAttempts = useRef(createGeneratedInvoicePdfAttempts());
  const invalidateWorkOrderData = () => Promise.all([
    qc.invalidateQueries({ queryKey: WORK_ORDERS_KEY }),
    qc.invalidateQueries({ queryKey: WORK_ORDER_PAGES_KEY }),
    qc.invalidateQueries({ queryKey: workOrderCountKey(readScope) }),
    qc.invalidateQueries({ queryKey: WORK_ORDER_BY_ID_KEY }),
    qc.invalidateQueries({ queryKey: WORK_ORDER_DETAILS_KEY }),
    qc.invalidateQueries({ queryKey: PORTAL_NAVIGATION_SUMMARY_KEY }),
    qc.invalidateQueries({ queryKey: CONTRACTOR_WORKLOAD_SUMMARY_KEY }),
  ]);
  const invalidateInvoiceData = () => Promise.all([
    qc.invalidateQueries({ queryKey: INVOICES_KEY }),
    qc.invalidateQueries({ queryKey: INVOICE_PAGES_KEY }),
    qc.invalidateQueries({ queryKey: invoiceCountKey(readScope) }),
    qc.invalidateQueries({ queryKey: INVOICE_BY_ID_KEY }),
  ]);
  const invalidateWorkflowData = () => Promise.all([
    invalidateWorkOrderData(),
    invalidateInvoiceData(),
  ]);
  const refreshFinancialMutation = async (invoiceIds: string[], includeHolds = false) => {
    const refreshes = await Promise.allSettled([
      invalidateWorkflowData(), invalidateFinancialNotificationData(invoiceIds),
      ...(includeHolds ? [qc.invalidateQueries({ queryKey: CONTROLLER_INVOICE_HOLDS_KEY })] : []),
    ]);
    return refreshes.some(result => result.status === "rejected")
      ? ". The action was saved, but the latest view could not be loaded. Refresh to review it." : "";
  };
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

  const contractorProfileFor = async (invoice: { contractor?: string; contractorId?: string }) => {
    const contractorId = invoice?.contractor || invoice?.contractorId;
    if (!contractorId) return null;
    // Self is already an exact authenticated read. Other invoice owners are
    // fetched on demand, never searched in a partial directory page.
    if (currentUser?.id === contractorId) return currentUser;
    const profile = await loadDirectorySelection("contact_detail", contractorId);
    if (profile) return profile;
    // Preserve existing member branding only for this actor's own canonical
    // company. A missing unrelated owner never falls back to the viewer.
    return currentUser?.role === "contractor"
      && currentUser.contractorAccountId === contractorId ? currentUser : null;
  };
  const contractorPdfOptions = async (invoice: { contractor?: string; contractorId?: string }) => {
    const profile = await contractorProfileFor(invoice);
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
  // modal opens. NOT trusted at write time — the owning invoice command
  // resolves collisions atomically. Clients may prefill the same suggestion.
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
  const generateAndUploadPdf = async (header: any, draft: any, wo: any, mappedLines: any[], subtotal: number, tax: number, total: number, fullStoreAddr: string, isCurrent: () => boolean) => {
    try {
      const { generateInvoicePDFBlob } = await import("../../lib/invoicePdf");
      if (!isCurrent()) return;
      const pdfOptions = await contractorPdfOptions({ contractor: wo.contractor });
      if (!isCurrent()) return;
      const blob = generatedPdfAttempts.current.get({ actorId: currentUser?.id ?? null,
        invoiceId: header.id, invoiceVersion: header.invoiceVersion ?? null,
        operationId: draft.commandContext?.operationId ?? null }, [{
        num: draft.num, wot: wo.id, store: wo.store, storeAddr: fullStoreAddr,
        invoiceDate: draft.invoiceDate, serviceDate: draft.serviceDate, terms: draft.terms,
        cme: draft.cme, lines: mappedLines, subtotal, salesTax: tax, total,
      }, null, pdfOptions], generateInvoicePDFBlob);
      await uploadInvoicePdf(header.id, draft.num, blob, "invoice_generated");
    } catch (e: any) {
      // Non-fatal — PDF regenerates on first download via the same path.
      if (isCurrent()) fire(`PDF upload skipped: ${safeErrorMessage(e)}`);
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
      ? (draft.lines || [])
      : (draft.lines || []).filter((l: any) => l.desc || l.qty || l.rate);
    if (requireFullLines && candidateLines.some((line: { desc?: string; type?: string; qty?: unknown; rate?: unknown }) =>
      (!line.desc?.trim() && !/^(travel|truck charge)$/i.test(String(line.type || "")))
      || !Number.isFinite(Number(line.qty)) || Number(line.qty) <= 0
      || !Number.isFinite(Number(line.rate)) || Number(line.rate) < 0,
    )) {
      fire("Check every invoice line's description, quantity, and rate before submitting."); return null;
    }
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
    const tax = uploadOnly ? 0 : Number(draft.tax || 0);
    if (!Number.isFinite(tax) || tax < 0) {
      fire("Enter a valid non-negative tax amount"); return null;
    }
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

  const doSaveDraftInvoice = async (wo: any, formData?: any, existingInvoiceId?: string | null, isCurrent: () => boolean = () => true) => {
    if (!isCurrent()) return false;
    const draft = formData ?? newInv;
    const payload = buildInvoicePayload(wo, draft, /* requireFullLines */ false);
    if (!payload) return false;
    const { validLines, tax, total, fullStoreAddr, uploadOnly } = payload;
    const userTypedNum = !!draft.userTypedNum;
    const operationId = draft.commandContext?.operationId;
    let attemptStarted = false;
    try {
      invoiceAttempts.current.begin(operationId, { action: "draft", context: draft.commandContext,
        draft: { ...draft, pdfFile: draft.pdfFile ? { name: draft.pdfFile.name, size: draft.pdfFile.size, lastModified: draft.pdfFile.lastModified } : null } });
      attemptStarted = true;
      let result: any;
      if (existingInvoiceId) {
        result = await updateInvoiceWithLines(
          existingInvoiceId,
          { num: draft.num, userTypedNum, cme: draft.cme || null, invoiceDate: draft.invoiceDate, serviceDate: draft.serviceDate || null, terms: draft.terms, storeAddr: fullStoreAddr, state: "draft", salesTax: tax, totalOverride: uploadOnly ? total : undefined, commandContext: draft.commandContext },
          validLines,
        );
      } else {
        result = await insertInvoice(
          { ...draft, userTypedNum, wot: wo.id, store: wo.store, storeAddr: fullStoreAddr, contractor: wo.contractor, state: "draft", salesTax: tax, totalOverride: uploadOnly ? total : undefined },
          validLines,
          currentUser.name,
        );
      }
      if (!isCurrent()) { invoiceAttempts.current.finish(operationId); return true; }
      if (draft.pdfFile) {
        try {
          await uploadInvoicePdf(result.id, result.num, draft.pdfFile);
          if (!isCurrent()) { invoiceAttempts.current.finish(operationId); return true; }
          await insertActivity(
            wo.id,
            currentUser.name,
            `PDF attached to invoice #${result.num} draft: ${draft.pdfFile.name}.`,
            "system",
            { eventKey: "invoice_uploaded", eventData: { invoiceId: result.id, invoiceNum: result.num, fileName: draft.pdfFile.name, fileSize: draft.pdfFile.size } },
          );
        } catch (e: any) {
          if (isCurrent()) fire(`Draft saved, but PDF upload failed: ${safeErrorMessage(e)}`);
        }
      }
      if (!isCurrent()) { invoiceAttempts.current.finish(operationId); return true; }
      invalidateWorkOrderData();
      invalidateInvoiceData();
      announceSavedNum("draft saved", result, draft.num || null);
      resetNewInv();
      invoiceAttempts.current.finish(operationId);
      return true;
    } catch (e: any) {
      if (attemptStarted) invoiceAttempts.current.finish(operationId, e);
      if (!isCurrent()) return false;
      invalidateWorkOrderData();
      invalidateInvoiceData();
      if (e?.code === "INVOICE_NUM_CONFLICT") {
        fire(safeErrorMessage(e));
      } else {
        fire(`Draft save failed: ${safeErrorMessage(e)}`);
      }
      return false;
    }
  };

  const doSubmitInvoice = async (wo: any, formData?: any, existingInvoiceId?: string | null, isCurrent: () => boolean = () => true) => {
    if (!isCurrent()) return false;
    const draft = formData ?? newInv;
    const payload = buildInvoicePayload(wo, draft, /* requireFullLines */ true);
    if (!payload) return false;
    const { validLines, subtotal, tax, total, mappedLines, fullStoreAddr, uploadOnly } = payload;
    const userTypedNum = !!draft.userTypedNum;
    const operationId = draft.commandContext?.operationId;
    let attemptStarted = false;
    let releaseInvoiceLock: (() => void) | null = null;
    if (existingInvoiceId && draft.resubmittingRejected) {
      releaseInvoiceLock = acquireInvoiceMutationLocks([existingInvoiceId]);
      if (!releaseInvoiceLock) {
        fire("This invoice already has an update in progress");
        return false;
      }
    }
    try {
      invoiceAttempts.current.begin(operationId, { action: draft.resubmittingRejected ? "revise" : "submit", context: draft.commandContext,
        draft: { ...draft, pdfFile: draft.pdfFile ? { name: draft.pdfFile.name, size: draft.pdfFile.size, lastModified: draft.pdfFile.lastModified } : null } });
      attemptStarted = true;
      let header: any;
      let finalNum: string = draft.num || "";
      let collidedFrom: string | null = null;
      let pdfHandled = false;
      if (existingInvoiceId && draft.resubmittingRejected) {
        let replacementPdfPath: string | null = invoiceAttempts.current.pdfPath(operationId);
        if (!replacementPdfPath && draft.pdfFile) {
          replacementPdfPath = await uploadInvoicePdfObject(
            existingInvoiceId,
            finalNum,
            draft.pdfFile,
          );
        } else if (!replacementPdfPath && !draft.hasExistingOriginalPdf) {
          try {
            const { generateInvoicePDFBlob } = await import("../../lib/invoicePdf");
            if (!isCurrent()) { invoiceAttempts.current.finish(operationId); return false; }
            const pdfOptions = await contractorPdfOptions({ contractor: wo.contractor });
            if (!isCurrent()) { invoiceAttempts.current.finish(operationId); return false; }
            const blob = generatedPdfAttempts.current.get({ actorId: currentUser?.id ?? null,
              invoiceId: existingInvoiceId, invoiceVersion: draft.commandContext?.expectedInvoiceVersion ?? null,
              operationId: operationId ?? null }, [{
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
            }, null, pdfOptions], generateInvoicePDFBlob);
            replacementPdfPath = await uploadInvoicePdfObject(
              existingInvoiceId,
              finalNum,
              blob,
              "invoice_generated",
            );
          } catch (error: any) {
            // Line-item invoices remain valid without a cached generated PDF;
            // the normal download path can regenerate it later.
            if (isCurrent()) fire(`PDF upload skipped: ${safeErrorMessage(error)}`);
          }
        }
        if (replacementPdfPath) invoiceAttempts.current.rememberPdf(operationId, replacementPdfPath);
        if (!isCurrent()) { invoiceAttempts.current.finish(operationId); return false; }

        const result = await resubmitRejectedContractorInvoice(
          existingInvoiceId,
          {
            num: draft.num,
            userTypedNum,
            commandContext: draft.commandContext,
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
        header = result;
        finalNum = result.invoiceNum || finalNum;
        pdfHandled = true;
      } else if (existingInvoiceId) {
        // The owning command replaces lines, submits, and records its audit
        // atomically. Parent invoicing state remains database-authoritative.
        const res = await updateInvoiceWithLines(
          existingInvoiceId,
          { num: draft.num, userTypedNum, cme: draft.cme || null, invoiceDate: draft.invoiceDate, serviceDate: draft.serviceDate || null, terms: draft.terms, storeAddr: fullStoreAddr, state: "submitted", salesTax: tax, totalOverride: uploadOnly ? total : undefined, commandContext: draft.commandContext },
          validLines,
        );
        header = res;
        finalNum = res.num || finalNum;
        collidedFrom = res.collidedFrom;
      } else {
        header = await insertInvoice(
          { ...draft, userTypedNum, wot: wo.id, store: wo.store, storeAddr: fullStoreAddr, contractor: wo.contractor, state: "submitted", salesTax: tax, totalOverride: uploadOnly ? total : undefined },
          validLines,
          currentUser.name,
        );
        finalNum = header.num || finalNum;
        collidedFrom = header._collidedFrom || null;
      }
      // Use the RESOLVED number for the PDF too — otherwise the stored bytes
      // would label the file with the colliding number the user originally
      // typed, which would be wrong on download.
      if (!isCurrent()) { invoiceAttempts.current.finish(operationId); return true; }
      const draftForPdf = { ...draft, num: finalNum };
      if (!pdfHandled && draft.pdfFile) {
        try {
          await uploadInvoicePdf(header.id, finalNum, draft.pdfFile);
          if (!isCurrent()) { invoiceAttempts.current.finish(operationId); return true; }
          await insertActivity(
            wo.id,
            currentUser.name,
            `Contractor invoice PDF uploaded for #${finalNum}: ${draft.pdfFile.name}.`,
            "system",
            { eventKey: "invoice_uploaded", eventData: { invoiceId: header.id, invoiceNum: finalNum, fileName: draft.pdfFile.name, fileSize: draft.pdfFile.size } },
          );
        } catch (e: any) {
          if (isCurrent()) fire(`Invoice saved, but PDF upload failed: ${safeErrorMessage(e)}`);
        }
      } else if (!pdfHandled && !draft.hasExistingPdf) {
        await generateAndUploadPdf(header, draftForPdf, wo, mappedLines, header.subtotal, header.salesTax, header.total, fullStoreAddr, isCurrent);
      }
      if (!isCurrent()) { invoiceAttempts.current.finish(operationId); return true; }
      invalidateWorkOrderData();
      invalidateInvoiceData();
      setSubmittedInvoiceNum(finalNum);
      if (collidedFrom && collidedFrom !== finalNum) {
        fire(`Invoice #${collidedFrom} already exists — saved as #${finalNum} instead.`);
      }
      resetNewInv();
      invoiceAttempts.current.finish(operationId);
      return true;
    } catch (e: any) {
      if (attemptStarted) invoiceAttempts.current.finish(operationId, e);
      if (!isCurrent()) return false;
      invalidateWorkOrderData();
      invalidateInvoiceData();
      if (e?.code === "INVOICE_NUM_CONFLICT") {
        fire(safeErrorMessage(e));
      } else if (isRpcConflict(e)) {
        fire(rpcConflictMessage("Invoice"));
      } else {
        fire(`Invoice save failed: ${safeErrorMessage(e)}`);
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
      // Original uploads require only an authorized exact header. They remain
      // downloadable even when a historical invoice exceeds the editor limit.
      if (inv.projection === "summary") inv = await readCompleteDocument.summary(String(inv.id));
      const { triggerBlobDownload, generateInvoicePDFBlob, invoiceFilename } = await import("../../lib/invoicePdf");
      readCompleteDocument.assertCurrent();
      const filename = invoiceFilename(inv);
      const lineCount = inv.projection === "summary" ? inv.lineCount : (inv.lines || []).length;
      if (!inv.pdfStoragePath && lineCount === 0) {
        fire(`Original PDF is unavailable for invoice ${inv.num}. Reattach the contractor invoice before downloading.`);
        return;
      }
      // Externally uploaded PDFs are the source document even when a legacy
      // invoice also has saved line items. Zero-line invoices are retained as
      // a fallback for uploads created before upload audit metadata existed.
      const hasOriginalPdf = inv.pdfStoragePath
        && (inv.pdfIsOriginal || lineCount === 0);
      if (hasOriginalPdf) {
        const blob = await downloadInvoicePdfBlob(inv.pdfStoragePath);
        readCompleteDocument.assertCurrent();
        triggerBlobDownload(blob, inv.originalPdfName || filename);
        fire(`Invoice ${inv.num} downloaded`);
        return;
      }
      // Generated exports require all version-consistent lines; a summary or
      // the currently visible line page can never become a financial document.
      if (inv.projection === "summary") inv = await readCompleteDocument(String(inv.id), "pdf");
      rejectPartialInvoiceDocument(inv);
      // Every generated contractor invoice uses contractor framing for every
      // viewer. This also bypasses legacy cached PDFs that were generated with
      // a P1 header; original contractor-uploaded PDFs remain untouched above.
      const pdfOptions = await contractorPdfOptions(inv);
      readCompleteDocument.assertCurrent();
      const blob = generatedPdfAttempts.current.get({ actorId: currentUser?.id ?? null,
        invoiceId: inv.id ?? "", invoiceVersion: inv.invoiceVersion ?? null, operationId: null },
      [inv, null, pdfOptions], generateInvoicePDFBlob);
      if (inv.id) {
        try {
          if (!inv.pdfStoragePath) {
            await uploadInvoicePdf(inv.id, inv.num, blob, "invoice_generated");
            void invalidateInvoiceData();
          }
        } catch (e: any) {
          fire(`PDF cache failed: ${safeErrorMessage(e)}`);
        }
      }
      readCompleteDocument.assertCurrent();
      triggerBlobDownload(blob, filename);
      fire(`Invoice ${inv.num} downloaded`);
    } catch (e: any) {
      fire(`Download failed: ${safeErrorMessage(e)}`);
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
      let context = deletionContexts.current.get(inv.id);
      if (!context) {
        context = invoiceDeletionSnapshotFor(inv, crypto.randomUUID());
        deletionContexts.current.set(inv.id, context);
      }
      if (currentUser?.role === "contractor") {
        await deleteOwnContractorInvoice(inv.id, contractorInvoiceContextSchema.parse(context));
      } else {
        await deleteInvoice(inv.id, {
          operationId: context.operationId, expectedInvoiceVersion: context.expectedInvoiceVersion,
          expectedAssignmentVersion: context.expectedAssignmentVersion, expectedWorkflowCycle: context.expectedWorkflowCycle,
        });
      }
      deletionContexts.current.delete(inv.id);
      // The shell no longer owns a global invoice cache. Check only this work
      // order's cursor pages before claiming that its final live invoice was
      // removed; a scoped read preserves the old warning without a full-table
      // bootstrap query.
      let hasLiveSibling: boolean | null = null;
      try {
        hasLiveSibling = await hasLiveSiblingInvoice(inv);
      } catch {
        void reportClientFailure({ source: "invoice_sibling_refresh", message: "RESULT_UNCONFIRMED" });
      }
      await invalidateWorkflowData();
      if (hasLiveSibling === false && inv.wot) {
        fire(`Invoice #${inv.num} deleted — no live invoices left on ${inv.wot}; move the WO manually if needed.`);
      } else {
        fire(`Invoice #${inv.num} deleted`);
      }
      return true;
    } catch (e: any) {
      fire(`Delete failed: ${safeErrorMessage(e)}`);
      return false;
    }
  };

  // The review command owns its durable notification intent. Browser lifetime
  // and provider delivery no longer determine whether a notice is recorded.
  const doRejectInvoice = async (inv: { id: string; num: string; reviewRevision: number }, reason: string) => {
    const trimmed = (reason || "").trim();
    if (!trimmed) { fire("Enter a rejection reason"); return false; }
    const releaseInvoiceLock = acquireInvoiceMutationLocks([inv.id]);
    if (!releaseInvoiceLock) {
      fire("This invoice already has a review in progress");
      return false;
    }
    try {
      const result = await reviewContractorInvoice(inv.id, "reject", trimmed, inv.reviewRevision);
      const refreshWarning = await refreshFinancialMutation([inv.id]);
      fire(`Invoice #${inv.num} rejected — ${financialNotificationFeedback(result)}${refreshWarning}`);
      return true;
    } catch (cause) {
      await invalidateWorkflowData().catch(() => undefined);
      fire(safeFinancialNotificationCommandError(cause).message);
      return false;
    } finally {
      releaseInvoiceLock();
    }
  };

  const doBatchReviewInvoices = async (
    invoiceIds: string[],
    action: "approve" | "reject",
    reason?: string,
    expectedRevisions?: Record<string, number>,
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
        expectedRevisions,
      );
      const refreshWarning = await refreshFinancialMutation(normalizedIds);

      const reviewedCount = Number(result?.count || normalizedIds.length);
      if (action === "approve") {
        fire(`${reviewedCount} invoice${reviewedCount === 1 ? "" : "s"} approved${refreshWarning}`);
        return true;
      }

      const needsAttention = result.results.filter(item => item.notificationStatus === "not_deliverable").length;
      fire(`${reviewedCount} invoice${reviewedCount === 1 ? "" : "s"} rejected — ${needsAttention
        ? `${needsAttention} notification${needsAttention === 1 ? " needs" : "s need"} attention; review invoice notification delivery`
        : "notifications queued"}${refreshWarning}`);
      return true;
    } catch (error) {
      await invalidateWorkflowData().catch(() => undefined);
      fire(safeFinancialNotificationCommandError(error).message);
      return false;
    } finally {
      releaseInvoiceLocks();
    }
  };

  const doRetractInvoiceRejection = async (inv: { id: string; num: string; reviewRevision: number }) => {
    const releaseInvoiceLock = acquireInvoiceMutationLocks([inv.id]);
    if (!releaseInvoiceLock) {
      fire("This invoice already has an update in progress");
      return false;
    }
    try {
      const result = await retractContractorInvoiceRejection(inv.id, inv.reviewRevision);
      const refreshWarning = await refreshFinancialMutation([inv.id]);
      fire(`Invoice #${inv.num} rejection retracted and approved — ${financialNotificationFeedback(result)}${refreshWarning}`);
      return true;
    } catch (error) {
      await invalidateWorkflowData().catch(() => undefined);
      fire(safeFinancialNotificationCommandError(error).message);
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
      fire(`Total correction failed: ${safeErrorMessage(e)}`);
      return false;
    }
  };

  const doPlaceInvoicePaymentHold = async (inv: { id: string; num: string }, reason: string, expectedSourceEventId?: string | null) => {
    const cleanReason = String(reason || "").trim();
    if (!cleanReason) {
      fire("Enter a reason for the payment hold");
      return false;
    }
    try {
      const result = await updateInvoicePaymentHold(inv.id, "hold", cleanReason, expectedSourceEventId);
      const refreshWarning = await refreshFinancialMutation([inv.id], true);
      fire(`Invoice #${inv.num} placed on hold — ${financialNotificationFeedback(result)}${refreshWarning}`);
      return true;
    } catch (error) {
      await invalidateWorkflowData().catch(() => undefined);
      fire(safeFinancialNotificationCommandError(error).message);
      return false;
    }
  };

  const doReleaseInvoicePaymentHold = async (inv: { id: string; num: string }, reason: string, expectedSourceEventId?: string | null) => {
    const cleanReason = String(reason || "").trim();
    if (!cleanReason) {
      fire("Enter a reason for releasing the payment hold");
      return false;
    }
    try {
      const result = await updateInvoicePaymentHold(inv.id, "release", cleanReason, expectedSourceEventId);
      const refreshWarning = await refreshFinancialMutation([inv.id], true);
      fire(`Payment hold released for invoice #${inv.num} — ${financialNotificationFeedback(result)}${refreshWarning}`);
      return true;
    } catch (error) {
      await invalidateWorkflowData().catch(() => undefined);
      fire(safeFinancialNotificationCommandError(error).message);
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
