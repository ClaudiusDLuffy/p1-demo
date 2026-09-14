"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useUnsavedChangesGuard } from "../../lib/forms/useUnsavedChangesGuard";
import { useForm, useFieldArray } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { CreateInvoiceSchema, CreateInvoiceForm } from "../../lib/schemas";
import { Modal } from "../../components/ui/Modal";
import { BtnSpinner } from "../../components/ui/BtnSpinner";
import { CopyWorkOrderButton } from "../../components/ui/CopyWorkOrderButton";
import { Sel } from "../../components/ui/Sel";
import { T, LINE_TYPES, P1_BUSINESS } from "../../lib/constants";
import { parseInvoicePdf } from "../../lib/invoicePdfParserClient";
import { InvoicePdfError } from "../../lib/pdf/invoicePdfBudget";
import { invoiceQuantityInputConstraints } from "../../lib/invoiceQuantity";
import { canonicalSevenElevenWorkOrderId } from "../../lib/workOrderIdentity";
import { useWorkOrderPartsQuery } from "../work-orders/queries";
import { contractorInvoiceSnapshotFor } from "../../lib/contractorInvoiceCommands";
import type { ContractorInvoiceContext, ContractorInvoiceSnapshot } from "../../lib/contractorInvoiceCommandContracts";

type InvoiceModalWorkOrder = {
  id: string; store?: string | number | null; addr?: string | null;
  contractorAssignmentVersion?: number; workflowCycle?: number;
  duplicateRootWorkOrderId?: string | null; duplicate_root_work_order_id?: string | null;
};
type InvoiceDraftLine = { type: string; desc?: string | null; description?: string | null; qty?: number | string | null; rate?: number | string | null };
type InvoiceModalDraft = {
  projection?: "summary" | "complete_document";
  id: string; state?: string; num?: string; invoiceVersion?: number; pdfStoragePath?: string | null; pdfIsOriginal?: boolean;
  invoiceDateRaw?: string; invoiceDate?: string; serviceDateRaw?: string; serviceDate?: string; terms?: string;
  salesTax?: number | null; cme?: string; total?: number; lines?: InvoiceDraftLine[];
  rejectionReason?: string | null; reason?: string | null;
};
type InvoiceModalPayload = CreateInvoiceForm & {
  userTypedNum: boolean; pdfFile: File | null; hasExistingPdf: boolean; hasExistingOriginalPdf?: boolean;
  commandContext: ContractorInvoiceContext | null; submissionKey?: string; resubmittingRejected?: boolean;
};
type InvoiceModalProps = {
  modal: string | null; woData?: InvoiceModalWorkOrder | null;
  currentUser?: { id?: string; company?: string | null; name?: string | null } | null;
  fmt(value: number): string; setModal(value: string | null): void; resetNewInv(): void;
  doSubmitInvoice(workOrder: InvoiceModalWorkOrder, data: InvoiceModalPayload, invoiceId: string | null): Promise<boolean | void>;
  doSaveDraftInvoice?(workOrder: InvoiceModalWorkOrder, data: InvoiceModalPayload, invoiceId: string | null): Promise<boolean | void>;
  resumeDraft?: InvoiceModalDraft | null; nextInvNumFromDb?(): Promise<string>; woParts?: readonly unknown[];
  // Existing shell compatibility props are not consumed by this form.
  invSubtotal?: unknown; newInv?: unknown; lineAmount?: unknown; invoices?: unknown; setNewInv?: unknown;
};
type ReceivedPart = { workOrderId: string; status: "received"; description: string; partNumber?: string | null; qty?: number | string | null };
const isReceivedPart = (part: unknown): part is ReceivedPart => typeof part === "object" && part !== null
  && "workOrderId" in part && typeof part.workOrderId === "string" && "status" in part && part.status === "received"
  && "description" in part && typeof part.description === "string"
  && (!("partNumber" in part) || part.partNumber == null || typeof part.partNumber === "string")
  && (!("qty" in part) || part.qty == null || typeof part.qty === "string" || typeof part.qty === "number");
const amount = (l: Pick<CreateInvoiceForm["lines"][number], "qty" | "rate"> | undefined) => (Number(l?.qty) || 0) * (Number(l?.rate) || 0);
const todayIso = () => {
  const date = new Date();
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

const createSubmissionKey = () => {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, character => {
    const random = Math.floor(Math.random() * 16);
    const value = character === "x" ? random : (random & 0x3) | 0x8;
    return value.toString(16);
  });
};

// Contractors explicitly add only the line types needed for this invoice.
const initialLines = (): CreateInvoiceForm["lines"] => [];

