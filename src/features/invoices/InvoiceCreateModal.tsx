"use client";
// @ts-nocheck

import { useEffect, useMemo, useState } from "react";
import { useForm, useFieldArray } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { CreateInvoiceSchema, CreateInvoiceForm } from "../../lib/schemas";
import { Modal } from "../../components/ui/Modal";
import { BtnSpinner } from "../../components/ui/BtnSpinner";
import { Sel } from "../../components/ui/Sel";
import { T, LINE_TYPES, P1_BUSINESS, SEVEN_BILL_TO } from "../../lib/constants";

const amount = (l: any) => (Number(l?.qty) || 0) * (Number(l?.rate) || 0);

// Rates start EMPTY so the contractor enters their own number; Truck Charge
// is the one exception — editable default of 60. (Per-contractor profile
// rates are reserved for Phase 2 and intentionally not read here.)
const initialLines = () => [
  { type: "Truck Charge", desc: "Truck charge", qty: 1, rate: P1_BUSINESS.defaultTruckCharge },
  { type: "Labor", desc: "", qty: 1, rate: undefined },
];

export default function InvoiceCreateModal(props: any) {
  const { modal, woData, invoices, currentUser, fmt, setModal, resetNewInv, doSubmitInvoice, doSaveDraftInvoice, resumeDraft, nextInvNumFromDb } = props;
  const [submitting, setSubmitting] = useState(false);
  const [savingDraft, setSavingDraft] = useState(false);
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
    formState: { errors },
  } = useForm<CreateInvoiceForm>({
    resolver: zodResolver(CreateInvoiceSchema),
    defaultValues: {
      num: "",
      invoiceDate: new Date().toISOString().slice(0, 10),
      serviceDate: new Date().toISOString().slice(0, 10),
      terms: "Net 30",
      tax: "",
      cme: "",
      lines: initialLines(),
    },
  });
  const { fields, append, remove } = useFieldArray({ control, name: "lines" });
  const watchedLines = watch("lines") || [];
  const watchedTax = watch("tax");
  const sub = watchedLines.reduce((s: number, l: any) => s + amount(l), 0);
  const tax = parseFloat(watchedTax || "") || 0;
  const total = sub + tax;

  useEffect(() => {
    if (modal !== "createInvoice") return;
    let cancelled = false;
    setNumTouched(false);
    // Resuming an existing draft → hydrate the form from its stored fields
    // (keep its existing number untouched). Otherwise pull the authoritative
    // next-number from the DB so the user sees a non-colliding suggestion
    // immediately; falls back to blank if the lookup fails.
    if (resumeDraft) {
      reset({
        num: resumeDraft.num || "",
        invoiceDate: resumeDraft.invoiceDate || new Date().toISOString().slice(0, 10),
        serviceDate: resumeDraft.serviceDate || new Date().toISOString().slice(0, 10),
        terms: resumeDraft.terms || "Net 30",
        tax: resumeDraft.salesTax != null ? String(resumeDraft.salesTax) : "",
        cme: resumeDraft.cme || "",
        lines: (resumeDraft.lines || []).length
          ? resumeDraft.lines.map((l: any) => ({ type: l.type, desc: l.desc || l.description || "", qty: Number(l.qty) || 1, rate: Number(l.rate) }))
          : initialLines(),
      });
    } else {
      const today = new Date().toISOString().slice(0, 10);
      reset({
        num: "",
        invoiceDate: today,
        serviceDate: today,
        terms: "Net 30",
        tax: "",
        cme: "",
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
            if (!numTouched) {
              // Use reset to write only `num`, preserving the rest.
              reset((cur: any) => ({ ...cur, num: suggested }));
            }
          } catch { /* keep blank — submit-side retry still saves us */ }
        })();
      }
    }
    return () => { cancelled = true; };
  }, [modal, reset, resumeDraft, nextInvNumFromDb]);

  const priorSpend = useMemo(
    () => {
      if (!woData) return 0;
      return invoices.reduce((s, i) => i.wot === woData.id && i.state !== "draft" ? s + (i.total || 0) : s, 0);
    },
    [invoices, woData]
  );

  if (modal !== "createInvoice" || !woData) return null;

  const projectedSpend = priorSpend + total;
  const over = (woData.nte || 0) > 0 && projectedSpend > woData.nte;
  const close = () => { setModal(null); resetNewInv(); };
  const onSubmit = async (data: CreateInvoiceForm) => {
    setSubmitting(true);
    try {
    const ok = await doSubmitInvoice(woData, { ...data, userTypedNum: numTouched }, existingInvoiceId);
    if (ok) reset();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal onClose={close} title="Create invoice" width={820}>
      <form onSubmit={handleSubmit(onSubmit)}>
        <div style={{ fontSize: 13, color: T.muted, marginBottom: 20 }}>P1 Pros invoice to 7-Eleven - Work Order {woData.id}</div>

        <div className="modal-form-row" style={{ display: "grid", gridTemplateColumns: "1.2fr 1fr 1fr", gap: 14, padding: "14px 16px", background: T.surfaceSoft, borderRadius: 12, border: `1px solid ${T.borderSoft}`, marginBottom: 18 }}>
          <div>
            <div className="display" style={{ fontSize: 16, color: T.ink, lineHeight: 1.1 }}>{P1_BUSINESS.dba}</div>
            <div style={{ fontSize: 10, color: T.subtle, marginTop: 2 }}>({P1_BUSINESS.legalName})</div>
            <div style={{ fontSize: 11, color: T.muted, marginTop: 6, lineHeight: 1.5 }}>{P1_BUSINESS.addr1}<br />{P1_BUSINESS.addr2}<br />{P1_BUSINESS.phone}</div>
          </div>
          <div>
            <div style={{ fontSize: 9, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.8, color: T.subtle, marginBottom: 4 }}>Bill to</div>
            <div style={{ fontSize: 11, color: T.ink, fontWeight: 600 }}>{SEVEN_BILL_TO.name}</div>
            <div style={{ fontSize: 11, color: T.muted, lineHeight: 1.5 }}>{SEVEN_BILL_TO.addr1}<br />{SEVEN_BILL_TO.addr2}</div>
          </div>
          <div>
            <div style={{ fontSize: 9, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.8, color: T.subtle, marginBottom: 4 }}>Ship to - Store #{woData.store}</div>
            <div style={{ fontSize: 11, color: T.muted, lineHeight: 1.5 }}>{woData.addr || "-"}</div>
          </div>
        </div>

        <div className="modal-form-row" style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 10, marginBottom: 16 }}>
          <label><span style={{ display: "block", fontSize: 11, fontWeight: 600, color: T.muted, marginBottom: 6 }}>Invoice #</span><input {...register("num", { onChange: () => setNumTouched(true) })} placeholder="e.g. 6557" style={{ width: "100%", padding: "10px 13px", borderRadius: 10, border: `1px solid ${T.border}`, background: T.surface, color: T.ink, fontSize: 13 }} />{errors.num && <span style={{ fontSize: 11, color: T.danger }}>{errors.num.message}</span>}</label>
          <label><span style={{ display: "block", fontSize: 11, fontWeight: 600, color: T.muted, marginBottom: 6 }}>Invoice date</span><input type="date" {...register("invoiceDate")} style={{ width: "100%", padding: "10px 13px", borderRadius: 10, border: `1px solid ${T.border}`, background: T.surface, color: T.ink, fontSize: 13 }} /></label>
          <label><span style={{ display: "block", fontSize: 11, fontWeight: 600, color: T.muted, marginBottom: 6 }}>Service date</span><input type="date" {...register("serviceDate")} style={{ width: "100%", padding: "10px 13px", borderRadius: 10, border: `1px solid ${T.border}`, background: T.surface, color: T.ink, fontSize: 13 }} /></label>
          <label><span style={{ display: "block", fontSize: 11, fontWeight: 600, color: T.muted, marginBottom: 6 }}>Terms</span><Sel {...register("terms")} style={{ width: "100%", padding: "10px 13px", borderRadius: 10, border: `1px solid ${T.border}`, background: T.surface, color: T.ink, fontSize: 13 }}><option>Net 30</option><option>Net 15</option><option>Due on receipt</option></Sel></label>
        </div>

        <div className="modal-form-row" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 18 }}>
          <div><div style={{ fontSize: 11, fontWeight: 600, color: T.muted, marginBottom: 6 }}>Work Order #</div><div style={{ padding: "10px 13px", borderRadius: 10, border: `1px solid ${T.borderSoft}`, background: T.surfaceSoft, fontSize: 13, color: T.ink, fontFamily: "var(--font-jetbrains-mono), monospace" }}>{woData.id}</div></div>
          <div><div style={{ fontSize: 11, fontWeight: 600, color: T.muted, marginBottom: 6 }}>Store #</div><div style={{ padding: "10px 13px", borderRadius: 10, border: `1px solid ${T.borderSoft}`, background: T.surfaceSoft, fontSize: 13, color: T.ink }}>#{woData.store}</div></div>
        </div>

        <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.8, color: T.subtle, marginBottom: 8 }}>Line items</div>
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
                <textarea {...register(`lines.${i}.desc` as const)} placeholder={line.type === "Labor" ? "What was done on site..." : line.type === "Parts/Hardware" ? "Part description" : "Description"} style={{ padding: "8px 10px", borderRadius: 8, border: `1px solid ${lineErr?.desc ? T.danger : T.border}`, background: T.surface, fontSize: 12, fontFamily: "inherit", color: T.ink, resize: "vertical", minHeight: 36, outline: "none" }} />
                {/* Mobile-only field labels — hidden inline so the desktop grid
                    (direct-children columns) is untouched; CSS reveals them. */}
                <span className="inv-mlabel" style={{ display: "none" }}>Qty</span>
                <span className="inv-mlabel" style={{ display: "none" }}>Rate</span>
                <span className="inv-mlabel" style={{ display: "none" }}>Amount</span>
                <input type="number" step="0.1" {...register(`lines.${i}.qty` as const, { valueAsNumber: true })} style={{ padding: "8px 10px", borderRadius: 8, border: `1px solid ${lineErr?.qty ? T.danger : T.border}`, background: T.surface, fontSize: 12, fontFamily: "inherit", color: T.ink, textAlign: "right", outline: "none" }} />
                <input type="number" step="0.01" placeholder="0.00" {...register(`lines.${i}.rate` as const, { valueAsNumber: true })} style={{ padding: "8px 10px", borderRadius: 8, border: `1px solid ${lineErr?.rate ? T.danger : T.border}`, background: T.surface, fontSize: 12, fontFamily: "var(--font-jetbrains-mono), monospace", color: T.ink, textAlign: "right", outline: "none" }} />
                <div className="mono inv-amount" style={{ fontSize: 12, fontWeight: 600, color: T.ink, textAlign: "right", paddingTop: 10 }}>{fmt(Math.round(amount(line) * 100) / 100)}</div>
                <button type="button" className="inv-line-remove" onClick={() => remove(i)} style={{ background: "transparent", border: "none", color: T.subtle, cursor: "pointer", fontSize: 16, padding: 0, paddingTop: 6 }}>x</button>
              </div>
            );
          })}
        </div>
        {errors.lines && (
          <div style={{ fontSize: 12, color: T.danger, fontWeight: 600, marginBottom: 10 }}>
            Check the highlighted line items — each line needs a description, a qty, and a rate (remove lines you don't need).
          </div>
        )}
        <div className="inv-add-btns" style={{ display: "flex", gap: 8, marginBottom: 18, flexWrap: "wrap" }}>
          {["Labor", "Truck Charge", "Parts/Hardware", "Shipping", "Other"].map(type => (
            <button key={type} type="button" onClick={() => append({ type, desc: "", qty: 1, rate: type === "Truck Charge" ? P1_BUSINESS.defaultTruckCharge : undefined })} className="btn-soft" style={{ padding: "7px 12px", fontSize: 11 }}>+ {type === "Parts/Hardware" ? "Parts" : type}</button>
          ))}
        </div>

        <div className="inv-totals-row" style={{ display: "grid", gridTemplateColumns: "1fr 280px", gap: 14, marginBottom: 18, alignItems: "start" }}>
          <div />
          <div style={{ background: T.surfaceSoft, borderRadius: 12, border: `1px solid ${T.borderSoft}`, padding: "14px 16px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10, fontSize: 13 }}><span style={{ color: T.muted }}>Subtotal</span><span className="mono" style={{ fontWeight: 600, color: T.ink }}>{fmt(Math.round(sub * 100) / 100)}</span></div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10, fontSize: 13, gap: 10 }}>
              <span style={{ color: T.muted }}>Sales tax</span>
              <input type="number" step="0.01" {...register("tax")} placeholder="0.00" style={{ width: 110, padding: "6px 10px", borderRadius: 8, border: `1px solid ${T.border}`, background: T.surface, fontSize: 12, fontFamily: "var(--font-jetbrains-mono), monospace", color: T.ink, textAlign: "right", outline: "none" }} />
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", paddingTop: 10, borderTop: `1px solid ${T.border}`, fontSize: 14 }}><span style={{ fontWeight: 700, color: T.ink }}>Total</span><span className="display" style={{ fontSize: 22, color: over ? T.danger : T.ink, letterSpacing: -0.4 }}>{fmt(Math.round(total * 100) / 100)}</span></div>
            <div style={{ fontSize: 11, color: over ? T.danger : T.muted, marginTop: 8, textAlign: "right" }}>
              {(woData.nte || 0) > 0 ? (over ? `Total spend would be ${fmt(projectedSpend)} - exceeds NTE by ${fmt(projectedSpend - woData.nte)}` : `${fmt(woData.nte - projectedSpend)} under NTE (${fmt(woData.nte)})${priorSpend > 0 ? ` - prior invoices ${fmt(priorSpend)}` : ""}`) : "No NTE set on this work order"}
            </div>
          </div>
        </div>

        {over && (
          <div className="card" style={{ background: T.warnSoft, border: `1px solid ${T.warn}55`, padding: "12px 16px", marginBottom: 12, display: "flex", alignItems: "flex-start", gap: 10 }}>
            <div style={{ fontSize: 18, lineHeight: 1 }}>!</div>
            <div style={{ flex: 1, fontSize: 12, color: "#73560C", lineHeight: 1.55 }}><div style={{ fontWeight: 700, color: T.warn, marginBottom: 2 }}>This invoice will push the total to {fmt(projectedSpend)} - exceeds the {fmt(woData.nte)} NTE.</div>You can still submit. Be ready to justify the overage.</div>
          </div>
        )}

        <label style={{ padding: "12px 16px", background: T.accentSoft, borderRadius: 10, border: `1px solid ${T.accentRing}`, cursor: "pointer", display: "block", marginBottom: 4 }}>
          <div style={{ border: `2px dashed ${T.accent}`, borderRadius: 8, padding: 18, textAlign: "center" }}>
            <div style={{ fontSize: 13, color: T.accent, fontWeight: 600 }}>Attach the PDF invoice (from QuickBooks)</div>
            <div style={{ fontSize: 11, color: T.subtle, marginTop: 4 }}>A copy is generated on submit if none is attached</div>
            <input type="file" accept="application/pdf" style={{ display: "none" }} />
          </div>
        </label>

        <div style={{ display: "flex", gap: 8, marginTop: 18, justifyContent: "flex-end", flexWrap: "wrap" }}>
          <button type="button" onClick={close} className="btn-soft">Cancel</button>
          {/* Save draft bypasses the lines-complete validation — a draft can
              be partially filled. Resumes by passing the existing invoice id
              so we update in place instead of inserting a duplicate. */}
          {doSaveDraftInvoice && (
            <button
              type="button"
              disabled={savingDraft || submitting}
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
                    lines: watch("lines"),
                    userTypedNum: numTouched,
                  };
                  const ok = await doSaveDraftInvoice(woData, data, existingInvoiceId);
                  if (ok) { setModal(null); resetNewInv(); }
                } finally { setSavingDraft(false); }
              }}
              className="btn-soft"
              style={{ opacity: savingDraft ? 0.7 : 1, cursor: savingDraft ? "default" : "pointer", display: "flex", alignItems: "center", gap: 6 }}
            >
              {savingDraft ? <><BtnSpinner />Saving...</> : (existingInvoiceId ? "Save draft" : "Save as draft")}
            </button>
          )}
          <button
            type="submit"
            disabled={submitting || savingDraft}
            className="btn-accent"
            style={{
              opacity: submitting ? 0.7 : 1,
              cursor: submitting ? "default" : "pointer",
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
