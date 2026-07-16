"use client";
// @ts-nocheck

import { useEffect, useMemo, useState } from "react";
import { useForm, useFieldArray } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Modal } from "../../components/ui/Modal";
import { BtnSpinner } from "../../components/ui/BtnSpinner";
import { Sel } from "../../components/ui/Sel";
import { T, LINE_TYPES, SEVEN_STAFF_BILL_TO } from "../../lib/constants";
import { supabase } from "../../lib/supabase/client";

const BillingLineSchema = z.object({
  type: z.string().min(1),
  desc: z.string().min(1, "Description is required"),
  qty: z.number().positive("Qty must be greater than 0"),
  rate: z.number().positive("Rate must be greater than 0"),
});

const BillingInvoiceSchema = z.object({
  num: z.string().min(1, "Invoice number is required"),
  invoiceDate: z.string().min(1, "Invoice date is required"),
  serviceDate: z.string().optional(),
  dueDate: z.string().optional(),
  workOrderId: z.string().optional(),
  storeNumber: z.string().min(1, "Store number is required"),
  storeAddress: z.string().optional(),
  terms: z.string().min(1),
  cme: z.string().optional(),
  salesTax: z.string().optional(),
  state: z.enum(["draft", "submitted"]),
  lines: z.array(BillingLineSchema).min(1, "At least one line item is required"),
});

const todayIso = () => new Date().toISOString().slice(0, 10);
const addDays = (iso: string, days: number) => {
  const date = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(date.getTime())) return "";
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 10);
};

const amount = (line: any) => (Number(line?.qty) || 0) * (Number(line?.rate) || 0);

const nextStaffNum = (invoices: any[]) => {
  const maxNum = (invoices || []).reduce((max: number, invoice: any) => {
    const match = String(invoice.num || "").match(/^P1-(\d+)$/i);
    const n = match ? parseInt(match[1], 10) : 0;
    return Number.isFinite(n) && n > max ? n : max;
  }, 0);
  return `P1-${String(maxNum + 1).padStart(5, "0")}`;
};

