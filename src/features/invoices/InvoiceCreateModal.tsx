"use client";
// @ts-nocheck

import { useEffect, useMemo, useRef, useState } from "react";
import { useForm, useFieldArray } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { CreateInvoiceSchema, CreateInvoiceForm } from "../../lib/schemas";
import { Modal } from "../../components/ui/Modal";
import { BtnSpinner } from "../../components/ui/BtnSpinner";
import { CopyWorkOrderButton } from "../../components/ui/CopyWorkOrderButton";
import { Sel } from "../../components/ui/Sel";
import { T, LINE_TYPES, P1_BUSINESS } from "../../lib/constants";
import { parseInvoicePdf } from "../../lib/invoicePdfParserClient";

const amount = (l: any) => (Number(l?.qty) || 0) * (Number(l?.rate) || 0);
const todayIso = () => {
  const date = new Date();
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

// Contractors explicitly add only the line types needed for this invoice.
const initialLines = () => [];

export default function InvoiceCreateModal(props: any) {
  const { modal, woData, currentUser, fmt, setModal, resetNewInv, doSubmitInvoice, doSaveDraftInvoice, resumeDraft, nextInvNumFromDb, woParts = [] } = props;
  // Parts on this WO that have been received (and so are billable) — feeds
  // the "Add from parts list" button below the line items grid. Description
  // + qty pre-fill only; the contractor types their own rate.
  const receivedPartsForWO = useMemo(() => {
    if (!woData) return [];
    return woParts.filter((p: any) => p.workOrderId === woData.id && p.status === "received");
  }, [woParts, woData]);
  const [submitting, setSubmitting] = useState(false);
  const [savingDraft, setSavingDraft] = useState(false);
  const [pdfFile, setPdfFile] = useState<File | null>(null);
  const [pdfError, setPdfError] = useState("");
  const [pdfParseStatus, setPdfParseStatus] = useState<"idle" | "reading" | "detected" | "manual">("idle");
  const [pdfLineStatus, setPdfLineStatus] = useState<"idle" | "detected" | "none">("idle");
  const [pdfLinesReviewed, setPdfLinesReviewed] = useState(false);
  const pdfParseAttempt = useRef(0);
  const numTouchedRef = useRef(false);
  const existingInvoiceId = resumeDraft?.id || null;
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
    formState: { errors },
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
  const sub = watchedLines.reduce((s: number, l: any) => s + amount(l), 0);
  const tax = parseFloat(watchedTax || "") || 0;
  const total = uploadOnly ? uploadedTotal : sub + tax;
  const uploadedLineDifference = uploadOnly ? Math.abs(sub - uploadedTotal) : 0;
  const uploadedLinesMatchTotal = uploadedLineDifference <= Math.max(0.05, uploadedTotal * 0.01);

  useEffect(() => {
    if (modal !== "createInvoice") return;
    let cancelled = false;
    pdfParseAttempt.current += 1;
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
        invoiceDate: resumeDraft.invoiceDate || todayIso(),
        serviceDate: resumeDraft.serviceDate || todayIso(),
        terms: resumeDraft.terms || "Net 30",
        tax: resumeUploadOnly ? "" : resumeDraft.salesTax != null ? String(resumeDraft.salesTax) : "",
        cme: resumeDraft.cme || "",
        uploadOnly: resumeUploadOnly,
        uploadedTotal: resumeUploadOnly ? String(resumeDraft.total || "") : "",
        lines: (resumeDraft.lines || []).length
          ? resumeDraft.lines.map((l: any) => ({ type: l.type, desc: l.desc || l.description || "", qty: Number(l.qty) || 1, rate: Number(l.rate) }))
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
            if (cancelled) return;
            // setValue is part of RHF; pull it from the hook indirectly via reset.
            // The simplest non-invasive approach: only set if user hasn't touched.
            // (Closure check via ref-like flag.)
            if (!numTouchedRef.current) {
              // Use reset to write only `num`, preserving the rest.
              reset((cur: any) => ({ ...cur, num: suggested }));
            }
          } catch { /* keep blank — submit-side retry still saves us */ }
        })();
      }
    }
    return () => {
      cancelled = true;
      pdfParseAttempt.current += 1;
    };
  }, [modal, reset, resumeDraft, nextInvNumFromDb]);

  if (modal !== "createInvoice" || !woData) return null;

  const close = () => {
    const today = todayIso();
    pdfParseAttempt.current += 1;
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
    setModal(null);
  };
  const clearPendingPdf = (error = "") => {
    pdfParseAttempt.current += 1;
    setPdfFile(null);
    setPdfError(error);
    setPdfParseStatus(resumeDraft?.pdfStoragePath ? "detected" : "idle");
    if (resumeDraft?.pdfStoragePath) {
      setValue("uploadOnly", true, { shouldDirty: true });
      setValue("uploadedTotal", String(resumeDraft.total || ""), { shouldDirty: true });
      const existingLines = (resumeDraft.lines || []).map((line: any) => ({
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
    if (data.uploadOnly && (data.lines || []).length > 0 && !pdfLinesReviewed) {
      setPdfError("Review the extracted line items and confirm them before submitting.");
      return;
    }
    setSubmitting(true);
    try {
    const ok = await doSubmitInvoice(woData, {
      ...data,
      userTypedNum: numTouched,
      pdfFile,
      hasExistingPdf: !!resumeDraft?.pdfStoragePath,
    }, existingInvoiceId);
    if (ok) reset();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal onClose={close} title="Create invoice" width={820} closeOnBackdrop={false}>
      <form onSubmit={handleSubmit(onSubmit)}>
        <div style={{ fontSize: 13, color: T.muted, marginBottom: 20 }}>Invoice from {currentUser?.company || currentUser?.name || "your company"} to P1 Pros - Work Order {woData.id}</div>

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
          <label><span style={{ display: "block", fontSize: 11, fontWeight: 600, color: T.muted, marginBottom: 6 }}>Invoice #</span><input {...register("num", { onChange: () => { numTouchedRef.current = true; setNumTouched(true); } })} placeholder="e.g. 6557" style={{ width: "100%", padding: "10px 13px", borderRadius: 10, border: `1px solid ${T.border}`, background: T.surface, color: T.ink, fontSize: 13 }} />{errors.num && <span style={{ fontSize: 11, color: T.danger }}>{errors.num.message}</span>}</label>
          <label><span style={{ display: "block", fontSize: 11, fontWeight: 600, color: T.muted, marginBottom: 6 }}>Invoice date</span><input type="date" {...register("invoiceDate")} style={{ width: "100%", padding: "10px 13px", borderRadius: 10, border: `1px solid ${T.border}`, background: T.surface, color: T.ink, fontSize: 13 }} /></label>
          <label><span style={{ display: "block", fontSize: 11, fontWeight: 600, color: T.muted, marginBottom: 6 }}>Service date</span><input type="date" {...register("serviceDate")} style={{ width: "100%", padding: "10px 13px", borderRadius: 10, border: `1px solid ${T.border}`, background: T.surface, color: T.ink, fontSize: 13 }} /></label>
          <label><span style={{ display: "block", fontSize: 11, fontWeight: 600, color: T.muted, marginBottom: 6 }}>Terms</span><Sel {...register("terms")} style={{ width: "100%", padding: "10px 13px", borderRadius: 10, border: `1px solid ${T.border}`, background: T.surface, color: T.ink, fontSize: 13 }}><option>Net 30</option><option>Net 15</option><option>Due on receipt</option></Sel></label>
        </div>

        <div className="modal-form-row" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 18 }}>
          <div>
            <div style={{ fontSize: 11, fontWeight: 600, color: T.muted, marginBottom: 6 }}>Work Order #</div>
            <div style={{ minHeight: 42, display: "flex", alignItems: "center", gap: 5, padding: "7px 8px 7px 13px", borderRadius: 10, border: `1px solid ${T.borderSoft}`, background: T.surfaceSoft, fontSize: 13, color: T.ink, fontFamily: "var(--font-jetbrains-mono), monospace" }}>
              {woData.id}
              <CopyWorkOrderButton value={woData.id} />
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
            return (
              <div key={field.id} className="inv-line-row" style={{ display: "grid", gridTemplateColumns: "30px 140px 1fr 70px 90px 90px 28px", gap: 10, padding: "10px 12px", borderBottom: i < fields.length - 1 ? `1px solid ${T.borderSoft}` : "none", alignItems: "start" }}>
                <div className="mono inv-num" style={{ fontSize: 12, color: T.subtle, paddingTop: 10 }}>{i + 1}</div>
                <Sel {...register(`lines.${i}.type` as const)} defaultValue={field.type} style={{ padding: "8px 10px", borderRadius: 8, border: `1px solid ${T.border}`, background: T.surface, fontSize: 12, fontFamily: "inherit", color: T.ink, outline: "none" }}>{LINE_TYPES.map(t => <option key={t}>{t}</option>)}</Sel>
                <textarea {...register(`lines.${i}.desc` as const)} placeholder={line.type === "Labor" ? "What was done on site..." : line.type === "Parts/Hardware" ? "Part description" : /^(travel|truck charge)$/i.test(line.type || "") ? "Description (optional)" : "Description"} style={{ padding: "8px 10px", borderRadius: 8, border: `1px solid ${lineErr?.desc ? T.danger : T.border}`, background: T.surface, fontSize: 12, fontFamily: "inherit", color: T.ink, resize: "vertical", minHeight: 36, outline: "none" }} />
                {/* Mobile-only field labels — hidden inline so the desktop grid
                    (direct-children columns) is untouched; CSS reveals them. */}
                <span className="inv-mlabel" style={{ display: "none" }}>Qty</span>
                <span className="inv-mlabel" style={{ display: "none" }}>Rate</span>
                <span className="inv-mlabel" style={{ display: "none" }}>Amount</span>
                <input type="number" step="0.1" {...register(`lines.${i}.qty` as const, { valueAsNumber: true })} style={{ padding: "8px 10px", borderRadius: 8, border: `1px solid ${lineErr?.qty ? T.danger : T.border}`, background: T.surface, fontSize: 12, fontFamily: "inherit", color: T.ink, textAlign: "right", outline: "none" }} />
                <input type="number" step="any" placeholder="0.00" {...register(`lines.${i}.rate` as const, { valueAsNumber: true })} style={{ padding: "8px 10px", borderRadius: 8, border: `1px solid ${lineErr?.rate ? T.danger : T.border}`, background: T.surface, fontSize: 12, fontFamily: "var(--font-jetbrains-mono), monospace", color: T.ink, textAlign: "right", outline: "none" }} />
                <div className="mono inv-amount" style={{ fontSize: 12, fontWeight: 600, color: T.ink, textAlign: "right", paddingTop: 10 }}>{fmt(Math.round(amount(line) * 100) / 100)}</div>
                <button type="button" className="inv-line-remove" onClick={() => remove(i)} style={{ background: "transparent", border: "none", color: T.subtle, cursor: "pointer", fontSize: 16, padding: 0, paddingTop: 6 }}>x</button>
              </div>
            );
          })}
        </div>
        {errors.lines && (
          <div style={{ fontSize: 12, color: T.danger, fontWeight: 600, marginBottom: 10 }}>
            Check the highlighted line items. Every line needs a quantity and rate; travel descriptions are optional.
          </div>
        )}
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
                <input type="number" step="0.01" {...register("tax")} placeholder="0.00" style={{ width: 110, padding: "6px 10px", borderRadius: 8, border: `1px solid ${T.border}`, background: T.surface, fontSize: 12, fontFamily: "var(--font-jetbrains-mono), monospace", color: T.ink, textAlign: "right", outline: "none" }} />
              </div>
            )}
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", paddingTop: 10, borderTop: `1px solid ${T.border}`, fontSize: 14 }}><span style={{ fontWeight: 700, color: T.ink }}>Total</span><span className="display" style={{ fontSize: 22, color: T.ink, letterSpacing: -0.4 }}>{fmt(Math.round(total * 100) / 100)}</span></div>
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
                  {...register("uploadedTotal")}
                  style={{ width: "100%", padding: "10px 13px", borderRadius: 10, border: `1px solid ${errors.uploadedTotal ? T.danger : T.border}`, background: T.surface, color: T.ink, fontSize: 13, fontFamily: "var(--font-jetbrains-mono), monospace" }}
                />
                {errors.uploadedTotal && <span style={{ display: "block", marginTop: 5, fontSize: 11, color: T.danger }}>{errors.uploadedTotal.message}</span>}
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
          <label style={{ cursor: "pointer", display: "block" }}>
            <div style={{ border: `2px dashed ${pdfError ? T.danger : T.accent}`, borderRadius: 8, padding: 18, textAlign: "center" }}>
              <div style={{ fontSize: 13, color: pdfError ? T.danger : T.accent, fontWeight: 600 }}>
                {pdfFile ? pdfFile.name : resumeDraft?.pdfStoragePath ? "A PDF is already attached" : "Upload your invoice PDF"}
              </div>
              <div style={{ fontSize: 11, color: T.subtle, marginTop: 4 }}>
                PDF only, up to 5 MB. Uploading a PDF makes detailed line items optional.
              </div>
              <input
                type="file"
                accept="application/pdf,.pdf"
                style={{ display: "none" }}
                onChange={async (event) => {
                  const file = event.target.files?.[0] || null;
                  event.target.value = "";
                  if (!file) return;
                  if (file.type !== "application/pdf" && !file.name.toLowerCase().endsWith(".pdf")) {
                    clearPendingPdf("Choose a PDF file.");
                    return;
                  }
                  if (file.size > 5 * 1024 * 1024) {
                    clearPendingPdf("PDF must be 5 MB or smaller.");
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
                  setPdfParseStatus("reading");
                  try {
                    const parsed = await parseInvoicePdf(file);
                    if (pdfParseAttempt.current !== attempt) return;
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
                  } catch {
                    if (pdfParseAttempt.current === attempt) {
                      setPdfParseStatus("manual");
                      setPdfLineStatus("none");
                    }
                  }
                }}
              />
            </div>
          </label>
          {pdfError && <div style={{ marginTop: 7, color: T.danger, fontSize: 11, fontWeight: 600 }}>{pdfError}</div>}
          {pdfFile && (
            <button type="button" onClick={() => {
              clearPendingPdf();
            }} className="btn-soft" style={{ display: "block", margin: "8px auto 0", padding: "5px 10px", fontSize: 10 }}>
              Remove attachment
            </button>
          )}
        </div>

        <div style={{ display: "flex", gap: 8, marginTop: 18, justifyContent: "flex-end", flexWrap: "wrap" }}>
          <button type="button" onClick={close} className="btn-soft">Cancel</button>
          {/* Save draft bypasses the lines-complete validation — a draft can
              be partially filled. Resumes by passing the existing invoice id
              so we update in place instead of inserting a duplicate. */}
          {doSaveDraftInvoice && (
            <button
              type="button"
              disabled={savingDraft || submitting || pdfParseStatus === "reading"}
              onClick={async () => {
                setSavingDraft(true);
                try {
                  const data: any = {
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
                  };
                  const ok = await doSaveDraftInvoice(woData, data, existingInvoiceId);
                  if (ok) { setModal(null); resetNewInv(); }
                } finally { setSavingDraft(false); }
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
              ? <><BtnSpinner />Submitting...</>
              : (existingInvoiceId ? "Submit draft" : "Submit")
            }
          </button>
        </div>
      </form>
    </Modal>
  );
}
