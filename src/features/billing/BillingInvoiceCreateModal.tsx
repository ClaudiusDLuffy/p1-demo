"use client";
// @ts-nocheck

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useForm, useFieldArray } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Modal } from "../../components/ui/Modal";
import { BtnSpinner } from "../../components/ui/BtnSpinner";
import { Ico } from "../../components/ui/Ico";
import { Sel } from "../../components/ui/Sel";
import { PRIORITY, T, SEVEN_STAFF_BILL_TO } from "../../lib/constants";
import {
  calculateTrips,
  defaultLineTaxable,
  stateCodeFromWorkOrder,
  timezoneForWorkOrder,
} from "../../lib/billingRules";
import {
  importedStaffBillingRate,
  isStaffBillingPartsLine,
  normalizeStaffBillingLineType,
  STAFF_BILLING_LINE_TYPES,
} from "../../lib/staffBilling";
import { supabase } from "../../lib/supabase/client";
import BillingWorkOrderActivityPanel from "./BillingWorkOrderActivityPanel";
import {
  billingDraftStorageKey,
  createBillingDraftPayload,
  readBillingDraft,
  removeBillingDraft,
  writeBillingDraft,
} from "../../lib/billingDraftPersistence";

const BillingLineSchema = z.object({
  type: z.string().min(1),
  desc: z.string(),
  qty: z.number().positive("Qty must be greater than 0"),
  rate: z.number().positive("Rate must be greater than 0"),
  isTaxable: z.boolean().default(false),
  sourceInvoiceLineId: z.string().optional().nullable(),
  sourceUnitCost: z.number().nonnegative().optional().nullable(),
  markupPercent: z.number().min(0).max(999).optional().nullable(),
}).superRefine((line, context) => {
  const descriptionOptional = /^(travel|truck charge)$/i.test(line.type.trim());
  if (!descriptionOptional && !line.desc.trim()) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["desc"],
      message: "Description is required",
    });
  }
});

const OptionalTaxAmountSchema = z.preprocess(
  value => {
    if (value === "" || value == null) return undefined;
    const parsed = Number(value);
    return Number.isNaN(parsed) ? value : parsed;
  },
  z.number().finite().nonnegative("Sales tax must be zero or greater").optional(),
);

const OptionalTaxRateSchema = z.preprocess(
  value => {
    if (value === "" || value == null) return undefined;
    const parsed = Number(value);
    return Number.isNaN(parsed) ? value : parsed;
  },
  z.number()
    .finite()
    .min(0, "Tax rate must be between 0% and 100%")
    .max(100, "Tax rate must be between 0% and 100%")
    .optional(),
);