export default function BillingInvoiceCreateModal(props: any) {
  const {
    modal,
    workOrders,
    billingInvoices,
    onClose,
    onCreated,
    fire,
    fmt,
  } = props;
  const [submitting, setSubmitting] = useState(false);
  const [woSearch, setWoSearch] = useState("");

  const {
    register,
    handleSubmit,
    control,
    watch,
    reset,
    setValue,
    formState: { errors },
  } = useForm({
    resolver: zodResolver(BillingInvoiceSchema),
    defaultValues: {
      num: "",
      invoiceDate: todayIso(),
      serviceDate: "",
      dueDate: addDays(todayIso(), 30),
      workOrderId: "",
      storeNumber: "",
      storeAddress: "",
      terms: "Net 30",
      cme: "",
      salesTax: "",
      state: "submitted",
      lines: [{ type: "Labor", desc: "", qty: 1, rate: undefined }],
    },
  });

  const { fields, append, remove } = useFieldArray({ control, name: "lines" });
  const lines = watch("lines") || [];
  const salesTax = Number(watch("salesTax") || 0);
  const subtotal = lines.reduce((sum: number, line: any) => sum + amount(line), 0);
  const total = subtotal + salesTax;
  const selectedWorkOrderId = watch("workOrderId");
  const invoiceDate = watch("invoiceDate");

  const activeWorkOrders = useMemo(
    () => (workOrders || []).filter((wo: any) => wo.status !== "closed"),
    [workOrders],
  );

  const workOrderOptions = useMemo(() => {
    const q = woSearch.trim().toLowerCase();
    if (!q) return activeWorkOrders.slice(0, 80);
    return activeWorkOrders.filter((wo: any) =>
      [wo.id, wo.incidentId, wo.store, wo.city, wo.addr, wo.summary]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
        .includes(q),
    ).slice(0, 80);
  }, [activeWorkOrders, woSearch]);

  useEffect(() => {
    if (modal !== "createBillingInvoice") return;
    const today = todayIso();
    reset({
      num: nextStaffNum(billingInvoices),
      invoiceDate: today,
      serviceDate: "",
      dueDate: addDays(today, 30),
      workOrderId: "",
      storeNumber: "",
      storeAddress: "",
      terms: "Net 30",
      cme: "",
      salesTax: "",
      state: "submitted",
      lines: [{ type: "Labor", desc: "", qty: 1, rate: undefined }],
    });
    setWoSearch("");
  }, [modal, billingInvoices, reset]);

  useEffect(() => {
    if (!invoiceDate) return;
    setValue("dueDate", addDays(invoiceDate, 30));
  }, [invoiceDate, setValue]);

  useEffect(() => {
    if (!selectedWorkOrderId) return;
    const wo = activeWorkOrders.find((item: any) => item.id === selectedWorkOrderId);
    if (!wo) return;
    setValue("storeNumber", wo.store || "");
    setValue("storeAddress", wo.addr || "");
  }, [selectedWorkOrderId, activeWorkOrders, setValue]);

  if (modal !== "createBillingInvoice") return null;

  const submit = async (data: any, state: "draft" | "submitted") => {
    setSubmitting(true);
    try {
      const sb = supabase();
      const { data: sessionData } = await sb.auth.getSession();
      const token = sessionData.session?.access_token;
      if (!token) throw new Error("Missing session");

      const res = await fetch("/api/billing-invoices", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          ...data,
          state,
          salesTax: Number(data.salesTax || 0),
        }),
      });

      const payload = await res.json();
      if (!res.ok) throw new Error(payload.error || "Billing invoice save failed");
      fire?.(`Invoice #${payload.invoice?.num || data.num} ${state === "draft" ? "draft saved" : "submitted"}`);
      onCreated?.(payload.invoice);
      onClose?.();
    } catch (err: any) {
      fire?.(`Billing invoice save failed: ${err.message || err}`);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal onClose={onClose} title="Create P1 to 7-Eleven invoice" width={920}>
      <form onSubmit={handleSubmit(data => submit(data, "submitted"))}>
        <div style={{ fontSize: 13, color: T.muted, marginBottom: 18 }}>
          Direction is fixed: P1 Pros bills 7-Eleven. Linking a work order is optional.
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, padding: "14px 16px", background: T.surfaceSoft, borderRadius: 12, border: `1px solid ${T.borderSoft}`, marginBottom: 18 }} className="billing-summary-grid">
          <div>
            <div style={{ fontSize: 9, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.8, color: T.subtle, marginBottom: 4 }}>Bill to</div>
            <div style={{ fontSize: 12, fontWeight: 700, color: T.ink }}>{SEVEN_STAFF_BILL_TO.name}</div>
            <div style={{ fontSize: 11, color: T.muted, lineHeight: 1.5 }}>{SEVEN_STAFF_BILL_TO.addr1}<br />{SEVEN_STAFF_BILL_TO.addr2}</div>
          </div>
          <div>
            <div style={{ fontSize: 9, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.8, color: T.subtle, marginBottom: 4 }}>Ship to</div>
            <div style={{ fontSize: 11, color: T.muted, lineHeight: 1.5 }}>{watch("storeAddress") || "Select a WO or enter store address below"}</div>
          </div>
        </div>

        <div className="billing-form-grid" style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 10, marginBottom: 16 }}>
          <label><span style={{ display: "block", fontSize: 11, fontWeight: 600, color: T.muted, marginBottom: 6 }}>Invoice #</span><input {...register("num")} style={{ width: "100%", padding: "10px 13px", borderRadius: 10, border: `1px solid ${errors.num ? T.danger : T.border}`, background: T.surface, color: T.ink, fontSize: 13 }} /></label>
          <label><span style={{ display: "block", fontSize: 11, fontWeight: 600, color: T.muted, marginBottom: 6 }}>Invoice date</span><input type="date" {...register("invoiceDate")} style={{ width: "100%", padding: "10px 13px", borderRadius: 10, border: `1px solid ${errors.invoiceDate ? T.danger : T.border}`, background: T.surface, color: T.ink, fontSize: 13 }} /></label>
          <label><span style={{ display: "block", fontSize: 11, fontWeight: 600, color: T.muted, marginBottom: 6 }}>Service date</span><input type="date" {...register("serviceDate")} style={{ width: "100%", padding: "10px 13px", borderRadius: 10, border: `1px solid ${T.border}`, background: T.surface, color: T.ink, fontSize: 13 }} /></label>
          <label><span style={{ display: "block", fontSize: 11, fontWeight: 600, color: T.muted, marginBottom: 6 }}>Due date</span><input type="date" {...register("dueDate")} style={{ width: "100%", padding: "10px 13px", borderRadius: 10, border: `1px solid ${T.border}`, background: T.surface, color: T.ink, fontSize: 13 }} /></label>
        </div>

        <div className="billing-form-grid" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 16 }}>
          <div>
            <span style={{ display: "block", fontSize: 11, fontWeight: 600, color: T.muted, marginBottom: 6 }}>Search work order</span>
            <input value={woSearch} onChange={(e: any) => setWoSearch(e.target.value)} placeholder="WO number, store, city, keyword" style={{ width: "100%", padding: "10px 13px", borderRadius: 10, border: `1px solid ${T.border}`, background: T.surface, color: T.ink, fontSize: 13, marginBottom: 8 }} />
            <Sel {...register("workOrderId")} style={{ width: "100%", padding: "10px 13px", borderRadius: 10, border: `1px solid ${T.border}`, background: T.surface, color: T.ink, fontSize: 13 }}>
              <option value="">Standalone invoice</option>
              {workOrderOptions.map((wo: any) => (
                <option key={wo.id} value={wo.id}>{wo.id} - Store #{wo.store || "-"} - {wo.summary || "No summary"}</option>
              ))}
            </Sel>
          </div>
          <label><span style={{ display: "block", fontSize: 11, fontWeight: 600, color: T.muted, marginBottom: 6 }}>Store number</span><input {...register("storeNumber")} placeholder="Required" style={{ width: "100%", padding: "10px 13px", borderRadius: 10, border: `1px solid ${errors.storeNumber ? T.danger : T.border}`, background: T.surface, color: T.ink, fontSize: 13 }} />{errors.storeNumber && <span style={{ fontSize: 11, color: T.danger }}>{errors.storeNumber.message}</span>}</label>
        </div>

        <div className="billing-form-grid" style={{ display: "grid", gridTemplateColumns: "1.4fr 1fr 1fr", gap: 10, marginBottom: 18 }}>
          <label><span style={{ display: "block", fontSize: 11, fontWeight: 600, color: T.muted, marginBottom: 6 }}>Store address</span><input {...register("storeAddress")} style={{ width: "100%", padding: "10px 13px", borderRadius: 10, border: `1px solid ${T.border}`, background: T.surface, color: T.ink, fontSize: 13 }} /></label>
          <label><span style={{ display: "block", fontSize: 11, fontWeight: 600, color: T.muted, marginBottom: 6 }}>Terms</span><Sel {...register("terms")} style={{ width: "100%", padding: "10px 13px", borderRadius: 10, border: `1px solid ${T.border}`, background: T.surface, color: T.ink, fontSize: 13 }}><option>Net 30</option><option>Net 15</option><option>Due on receipt</option></Sel></label>
          <label><span style={{ display: "block", fontSize: 11, fontWeight: 600, color: T.muted, marginBottom: 6 }}>Notes / CME</span><input {...register("cme")} style={{ width: "100%", padding: "10px 13px", borderRadius: 10, border: `1px solid ${T.border}`, background: T.surface, color: T.ink, fontSize: 13 }} /></label>
        </div>

        <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.8, color: T.subtle, marginBottom: 8 }}>Line items</div>
        <div style={{ border: `1px solid ${T.borderSoft}`, borderRadius: 12, overflow: "hidden", marginBottom: 10 }}>
          <div className="billing-line-head" style={{ display: "grid", gridTemplateColumns: "120px 1fr 70px 90px 100px 32px", gap: 10, padding: "10px 12px", background: T.surfaceSoft, fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.6, color: T.subtle, borderBottom: `1px solid ${T.borderSoft}` }}>
            <div>Type</div><div>Description</div><div style={{ textAlign: "right" }}>Qty</div><div style={{ textAlign: "right" }}>Rate</div><div style={{ textAlign: "right" }}>Amount</div><div />
          </div>
          {fields.map((field, i) => {
            const line = lines[i] || field;
            return (
              <div key={field.id} className="billing-line-row" style={{ display: "grid", gridTemplateColumns: "120px 1fr 70px 90px 100px 32px", gap: 10, padding: "10px 12px", borderBottom: i < fields.length - 1 ? `1px solid ${T.borderSoft}` : "none", alignItems: "start" }}>
                <Sel {...register(`lines.${i}.type` as const)} style={{ padding: "8px 10px", borderRadius: 8, border: `1px solid ${T.border}`, background: T.surface, fontSize: 12, color: T.ink }}>{LINE_TYPES.map(t => <option key={t}>{t}</option>)}</Sel>
                <textarea {...register(`lines.${i}.desc` as const)} placeholder="Description" style={{ padding: "8px 10px", borderRadius: 8, border: `1px solid ${errors.lines?.[i]?.desc ? T.danger : T.border}`, background: T.surface, fontSize: 12, fontFamily: "inherit", color: T.ink, resize: "vertical", minHeight: 36 }} />
                <input type="number" step="0.1" {...register(`lines.${i}.qty` as const, { valueAsNumber: true })} style={{ padding: "8px 10px", borderRadius: 8, border: `1px solid ${errors.lines?.[i]?.qty ? T.danger : T.border}`, background: T.surface, fontSize: 12, color: T.ink, textAlign: "right" }} />
                <input type="number" step="0.01" {...register(`lines.${i}.rate` as const, { valueAsNumber: true })} style={{ padding: "8px 10px", borderRadius: 8, border: `1px solid ${errors.lines?.[i]?.rate ? T.danger : T.border}`, background: T.surface, fontSize: 12, color: T.ink, textAlign: "right" }} />
                <div className="mono" style={{ fontSize: 12, fontWeight: 600, color: T.ink, textAlign: "right", paddingTop: 10 }}>{fmt(Math.round(amount(line) * 100) / 100)}</div>
                <button type="button" onClick={() => remove(i)} style={{ background: "transparent", border: "none", color: T.subtle, cursor: "pointer", fontSize: 16, paddingTop: 6 }}>x</button>
              </div>
            );
          })}
        </div>
        {errors.lines && <div style={{ fontSize: 12, color: T.danger, fontWeight: 600, marginBottom: 10 }}>Each line needs a description, qty, and rate.</div>}
        <div style={{ display: "flex", gap: 8, marginBottom: 18, flexWrap: "wrap" }}>
          {["Labor", "Parts/Hardware", "Truck Charge", "Other"].map(type => (
            <button key={type} type="button" onClick={() => append({ type, desc: "", qty: 1, rate: undefined })} className="btn-soft" style={{ padding: "7px 12px", fontSize: 11 }}>+ {type}</button>
          ))}
        </div>

        <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 18 }}>
          <div style={{ width: 300, background: T.surfaceSoft, borderRadius: 12, border: `1px solid ${T.borderSoft}`, padding: "14px 16px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, marginBottom: 10 }}><span style={{ color: T.muted }}>Subtotal</span><span className="mono" style={{ color: T.ink, fontWeight: 600 }}>{fmt(Math.round(subtotal * 100) / 100)}</span></div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 13, marginBottom: 10, gap: 10 }}>
              <span style={{ color: T.muted }}>Sales tax</span>
              <input type="number" step="0.01" {...register("salesTax")} placeholder="0.00" style={{ width: 110, padding: "6px 10px", borderRadius: 8, border: `1px solid ${T.border}`, background: T.surface, fontSize: 12, color: T.ink, textAlign: "right" }} />
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", paddingTop: 10, borderTop: `1px solid ${T.border}` }}><span style={{ fontWeight: 700, color: T.ink }}>Total</span><span className="display" style={{ fontSize: 22, color: T.ink }}>{fmt(Math.round(total * 100) / 100)}</span></div>
          </div>
        </div>

        <div style={{ display: "flex", gap: 8, marginTop: 18, justifyContent: "flex-end", flexWrap: "wrap" }}>
          <button type="button" onClick={onClose} className="btn-soft">Cancel</button>
          <button type="button" disabled={submitting} onClick={handleSubmit(data => submit(data, "draft"))} className="btn-soft" style={{ display: "flex", alignItems: "center", gap: 6, opacity: submitting ? 0.7 : 1 }}>
            {submitting ? <><BtnSpinner />Saving...</> : "Save as Draft"}
          </button>
          <button type="submit" disabled={submitting} className="btn-accent" style={{ display: "flex", alignItems: "center", gap: 6, opacity: submitting ? 0.7 : 1 }}>
            {submitting ? <><BtnSpinner />Submitting...</> : "Submit Invoice"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
