"use client";
// @ts-nocheck

import { useEffect, useMemo, useRef, useState } from "react";
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

const dateInputValue = (date: Date) => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};
const todayIso = () => dateInputValue(new Date());
const addDays = (iso: string, days: number) => {
  const date = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(date.getTime())) return "";
  date.setDate(date.getDate() + days);
  return dateInputValue(date);
};

const amount = (line: any) => (Number(line?.qty) || 0) * (Number(line?.rate) || 0);
const normalizeLineType = (type: string) => {
  if ((LINE_TYPES as readonly string[]).includes(type)) return type;
  if (type === "Travel") return "Truck Charge";
  if (type === "Parts") return "Parts/Hardware";
  return "Other";
};

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
    contractorInvoices,
    billingInvoices,
    editingInvoice,
    onClose,
    onCreated,
    fire,
    fmt,
  } = props;
  const [submitting, setSubmitting] = useState(false);
  const [woSearch, setWoSearch] = useState("");
  const [selectedSourceIds, setSelectedSourceIds] = useState<string[]>([]);
  const [targetMargin, setTargetMargin] = useState("30");
  const initializedFor = useRef<string | null>(null);
  const previousInvoiceDate = useRef("");
  const previousWorkOrderId = useRef("");
  const isEditing = !!editingInvoice?.id;

  const {
    register,
    handleSubmit,
    control,
    watch,
    reset,
    setValue,
    clearErrors,
    trigger,
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

  const { fields, append, remove, replace } = useFieldArray({ control, name: "lines" });
  const lines = watch("lines") || [];
  const salesTax = Number(watch("salesTax") || 0);
  const subtotal = lines.reduce((sum: number, line: any) => sum + amount(line), 0);
  const total = subtotal + salesTax;
  const selectedWorkOrderId = watch("workOrderId");
  const invoiceDate = watch("invoiceDate");

  const activeWorkOrders = useMemo(
    () => (workOrders || []).filter((wo: any) =>
      wo.status !== "closed" || wo.id === editingInvoice?.wot,
    ),
    [editingInvoice?.wot, workOrders],
  );

  const sourceOwnerById = useMemo(() => {
    const owners = new Map<string, { id: string; num: string }>();
    for (const invoice of billingInvoices || []) {
      for (const sourceId of invoice.sourceInvoiceIds || []) {
        owners.set(sourceId, { id: invoice.id, num: invoice.num });
      }
    }
    return owners;
  }, [billingInvoices]);

  const availableSourceInvoices = useMemo(
    () => (contractorInvoices || []).filter((invoice: any) =>
      invoice.wot === selectedWorkOrderId
      && invoice.state !== "draft"
      && invoice.state !== "rejected",
    ),
    [contractorInvoices, selectedWorkOrderId],
  );

  const selectedSourceInvoices = useMemo(
    () => availableSourceInvoices.filter((invoice: any) =>
      selectedSourceIds.includes(invoice.id),
    ),
    [availableSourceInvoices, selectedSourceIds],
  );

  const contractorCost = selectedSourceInvoices.reduce(
    (sum: number, invoice: any) => sum + Number(invoice.total || 0),
    0,
  );
  const grossProfit = total - contractorCost;
  const actualMargin = total > 0 && contractorCost > 0
    ? (grossProfit / total) * 100
    : null;

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
    if (modal !== "createBillingInvoice") {
      initializedFor.current = null;
      return;
    }
    const initializationKey = editingInvoice?.id
      ? `edit:${editingInvoice.id}`
      : "create";
    if (initializedFor.current === initializationKey) return;
    initializedFor.current = initializationKey;

    const today = todayIso();
    const initialInvoiceDate = editingInvoice?.invoiceDateRaw || today;
    const initialWorkOrderId = editingInvoice?.wot || "";
    previousInvoiceDate.current = initialInvoiceDate;
    previousWorkOrderId.current = initialWorkOrderId;
    reset({
      num: editingInvoice?.num || nextStaffNum(billingInvoices),
      invoiceDate: initialInvoiceDate,
      serviceDate: editingInvoice?.serviceDateRaw || "",
      dueDate: editingInvoice?.dueDateRaw || addDays(initialInvoiceDate, 30),
      workOrderId: initialWorkOrderId,
      storeNumber: editingInvoice?.store || "",
      storeAddress: editingInvoice?.storeAddr || "",
      terms: editingInvoice?.terms || "Net 30",
      cme: editingInvoice?.cme || "",
      salesTax: editingInvoice?.salesTax ? String(editingInvoice.salesTax) : "",
      state: editingInvoice?.state === "draft" ? "draft" : "submitted",
      lines: editingInvoice?.lines?.length
        ? editingInvoice.lines.map((line: any) => ({
            type: normalizeLineType(line.type || "Other"),
            desc: line.desc || line.description || "",
            qty: Number(line.qty || 1),
            rate: Number(line.rate || 0),
          }))
        : [{ type: "Labor", desc: "", qty: 1, rate: undefined }],
    });
    setWoSearch("");
    setSelectedSourceIds(editingInvoice?.sourceInvoiceIds || []);
    setTargetMargin(editingInvoice?.marginPercent != null
      ? Number(editingInvoice.marginPercent).toFixed(1)
      : "30");
  }, [billingInvoices, editingInvoice, modal, reset]);

  useEffect(() => {
    if (!invoiceDate) return;
    if (previousInvoiceDate.current === invoiceDate) return;
    previousInvoiceDate.current = invoiceDate;
    setValue("dueDate", addDays(invoiceDate, 30));
  }, [invoiceDate, setValue]);

  useEffect(() => {
    if (!selectedWorkOrderId) return;
    const wo = activeWorkOrders.find((item: any) => item.id === selectedWorkOrderId);
    if (!wo) return;
    setValue("storeNumber", wo.store || "", { shouldDirty: true, shouldValidate: true });
    setValue("storeAddress", wo.addr || "", { shouldDirty: true });
    clearErrors("storeNumber");
  }, [selectedWorkOrderId, activeWorkOrders, clearErrors, setValue]);

  useEffect(() => {
    if (previousWorkOrderId.current === selectedWorkOrderId) return;
    previousWorkOrderId.current = selectedWorkOrderId || "";
    setSelectedSourceIds([]);
  }, [selectedWorkOrderId]);

  if (modal !== "createBillingInvoice") return null;

  const toggleSourceInvoice = (invoiceId: string) => {
    const owner = sourceOwnerById.get(invoiceId);
    if (owner && owner.id !== editingInvoice?.id) return;
    setSelectedSourceIds(current => current.includes(invoiceId)
      ? current.filter(id => id !== invoiceId)
      : [...current, invoiceId]);
  };

  const pullSourceLines = () => {
    if (selectedSourceInvoices.length === 0) {
      fire?.("Select at least one contractor invoice");
      return;
    }
    const margin = Number(targetMargin);
    if (!Number.isFinite(margin) || margin < 0 || margin >= 100) {
      fire?.("Target margin must be between 0 and 99.99 percent");
      return;
    }
    const multiplier = 1 / (1 - margin / 100);
    const imported = selectedSourceInvoices.flatMap((invoice: any) => {
      if ((invoice.lines || []).length === 0) {
        return [{
          type: "Other",
          desc: "Contracted service",
          qty: 1,
          rate: Math.round(Number(invoice.total || 0) * multiplier * 100) / 100,
        }];
      }
      return invoice.lines.map((line: any) => ({
        type: normalizeLineType(line.type || "Other"),
        desc: line.desc || line.description || "Contractor service",
        qty: Number(line.qty || 1),
        rate: Math.round(Number(line.rate || 0) * multiplier * 100) / 100,
      }));
    });
    replace(imported);
    clearErrors("lines");
    setTimeout(() => void trigger("lines"), 0);
    fire?.(`Pulled ${imported.length} line item${imported.length === 1 ? "" : "s"}`);
  };

  const submit = async (data: any, state: "draft" | "submitted") => {
    setSubmitting(true);
    try {
      const sb = supabase();
      const { data: sessionData } = await sb.auth.getSession();
      const token = sessionData.session?.access_token;
      if (!token) throw new Error("Missing session");

      const res = await fetch(
        isEditing
          ? `/api/billing-invoices?id=${encodeURIComponent(editingInvoice.id)}`
          : "/api/billing-invoices",
        {
        method: isEditing ? "PATCH" : "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          ...data,
          state,
          salesTax: Number(data.salesTax || 0),
          sourceInvoiceIds: selectedSourceIds,
        }),
      });

      const payload = await res.json();
      if (!res.ok) throw new Error(payload.error || "Billing invoice save failed");
      fire?.(`Invoice #${payload.invoice?.num || data.num} ${state === "draft" ? (isEditing ? "draft updated" : "draft saved") : "submitted"}`);
      onCreated?.(payload.invoice);
      onClose?.();
    } catch (err: any) {
      fire?.(`Billing invoice ${isEditing ? "update" : "save"} failed: ${err.message || err}`);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal onClose={onClose} title={isEditing ? `Edit draft #${editingInvoice.num}` : "Create P1 to 7-Eleven invoice"} width={920}>
      <form onSubmit={handleSubmit(data => submit(data, "submitted"))}>
        <div style={{ fontSize: 13, color: T.muted, marginBottom: 18 }}>
          {isEditing
            ? "Update this draft, or submit it when it is ready."
            : "Direction is fixed: P1 Pros bills 7-Eleven. Linking a work order is optional."}
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
            {woSearch.trim() && (
              <div role="listbox" aria-label="Matching work orders" style={{ display: "grid", gap: 4, padding: 5, marginBottom: 8, maxHeight: 210, overflowY: "auto", border: `1px solid ${T.borderSoft}`, borderRadius: 9, background: T.surface }}>
                {workOrderOptions.length === 0 ? (
                  <div style={{ padding: "10px 9px", fontSize: 12, color: T.subtle }}>No matching work orders.</div>
                ) : workOrderOptions.slice(0, 8).map((wo: any) => (
                  <button
                    key={wo.id}
                    type="button"
                    role="option"
                    aria-selected={selectedWorkOrderId === wo.id}
                    onClick={() => {
                      setValue("workOrderId", wo.id, { shouldDirty: true, shouldValidate: true });
                      setWoSearch("");
                    }}
                    style={{ padding: "9px 10px", border: "none", borderRadius: 7, background: selectedWorkOrderId === wo.id ? T.accentSoft : T.surface, color: T.ink, cursor: "pointer", textAlign: "left", fontFamily: "inherit", fontSize: 12 }}
                  >
                    <span className="mono" style={{ color: T.accent, fontWeight: 700 }}>{wo.id}</span>
                    <span style={{ color: T.muted }}> - Store #{wo.store || "-"} - {wo.summary || "No summary"}</span>
                  </button>
                ))}
              </div>
            )}
            <Sel {...register("workOrderId")} value={selectedWorkOrderId || ""} style={{ width: "100%", padding: "10px 13px", borderRadius: 10, border: `1px solid ${T.border}`, background: T.surface, color: T.ink, fontSize: 13 }}>
              <option value="">Standalone invoice</option>
              {workOrderOptions.map((wo: any) => (
                <option key={wo.id} value={wo.id}>{wo.id} - Store #{wo.store || "-"} - {wo.summary || "No summary"}</option>
              ))}
            </Sel>
          </div>
          <label><span style={{ display: "block", fontSize: 11, fontWeight: 600, color: T.muted, marginBottom: 6 }}>Store number</span><input {...register("storeNumber")} placeholder="Required" style={{ width: "100%", padding: "10px 13px", borderRadius: 10, border: `1px solid ${errors.storeNumber ? T.danger : T.border}`, background: T.surface, color: T.ink, fontSize: 13 }} />{errors.storeNumber && <span style={{ fontSize: 11, color: T.danger }}>{errors.storeNumber.message}</span>}</label>
        </div>

        {selectedWorkOrderId && (
          <div style={{ border: `1px solid ${T.borderSoft}`, borderRadius: 10, padding: 14, marginBottom: 16, background: T.surfaceSoft }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, flexWrap: "wrap", marginBottom: 10 }}>
              <div>
                <div style={{ fontSize: 11, fontWeight: 700, color: T.ink }}>Contractor invoices on {selectedWorkOrderId}</div>
                <div style={{ fontSize: 11, color: T.muted, marginTop: 3 }}>Select the source invoices used to build this 7-Eleven invoice.</div>
              </div>
              {selectedSourceInvoices.length > 0 && (
                <div style={{ display: "flex", alignItems: "flex-end", gap: 8, flexWrap: "wrap" }}>
                  <label>
                    <span style={{ display: "block", fontSize: 10, fontWeight: 700, color: T.subtle, marginBottom: 4 }}>Target margin %</span>
                    <input type="number" min="0" max="99.99" step="0.1" value={targetMargin} onChange={(e: any) => setTargetMargin(e.target.value)} style={{ width: 92, padding: "7px 9px", borderRadius: 8, border: `1px solid ${T.border}`, background: T.surface, color: T.ink, fontSize: 12 }} />
                  </label>
                  <button type="button" onClick={pullSourceLines} className="btn-primary" style={{ padding: "8px 12px", fontSize: 11 }}>Pull lines + apply margin</button>
                </div>
              )}
            </div>
            {availableSourceInvoices.length === 0 ? (
              <div style={{ fontSize: 12, color: T.subtle, padding: "10px 0" }}>No submitted contractor invoices are available on this work order.</div>
            ) : (
              <div style={{ display: "grid", gap: 7 }}>
                {availableSourceInvoices.map((invoice: any) => {
                  const linkedTo = sourceOwnerById.get(invoice.id);
                  const linkedElsewhere = !!linkedTo && linkedTo.id !== editingInvoice?.id;
                  const checked = selectedSourceIds.includes(invoice.id);
                  return (
                    <label key={invoice.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 10px", borderRadius: 8, border: `1px solid ${checked ? T.accent : T.borderSoft}`, background: T.surface, opacity: linkedElsewhere ? 0.6 : 1, cursor: linkedElsewhere ? "not-allowed" : "pointer" }}>
                      <input type="checkbox" checked={checked} disabled={linkedElsewhere} onChange={() => toggleSourceInvoice(invoice.id)} />
                      <span className="mono" style={{ fontSize: 12, fontWeight: 700, color: T.accent }}>#{invoice.num}</span>
                      <span style={{ fontSize: 11, color: T.muted, textTransform: "capitalize" }}>{invoice.state}</span>
                      <span className="mono" style={{ marginLeft: "auto", fontSize: 12, fontWeight: 700, color: T.ink }}>{fmt(Number(invoice.total || 0))}</span>
                      {linkedElsewhere && <span style={{ fontSize: 10, color: T.warn }}>Used by {linkedTo?.num}</span>}
                    </label>
                  );
                })}
              </div>
            )}
            {selectedSourceInvoices.length > 0 && (
              <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 8, marginTop: 12 }} className="billing-source-metrics">
                <div><div style={{ fontSize: 9, color: T.subtle, textTransform: "uppercase", fontWeight: 700 }}>Contractor cost</div><div className="mono" style={{ fontSize: 13, fontWeight: 700 }}>{fmt(contractorCost)}</div></div>
                <div><div style={{ fontSize: 9, color: T.subtle, textTransform: "uppercase", fontWeight: 700 }}>P1 invoice</div><div className="mono" style={{ fontSize: 13, fontWeight: 700 }}>{fmt(total)}</div></div>
                <div><div style={{ fontSize: 9, color: T.subtle, textTransform: "uppercase", fontWeight: 700 }}>Current margin</div><div className="mono" style={{ fontSize: 13, fontWeight: 700, color: actualMargin == null ? T.subtle : actualMargin >= 30 ? T.success : T.danger }}>{actualMargin == null ? "-" : `${actualMargin.toFixed(1)}%`}</div></div>
              </div>
            )}
          </div>
        )}

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
                <Sel {...register(`lines.${i}.type` as const)} defaultValue={field.type} style={{ padding: "8px 10px", borderRadius: 8, border: `1px solid ${T.border}`, background: T.surface, fontSize: 12, color: T.ink }}>{LINE_TYPES.map(t => <option key={t} value={t}>{t}</option>)}</Sel>
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
            {submitting ? <><BtnSpinner />Saving...</> : isEditing ? "Save Draft" : "Save as Draft"}
          </button>
          <button type="submit" disabled={submitting} className="btn-accent" style={{ display: "flex", alignItems: "center", gap: 6, opacity: submitting ? 0.7 : 1 }}>
            {submitting ? <><BtnSpinner />Submitting...</> : "Submit Invoice"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