const BillingInvoiceSchema = z.object({
  num: z.string().trim().min(1, "Invoice number is required").max(80, "Invoice number is too long"),
  invoiceDate: z.string().min(1, "Invoice date is required"),
  serviceDate: z.string().optional(),
  dueDate: z.string().optional(),
  workOrderId: z.string().optional(),
  territory: z.string().trim().min(1, "Territory is required"),
  storeNumber: z.string().min(1, "Store number is required"),
  storeAddress: z.string().optional(),
  terms: z.string().min(1),
  cme: z.string().optional(),
  taxState: z.string().max(2).optional(),
  taxRateOverride: OptionalTaxRateSchema,
  salesTaxOverride: OptionalTaxAmountSchema,
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
const money = (value: number) => Math.round(value * 100) / 100;
const KNOWN_TERRITORIES = ["Virginia", "Texas", "Florida"] as const;
const CONTROLLER_EMAIL = "emilyb@phospitality.com";
const STAFF_INVOICE_SERIES: Record<string, { prefix: string; start: number }> = {
  "lynzy@p1pros.com": { prefix: "P1-L-", start: 1000 },
  "mandy@p1pros.com": { prefix: "P1-M-", start: 2000 },
  "lynette@p1pros.com": { prefix: "P1-N-", start: 3000 },
  "landryd@phospitality.com": { prefix: "P1-D-", start: 4000 },
};

const territoryFromState = (state: unknown) => {
  const code = String(state || "").trim().toUpperCase();
  if (code === "VA") return "Virginia";
  if (code === "TX") return "Texas";
  if (code === "FL") return "Florida";
  return "";
};

const QUICK_ADD_LINES = [
  { label: "Labor", type: "Labor", desc: "", rate: 110 },
  { label: "OT Labor", type: "OT Labor", desc: "", rate: 165 },
  { label: "Parts", type: "Parts/Hardware", desc: "", rate: undefined },
  { label: "Travel", type: "Travel", desc: "", rate: 110 },
  { label: "Refrigerant", type: "Parts/Hardware", desc: "Refrigerant", rate: 35 },
] as const;

const QUICK_ADD_PRESETS = [
  { label: "Field Wiring Kit", type: "Parts/Hardware", rate: 52 },
  { label: "TVRN", type: "Parts/Hardware", rate: 236 },
  { label: "Nitrogen", type: "Parts/Hardware", rate: 45 },
  { label: "Commercial Coil Cleaner", type: "Parts/Hardware", rate: 63 },
] as const;

const dateInTimeZone = (value: string | null | undefined, timeZone: string) => {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find(part => part.type === type)?.value || "";
  return `${get("year")}-${get("month")}-${get("day")}`;
};

const nextStaffNum = (invoices: any[], currentUser: any) => {
  const email = String(currentUser?.email || "").trim().toLowerCase();
  const series = STAFF_INVOICE_SERIES[email];
  if (series) {
    const maxNum = (invoices || []).reduce((max: number, invoice: any) => {
      const value = String(invoice.num || "");
      if (!value.startsWith(series.prefix)) return max;
      const n = Number(value.slice(series.prefix.length));
      return Number.isInteger(n) && n >= series.start && n > max ? n : max;
    }, series.start - 1);
    return `${series.prefix}${maxNum + 1}`;
  }

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
    currentUser,
    workOrders,
    contractorInvoices,
    billingInvoices,
    editingInvoice,
    initialSourceInvoiceId,
    initialWorkOrderId,
    onClose,
    onCreated,
    fire,
    fmt,
  } = props;
  const [submitting, setSubmitting] = useState(false);
  const [pullingLines, setPullingLines] = useState(false);
  const [woSearch, setWoSearch] = useState("");
  const [selectedSourceIds, setSelectedSourceIds] = useState<string[]>([]);
  const [partsMarkup, setPartsMarkup] = useState("25");
  const [customTerritory, setCustomTerritory] = useState(false);
  const [draggingLine, setDraggingLine] = useState<number | null>(null);
  const [sourceSnapshots, setSourceSnapshots] = useState<Record<string, any>>({});
  const [taxRates, setTaxRates] = useState<any[]>([]);
  const [taxRateLoadError, setTaxRateLoadError] = useState("");
  const [numberEdited, setNumberEdited] = useState(false);
  const [draftState, setDraftState] = useState<"idle" | "restored" | "saved" | "error">("idle");
  const [draftSavedAt, setDraftSavedAt] = useState<string | null>(null);
  const initializedFor = useRef<string | null>(null);
  const previousInvoiceDate = useRef("");
  const previousWorkOrderId = useRef("");
  const skipRestoredWorkOrderHydration = useRef<string | null>(null);
  const draftHydrated = useRef(false);
  const draftSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isEditing = !!editingInvoice?.id;
  const controller = String(currentUser?.email || "").trim().toLowerCase()
    === CONTROLLER_EMAIL;
  const draftStorageKey = useMemo(
    () => billingDraftStorageKey({
      userId: currentUser?.id || currentUser?.email || "staff",
      editingInvoiceId: editingInvoice?.id || null,
    }),
    [currentUser?.email, currentUser?.id, editingInvoice?.id],
  );

  const {
    register,
    handleSubmit,
    control,
    watch,
    reset,
    setValue,
    getValues,
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
      territory: "",
      storeNumber: "",
      storeAddress: "",
      terms: "Net 30",
      cme: "",
      taxState: "",
      taxRateOverride: "",
      salesTaxOverride: "",
      state: "submitted",
      lines: [],
    },
  });

  const { fields, append, remove, replace, move } = useFieldArray({ control, name: "lines" });
  const lines = watch("lines") || [];
  const subtotal = lines.reduce((sum: number, line: any) => sum + amount(line), 0);
  const selectedWorkOrderId = watch("workOrderId");
  const territory = String(watch("territory") || "");
  const invoiceDate = watch("invoiceDate");
  const serviceDate = watch("serviceDate");
  const taxState = String(watch("taxState") || "").toUpperCase();
  const taxRateOverride = watch("taxRateOverride");
  const salesTaxOverride = watch("salesTaxOverride");

  const activeWorkOrders = useMemo(
    () => (workOrders || []).filter((wo: any) =>
      wo.status !== "closed" || wo.id === editingInvoice?.wot,
    ),
    [editingInvoice?.wot, workOrders],
  );
  const selectedWorkOrder = useMemo(
    () => activeWorkOrders.find((wo: any) => wo.id === selectedWorkOrderId) || null,
    [activeWorkOrders, selectedWorkOrderId],
  );
  const selectedTimeZone = timezoneForWorkOrder(selectedWorkOrder);
  const selectedTrips = useMemo(() => {
    const visits = (selectedWorkOrder?.visits || [])
      .filter((visit: any) => visit?.checkInAt)
      .map((visit: any) => ({
        id: visit.id,
        checkInAt: visit.checkInAt,
        checkOutAt: visit.checkOutAt || null,
      }));
    if (visits.length > 0) return calculateTrips(visits, selectedTimeZone);
    if (!selectedWorkOrder?.startTimeRaw) return [];
    return calculateTrips([{
      id: "legacy",
      checkInAt: selectedWorkOrder.startTimeRaw,
      checkOutAt: selectedWorkOrder.endTimeRaw || null,
    }], selectedTimeZone);
  }, [selectedTimeZone, selectedWorkOrder]);
  const tripTotals = useMemo(
    () => selectedTrips.reduce(
      (totals: any, trip: any) => ({
        totalHours: totals.totalHours + trip.totalHours,
        regularHours: totals.regularHours + trip.regularHours,
        overtimeHours: totals.overtimeHours + trip.overtimeHours,
      }),
      { totalHours: 0, regularHours: 0, overtimeHours: 0 },
    ),
    [selectedTrips],
  );

  const activeTaxRate = useMemo(() => {
    if (!taxState) return null;
    const onDate = serviceDate || invoiceDate || todayIso();
    return taxRates
      .filter((rate: any) =>
        String(rate.state_code || "").toUpperCase() === taxState
        && (!rate.effective_from || rate.effective_from <= onDate)
        && (!rate.effective_to || rate.effective_to >= onDate),
      )
      .sort((a: any, b: any) =>
        String(b.effective_from || "").localeCompare(String(a.effective_from || "")),
      )[0] || null;
  }, [invoiceDate, serviceDate, taxRates, taxState]);
  const configuredTaxRate = activeTaxRate ? Number(activeTaxRate.rate || 0) : null;
  const taxableSubtotal = lines.reduce(
    (sum: number, line: any) => sum + (line?.isTaxable ? amount(line) : 0),
    0,
  );
  const hasTaxRateOverride = taxRateOverride !== ""
    && taxRateOverride != null
    && Number.isFinite(Number(taxRateOverride))
    && Number(taxRateOverride) >= 0
    && Number(taxRateOverride) <= 100;
  const manualTaxRate = hasTaxRateOverride
    ? Number(taxRateOverride) / 100
    : null;
  const effectiveTaxRate = manualTaxRate ?? configuredTaxRate;
  const hasSalesTaxOverride = salesTaxOverride !== ""
    && salesTaxOverride != null
    && Number.isFinite(Number(salesTaxOverride))
    && Number(salesTaxOverride) >= 0;
  const rateBasedSalesTax = effectiveTaxRate == null
    ? 0
    : money(taxableSubtotal * effectiveTaxRate);
  const salesTax = hasSalesTaxOverride
    ? money(Number(salesTaxOverride))
    : rateBasedSalesTax;
  const total = subtotal + salesTax;

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
      && invoice.state !== "rejected"
      && (!controller || ["approved", "paid"].includes(invoice.state)),
    ),
    [contractorInvoices, controller, selectedWorkOrderId],
  );

  const selectedSourceInvoices = useMemo(
    () => availableSourceInvoices.filter((invoice: any) =>
      selectedSourceIds.includes(invoice.id),
    ).map((invoice: any) => sourceSnapshots[invoice.id] || invoice),
    [availableSourceInvoices, selectedSourceIds, sourceSnapshots],
  );

  const contractorCost = selectedSourceInvoices.reduce(
    (sum: number, invoice: any) => sum + Number(
      invoice.subtotal
      ?? Math.max(Number(invoice.total || 0) - Number(invoice.salesTax || 0), 0),
    ),
    0,
  );
  const partsMarkupAmount = lines.reduce((sum: number, line: any) => {
    if (
      !isStaffBillingPartsLine(line.type)
      || line.sourceUnitCost == null
    ) return sum;
    return sum + Math.max(
      (Number(line.rate) - Number(line.sourceUnitCost)) * Number(line.qty || 0),
      0,
    );
  }, 0);
  const actualMargin = subtotal > 0 && contractorCost > 0
    ? ((subtotal - contractorCost) / subtotal) * 100
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

  const persistBillingDraft = useCallback(() => {
    if (
      modal !== "createBillingInvoice"
      || !draftHydrated.current
      || typeof window === "undefined"
    ) return;
    try {
      const payload = createBillingDraftPayload({
        form: getValues(),
        selectedSourceIds,
        sourceSnapshots,
        partsMarkup,
        customTerritory,
        numberEdited,
      });
      writeBillingDraft(window.localStorage, draftStorageKey, payload);
      setDraftSavedAt(payload.savedAt);
      setDraftState("saved");
    } catch {
      setDraftState("error");
    }
  }, [
    customTerritory,
    draftStorageKey,
    getValues,
    modal,
    numberEdited,
    partsMarkup,
    selectedSourceIds,
    sourceSnapshots,
  ]);

  useEffect(() => {
    if (modal !== "createBillingInvoice") return;
    let cancelled = false;
    void (async () => {
      const sb = supabase();
      const { data, error } = await (sb as any)
        .from("state_sales_tax_rates")
        .select("state_code, rate, effective_from, effective_to")
        .order("state_code")
        .order("effective_from", { ascending: false });
      if (cancelled) return;
      if (error) {
        setTaxRates([]);
        setTaxRateLoadError("Tax rates are unavailable. Apply the billing pricing migration.");
        return;
      }
      setTaxRates(data || []);
      setTaxRateLoadError("");
    })();
    return () => {
      cancelled = true;
    };
  }, [modal]);

  useEffect(() => {
    if (modal !== "createBillingInvoice") {
      initializedFor.current = null;
      draftHydrated.current = false;
      return;
    }
    const initializationKey = editingInvoice?.id
      ? `edit:${editingInvoice.id}`
      : `create:${initialSourceInvoiceId || ""}:${initialWorkOrderId || ""}`;
    if (initializedFor.current === initializationKey) return;
    initializedFor.current = initializationKey;
    draftHydrated.current = false;

    const today = todayIso();
    const initialInvoiceDate = editingInvoice?.invoiceDateRaw || today;
    const initialSourceInvoice = (contractorInvoices || []).find(
      (invoice: any) => invoice.id === initialSourceInvoiceId,
    );
    const resolvedInitialWorkOrderId = editingInvoice?.wot
      || initialSourceInvoice?.wot
      || initialWorkOrderId
      || "";
    const initialForm = {
      num: editingInvoice?.num || nextStaffNum(billingInvoices, currentUser),
      invoiceDate: initialInvoiceDate,
      serviceDate: editingInvoice?.serviceDateRaw || "",
      dueDate: editingInvoice?.dueDateRaw || addDays(initialInvoiceDate, 30),
      workOrderId: resolvedInitialWorkOrderId,
      territory: editingInvoice?.territory
        || territoryFromState(
          editingInvoice?.taxState
          || stateCodeFromWorkOrder(
            activeWorkOrders.find((item: any) => item.id === resolvedInitialWorkOrderId),
          ),
        )
        || "",
      storeNumber: editingInvoice?.store || "",
      storeAddress: editingInvoice?.storeAddr || "",
      terms: editingInvoice?.terms || "Net 30",
      cme: editingInvoice?.cme || "",
      taxState: editingInvoice?.taxState || "",
      taxRateOverride: editingInvoice?.taxRate == null
        ? ""
        : Number(editingInvoice.taxRate) * 100,
      salesTaxOverride: editingInvoice?.taxRate == null && Number(editingInvoice?.salesTax || 0) > 0
        ? Number(editingInvoice.salesTax)
        : "",
      state: editingInvoice?.state === "draft" ? "draft" : "submitted",
      lines: editingInvoice?.lines?.length
        ? editingInvoice.lines.map((line: any) => ({
            type: normalizeStaffBillingLineType(line.type),
            desc: line.desc || line.description || "",
            qty: Number(line.qty || 1),
            rate: Number(line.rate || 0),
            isTaxable: !!line.isTaxable,
            sourceInvoiceLineId: line.sourceInvoiceLineId || null,
            sourceUnitCost: line.sourceUnitCost == null
              ? null
              : Number(line.sourceUnitCost),
            markupPercent: line.markupPercent == null
              ? null
              : Number(line.markupPercent),
          }))
        : [],
    };
    let storedDraft: ReturnType<typeof readBillingDraft> = null;
    if (typeof window !== "undefined") {
      try {
        storedDraft = readBillingDraft(window.localStorage, draftStorageKey);
      } catch {
        storedDraft = null;
      }
    }
    const storedWorkOrderId = String(storedDraft?.form?.workOrderId || "");
    const requestedWorkOrderMatches = !resolvedInitialWorkOrderId
      || storedWorkOrderId === resolvedInitialWorkOrderId;
    const restoredDraft = storedDraft && requestedWorkOrderMatches
      ? storedDraft
      : null;
    const formToLoad = restoredDraft?.form || initialForm;
    previousInvoiceDate.current = String(formToLoad.invoiceDate || initialInvoiceDate);
    previousWorkOrderId.current = String(formToLoad.workOrderId || resolvedInitialWorkOrderId);
    reset(formToLoad as any);
    setWoSearch("");
    setSelectedSourceIds(restoredDraft?.selectedSourceIds || (
      editingInvoice?.sourceInvoiceIds
      || (initialSourceInvoice?.id ? [initialSourceInvoice.id] : [])
    ));
    setSourceSnapshots(restoredDraft?.sourceSnapshots || Object.fromEntries(
      (editingInvoice?.sourceInvoices || []).map((invoice: any) => [invoice.id, invoice]),
    ));
    setPartsMarkup(restoredDraft?.partsMarkup || "25");
    setCustomTerritory(restoredDraft?.customTerritory ?? (
      !!editingInvoice?.territory
      && !KNOWN_TERRITORIES.includes(editingInvoice.territory)
    ));
    setNumberEdited(restoredDraft?.numberEdited ?? isEditing);
    setDraftSavedAt(restoredDraft?.savedAt || null);
    setDraftState(restoredDraft ? "restored" : "idle");
    skipRestoredWorkOrderHydration.current = restoredDraft
      ? String(restoredDraft.form.workOrderId || "")
      : null;
    draftHydrated.current = true;
  }, [
    activeWorkOrders,
    billingInvoices,
    contractorInvoices,
    currentUser,
    editingInvoice,
    initialSourceInvoiceId,
    initialWorkOrderId,
    isEditing,
    modal,
    reset,
    draftStorageKey,
  ]);

  useEffect(() => {
    if (modal !== "createBillingInvoice" || !draftHydrated.current) return;
    const scheduleSave = () => {
      if (draftSaveTimer.current) clearTimeout(draftSaveTimer.current);
      draftSaveTimer.current = setTimeout(persistBillingDraft, 450);
    };
    const subscription = watch(scheduleSave);
    scheduleSave();
    window.addEventListener("beforeunload", persistBillingDraft);
    return () => {
      subscription.unsubscribe();
      if (draftSaveTimer.current) clearTimeout(draftSaveTimer.current);
      draftSaveTimer.current = null;
      window.removeEventListener("beforeunload", persistBillingDraft);
      persistBillingDraft();
    };
  }, [modal, persistBillingDraft, watch]);

  useEffect(() => {
    if (!invoiceDate) return;
    if (previousInvoiceDate.current === invoiceDate) return;
    previousInvoiceDate.current = invoiceDate;
    setValue("dueDate", addDays(invoiceDate, 30));
  }, [invoiceDate, setValue]);

  useEffect(() => {
    if (!selectedWorkOrderId) return;
    if (skipRestoredWorkOrderHydration.current === selectedWorkOrderId) {
      skipRestoredWorkOrderHydration.current = null;
      return;
    }
    const wo = activeWorkOrders.find((item: any) => item.id === selectedWorkOrderId);
    if (!wo) return;
    setValue("storeNumber", wo.store || "", { shouldDirty: true, shouldValidate: true });
    setValue("storeAddress", wo.addr || "", { shouldDirty: true });
    const storeState = stateCodeFromWorkOrder(wo);
    setValue("taxState", storeState, { shouldDirty: true });
    setValue("territory", territoryFromState(storeState), {
      shouldDirty: true,
      shouldValidate: true,
    });
    setCustomTerritory(false);
    const latestVisitClockOut = [...(wo.visits || [])]
      .filter((visit: any) => visit?.checkOutAt)
      .sort((a: any, b: any) =>
        new Date(b.checkOutAt).getTime() - new Date(a.checkOutAt).getTime(),
      )[0]?.checkOutAt;
    const clockOutDate = dateInTimeZone(
      latestVisitClockOut || wo.endTimeRaw,
      timezoneForWorkOrder(wo),
    );
    if (clockOutDate && (!isEditing || editingInvoice?.wot !== wo.id || !editingInvoice?.serviceDateRaw)) {
      setValue("serviceDate", clockOutDate, { shouldDirty: true });
    }
    clearErrors("storeNumber");
  }, [
    activeWorkOrders,
    clearErrors,
    editingInvoice?.serviceDateRaw,
    editingInvoice?.wot,
    isEditing,
    selectedWorkOrderId,
    setValue,
  ]);

  useEffect(() => {
    if (previousWorkOrderId.current === selectedWorkOrderId) return;
    previousWorkOrderId.current = selectedWorkOrderId || "";
    setSelectedSourceIds([]);
    setSourceSnapshots({});
    setValue("taxRateOverride", "", { shouldDirty: true });
    setValue("salesTaxOverride", "", { shouldDirty: true });
  }, [selectedWorkOrderId, setValue]);

  const closeKeepingDraft = () => {
    persistBillingDraft();
    onClose?.();
  };

  const discardAndClose = () => {
    if (typeof window !== "undefined") {
      try {
        removeBillingDraft(window.localStorage, draftStorageKey);
      } catch {
        // The form still closes even when browser storage is unavailable.
      }
    }
    const today = todayIso();
    draftHydrated.current = false;
    initializedFor.current = null;
    previousInvoiceDate.current = "";
    previousWorkOrderId.current = "";
    skipRestoredWorkOrderHydration.current = null;
    reset({
      num: "",
      invoiceDate: today,
      serviceDate: "",
      dueDate: addDays(today, 30),
      workOrderId: "",
      territory: "",
      storeNumber: "",
      storeAddress: "",
      terms: "Net 30",
      cme: "",
      taxState: "",
      taxRateOverride: "",
      salesTaxOverride: "",
      state: "submitted",
      lines: [],
    });
    clearErrors();
    setWoSearch("");
    setSelectedSourceIds([]);
    setSourceSnapshots({});
    setPartsMarkup("25");
    setCustomTerritory(false);
    setNumberEdited(false);
    setDraftState("idle");
    setDraftSavedAt(null);
    setDraggingLine(null);
    onClose?.();
  };

  if (modal !== "createBillingInvoice") return null;

  const toggleSourceInvoice = (invoiceId: string) => {
    const owner = sourceOwnerById.get(invoiceId);
    if (owner && owner.id !== editingInvoice?.id) return;
    setSelectedSourceIds(current => current.includes(invoiceId)
      ? current.filter(id => id !== invoiceId)
      : [...current, invoiceId]);
  };

  const pullSourceLines = async () => {
    if (selectedSourceIds.length === 0) {
      fire?.("Select at least one contractor invoice");
      return;
    }
    const partMarkupPercent = Number(partsMarkup);
    if (!Number.isFinite(partMarkupPercent) || partMarkupPercent < 0 || partMarkupPercent > 999) {
      fire?.("Parts markup must be between 0 and 999 percent");
      return;
    }
    setPullingLines(true);
    try {
      const sb = supabase();
      const { data: sessionData } = await sb.auth.getSession();
      const token = sessionData.session?.access_token;
      if (!token) throw new Error("Missing session");

      const params = new URLSearchParams({
        sourceInvoiceIds: selectedSourceIds.join(","),
      });
      const response = await fetch(`/api/billing-invoices?${params}`, {
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store",
      });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error || "Contractor invoice lines could not be loaded");
      }

      const freshInvoices = payload.invoices || [];
      setSourceSnapshots(current => ({
        ...current,
        ...Object.fromEntries(
          freshInvoices.map((invoice: any) => [invoice.id, invoice]),
        ),
      }));
      const sourceLines = freshInvoices.flatMap((invoice: any) => {
        if ((invoice.lines || []).length === 0) {
          return [{
            type: "Other",
            desc: "Contracted service",
            qty: 1,
            sourceInvoiceLineId: null,
            sourceUnitCost: Number(
              invoice.subtotal
              ?? Math.max(Number(invoice.total || 0) - Number(invoice.salesTax || 0), 0),
            ),
          }];
        }
        return invoice.lines.map((line: any) => ({
          type: normalizeStaffBillingLineType(line.type),
          desc: line.desc || line.description || "Contractor service",
          qty: Number(line.qty || 1),
          sourceInvoiceLineId: line.id || null,
          sourceUnitCost: Number(line.rate || 0),
        }));
      });

      const imported = sourceLines.map((line: any) => {
        const parts = isStaffBillingPartsLine(line.type);
        return {
          ...line,
          rate: importedStaffBillingRate(
            line.type,
            line.sourceUnitCost,
            partMarkupPercent,
          ),
          markupPercent: parts ? partMarkupPercent : null,
          isTaxable: defaultLineTaxable(line.type, line.desc),
        };
      });
      replace(imported);
      clearErrors("lines");
      setTimeout(() => void trigger("lines"), 0);
      fire?.(`Pulled ${imported.length} line item${imported.length === 1 ? "" : "s"}`);
    } catch (error: any) {
      fire?.(`Pull lines failed: ${error.message || error}`);
    } finally {
      setPullingLines(false);
    }
  };

  const submit = async (data: any, state: "draft" | "submitted") => {
    const taxableAmount = (data.lines || []).reduce(
      (sum: number, line: any) => sum + (line.isTaxable ? amount(line) : 0),
      0,
    );
    const hasManualTax = data.salesTaxOverride !== ""
      && data.salesTaxOverride != null
      && Number.isFinite(Number(data.salesTaxOverride))
      && Number(data.salesTaxOverride) >= 0;
    const hasManualTaxRate = data.taxRateOverride !== ""
      && data.taxRateOverride != null
      && Number.isFinite(Number(data.taxRateOverride))
      && Number(data.taxRateOverride) >= 0
      && Number(data.taxRateOverride) <= 100;
    if (taxableAmount > 0 && !activeTaxRate && !hasManualTax && !hasManualTaxRate) {
      fire?.(`No configured sales-tax rate for ${data.taxState || "this store state"}`);
      return;
    }
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
          taxState: String(data.taxState || "").toUpperCase(),
          sourceInvoiceIds: selectedSourceIds,
          userTypedNum: numberEdited,
        }),
      });

      const payload = await res.json();
      if (!res.ok) throw new Error(payload.error || "Billing invoice save failed");
      fire?.(`Invoice #${payload.invoice?.num || data.num} ${state === "draft" ? (isEditing ? "draft updated" : "draft saved") : "ready for 7-Eleven"}`);
      onCreated?.(payload.invoice);
      discardAndClose();
    } catch (err: any) {
      fire?.(`Billing invoice ${isEditing ? "update" : "save"} failed: ${err.message || err}`);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      onClose={closeKeepingDraft}
      title={isEditing ? `Edit invoice #${editingInvoice.num}` : "Create P1 to 7-Eleven invoice"}
      width={1240}
      closeOnBackdrop={false}
    >
      <form onSubmit={handleSubmit(data => submit(data, "submitted"))}>
        <div style={{ fontSize: 13, color: T.muted, marginBottom: 18 }}>
          {isEditing
            ? `Update this ${editingInvoice.state} invoice. Approved, paid, and QuickBooks-synced invoices stay locked.`
            : "Direction is fixed: P1 Pros bills 7-Eleven. Linking a work order is optional."}
        </div>

        <div role="status" style={{ marginTop: -10, marginBottom: 14, fontSize: 10, color: draftState === "error" ? T.danger : T.subtle }}>
          {draftState === "restored"
            ? `Restored your unsaved draft${draftSavedAt ? ` from ${new Date(draftSavedAt).toLocaleString()}` : ""}.`
            : draftState === "saved"
              ? `Draft autosaved on this device${draftSavedAt ? ` at ${new Date(draftSavedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` : ""}.`
              : draftState === "error"
                ? "Draft autosave is unavailable in this browser. Use Save as Draft before leaving."
                : "Changes autosave on this device as you work."}
        </div>

        <div className="billing-create-layout">
          <div style={{ minWidth: 0 }}>

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
          <label><span style={{ display: "block", fontSize: 11, fontWeight: 600, color: T.muted, marginBottom: 6 }}>Invoice #</span><input {...register("num", { onChange: () => setNumberEdited(true) })} title="Auto-populated, but editable until approval or QuickBooks sync" style={{ width: "100%", padding: "10px 13px", borderRadius: 10, border: `1px solid ${errors.num ? T.danger : T.border}`, background: T.surface, color: T.ink, fontSize: 13 }} />{errors.num && <span style={{ fontSize: 11, color: T.danger }}>{errors.num.message}</span>}</label>
          <label><span style={{ display: "block", fontSize: 11, fontWeight: 600, color: T.muted, marginBottom: 6 }}>Invoice date</span><input type="date" {...register("invoiceDate")} style={{ width: "100%", padding: "10px 13px", borderRadius: 10, border: `1px solid ${errors.invoiceDate ? T.danger : T.border}`, background: T.surface, color: T.ink, fontSize: 13 }} /></label>
          <label><span style={{ display: "block", fontSize: 11, fontWeight: 600, color: T.muted, marginBottom: 6 }}>Service date</span><input type="date" {...register("serviceDate")} style={{ width: "100%", padding: "10px 13px", borderRadius: 10, border: `1px solid ${T.border}`, background: T.surface, color: T.ink, fontSize: 13 }} /></label>
          <label><span style={{ display: "block", fontSize: 11, fontWeight: 600, color: T.muted, marginBottom: 6 }}>Due date</span><input type="date" {...register("dueDate")} style={{ width: "100%", padding: "10px 13px", borderRadius: 10, border: `1px solid ${T.border}`, background: T.surface, color: T.ink, fontSize: 13 }} /></label>
        </div>

        <div className="billing-form-grid" style={{ display: "grid", gridTemplateColumns: "1.2fr 0.8fr 0.8fr", gap: 10, marginBottom: 16 }}>
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
          <label>
            <span style={{ display: "block", fontSize: 11, fontWeight: 600, color: T.muted, marginBottom: 6 }}>Territory</span>
            <Sel
              value={customTerritory ? "__new__" : territory}
              onChange={(event: any) => {
                if (event.target.value === "__new__") {
                  setCustomTerritory(true);
                  setValue("territory", "", { shouldDirty: true, shouldValidate: true });
                  return;
                }
                setCustomTerritory(false);
                setValue("territory", event.target.value, {
                  shouldDirty: true,
                  shouldValidate: true,
                });
              }}
              aria-label="Invoice territory"
              style={{ width: "100%", padding: "10px 13px", borderRadius: 10, border: `1px solid ${errors.territory ? T.danger : T.border}`, background: T.surface, color: T.ink, fontSize: 13 }}
            >
              <option value="">Select territory</option>
              {KNOWN_TERRITORIES.map(item => <option key={item} value={item}>{item}</option>)}
              <option value="__new__">+ Add new territory</option>
            </Sel>
            {customTerritory ? (
              <input
                {...register("territory")}
                autoFocus
                placeholder="Territory name"
                style={{ width: "100%", marginTop: 6, padding: "8px 10px", borderRadius: 8, border: `1px solid ${errors.territory ? T.danger : T.border}`, background: T.surface, color: T.ink, fontSize: 12 }}
              />
            ) : (
              <input type="hidden" {...register("territory")} />
            )}
            {errors.territory && <span style={{ display: "block", fontSize: 11, color: T.danger, marginTop: 4 }}>{String(errors.territory.message)}</span>}
          </label>
        </div>

        {selectedWorkOrder && (
          <div role="status" style={{ padding: "11px 14px", marginBottom: 14, borderRadius: 9, border: `1px solid ${selectedWorkOrder.priority === "p1" ? `${T.warn}55` : T.borderSoft}`, background: selectedWorkOrder.priority === "p1" ? T.warnSoft : T.surfaceSoft, color: T.ink, fontSize: 12, fontWeight: 700 }}>
            Priority: {PRIORITY[selectedWorkOrder.priority]?.label || String(selectedWorkOrder.priority || "Not set")}
            {selectedWorkOrder.priority === "p1" ? " - overtime work is approved. Review the trip summary before billing." : ""}
          </div>
        )}

        {selectedWorkOrder?.priority === "p1" && (
          <div style={{ border: `1px solid ${T.borderSoft}`, borderRadius: 10, padding: 14, marginBottom: 16, background: T.surface }}>
            <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, flexWrap: "wrap", marginBottom: selectedTrips.length ? 10 : 0 }}>
              <div>
                <div style={{ fontSize: 11, fontWeight: 700, color: T.ink }}>Trip and overtime summary</div>
                <div style={{ fontSize: 11, color: T.muted, marginTop: 3 }}>
                  Store-local time ({selectedTimeZone}). Overtime is before 8:00 AM, after 5:00 PM, or weekends.
                </div>
              </div>
              {selectedTrips.length > 0 && (
                <div className="mono" style={{ display: "flex", gap: 12, fontSize: 11, flexWrap: "wrap" }}>
                  <span>{tripTotals.totalHours.toFixed(2)}h total</span>
                  <span style={{ color: T.muted }}>{tripTotals.regularHours.toFixed(2)}h regular</span>
                  <span style={{ color: tripTotals.overtimeHours > 0 ? T.warn : T.success, fontWeight: 700 }}>{tripTotals.overtimeHours.toFixed(2)}h OT</span>
                </div>
              )}
            </div>
            {selectedTrips.length === 0 ? (
              <div style={{ fontSize: 12, color: T.subtle }}>No check-in/clock-out trips have been recorded.</div>
            ) : (
              <div style={{ display: "grid", gap: 7 }}>
                {selectedTrips.map((trip: any, index: number) => (
                  <div key={trip.id || index} style={{ display: "grid", gridTemplateColumns: "48px minmax(0, 1fr) auto", gap: 10, alignItems: "center", padding: "8px 10px", borderRadius: 8, background: T.surfaceSoft, fontSize: 11 }}>
                    <strong style={{ color: T.ink }}>Trip {index + 1}</strong>
                    <span style={{ color: T.muted }}>
                      {new Date(trip.checkInAt).toLocaleString("en-US", { timeZone: selectedTimeZone, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
                      {" to "}
                      {trip.checkOutAt
                        ? new Date(trip.checkOutAt).toLocaleString("en-US", { timeZone: selectedTimeZone, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
                        : "Open"}
                    </span>
                    <span className="mono" style={{ color: trip.overtimeHours > 0 ? T.warn : T.ink, fontWeight: 700 }}>
                      {trip.regularHours.toFixed(2)}h regular / {trip.overtimeHours.toFixed(2)}h OT
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

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
                    <span style={{ display: "block", fontSize: 10, fontWeight: 700, color: T.subtle, marginBottom: 4 }}>Parts markup %</span>
                    <input type="number" min="0" max="999" step="0.1" value={partsMarkup} onChange={(e: any) => setPartsMarkup(e.target.value)} style={{ width: 92, padding: "7px 9px", borderRadius: 8, border: `1px solid ${T.border}`, background: T.surface, color: T.ink, fontSize: 12 }} />
                  </label>
                  <button type="button" disabled={pullingLines} onClick={() => void pullSourceLines()} className="btn-primary" style={{ padding: "8px 12px", fontSize: 11, opacity: pullingLines ? 0.7 : 1, display: "flex", alignItems: "center", gap: 6 }}>
                    {pullingLines ? <><BtnSpinner />Pulling...</> : "Pull lines + calculate"}
                  </button>
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
                <div><div style={{ fontSize: 9, color: T.subtle, textTransform: "uppercase", fontWeight: 700 }}>Parts markup</div><div className="mono" style={{ fontSize: 13, fontWeight: 700, color: T.accent }}>+{fmt(partsMarkupAmount)}</div></div>
                <div><div style={{ fontSize: 9, color: T.subtle, textTransform: "uppercase", fontWeight: 700 }}>P1 subtotal</div><div className="mono" style={{ fontSize: 13, fontWeight: 700 }}>{fmt(subtotal)}</div></div>
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
          <div className="billing-line-head" style={{ display: "grid", gridTemplateColumns: "28px minmax(86px, 110px) minmax(120px, 1fr) minmax(48px, 58px) minmax(64px, 82px) minmax(58px, 74px) minmax(54px, 66px) minmax(72px, 92px)", gap: 8, padding: "10px 48px 10px 12px", background: T.surfaceSoft, fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.6, color: T.subtle, borderBottom: `1px solid ${T.borderSoft}` }}>
            <div /><div>Type</div><div>Description</div><div style={{ textAlign: "right" }}>Qty</div><div style={{ textAlign: "right" }}>Rate</div><div style={{ textAlign: "right" }}>Markup</div><div style={{ textAlign: "center" }}>Taxable</div><div style={{ textAlign: "right" }}>Amount</div>
          </div>
          {fields.map((field, i) => {
            const line = lines[i] || field;
            const sourceUnitCost = line.sourceUnitCost == null
              ? null
              : Number(line.sourceUnitCost);
            const typeRegistration = register(`lines.${i}.type` as const);
            return (
              <div
                key={field.id}
                className="billing-line-row"
                onDragOver={(event: any) => event.preventDefault()}
                onDrop={(event: any) => {
                  event.preventDefault();
                  if (draggingLine != null && draggingLine !== i) move(draggingLine, i);
                  setDraggingLine(null);
                }}
                style={{ position: "relative", display: "grid", gridTemplateColumns: "28px minmax(86px, 110px) minmax(120px, 1fr) minmax(48px, 58px) minmax(64px, 82px) minmax(58px, 74px) minmax(54px, 66px) minmax(72px, 92px)", gap: 8, padding: "10px 48px 10px 12px", borderBottom: i < fields.length - 1 ? `1px solid ${T.borderSoft}` : "none", alignItems: "start", background: draggingLine === i ? T.accentSoft : T.surface }}
              >
                <input type="hidden" {...register(`lines.${i}.sourceInvoiceLineId` as const)} />
                <input
                  type="hidden"
                  {...register(`lines.${i}.sourceUnitCost` as const, {
                    setValueAs: value =>
                      value === "" || value == null ? null : Number(value),
                  })}
                />
                <button
                  type="button"
                  draggable
                  onDragStart={(event: any) => {
                    setDraggingLine(i);
                    event.dataTransfer.effectAllowed = "move";
                    event.dataTransfer.setData("text/plain", String(i));
                  }}
                  onDragEnd={() => setDraggingLine(null)}
                  title="Drag to reorder line"
                  aria-label={`Drag line ${i + 1} to reorder`}
                  style={{ width: 28, height: 34, display: "grid", placeItems: "center", padding: 0, border: "none", background: "transparent", color: T.subtle, cursor: "grab" }}
                >
                  <Ico d="M9 5h.01M9 12h.01M9 19h.01M15 5h.01M15 12h.01M15 19h.01" size={16} color="currentColor" />
                </button>
                <Sel
                  {...typeRegistration}
                  defaultValue={field.type}
                  onChange={(event: any) => {
                    void typeRegistration.onChange(event);
                    const nextType = normalizeStaffBillingLineType(event.target.value);
                    setValue(
                      `lines.${i}.isTaxable` as const,
                      defaultLineTaxable(nextType, line.desc),
                      { shouldDirty: true },
                    );
                    if (!isStaffBillingPartsLine(nextType)) {
                      setValue(`lines.${i}.markupPercent` as const, null, {
                        shouldDirty: true,
                      });
                    }
                    if (["Labor", "OT Labor", "Travel"].includes(nextType)) {
                      setValue(
                        `lines.${i}.rate` as const,
                        importedStaffBillingRate(nextType, sourceUnitCost),
                        { shouldDirty: true, shouldValidate: true },
                      );
                    } else if (
                      isStaffBillingPartsLine(nextType)
                      && sourceUnitCost != null
                    ) {
                      const markup = Number(partsMarkup);
                      setValue(
                        `lines.${i}.markupPercent` as const,
                        Number.isFinite(markup) ? markup : 25,
                        { shouldDirty: true },
                      );
                      setValue(
                        `lines.${i}.rate` as const,
                        importedStaffBillingRate(
                          nextType,
                          sourceUnitCost,
                          Number.isFinite(markup) ? markup : 25,
                        ),
                        { shouldDirty: true, shouldValidate: true },
                      );
                    }
                  }}
                  style={{ padding: "8px 10px", borderRadius: 8, border: `1px solid ${T.border}`, background: T.surface, fontSize: 12, color: T.ink }}
                >
                  {STAFF_BILLING_LINE_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                </Sel>
                <textarea {...register(`lines.${i}.desc` as const)} placeholder={/^(travel|truck charge)$/i.test(line.type || "") ? "Description (optional)" : "Description"} style={{ padding: "8px 10px", borderRadius: 8, border: `1px solid ${errors.lines?.[i]?.desc ? T.danger : T.border}`, background: T.surface, fontSize: 12, fontFamily: "inherit", color: T.ink, resize: "vertical", minHeight: 36 }} />
                <input type="number" min="0.5" step="0.5" {...register(`lines.${i}.qty` as const, { valueAsNumber: true })} style={{ padding: "8px 10px", borderRadius: 8, border: `1px solid ${errors.lines?.[i]?.qty ? T.danger : T.border}`, background: T.surface, fontSize: 12, color: T.ink, textAlign: "right" }} />
                <input type="number" step="any" {...register(`lines.${i}.rate` as const, { valueAsNumber: true })} style={{ padding: "8px 10px", borderRadius: 8, border: `1px solid ${errors.lines?.[i]?.rate ? T.danger : T.border}`, background: T.surface, fontSize: 12, color: T.ink, textAlign: "right" }} />
                {sourceUnitCost == null || !isStaffBillingPartsLine(line.type) ? (
                  <div style={{ paddingTop: 10, textAlign: "right", color: T.subtle, fontSize: 11 }}>-</div>
                ) : (
                  <label style={{ position: "relative" }}>
                    <input
                      type="number"
                      min="0"
                      max="999"
                      step="0.1"
                      value={line.markupPercent ?? ""}
                      onChange={(event: any) => {
                        const markup = Number(event.target.value);
                        setValue(
                          `lines.${i}.markupPercent` as const,
                          Number.isFinite(markup) ? markup : 0,
                          { shouldDirty: true },
                        );
                        setValue(
                          `lines.${i}.rate` as const,
                          money(sourceUnitCost * (1 + (Number.isFinite(markup) ? markup : 0) / 100)),
                          { shouldDirty: true, shouldValidate: true },
                        );
                      }}
                      aria-label={`Line ${i + 1} markup percent`}
                      style={{ width: "100%", padding: "8px 20px 8px 7px", borderRadius: 8, border: `1px solid ${T.border}`, background: T.surface, fontSize: 12, color: T.ink, textAlign: "right" }}
                    />
                    <span style={{ position: "absolute", right: 7, top: 9, color: T.subtle, fontSize: 11 }}>%</span>
                  </label>
                )}
                <label style={{ display: "flex", justifyContent: "center", paddingTop: 9 }} title="Include this line in store-state sales tax">
                  <input type="checkbox" {...register(`lines.${i}.isTaxable` as const)} aria-label={`Line ${i + 1} taxable`} />
                </label>
                <div className="mono" style={{ fontSize: 12, fontWeight: 600, color: T.ink, textAlign: "right", paddingTop: 10 }}>{fmt(Math.round(amount(line) * 100) / 100)}</div>
                <button
                  type="button"
                  className="billing-line-remove"
                  onClick={() => remove(i)}
                  title={`Delete line ${i + 1}`}
                  aria-label={`Delete line ${i + 1}`}
                  style={{ position: "absolute", top: 10, right: 10, width: 30, height: 34, display: "grid", placeItems: "center", padding: 0, borderRadius: 8, border: `1px solid ${T.danger}33`, background: T.dangerSoft, color: T.danger, cursor: "pointer", fontSize: 18, lineHeight: 1 }}
                >
                  ×
                </button>
              </div>
            );
          })}
        </div>
        {errors.lines && <div style={{ fontSize: 12, color: T.danger, fontWeight: 600, marginBottom: 10 }}>Each line needs a quantity and rate. Descriptions are optional only for travel.</div>}
        <div style={{ display: "flex", gap: 8, marginBottom: 10, flexWrap: "wrap" }}>
          {QUICK_ADD_LINES.map(item => (
            <button
              key={item.label}
              type="button"
              onClick={() => append({
                type: item.type,
                desc: item.desc,
                qty: 1,
                rate: item.rate,
                isTaxable: defaultLineTaxable(item.type, item.desc),
                sourceInvoiceLineId: null,
                sourceUnitCost: null,
                markupPercent: null,
              })}
              className="btn-soft"
              style={{ padding: "7px 12px", fontSize: 11 }}
            >
              + {item.label}{item.rate == null ? "" : ` ${fmt(item.rate)}`}
            </button>
          ))}
        </div>
        <div style={{ display: "flex", gap: 8, marginBottom: 18, flexWrap: "wrap", paddingTop: 10, borderTop: `1px solid ${T.borderSoft}` }}>
          {QUICK_ADD_PRESETS.map(preset => (
            <button
              key={preset.label}
              type="button"
              onClick={() => append({
                type: preset.type,
                desc: preset.label,
                qty: 1,
                rate: preset.rate,
                isTaxable: true,
                sourceInvoiceLineId: null,
                sourceUnitCost: null,
                markupPercent: null,
              })}
              className="btn-soft"
              style={{ padding: "7px 12px", fontSize: 11 }}
            >
              + {preset.label} {fmt(preset.rate)}
            </button>
          ))}
        </div>

        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 16, marginBottom: 18, flexWrap: "wrap" }}>
          <div style={{ flex: "1 1 360px", minWidth: 0, maxWidth: 460 }}>
            <div style={{ display: "flex", alignItems: "flex-start", gap: 12, flexWrap: "wrap" }}>
              <label>
                <span style={{ display: "block", fontSize: 11, fontWeight: 600, color: T.muted, marginBottom: 6 }}>Work state for tax</span>
                <input
                  {...register("taxState")}
                  maxLength={2}
                  placeholder="VA"
                  style={{ width: 100, padding: "8px 10px", borderRadius: 8, border: `1px solid ${T.border}`, background: T.surface, color: T.ink, fontSize: 12, textTransform: "uppercase" }}
                />
              </label>
              <label>
                <span style={{ display: "block", fontSize: 11, fontWeight: 600, color: T.muted, marginBottom: 6 }}>Tax rate (%)</span>
                <div style={{ position: "relative", width: 120 }}>
                  <input
                    type="number"
                    min="0"
                    max="100"
                    step="0.001"
                    inputMode="decimal"
                    {...register("taxRateOverride", {
                      onChange: event => {
                        if (event.target.value !== "") {
                          setValue("salesTaxOverride", "", {
                            shouldDirty: true,
                            shouldValidate: true,
                          });
                        }
                      },
                    })}
                    placeholder={configuredTaxRate == null
                      ? "0.000"
                      : (configuredTaxRate * 100).toFixed(3)}
                    aria-label="Tax rate percentage"
                    style={{ width: "100%", padding: "8px 26px 8px 10px", borderRadius: 8, border: `1px solid ${T.border}`, background: T.surface, color: T.ink, fontSize: 12 }}
                  />
                  <span aria-hidden="true" style={{ position: "absolute", right: 10, top: 8, color: T.subtle }}>%</span>
                </div>
              </label>
            </div>
            {errors.taxRateOverride && (
              <div style={{ color: T.danger, fontSize: 10, marginTop: 6 }}>
                {String(errors.taxRateOverride.message || "Enter a valid tax rate")}
              </div>
            )}
            <div style={{ fontSize: 11, color: !hasSalesTaxOverride && !hasTaxRateOverride && (taxRateLoadError || (taxableSubtotal > 0 && !activeTaxRate)) ? T.danger : T.subtle, marginTop: 6, maxWidth: 460 }}>
              {hasSalesTaxOverride
                ? "Manual tax amount is applied. Clear it to calculate tax from the percentage."
                : hasTaxRateOverride
                  ? `${Number(taxRateOverride).toFixed(3)}% manual rate. Tax applies only to checked lines.`
                  : taxRateLoadError
                    ? `${taxRateLoadError} Enter a tax rate or amount manually to continue.`
                    : activeTaxRate
                      ? `${(configuredTaxRate * 100).toFixed(3)}% configured for ${taxState}. Edit the percentage when a local rate differs.`
                      : taxableSubtotal > 0
                        ? `No active tax rate configured for ${taxState || "this state"}. Enter a tax rate or amount manually.`
                        : "Check each taxable line. Building-attached service defaults to exempt; parts default taxable."}
            </div>
          </div>
          <div style={{ width: 300, background: T.surfaceSoft, borderRadius: 12, border: `1px solid ${T.borderSoft}`, padding: "14px 16px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, marginBottom: 10 }}><span style={{ color: T.muted }}>Subtotal</span><span className="mono" style={{ color: T.ink, fontWeight: 600 }}>{fmt(Math.round(subtotal * 100) / 100)}</span></div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 13, marginBottom: 10, gap: 10 }}>
              <span style={{ color: T.muted }}>Taxable subtotal</span>
              <span className="mono" style={{ color: T.ink }}>{fmt(money(taxableSubtotal))}</span>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 13, marginBottom: 10, gap: 10 }}>
              <span style={{ color: T.muted }}>Sales tax</span>
              <span className="mono" style={{ color: T.ink, fontWeight: 600 }}>{fmt(salesTax)}</span>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 12, marginBottom: 10, gap: 10 }}>
              <span style={{ color: T.subtle }}>Manual tax amount</span>
              <label style={{ position: "relative", width: 112 }}>
                <span aria-hidden="true" style={{ position: "absolute", left: 9, top: 7, color: T.subtle }}>$</span>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  inputMode="decimal"
                  {...register("salesTaxOverride", {
                    onChange: event => {
                      if (event.target.value !== "") {
                        setValue("taxRateOverride", "", {
                          shouldDirty: true,
                          shouldValidate: true,
                        });
                      }
                    },
                  })}
                  placeholder={rateBasedSalesTax.toFixed(2)}
                  aria-label="Manual sales tax amount"
                  style={{ width: "100%", padding: "6px 8px 6px 20px", borderRadius: 7, border: `1px solid ${T.border}`, background: T.surface, color: T.ink, fontSize: 12, textAlign: "right" }}
                />
              </label>
            </div>
            <div style={{ color: T.subtle, fontSize: 10, lineHeight: 1.4, marginTop: -4, marginBottom: 10, textAlign: "right" }}>
              {hasSalesTaxOverride
                ? "Amount override"
                : hasTaxRateOverride
                  ? `${Number(taxRateOverride).toFixed(3)}% rate override`
                  : activeTaxRate
                    ? `Configured ${taxState} rate`
                    : "Enter a rate or amount"}
            </div>
            {errors.salesTaxOverride && (
              <div style={{ color: T.danger, fontSize: 10, marginTop: -4, marginBottom: 10, textAlign: "right" }}>
                {String(errors.salesTaxOverride.message || "Enter a valid tax amount")}
              </div>
            )}
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, padding: "8px 0 10px", borderTop: `1px solid ${T.borderSoft}` }}>
              <span style={{ color: T.muted }}>Profit margin (pre-tax)</span>
              <span className="mono" style={{ fontWeight: 700, color: actualMargin == null ? T.subtle : actualMargin >= 30 ? T.success : T.warn }}>
                {actualMargin == null ? "-" : `${actualMargin.toFixed(1)}%`}
              </span>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", paddingTop: 10, borderTop: `1px solid ${T.border}` }}><span style={{ fontWeight: 700, color: T.ink }}>Total</span><span className="display" style={{ fontSize: 22, color: T.ink }}>{fmt(Math.round(total * 100) / 100)}</span></div>
          </div>
        </div>
          </div>

          <div className="billing-activity-sidebar">
            <BillingWorkOrderActivityPanel
              currentUser={currentUser}
              workOrder={selectedWorkOrder}
            />
          </div>
        </div>

        <div style={{ display: "flex", gap: 8, marginTop: 18, justifyContent: "flex-end", flexWrap: "wrap" }}>
          <button type="button" onClick={discardAndClose} className="btn-soft" style={{ color: T.danger }}>Discard draft</button>
          <button type="button" onClick={closeKeepingDraft} className="btn-soft">Close</button>
          {editingInvoice?.state !== "submitted" && (
            <button type="button" disabled={submitting} onClick={handleSubmit(data => submit(data, "draft"))} className="btn-soft" style={{ display: "flex", alignItems: "center", gap: 6, opacity: submitting ? 0.7 : 1 }}>
              {submitting ? <><BtnSpinner />Saving...</> : isEditing ? "Save Draft" : "Save as Draft"}
            </button>
          )}
          <button type="submit" disabled={submitting} className="btn-accent" style={{ display: "flex", alignItems: "center", gap: 6, opacity: submitting ? 0.7 : 1 }}>
            {submitting
              ? <><BtnSpinner />{isEditing ? "Updating..." : "Submitting..."}</>
              : isEditing
                ? "Update Invoice"
                : "Submit Invoice"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