export default function InvoiceCreateModal(props: InvoiceModalProps) {
  const formId = useId();
  const pdfUploadInput = useRef<HTMLInputElement>(null);
  const { modal, woData, currentUser, fmt, setModal, resetNewInv, doSubmitInvoice, doSaveDraftInvoice, resumeDraft, nextInvNumFromDb, woParts: suppliedWoParts = [] } = props;
  const partsQuery = useWorkOrderPartsQuery(
    woData?.id,
    modal === "createInvoice" && Boolean(woData?.id),
  );
  const woParts: readonly unknown[] = partsQuery.data || suppliedWoParts;
  // Parts on this WO that have been received (and so are billable) — feeds
  // the "Add from parts list" button below the line items grid. Description
  // + qty pre-fill only; the contractor types their own rate.
  const receivedPartsForWO = useMemo(() => {
    if (!woData) return [];
    return woParts.filter(isReceivedPart).filter(p => p.workOrderId === woData.id);
  }, [woParts, woData]);
  const [submitting, setSubmitting] = useState(false);
  const [savingDraft, setSavingDraft] = useState(false);
  const [pdfFile, setPdfFile] = useState<File | null>(null);
  const [pdfError, setPdfError] = useState("");
  const [pdfParseStatus, setPdfParseStatus] = useState<"idle" | "reading" | "detected" | "manual">("idle");
  const [pdfLineStatus, setPdfLineStatus] = useState<"idle" | "detected" | "none">("idle");
  const [pdfLinesReviewed, setPdfLinesReviewed] = useState(false);
  const pdfParseAttempt = useRef(0);
  const pdfParseController = useRef<AbortController | null>(null);
  const pdfParsingFile = useRef<File | null>(null);
  const numTouchedRef = useRef(false);
  const submitLockRef = useRef(false);
  const submissionKeyRef = useRef("");
  const draftOperationKeyRef = useRef("");
  const invoiceSnapshotRef = useRef<ContractorInvoiceSnapshot | null>(null);
  const snapshotSessionRef = useRef<string | null>(null);
  const hydratedFormSessionRef = useRef<string | null>(null);
  const hydrationGenerationRef = useRef(0);
  const existingInvoiceId = resumeDraft?.id || null;
  const isRejectedResubmission = resumeDraft?.state === "rejected";
  // Tracks whether the user has touched the # field — if so we trust their
  // value (and surface a friendly toast if it collides). If untouched, the
  // hook can replace it with a freshly-resolved DB number on submit.
  const [numTouched, setNumTouched] = useState(false);
  const {
    register,
    handleSubmit,
    control,
    watch,
    reset,
    setValue,
    formState: { errors, isDirty },
  } = useForm<CreateInvoiceForm>({
    resolver: zodResolver(CreateInvoiceSchema),
    defaultValues: {
      num: "",
      invoiceDate: todayIso(),
      serviceDate: todayIso(),
      terms: "Net 30",
      tax: "",
      cme: "",
      uploadOnly: false,
      uploadedTotal: "",
      lines: initialLines(),
    },
  });
  const { fields, append, remove, replace } = useFieldArray({ control, name: "lines" });
  const watchedLines = watch("lines") || [];
  const watchedTax = watch("tax");
  const uploadOnly = !!watch("uploadOnly");
  const uploadedTotal = Number(watch("uploadedTotal") || 0);
  const sub = watchedLines.reduce((s, l) => s + amount(l), 0);
  const tax = parseFloat(watchedTax || "") || 0;
  const total = uploadOnly ? uploadedTotal : sub + tax;
  const uploadedLineDifference = uploadOnly ? Math.abs(sub - uploadedTotal) : 0;
  const uploadedLinesMatchTotal = uploadedLineDifference <= Math.max(0.05, uploadedTotal * 0.01);

  useEffect(() => {
    if (modal !== "createInvoice") { snapshotSessionRef.current = null; invoiceSnapshotRef.current = null; return; }
    if (!woData?.id) return;
    const session = `${woData.id}:${resumeDraft?.id || "new"}`;
    if (snapshotSessionRef.current === session) return;
    snapshotSessionRef.current = session;
    try { invoiceSnapshotRef.current = contractorInvoiceSnapshotFor(woData, resumeDraft); }
    catch { invoiceSnapshotRef.current = null; } // Missing schema/version fails closed at the command boundary.
  }, [modal, woData, resumeDraft]);

  useEffect(() => () => {
    hydratedFormSessionRef.current = null;
    hydrationGenerationRef.current += 1;
    pdfParseAttempt.current += 1;
    pdfParseController.current?.abort();
    pdfParseController.current = null;
    pdfParsingFile.current = null;
  }, [modal, woData?.id, currentUser?.id]);

  useEffect(() => {
    if (modal !== "createInvoice") { hydratedFormSessionRef.current = null; return; }
    const formSession = `${currentUser?.id || ""}:${woData?.id || ""}:${resumeDraft?.id || "new"}`;
    if (hydratedFormSessionRef.current === formSession) return;
    hydratedFormSessionRef.current = formSession;
    const hydrationGeneration = ++hydrationGenerationRef.current;
    submitLockRef.current = false;
    setSubmitting(false);
    setSavingDraft(false);
    pdfParseController.current?.abort();
    pdfParseController.current = null;
    pdfParsingFile.current = null;
    pdfParseAttempt.current += 1;
    submissionKeyRef.current = createSubmissionKey();
    draftOperationKeyRef.current = createSubmissionKey();
    numTouchedRef.current = false;
    setNumTouched(false);
    setPdfFile(null);
    setPdfError("");
    setPdfLineStatus("idle");
    setPdfLinesReviewed(false);
    // Resuming an existing draft → hydrate the form from its stored fields
    // (keep its existing number untouched). Otherwise pull the authoritative
    // next-number from the DB so the user sees a non-colliding suggestion
    // immediately; falls back to blank if the lookup fails.
    if (resumeDraft) {
      numTouchedRef.current = true;
      setNumTouched(true);
      const resumeUploadOnly = !!resumeDraft.pdfStoragePath
        && (!!resumeDraft.pdfIsOriginal || (resumeDraft.lines || []).length === 0);
      setPdfParseStatus(resumeUploadOnly ? "detected" : "idle");
      setPdfLineStatus(
        resumeUploadOnly
          ? (resumeDraft.lines || []).length > 0 ? "detected" : "none"
          : "idle",
      );
      setPdfLinesReviewed(resumeUploadOnly && (resumeDraft.lines || []).length > 0);
      reset({
        num: resumeDraft.num || "",
        invoiceDate: resumeDraft.invoiceDateRaw || resumeDraft.invoiceDate || todayIso(),
        serviceDate: resumeDraft.serviceDateRaw || resumeDraft.serviceDate || todayIso(),
        terms: resumeDraft.terms || "Net 30",
        tax: resumeUploadOnly ? "" : resumeDraft.salesTax != null ? String(resumeDraft.salesTax) : "",
        cme: resumeDraft.cme || "",
        uploadOnly: resumeUploadOnly,
        uploadedTotal: resumeUploadOnly ? String(resumeDraft.total || "") : "",
        lines: (resumeDraft.lines || []).length
          ? (resumeDraft.lines || []).map(l => ({ type: l.type, desc: l.desc || l.description || "", qty: l.qty == null ? 1 : Number(l.qty), rate: Number(l.rate) }))
          : resumeUploadOnly ? [] : initialLines(),
      });
    } else {
      setPdfParseStatus("idle");
      setPdfLineStatus("idle");
      setPdfLinesReviewed(false);
      const today = todayIso();
      reset({
        num: "",
        invoiceDate: today,
        serviceDate: today,
        terms: "Net 30",
        tax: "",
        cme: "",
        uploadOnly: false,
        uploadedTotal: "",
        lines: initialLines(),
      });
      // Async hydrate the suggested invoice number. If the user is already
      // typing by the time it returns, we don't clobber their input.
      if (typeof nextInvNumFromDb === "function") {
        (async () => {
          try {
            const suggested = await nextInvNumFromDb();
            if (hydratedFormSessionRef.current !== formSession || hydrationGenerationRef.current !== hydrationGeneration) return;
            if (!numTouchedRef.current) {
              // Write only the suggestion; preserve all authored fields.
              setValue("num", suggested, { shouldDirty: false });
            }
          } catch { /* keep blank — submit-side retry still saves us */ }
        })();
      }
    }
  }, [modal, reset, setValue, resumeDraft, nextInvNumFromDb, woData?.id, currentUser?.id]);

  const close = () => {
    const today = todayIso();
    hydrationGenerationRef.current += 1;
    pdfParseAttempt.current += 1;
    pdfParseController.current?.abort();
    pdfParseController.current = null;
    pdfParsingFile.current = null;
    numTouchedRef.current = false;
    setNumTouched(false);
    reset({
      num: "",
      invoiceDate: today,
      serviceDate: today,
      terms: "Net 30",
      tax: "",
      cme: "",
      uploadOnly: false,
      uploadedTotal: "",
      lines: initialLines(),
    });
    resetNewInv();
    setPdfFile(null);
    setPdfError("");
    setPdfParseStatus("idle");
    setPdfLineStatus("idle");
    setPdfLinesReviewed(false);
    submissionKeyRef.current = "";
    draftOperationKeyRef.current = "";
    invoiceSnapshotRef.current = null;
    snapshotSessionRef.current = null;
    submitLockRef.current = false;
    setModal(null);
  };
  const dismissal = useUnsavedChangesGuard({
    scopeKey: `${currentUser?.id || ""}:${woData?.id || ""}:${resumeDraft?.id || "new"}`,
    dirty: isDirty || Boolean(pdfFile), busy: submitting || savingDraft,
    enabled: modal === "createInvoice" && Boolean(woData), onClose: close,
  });
  if (modal !== "createInvoice" || !woData) return null;
  if (resumeDraft?.projection && resumeDraft.projection !== "complete_document") return <Modal title="Invoice not ready to edit" onClose={() => setModal(null)} width={420}>
    <p role="alert">The complete invoice has not been loaded. Close and reopen Edit before making changes.</p>
  </Modal>;
  const externalWorkOrderId = canonicalSevenElevenWorkOrderId(woData);
  const portalWorkOrderId = String(woData.id || "").trim();
  const portalReassignmentReference = externalWorkOrderId !== portalWorkOrderId ? portalWorkOrderId : null;
  const clearPendingPdf = (error = "") => {
    pdfParseAttempt.current += 1;
    pdfParseController.current?.abort();
    pdfParseController.current = null;
    pdfParsingFile.current = null;
    setPdfFile(null);
    setPdfError(error);
    setPdfParseStatus(resumeDraft?.pdfStoragePath ? "detected" : "idle");
    if (resumeDraft?.pdfStoragePath) {
      setValue("uploadOnly", true, { shouldDirty: true });
      setValue("uploadedTotal", String(resumeDraft.total || ""), { shouldDirty: true });
      const existingLines = (resumeDraft.lines || []).map(line => ({
        type: line.type || "Other",
        desc: line.desc || line.description || "",
        qty: Number(line.qty) || 1,
        rate: Number(line.rate) || 0,
      }));
      replace(existingLines);
      setPdfLineStatus(existingLines.length > 0 ? "detected" : "none");
      setPdfLinesReviewed(existingLines.length > 0);
    } else {
      setValue("uploadOnly", false, { shouldDirty: true });
      setValue("uploadedTotal", "", { shouldDirty: true });
      if (fields.length === 0) replace(initialLines());
      setPdfLineStatus("idle");
      setPdfLinesReviewed(false);
    }
  };
  const onSubmit = async (data: CreateInvoiceForm) => {
    if (submitLockRef.current) return;
    if (pdfParseController.current) return;
    if (data.uploadOnly && (data.lines || []).length > 0 && !pdfLinesReviewed) {
      setPdfError("Review the extracted line items and confirm them before submitting.");
      return;
    }
    submitLockRef.current = true;
    setSubmitting(true);
    const submitGeneration = hydrationGenerationRef.current;
    try {
    const ok = await doSubmitInvoice(woData, {
      ...data,
      userTypedNum: numTouched,
      pdfFile,
      hasExistingPdf: !!resumeDraft?.pdfStoragePath,
      hasExistingOriginalPdf: !!resumeDraft?.pdfStoragePath
        && (!!resumeDraft?.pdfIsOriginal || (resumeDraft?.lines || []).length === 0),
      submissionKey: submissionKeyRef.current,
      commandContext: invoiceSnapshotRef.current && { ...invoiceSnapshotRef.current, operationId: submissionKeyRef.current },
      resubmittingRejected: isRejectedResubmission,
    }, existingInvoiceId);
    if (ok && hydrationGenerationRef.current === submitGeneration) reset();
    } finally {
      if (hydrationGenerationRef.current === submitGeneration) {
        submitLockRef.current = false;
        setSubmitting(false);
      }
    }
  };

  return (
    <Modal
      onRequestClose={dismissal.requestClose}
      dismissDisabled={submitting || savingDraft}
      title={isRejectedResubmission ? `Correct invoice #${resumeDraft.num}` : "Create invoice"}
      width={820}
      closeOnBackdrop={false}
    >
      {dismissal.dialog}
      <form onSubmit={handleSubmit(onSubmit)}>
        <div style={{ fontSize: 13, color: T.muted, marginBottom: isRejectedResubmission ? 12 : 20 }}>
          Invoice from {currentUser?.company || currentUser?.name || "your company"} to P1 Pros - Work Order {externalWorkOrderId}
          {portalReassignmentReference && (
            <span className="mono" style={{ display: "block", fontSize: 10, color: T.subtle, marginTop: 3 }}>
              P1 portal reassignment: {portalReassignmentReference}
            </span>
          )}
        </div>

        {isRejectedResubmission && (
          <div style={{ padding: "12px 14px", marginBottom: 18, borderRadius: 10, border: `1px solid ${T.danger}33`, background: T.dangerSoft }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: T.danger, textTransform: "uppercase", letterSpacing: 0.6, marginBottom: 4 }}>Correction requested</div>
            <div style={{ fontSize: 12, color: "#8B2C20", lineHeight: 1.5 }}>{resumeDraft.rejectionReason || resumeDraft.reason || "Review the invoice and correct the requested information before resubmitting."}</div>
            <div style={{ fontSize: 11, color: T.muted, lineHeight: 1.5, marginTop: 6 }}>The same invoice record and number will be preserved. Once resubmitted, it will be locked while P1 reviews it again.</div>
          </div>
        )}

        {/* Contractor invoice direction: FROM the contractor, BILL TO P1 Pros.
            Contractors have no direct 7-Eleven access — P1 reviews + posts to
            7-Eleven after approval. Staff-side detail/PDF keep the 7-Eleven
            framing (the document P1 ultimately sends). */}
        <div className="modal-form-row" style={{ display: "grid", gridTemplateColumns: "1.2fr 1fr 1fr", gap: 14, padding: "14px 16px", background: T.surfaceSoft, borderRadius: 12, border: `1px solid ${T.borderSoft}`, marginBottom: 18 }}>
          <div>
            <div style={{ fontSize: 9, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.8, color: T.subtle, marginBottom: 4 }}>From</div>
            <div className="display" style={{ fontSize: 16, color: T.ink, lineHeight: 1.1 }}>{currentUser?.company || currentUser?.name || "Your company"}</div>
            {currentUser?.company && currentUser?.name && <div style={{ fontSize: 10, color: T.subtle, marginTop: 2 }}>{currentUser.name}</div>}
          </div>
          <div>
            <div style={{ fontSize: 9, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.8, color: T.subtle, marginBottom: 4 }}>Bill to</div>
            <div style={{ fontSize: 11, color: T.ink, fontWeight: 600 }}>{P1_BUSINESS.dba}</div>
            <div style={{ fontSize: 11, color: T.muted, lineHeight: 1.5 }}>{P1_BUSINESS.addr1}<br />{P1_BUSINESS.addr2}</div>
          </div>
          <div>
            <div style={{ fontSize: 9, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.8, color: T.subtle, marginBottom: 4 }}>Reference - Store #{woData.store}</div>
            <div style={{ fontSize: 11, color: T.muted, lineHeight: 1.5 }}>{woData.addr || "-"}</div>
          </div>
        </div>

        <div className="modal-form-row" style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 10, marginBottom: 16 }}>
          <label><span style={{ display: "block", fontSize: 11, fontWeight: 600, color: T.muted, marginBottom: 6 }}>Invoice #</span><input aria-invalid={Boolean(errors.num)} aria-describedby={errors.num ? `${formId}-number-error` : undefined} {...register("num", { onChange: () => { numTouchedRef.current = true; setNumTouched(true); } })} readOnly={isRejectedResubmission} aria-readonly={isRejectedResubmission} placeholder="e.g. 6557" style={{ width: "100%", padding: "10px 13px", borderRadius: 10, border: `1px solid ${T.border}`, background: isRejectedResubmission ? T.surfaceSoft : T.surface, color: T.ink, fontSize: 13, cursor: isRejectedResubmission ? "not-allowed" : "text" }} />{errors.num && <span id={`${formId}-number-error`} role="alert" style={{ fontSize: 11, color: T.danger }}>{errors.num.message}</span>}</label>
          <label><span style={{ display: "block", fontSize: 11, fontWeight: 600, color: T.muted, marginBottom: 6 }}>Invoice date</span><input type="date" {...register("invoiceDate")} style={{ width: "100%", padding: "10px 13px", borderRadius: 10, border: `1px solid ${T.border}`, background: T.surface, color: T.ink, fontSize: 13 }} /></label>
          <label><span style={{ display: "block", fontSize: 11, fontWeight: 600, color: T.muted, marginBottom: 6 }}>Service date</span><input type="date" {...register("serviceDate")} style={{ width: "100%", padding: "10px 13px", borderRadius: 10, border: `1px solid ${T.border}`, background: T.surface, color: T.ink, fontSize: 13 }} /></label>
          <label><span style={{ display: "block", fontSize: 11, fontWeight: 600, color: T.muted, marginBottom: 6 }}>Terms</span><Sel aria-label="Terms" {...register("terms")} style={{ width: "100%", padding: "10px 13px", borderRadius: 10, border: `1px solid ${T.border}`, background: T.surface, color: T.ink, fontSize: 13 }}><option>Net 30</option><option>Net 15</option><option>Due on receipt</option></Sel></label>
        </div>

        <div className="modal-form-row" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 18 }}>
          <div>
            <div style={{ fontSize: 11, fontWeight: 600, color: T.muted, marginBottom: 6 }}>Work Order #</div>
            <div className="numeric-readable" style={{ minHeight: 42, display: "flex", flexDirection: "column", alignItems: "flex-start", justifyContent: "center", gap: 2, padding: "7px 8px 7px 13px", borderRadius: 10, border: `1px solid ${T.borderSoft}`, background: T.surfaceSoft, fontSize: 13, color: T.ink }}>
              <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
                {externalWorkOrderId}
                <CopyWorkOrderButton value={externalWorkOrderId} />
              </span>
              {portalReassignmentReference && (
                <span style={{ fontSize: 9, color: T.subtle }}>
                  P1 portal reassignment: {portalReassignmentReference}
                </span>
              )}
            </div>
          </div>
          <div><div style={{ fontSize: 11, fontWeight: 600, color: T.muted, marginBottom: 6 }}>Store #</div><div style={{ padding: "10px 13px", borderRadius: 10, border: `1px solid ${T.borderSoft}`, background: T.surfaceSoft, fontSize: 13, color: T.ink }}>#{woData.store}</div></div>
        </div>

        <div style={{ display: !uploadOnly || fields.length > 0 ? "block" : "none" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, marginBottom: 8, flexWrap: "wrap" }}>
          <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.8, color: T.subtle }}>
            {uploadOnly ? "Review extracted line items" : "Line items"}
          </div>
          {uploadOnly && (
            <button
              type="button"
              className="btn-soft"
              onClick={() => {
                replace([]);
                setPdfLineStatus("none");
                setPdfLinesReviewed(false);
                setPdfError("");
              }}
              style={{ padding: "5px 9px", fontSize: 10 }}
            >
              Use invoice total only
            </button>
          )}
        </div>
        {uploadOnly && (
          <div style={{ fontSize: 11, lineHeight: 1.5, color: T.muted, marginBottom: 10 }}>
            Confirm the description, quantity, and rate against the uploaded PDF. You can edit, add, or remove any extracted row.
          </div>
        )}
        <div style={{ border: `1px solid ${T.borderSoft}`, borderRadius: 12, overflow: "hidden", marginBottom: 10 }}>
          <div className="inv-line-head" style={{ display: "grid", gridTemplateColumns: "30px 140px 1fr 70px 90px 90px 28px", gap: 10, padding: "10px 12px", background: T.surfaceSoft, fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.6, color: T.subtle, borderBottom: `1px solid ${T.borderSoft}` }}>
            <div>#</div><div>Type</div><div>Description</div><div style={{ textAlign: "right" }}>Qty</div><div style={{ textAlign: "right" }}>Rate</div><div style={{ textAlign: "right" }}>Amount</div><div></div>
          </div>
          {fields.map((field, i) => {
            const line = watchedLines[i] || field;
            const lineErr = errors.lines?.[i];
            const quantityConstraints = invoiceQuantityInputConstraints(line.type);
            return (
              <div key={field.id} className="inv-line-row" style={{ display: "grid", gridTemplateColumns: "30px 140px 1fr 70px 90px 90px 28px", gap: 10, padding: "10px 12px", borderBottom: i < fields.length - 1 ? `1px solid ${T.borderSoft}` : "none", alignItems: "start" }}>
                <div className="mono inv-num" style={{ fontSize: 12, color: T.subtle, paddingTop: 10 }}>{i + 1}</div>
                <Sel aria-label={`Line ${i + 1} type`} {...register(`lines.${i}.type` as const)} defaultValue={field.type} style={{ padding: "8px 10px", borderRadius: 8, border: `1px solid ${T.border}`, background: T.surface, fontSize: 12, fontFamily: "inherit", color: T.ink, outline: "none" }}>{LINE_TYPES.map(t => <option key={t}>{t}</option>)}</Sel>
                <textarea aria-describedby={errors.lines ? `${formId}-lines-error` : undefined} aria-label={`Line ${i + 1} description`} aria-invalid={Boolean(lineErr?.desc)} {...register(`lines.${i}.desc` as const)} placeholder={line.type === "Labor" ? "What was done on site..." : line.type === "Parts/Hardware" ? "Part description" : /^(travel|truck charge)$/i.test(line.type || "") ? "Description (optional)" : "Description"} style={{ padding: "8px 10px", borderRadius: 8, border: `1px solid ${lineErr?.desc ? T.danger : T.border}`, background: T.surface, fontSize: 12, fontFamily: "inherit", color: T.ink, resize: "vertical", minHeight: 36, outline: "none" }} />
                {/* Mobile-only field labels — hidden inline so the desktop grid
                    (direct-children columns) is untouched; CSS reveals them. */}
                <span className="inv-mlabel" style={{ display: "none" }}>Qty</span>
                <span className="inv-mlabel" style={{ display: "none" }}>Rate</span>
                <span className="inv-mlabel" style={{ display: "none" }}>Amount</span>
                <input
                  type="number"
                  min={quantityConstraints.min}
                  aria-describedby={errors.lines ? `${formId}-lines-error` : undefined} aria-label={`Line ${i + 1} quantity`}
                  aria-invalid={Boolean(lineErr?.qty)}
                  step={quantityConstraints.step}
                  inputMode="decimal"
                  title="Labor may be billed in quarter-hour increments (1.25 = 1 hour 15 minutes)."
                  {...register(`lines.${i}.qty` as const, { valueAsNumber: true })}
                  className="numeric-readable"
                  style={{ padding: "8px 10px", borderRadius: 8, border: `1px solid ${lineErr?.qty ? T.danger : T.border}`, background: T.surface, fontSize: 12, color: T.ink, textAlign: "right", outline: "none" }}
                />
                <input aria-describedby={errors.lines ? `${formId}-lines-error` : undefined} aria-label={`Line ${i + 1} rate`} aria-invalid={Boolean(lineErr?.rate)} className="numeric-readable" type="number" step="any" placeholder="0.00" {...register(`lines.${i}.rate` as const, { valueAsNumber: true })} style={{ padding: "8px 10px", borderRadius: 8, border: `1px solid ${lineErr?.rate ? T.danger : T.border}`, background: T.surface, fontSize: 12, color: T.ink, textAlign: "right", outline: "none" }} />
                <div className="mono inv-amount" style={{ fontSize: 12, fontWeight: 600, color: T.ink, textAlign: "right", paddingTop: 10 }}>{fmt(Math.round(amount(line) * 100) / 100)}</div>
                <button type="button" aria-label={`Remove line ${i + 1}`} className="inv-line-remove" onClick={() => remove(i)} style={{ background: "transparent", border: "none", color: T.subtle, cursor: "pointer", fontSize: 16, padding: 0, paddingTop: 6 }}>x</button>
              </div>
            );
          })}
        </div>
        {errors.lines && (
          <div id={`${formId}-lines-error`} role="alert" style={{ fontSize: 12, color: T.danger, fontWeight: 600, marginBottom: 10 }}>
            Check the highlighted line items. Every line needs a quantity and rate; travel descriptions are optional.
          </div>
        )}
        <div style={{ fontSize: 11, color: T.muted, marginBottom: 10 }}>
          Labor can be entered in 0.25-hour increments (1.25 = 1 hour 15 minutes).
        </div>
        <div className="inv-add-btns" style={{ display: "flex", gap: 8, marginBottom: 18, flexWrap: "wrap" }}>
          {["Labor", "Truck Charge", "Parts/Hardware", "Shipping", "Other"].map(type => (
            <button key={type} type="button" onClick={() => append({ type, desc: "", qty: 1, rate: type === "Truck Charge" ? P1_BUSINESS.defaultTruckCharge : undefined })} className="btn-soft" style={{ padding: "7px 12px", fontSize: 11 }}>+ {type === "Parts/Hardware" ? "Parts" : type}</button>
          ))}
          {receivedPartsForWO.length > 0 && (
            <button
              type="button"
              onClick={() => {
                // Description + qty only — rate stays blank so the contractor
                // enters their own number per Jennifer's note on the call.
                for (const p of receivedPartsForWO) {
                  const desc = `${p.description}${p.partNumber ? ` (${p.partNumber})` : ""}`;
                  append({ type: "Parts/Hardware", desc, qty: Number(p.qty) || 1, rate: undefined });
                }
              }}
              className="btn-soft"
              style={{ padding: "7px 12px", fontSize: 11, fontWeight: 600 }}
            >+ Add from parts list ({receivedPartsForWO.length})</button>
          )}
        </div>

        {uploadOnly && fields.length > 0 && (
          <label style={{ display: "flex", alignItems: "flex-start", gap: 9, padding: "10px 12px", marginBottom: 12, borderRadius: 10, border: `1px solid ${pdfLinesReviewed ? T.success : T.border}`, background: pdfLinesReviewed ? T.successSoft : T.surfaceSoft, cursor: "pointer" }}>
            <input
              type="checkbox"
              checked={pdfLinesReviewed}
              onChange={event => {
                setPdfLinesReviewed(event.target.checked);
                if (event.target.checked) setPdfError("");
              }}
              style={{ marginTop: 2 }}
            />
            <span style={{ fontSize: 11, color: T.ink, lineHeight: 1.5 }}>
              I reviewed these line items against the uploaded invoice.
            </span>
          </label>
        )}

        <div className="inv-totals-row" style={{ display: "grid", gridTemplateColumns: "1fr 280px", gap: 14, marginBottom: 18, alignItems: "start" }}>
          <div />
          <div style={{ background: T.surfaceSoft, borderRadius: 12, border: `1px solid ${T.borderSoft}`, padding: "14px 16px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10, fontSize: 13 }}><span style={{ color: T.muted }}>{uploadOnly ? "Line item total" : "Subtotal"}</span><span className="mono" style={{ fontWeight: 600, color: T.ink }}>{fmt(Math.round(sub * 100) / 100)}</span></div>
            {!uploadOnly && (
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10, fontSize: 13, gap: 10 }}>
                <span style={{ color: T.muted }}>Sales tax</span>
                <input aria-label="Sales tax" className="numeric-readable" type="number" step="0.01" {...register("tax")} placeholder="0.00" style={{ width: 110, padding: "6px 10px", borderRadius: 8, border: `1px solid ${T.border}`, background: T.surface, fontSize: 12, color: T.ink, textAlign: "right", outline: "none" }} />
              </div>
            )}
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", paddingTop: 10, borderTop: `1px solid ${T.border}`, fontSize: 14 }}><span style={{ fontWeight: 700, color: T.ink }}>Total</span><span className="numeric-readable" style={{ fontSize: 22, color: T.ink, fontWeight: 750 }}>{fmt(Math.round(total * 100) / 100)}</span></div>
            {uploadOnly && uploadedTotal > 0 && !uploadedLinesMatchTotal && (
              <div style={{ fontSize: 11, color: T.warn, lineHeight: 1.45, marginTop: 8, textAlign: "right" }}>
                Lines differ from the PDF total by {fmt(uploadedLineDifference)}. Review before confirming.
              </div>
            )}
          </div>
        </div>
        </div>

        {uploadOnly && (
          <div style={{ padding: "14px 16px", marginBottom: 18, border: `1px solid ${errors.uploadedTotal ? T.danger : T.borderSoft}`, borderRadius: 12, background: T.surfaceSoft }}>
            <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.8, color: T.subtle, marginBottom: 8 }}>Uploaded invoice amount</div>
            <div className="modal-form-row" style={{ display: "grid", gridTemplateColumns: "minmax(0, 240px) 1fr", gap: 14, alignItems: "end" }}>
              <label>
                <span style={{ display: "block", fontSize: 11, fontWeight: 600, color: T.muted, marginBottom: 6 }}>Invoice total</span>
                <input
                  type="number"
                  min="0.01"
                  step="0.01"
                  placeholder="0.00"
                  aria-invalid={Boolean(errors.uploadedTotal)} aria-describedby={errors.uploadedTotal ? `${formId}-total-error` : undefined} {...register("uploadedTotal")}
                  className="numeric-readable"
                  style={{ width: "100%", padding: "10px 13px", borderRadius: 10, border: `1px solid ${errors.uploadedTotal ? T.danger : T.border}`, background: T.surface, color: T.ink, fontSize: 13 }}
                />
                {errors.uploadedTotal && <span id={`${formId}-total-error`} role="alert" style={{ display: "block", marginTop: 5, fontSize: 11, color: T.danger }}>{errors.uploadedTotal.message}</span>}
              </label>
              <div aria-live="polite" style={{ fontSize: 11, color: pdfParseStatus === "manual" ? T.warn : T.muted, lineHeight: 1.5 }}>
                {pdfParseStatus === "reading"
                  ? "Reading the invoice total and line items from the PDF..."
                  : pdfParseStatus === "detected"
                    ? pdfLineStatus === "detected"
                      ? `${fields.length} line item${fields.length === 1 ? "" : "s"} and the total were detected. Review both before submitting.`
                      : "Total detected. Line items were not found reliably, so you can submit the total only or enter them manually."
                    : pdfParseStatus === "manual"
                      ? pdfLineStatus === "detected"
                        ? `${fields.length} line item${fields.length === 1 ? "" : "s"} were detected, but the total was not. Enter the total and review the lines.`
                        : "The invoice could not be read reliably. Enter the total manually; line items remain optional."
                      : "Enter the final total shown on the uploaded invoice."}
              </div>
            </div>
            {fields.length === 0 && pdfParseStatus !== "reading" && (
              <button
                type="button"
                className="btn-soft"
                onClick={() => {
                  replace([{ type: "Other", desc: "", qty: 1, rate: undefined }]);
                  setPdfLineStatus("none");
                  setPdfLinesReviewed(false);
                  setPdfError("");
                }}
                style={{ marginTop: 12, padding: "7px 11px", fontSize: 11 }}
              >
                + Enter line items manually
              </button>
            )}
          </div>
        )}

        <div style={{ padding: "12px 16px", background: T.accentSoft, borderRadius: 10, border: `1px solid ${pdfError ? T.danger : T.accentRing}`, marginBottom: 4 }}>
          <button type="button" className="btn-soft" onClick={() => pdfUploadInput.current?.click()}
            aria-describedby={pdfError ? `${formId}-pdf-error` : undefined}
            style={{ marginBottom: 8 }}>Choose invoice PDF</button>
          <label style={{ cursor: "pointer", display: "block" }}>
            <div style={{ border: `2px dashed ${pdfError ? T.danger : T.accent}`, borderRadius: 8, padding: 18, textAlign: "center" }}>
              <div style={{ fontSize: 13, color: pdfError ? T.danger : T.accent, fontWeight: 600 }}>
                {pdfFile ? pdfFile.name : resumeDraft?.pdfStoragePath ? "A PDF is already attached" : "Upload your invoice PDF"}
              </div>
              <div style={{ fontSize: 11, color: T.subtle, marginTop: 4 }}>
                PDF only, up to 5 MB. Uploading a PDF makes detailed line items optional.
              </div>
              <input
                ref={pdfUploadInput}
                type="file"
                accept="application/pdf,.pdf"
                style={{ display: "none" }}
                onChange={async (event) => {
                  const file = event.target.files?.[0] || null;
                  event.target.value = "";
                  if (!file) return;
                  if (pdfParsingFile.current === file && pdfParseController.current) return;
                  pdfParseController.current?.abort();
                  pdfParseController.current = null;
                  pdfParsingFile.current = null;
                  pdfParseAttempt.current += 1;
                  if (!file.name || file.name.length > 255 || file.type.length > 128) {
                    clearPendingPdf("Choose a PDF with a shorter filename and supported file metadata.");
                    return;
                  }
                  if (file.size > 5 * 1024 * 1024) {
                    clearPendingPdf("PDF must be 5 MB or smaller.");
                    return;
                  }
                  if (file.size === 0) {
                    clearPendingPdf("PDF file is empty.");
                    return;
                  }
                  setPdfFile(file);
                  setPdfError("");
                  setValue("uploadOnly", true, { shouldDirty: true });
                  setValue("uploadedTotal", "", { shouldDirty: true });
                  setValue("tax", "", { shouldDirty: true });
                  replace([]);
                  setPdfLineStatus("idle");
                  setPdfLinesReviewed(false);
                  const attempt = pdfParseAttempt.current + 1;
                  pdfParseAttempt.current = attempt;
                  const controller = new AbortController();
                  pdfParseController.current = controller;
                  pdfParsingFile.current = file;
                  setPdfParseStatus("reading");
                  try {
                    const parsed = await parseInvoicePdf(file, { signal: controller.signal });
                    if (controller.signal.aborted || pdfParseAttempt.current !== attempt) return;
                    if (parsed.invoiceNumber && !numTouchedRef.current) {
                      setValue("num", parsed.invoiceNumber, {
                        shouldDirty: true,
                        shouldValidate: true,
                      });
                      numTouchedRef.current = true;
                      setNumTouched(true);
                    }
                    const parsedLines = (parsed.lines || []).map(line => ({
                      type: line.type || "Other",
                      desc: line.desc,
                      qty: Number(line.qty) || 1,
                      rate: Number(line.rate) || 0,
                    }));
                    replace(parsedLines);
                    setPdfLineStatus(parsedLines.length > 0 ? "detected" : "none");
                    if (parsed.total != null) {
                      setValue("uploadedTotal", parsed.total.toFixed(2), {
                        shouldDirty: true,
                        shouldValidate: true,
                      });
                      setPdfParseStatus("detected");
                    } else {
                      setPdfParseStatus("manual");
                    }
                  } catch (error: unknown) {
                    if (!controller.signal.aborted && pdfParseAttempt.current === attempt) {
                      if (error instanceof InvoicePdfError && ["PDF_INVALID_SIGNATURE", "PDF_MALFORMED"].includes(error.code)) {
                        clearPendingPdf("This PDF could not be validated. Choose a valid PDF or enter the invoice manually.");
                        return;
                      }
                      setPdfParseStatus("manual");
                      setPdfLineStatus("none");
                      const reason = error instanceof InvoicePdfError ? new InvoicePdfError(error.code).message : "The PDF could not be read reliably.";
                      setPdfError(`${reason} Enter the total manually and review the invoice before submitting.`);
                    }
                  } finally {
                    if (pdfParseAttempt.current === attempt) {
                      pdfParseController.current = null;
                      pdfParsingFile.current = null;
                    }
                  }
                }}
              />
            </div>
          </label>
          {pdfError && <div id={`${formId}-pdf-error`} role="alert" style={{ marginTop: 7, color: T.danger, fontSize: 11, fontWeight: 600 }}>{pdfError}</div>}
          {pdfFile && (
            <button type="button" onClick={() => {
              clearPendingPdf();
            }} className="btn-soft" style={{ display: "block", margin: "8px auto 0", padding: "5px 10px", fontSize: 10 }}>
              Remove attachment
            </button>
          )}
        </div>

        <div style={{ display: "flex", gap: 8, marginTop: 18, justifyContent: "flex-end", flexWrap: "wrap" }}>
          <button type="button" disabled={submitting || savingDraft} onClick={() => dismissal.requestClose("cancel_button")} className="btn-soft">Cancel</button>
          {/* Save draft bypasses the lines-complete validation — a draft can
              be partially filled. Resumes by passing the existing invoice id
              so we update in place instead of inserting a duplicate. */}
          {doSaveDraftInvoice && !isRejectedResubmission && (
            <button
              type="button"
              disabled={savingDraft || submitting || pdfParseStatus === "reading"}
              onClick={async () => {
                if (!doSaveDraftInvoice || submitLockRef.current || pdfParseController.current) return;
                submitLockRef.current = true;
                setSavingDraft(true);
                const saveGeneration = hydrationGenerationRef.current;
                try {
                  const data: InvoiceModalPayload = {
                    num: watch("num"),
                    invoiceDate: watch("invoiceDate"),
                    serviceDate: watch("serviceDate"),
                    terms: watch("terms"),
                    tax: watch("tax"),
                    cme: watch("cme"),
                    uploadOnly: watch("uploadOnly"),
                    uploadedTotal: watch("uploadedTotal"),
                    lines: watch("lines"),
                    userTypedNum: numTouched,
                    pdfFile,
                    hasExistingPdf: !!resumeDraft?.pdfStoragePath,
                    commandContext: invoiceSnapshotRef.current && { ...invoiceSnapshotRef.current, operationId: draftOperationKeyRef.current },
                  };
                  const ok = await doSaveDraftInvoice(woData, data, existingInvoiceId);
                  if (ok && hydrationGenerationRef.current === saveGeneration) { setModal(null); resetNewInv(); }
                } finally {
                  if (hydrationGenerationRef.current === saveGeneration) { submitLockRef.current = false; setSavingDraft(false); }
                }
              }}
              className="btn-soft"
              style={{ opacity: savingDraft || pdfParseStatus === "reading" ? 0.7 : 1, cursor: savingDraft || pdfParseStatus === "reading" ? "default" : "pointer", display: "flex", alignItems: "center", gap: 6 }}
            >
              {savingDraft ? <><BtnSpinner />Saving...</> : (existingInvoiceId ? "Save draft" : "Save as draft")}
            </button>
          )}
          <button
            type="submit"
            disabled={submitting || savingDraft || pdfParseStatus === "reading"}
            className="btn-accent"
            style={{
              opacity: submitting || pdfParseStatus === "reading" ? 0.7 : 1,
              cursor: submitting || pdfParseStatus === "reading" ? "default" : "pointer",
              display: "flex",
              alignItems: "center",
              gap: 6,
            }}
          >
            {submitting
              ? <><BtnSpinner />{isRejectedResubmission ? "Resubmitting..." : "Submitting..."}</>
              : isRejectedResubmission
                ? "Resubmit invoice"
                : (existingInvoiceId ? "Submit draft" : "Submit")
            }
          </button>
        </div>
      </form>
    </Modal>
  );
}
