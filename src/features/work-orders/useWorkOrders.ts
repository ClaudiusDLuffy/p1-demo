"use client";
// @ts-nocheck

import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  updateWorkOrder, insertActivity, updateInvoiceState,
  unassignWorkOrder, reassignWorkOrder, deleteActivity, deleteWorkOrder,
  uploadPhotos, removePhoto,
  insertWoPart, updateWoPart, deleteWoPart,
} from "../../lib/db";
import { T, PRIORITY, MONTHS } from "../../lib/constants";
import { supabase } from "../../lib/supabase/client";
import { WORK_ORDERS_KEY, WO_PARTS_KEY } from "./queries";
import { INVOICES_KEY } from "../invoices/queries";

const PART_STATUS_LABEL: Record<string, string> = {
  ordered: "Ordered",
  backordered: "Backordered",
  shipped: "Shipped",
  received: "Received",
};

export default function useWorkOrders({
  currentUser, USERS, workOrdersData, invoices, setInvoices, fire,
  startDateInput, startTimeInput, pauseDateInput, pauseTimeInput,
  setSelectedWO, setAiNote, setPage, isManager,
  noteText, setNoteText, SERVICE_TO_TRADES, contractorFor,
  getUser, dateNow, timeNow, fmt,
}: any) {
  const qc = useQueryClient();
  const [workOrders, setWorkOrders] = useState<any[]>(workOrdersData ?? []);
  const [loadingStates, setLoadingStates] = useState<Record<string, boolean>>({});
  const setLoading = (key: string, val: boolean) =>
    setLoadingStates(prev => ({ ...prev, [key]: val }));

  useEffect(() => {
    if (workOrdersData) setWorkOrders(workOrdersData);
  }, [workOrdersData]);

  const restoreWorkOrders = (snapshot: any) => {
    qc.setQueryData(WORK_ORDERS_KEY, snapshot);
    if (snapshot) setWorkOrders(snapshot as any[]);
  };
  const restoreInvoices = (snapshot: any) => {
    qc.setQueryData(INVOICES_KEY, snapshot);
    if (snapshot) setInvoices(snapshot as any[]);
  };
  const invalidateWorkOrders = () => {
    qc.invalidateQueries({ queryKey: WORK_ORDERS_KEY });
  };
  const invalidateBoth = () => {
    qc.invalidateQueries({ queryKey: WORK_ORDERS_KEY });
    qc.invalidateQueries({ queryKey: INVOICES_KEY });
  };

  // Local optimistic patch helper (visual update before DB confirms)
  const patchLocalWO = (id: string, patch: any, newActivity?: any) => {
    setWorkOrders(prev => prev.map(w => w.id === id ? {
      ...w,
      ...patch,
      activities: newActivity ? [newActivity, ...w.activities] : w.activities,
    } : w));
  };
  const localActivity = (text: string, type: "note" | "system" | "ai" = "system") => ({
    author: type === "system" ? "System" : currentUser.name,
    time: dateNow(),
    text,
    type,
  });

  // Wrap a DB call in a try/catch that fires a toast on failure
  const dbCall = async (fn: () => Promise<any>, errorMsg: string = "Save failed", onError?: () => void, onSettled?: () => void) => {
    try { await fn(); return true; }
    catch (e: any) { if (onError) onError(); fire(`${errorMsg}: ${e.message || e}`); return false; }
    finally { if (onSettled) onSettled(); else invalidateBoth(); }
  };

  const notifyDispatch = async (workOrderId: string, contractorId?: string | null) => {
    try {
      const sb = supabase();
      const { data } = await sb.auth.getSession();
      const token = data.session?.access_token;
      if (!token) return;

      const res = await fetch("/api/notifications/dispatch", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ workOrderId, contractorId }),
      });

      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        console.error("Dispatch notification request failed", payload.error || res.statusText);
      }
    } catch (err) {
      console.error("Dispatch notification request error", err);
    }
  };

  const doAssign = async (woId: string, contractorId: string) => {
    const c = getUser(contractorId);
    if (!c) { fire("Contractor not found"); return; }
    setLoading("assign_" + woId, true);
    try {
    const dispatchedAt = new Date().toISOString();
    const text = `Dispatched to ${c.name}${c.company ? ` (${c.company})` : ""}.`;
    const snapshot = qc.getQueryData(WORK_ORDERS_KEY);
    patchLocalWO(woId, { status: "assigned", contractor: contractorId, dispatchedAt, functionalStatus: "Dispatched" }, localActivity(text, "system"));
    fire(`Dispatched to ${c.name}`);
    const ok = await dbCall(async () => {
      await updateWorkOrder(woId, { status: "assigned", contractor: contractorId, dispatchedAt, functionalStatus: "Dispatched" });
      await insertActivity(woId, "System", text, "system");
    }, "Dispatch failed", () => restoreWorkOrders(snapshot));
    if (ok) await notifyDispatch(woId, contractorId);
    } finally {
      setLoading("assign_" + woId, false);
    }
  };

  const doUnassign = async (woId: string) => {
    setLoading("unassign_" + woId, true);
    try {
    const wo = workOrders.find(w => w.id === woId);
    const text = `Work order unassigned by ${currentUser.name}.`;
    const snapshot = qc.getQueryData(WORK_ORDERS_KEY);
    patchLocalWO(woId, { status: "unassigned", contractor: null, eta: null, dispatchedAt: null, functionalStatus: "New" }, localActivity(text, "system"));
    fire("Work order unassigned");
    await dbCall(async () => {
      await unassignWorkOrder(woId, currentUser.name);
    }, "Unassign failed", () => restoreWorkOrders(snapshot));
    } finally {
      setLoading("unassign_" + woId, false);
    }
  };

  // Soft delete. Optimistically pull the card from every view, drop the
  // detail panel, navigate home. Roll the card back if the DB write fails
  // so a failed delete is never silently swallowed.
  const doDeleteWO = async (woId: string) => {
    const wo = workOrders.find(w => w.id === woId);
    if (!wo) return;
    setLoading("deleteWO_" + woId, true);
    try {
    const snapshot = qc.getQueryData(WORK_ORDERS_KEY);
    setWorkOrders(prev => prev.filter(w => w.id !== woId));
    setSelectedWO(null);
    setAiNote(null);
    setPage(isManager ? "dashboard" : "my_jobs");
    const ok = await dbCall(async () => {
      await deleteWorkOrder(woId, currentUser.name);
    }, "Delete failed", () => restoreWorkOrders(snapshot));
    if (ok) fire(`Work order ${woId} deleted.`);
    else setWorkOrders(prev => prev.some(w => w.id === woId) ? prev : [wo, ...prev]);
    } finally {
      setLoading("deleteWO_" + woId, false);
    }
  };

  const doReassign = async (woId: string, newContractorId: string) => {
    const wo = workOrders.find(w => w.id === woId);
    const oldName = wo?.contractor ? (getUser(wo.contractor)?.name || "Unassigned") : "Unassigned";
    const newC = getUser(newContractorId);
    if (!newC) { fire("Contractor not found"); return; }
    if (wo?.contractor === newContractorId) { fire("Already assigned to that contractor"); return; }
    setLoading("reassign_" + woId, true);
    try {
    const text = `Reassigned from ${oldName} to ${newC.name} by ${currentUser.name}.`;
    const snapshot = qc.getQueryData(WORK_ORDERS_KEY);
    patchLocalWO(woId, { contractor: newContractorId, status: "assigned", functionalStatus: "Dispatched" }, localActivity(text, "system"));
    fire(`Reassigned to ${newC.name}`);
    const ok = await dbCall(async () => {
      await reassignWorkOrder(woId, newContractorId, oldName, newC.name, currentUser.name);
    }, "Reassign failed", () => restoreWorkOrders(snapshot));
    if (ok) await notifyDispatch(woId, newContractorId);
    } finally {
      setLoading("reassign_" + woId, false);
    }
  };

  const doDeleteActivity = async (woId: string, activityId: string) => {
    const snapshot = qc.getQueryData(WORK_ORDERS_KEY);
    setWorkOrders(prev => prev.map(w => w.id === woId
      ? { ...w, activities: (w.activities || []).filter((a: any) => a.id !== activityId) }
      : w));
    fire("Comment deleted");
    await dbCall(async () => {
      await deleteActivity(activityId);
    }, "Delete failed", () => restoreWorkOrders(snapshot));
  };

  // `eta` arrives as an ISO timestamp (timestamptz column). Persist the ISO
  // value but render a human-friendly version into the activity log.
  const doSetEta = async (woId: string, eta: string) => {
    setLoading("setEta_" + woId, true);
    try {
    const d = new Date(eta);
    const etaForLog = Number.isNaN(d.getTime())
      ? eta
      : d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true });
    const text = `ETA set: ${etaForLog}`;
    const snapshot = qc.getQueryData(WORK_ORDERS_KEY);
    patchLocalWO(woId, { eta }, localActivity(text, "system"));
    fire("ETA set");
    await dbCall(async () => {
      await updateWorkOrder(woId, { eta });
      await insertActivity(woId, currentUser.name, text, "system");
    }, "ETA save failed", () => restoreWorkOrders(snapshot));
    } finally {
      setLoading("setEta_" + woId, false);
    }
  };

  // Contractor records who was on the job (text snapshot). Blank clears it.
  const doSetTechnician = async (woId: string, name: string) => {
    const snapshot = qc.getQueryData(WORK_ORDERS_KEY);
    patchLocalWO(woId, { technicianOnJob: name || null });
    await dbCall(async () => {
      await updateWorkOrder(woId, { technicianOnJob: name || null });
    }, "Technician save failed", () => restoreWorkOrders(snapshot));
  };

  const doStartWork = async (woId: string, notes: string) => {
    setLoading("startWork_" + woId, true);
    try {
    const startIso = startDateInput && startTimeInput ? new Date(`${startDateInput}T${startTimeInput}`).toISOString() : new Date().toISOString();
    const text = notes || `Checked in and started work at ${timeNow()}.`;
    const snapshot = qc.getQueryData(WORK_ORDERS_KEY);
    patchLocalWO(woId, { status: "wip", functionalStatus: "Work in Progress", startTime: startIso }, localActivity(text, "note"));
    fire(`Work started · status synced to 7-Eleven`);
    await dbCall(async () => {
      await updateWorkOrder(woId, { status: "wip", functionalStatus: "Work in Progress", startTime: startIso });
      await insertActivity(woId, currentUser.name, text, "note");
    }, "Start work failed", () => restoreWorkOrders(snapshot));
    } finally {
      setLoading("startWork_" + woId, false);
    }
  };

  // partsList: optional structured rows that go into wo_parts. When present,
  // the legacy part_needed/part_eta scalars get filled from the first row so
  // historical surfaces (legacy fallback card, exports) still have something.
  const doPauseWork = async (
    woId: string,
    reason: string,
    partDesc: string,
    partNum: string,
    partEta: string,
    notes: string,
    partsList?: { description: string; partNumber?: string; qty?: number; expectedReturnDate?: string }[]
  ) => {
    setLoading("pauseWork_" + woId, true);
    try {
    const pauseIso = pauseDateInput && pauseTimeInput ? new Date(`${pauseDateInput}T${pauseTimeInput}`).toISOString() : new Date().toISOString();
    const cleanParts = (partsList || []).filter(p => (p.description || "").trim());
    // Legacy fallback fields: first structured row wins when present, else
    // fall back to the single-field inputs (preserves old API for callers
    // that haven't moved to the parts grid yet).
    const firstPart = cleanParts[0];
    const partLabel = firstPart
      ? `${firstPart.description}${firstPart.partNumber ? ` (${firstPart.partNumber})` : ""}`
      : partDesc
        ? `${partDesc}${partNum ? ` (${partNum})` : ""}`
        : null;
    const legacyEta = firstPart?.expectedReturnDate || partEta || "";
    const partsSummary = cleanParts.length > 1
      ? ` Parts needed: ${cleanParts.map(p => p.description).join(", ")}.`
      : (partLabel ? ` Part needed: ${partLabel}.` : "");
    const text = notes || `Work paused: ${reason}.${partsSummary}`;
    const updates: any = { status: "parts", functionalStatus: "Awaiting Parts", endTime: pauseIso };
    if (partLabel) updates.partNeeded = partLabel;
    if (legacyEta) updates.partEta = legacyEta;
    const snapshot = qc.getQueryData(WORK_ORDERS_KEY);
    const partsSnapshot = qc.getQueryData(WO_PARTS_KEY);
    patchLocalWO(woId, updates, localActivity(text, "note"));
    fire("Paused — awaiting parts");
    await dbCall(async () => {
      await updateWorkOrder(woId, updates);
      await insertActivity(woId, currentUser.name, text, "note");
      if (cleanParts.length) {
        const inserted: any[] = [];
        for (const p of cleanParts) {
          const row = await insertWoPart({
            workOrderId: woId,
            description: p.description.trim(),
            partNumber: (p.partNumber || "").trim(),
            qty: p.qty || 1,
            status: "ordered",
            expectedReturnDate: p.expectedReturnDate || null,
          });
          inserted.push(row);
        }
        // Optimistic cache append so the parts panel shows them instantly.
        qc.setQueryData(WO_PARTS_KEY, (prev: any) =>
          prev ? [...prev, ...inserted] : inserted
        );
        qc.invalidateQueries({ queryKey: WO_PARTS_KEY });
      }
    }, "Pause failed", () => {
      restoreWorkOrders(snapshot);
      if (partsSnapshot) qc.setQueryData(WO_PARTS_KEY, partsSnapshot);
    });
    } finally {
      setLoading("pauseWork_" + woId, false);
    }
  };

  // ── Parts list mutations ────────────────────────────────────────────────
  // Each one writes a structured activity-feed entry so the audit trail
  // captures who moved what, when. Cache-direct optimistic updates keep the
  // UI snappy; snapshot rollback on failure.
  const patchPartsCache = (mapper: (rows: any[]) => any[]) => {
    qc.setQueryData(WO_PARTS_KEY, (prev: any) =>
      Array.isArray(prev) ? mapper(prev) : prev
    );
  };

  const doAddPart = async (woId: string, part: {
    description: string;
    partNumber?: string;
    qty?: number;
    status?: "ordered" | "backordered" | "shipped" | "received";
    trackingNumber?: string;
    expectedReturnDate?: string | null;
  }) => {
    setLoading("addPart_" + woId, true);
    try {
      const snapshot = qc.getQueryData(WO_PARTS_KEY);
      const tempId = `tmp_${Date.now()}`;
      const optimistic = {
        id: tempId,
        workOrderId: woId,
        description: part.description,
        partNumber: part.partNumber || "",
        qty: part.qty || 1,
        status: part.status || "ordered",
        trackingNumber: part.trackingNumber || "",
        expectedReturnDate: part.expectedReturnDate || null,
      };
      patchPartsCache(rows => [...rows, optimistic]);
      const text = `Part added: ${part.description}${part.partNumber ? ` (${part.partNumber})` : ""}.`;
      patchLocalWO(woId, {}, localActivity(text, "note"));
      const ok = await dbCall(async () => {
        const row = await insertWoPart({ workOrderId: woId, ...part });
        patchPartsCache(rows => rows.map(r => r.id === tempId ? row : r));
        await insertActivity(woId, currentUser.name, text, "note");
      }, "Add part failed", () => {
        if (snapshot) qc.setQueryData(WO_PARTS_KEY, snapshot);
      }, () => qc.invalidateQueries({ queryKey: WO_PARTS_KEY }));
      if (ok) fire("Part added");
    } finally {
      setLoading("addPart_" + woId, false);
    }
  };

  const doUpdatePart = async (
    partId: string,
    woId: string,
    patch: {
      description?: string;
      partNumber?: string | null;
      qty?: number;
      status?: "ordered" | "backordered" | "shipped" | "received";
      trackingNumber?: string | null;
      expectedReturnDate?: string | null;
    }
  ) => {
    setLoading("updatePart_" + partId, true);
    try {
      const snapshot = qc.getQueryData(WO_PARTS_KEY);
      const existing = (snapshot as any[] | undefined)?.find(r => r.id === partId);
      patchPartsCache(rows => rows.map(r => r.id === partId ? { ...r, ...patch } : r));
      // Structured activity entry — captures the field-level change so staff
      // can audit "who moved part X to Shipped at 11:42".
      const entries: string[] = [];
      if (patch.status && existing && patch.status !== existing.status) {
        entries.push(`marked ${PART_STATUS_LABEL[patch.status] || patch.status}`);
      }
      if (patch.trackingNumber !== undefined && existing && (patch.trackingNumber || "") !== (existing.trackingNumber || "")) {
        entries.push(patch.trackingNumber ? `tracking ${patch.trackingNumber}` : "tracking cleared");
      }
      if (patch.expectedReturnDate !== undefined && existing && (patch.expectedReturnDate || null) !== (existing.expectedReturnDate || null)) {
        entries.push(patch.expectedReturnDate ? `return ${patch.expectedReturnDate}` : "return date cleared");
      }
      const label = existing ? `${existing.description}${existing.partNumber ? ` (${existing.partNumber})` : ""}` : "Part";
      const text = entries.length ? `${label}: ${entries.join(" · ")}.` : `${label} updated.`;
      if (entries.length) patchLocalWO(woId, {}, localActivity(text, "note"));
      const ok = await dbCall(async () => {
        await updateWoPart(partId, patch);
        if (entries.length) await insertActivity(woId, currentUser.name, text, "note");
      }, "Part update failed", () => {
        if (snapshot) qc.setQueryData(WO_PARTS_KEY, snapshot);
      }, () => qc.invalidateQueries({ queryKey: WO_PARTS_KEY }));
      if (ok && entries.length) fire("Part updated");
    } finally {
      setLoading("updatePart_" + partId, false);
    }
  };

  const doDeletePart = async (partId: string, woId: string) => {
    setLoading("deletePart_" + partId, true);
    try {
      const snapshot = qc.getQueryData(WO_PARTS_KEY);
      const existing = (snapshot as any[] | undefined)?.find(r => r.id === partId);
      patchPartsCache(rows => rows.filter(r => r.id !== partId));
      const text = existing ? `Part removed: ${existing.description}.` : "Part removed.";
      patchLocalWO(woId, {}, localActivity(text, "note"));
      const ok = await dbCall(async () => {
        await deleteWoPart(partId);
        await insertActivity(woId, currentUser.name, text, "note");
      }, "Remove part failed", () => {
        if (snapshot) qc.setQueryData(WO_PARTS_KEY, snapshot);
      }, () => qc.invalidateQueries({ queryKey: WO_PARTS_KEY }));
      if (ok) fire("Part removed");
    } finally {
      setLoading("deletePart_" + partId, false);
    }
  };

  const doCloseComplete = async (woId: string, make: string, model: string, serial: string, resolution: string, assetYear?: number | null, completedAt?: string) => {
    setLoading("closeComplete_" + woId, true);
    try {
    const endIso = completedAt || new Date().toISOString();
    const text = `Job completed. Asset: ${[make, model].filter(Boolean).join(" ")} / ${serial}. Resolution: ${resolution || "Repaired"}.`;
    const patch: any = { status: "completed", functionalStatus: "Completed", assetMake: make, assetModel: model, assetSerial: serial, endTime: endIso, resolutionCode: resolution || null };
    if (assetYear) patch.assetYear = assetYear;
    const snapshot = qc.getQueryData(WORK_ORDERS_KEY);
    patchLocalWO(woId, patch, localActivity(text, "note"));
    fire("Completed");
    await dbCall(async () => {
      await updateWorkOrder(woId, patch);
      await insertActivity(woId, currentUser.name, text, "note");
    }, "Close failed", () => restoreWorkOrders(snapshot));
    } finally {
      setLoading("closeComplete_" + woId, false);
    }
  };

  const doMoveToInvoice = async (woId: string) => {
    setLoading("moveToInvoice_" + woId, true);
    try {
    const text = "7-Eleven portal updated. Moved to pending invoice.";
    const snapshot = qc.getQueryData(WORK_ORDERS_KEY);
    patchLocalWO(woId, { status: "pending_invoice" }, localActivity(text, "system"));
    fire("Moved to Pending Invoice");
    await dbCall(async () => {
      await updateWorkOrder(woId, { status: "pending_invoice" });
      await insertActivity(woId, "System", text, "system");
    }, "Update failed", () => restoreWorkOrders(snapshot));
    } finally {
      setLoading("moveToInvoice_" + woId, false);
    }
  };

  // Multi-invoice rule (billing team, revised 2026-06-15):
  // - WO advances to pending_payment when every non-draft, non-rejected
  //   invoice is approved or paid (drafts + rejected ignored).
  // - Paying invoices NEVER closes the WO. Capital jobs run for weeks with
  //   the contractor sending more invoices as work continues; a person
  //   decides when the job is actually done (manual "Close work order"
  //   button below). This helper therefore never returns "closed".
  // - When no live invoices exist, returns null so the WO is left alone.
  const computeWoStatusFromInvoices = (woId: string, override?: any[]) => {
    const list = (override ?? invoices).filter((i: any) => i.wot === woId && i.state !== "draft" && i.state !== "rejected");
    if (list.length === 0) return null;
    if (list.every((i: any) => i.state === "approved" || i.state === "paid")) return "pending_payment";
    return "pending_approval";
  };

  // Per-invoice approve. Flips one invoice to 'approved' and then recomputes
  // the WO status across siblings. WO does not advance until ALL non-draft,
  // non-rejected invoices are approved/paid (billing team's expectation).
  // computeWoStatusFromInvoices never returns "closed" (capital-job rule),
  // so the closing branches are gone.
  const doApproveInvoice = async (invoiceId: string) => {
    setLoading("approveInvoice_" + invoiceId, true);
    try {
    const inv = invoices.find((i: any) => i.id === invoiceId);
    if (!inv) { fire("Invoice not found"); return; }
    const woSnapshot = qc.getQueryData(WORK_ORDERS_KEY);
    const invSnapshot = qc.getQueryData(INVOICES_KEY);
    const nextInvoices = invoices.map((i: any) => i.id === invoiceId ? { ...i, state: "approved" } : i);
    const nextWoStatus = computeWoStatusFromInvoices(inv.wot, nextInvoices);
    const woText = nextWoStatus === "pending_payment"
      ? `All invoices on this work order are approved — moved to Pending Payment.`
      : null;
    setInvoices(nextInvoices);
    const localUpdates: any = {};
    if (nextWoStatus) localUpdates.status = nextWoStatus;
    patchLocalWO(inv.wot, localUpdates, localActivity(`Invoice #${inv.num} approved on behalf of AFM by ${currentUser.name}.`, "system"));
    if (woText) patchLocalWO(inv.wot, {}, localActivity(woText, "system"));
    fire(nextWoStatus === "pending_payment" ? "All invoices approved — Pending Payment" : `Invoice #${inv.num} approved`);
    await dbCall(async () => {
      await updateInvoiceState(inv.num, "approved");
      await insertActivity(inv.wot, currentUser.name, `Invoice #${inv.num} approved on behalf of AFM by ${currentUser.name}.`, "system");
      if (nextWoStatus) {
        await updateWorkOrder(inv.wot, { status: nextWoStatus });
        if (woText) await insertActivity(inv.wot, "System", woText, "system");
      }
    }, "Approval failed", () => {
      restoreWorkOrders(woSnapshot);
      restoreInvoices(invSnapshot);
    });
    } finally {
      setLoading("approveInvoice_" + invoiceId, false);
    }
  };

  // Per-invoice mark paid. Flips the one invoice to 'paid' and recomputes WO
  // status. The WO is NEVER auto-closed here — capital jobs receive
  // additional invoices for weeks after payments start landing, so closing
  // is an explicit staff decision via doCloseWO below.
  const doMarkPaid = async (invoiceId: string) => {
    setLoading("markPaid_" + invoiceId, true);
    try {
    const inv = invoices.find((i: any) => i.id === invoiceId);
    if (!inv) { fire("Invoice not found"); return; }
    const paidAt = new Date().toISOString();
    const nextInvoices = invoices.map((i: any) => i.id === invoiceId ? { ...i, state: "paid" } : i);
    const nextWoStatus = computeWoStatusFromInvoices(inv.wot, nextInvoices);
    const woSnapshot = qc.getQueryData(WORK_ORDERS_KEY);
    const invSnapshot = qc.getQueryData(INVOICES_KEY);
    setInvoices(nextInvoices);
    const localPatch: any = {};
    if (nextWoStatus) localPatch.status = nextWoStatus;
    patchLocalWO(inv.wot, localPatch, localActivity(`Invoice #${inv.num} marked paid by ${currentUser.name}.`, "system"));
    fire(`Invoice #${inv.num} marked paid`);
    await dbCall(async () => {
      await updateInvoiceState(inv.num, "paid", { paid_at: paidAt });
      await insertActivity(inv.wot, currentUser.name, `Invoice #${inv.num} marked paid by ${currentUser.name}.`, "system");
      if (nextWoStatus) {
        await updateWorkOrder(inv.wot, { status: nextWoStatus });
      }
    }, "Mark paid failed", () => {
      restoreWorkOrders(woSnapshot);
      restoreInvoices(invSnapshot);
    });
    } finally {
      setLoading("markPaid_" + invoiceId, false);
    }
  };

  // Staff-only: explicit "this job is done" decision. Stamps closed_at,
  // clears the NTE flag, drops the WO into the 24h linger / History
  // bucket. Independent of invoice payment state — capital jobs can be
  // closed with unpaid invoices and vice versa; staff judgement decides.
  const doCloseWO = async (woId: string) => {
    setLoading("closeWO_" + woId, true);
    try {
    const closedAt = new Date().toISOString();
    const text = `Work order closed by ${currentUser.name}.`;
    const woSnapshot = qc.getQueryData(WORK_ORDERS_KEY);
    patchLocalWO(woId, { status: "closed", closedAt, nteFlagged: false }, localActivity(text, "system"));
    fire("Work order closed");
    await dbCall(async () => {
      await updateWorkOrder(woId, { status: "closed", closedAt, nteFlagged: false });
      await insertActivity(woId, currentUser.name, text, "system");
    }, "Close failed", () => restoreWorkOrders(woSnapshot));
    } finally {
      setLoading("closeWO_" + woId, false);
    }
  };

  // Staff-only fail-safe: pull a closed WO back onto the active board by
  // pulling it back onto the active board. Now that closing is a manual
  // staff decision (not "all invoices paid"), reopening does NOT touch
  // invoice states — a closed WO can have any mix (paid, approved,
  // submitted, none). We just clear closed_at and recompute WO status from
  // whatever invoices currently exist; defaults to pending_payment when
  // there are none, matching the pre-close convention.
  const doReopen = async (woId: string) => {
    setLoading("reopen_" + woId, true);
    try {
    const nextWoStatus = computeWoStatusFromInvoices(woId, invoices) || "pending_payment";
    const text = `Work order reopened by ${currentUser.name}.`;
    const woSnapshot = qc.getQueryData(WORK_ORDERS_KEY);
    patchLocalWO(woId, { status: nextWoStatus, closedAt: null }, localActivity(text, "system"));
    fire("Work order reopened — back on the active board");
    await dbCall(async () => {
      await updateWorkOrder(woId, { status: nextWoStatus, closedAt: null });
      await insertActivity(woId, currentUser.name, text, "system");
    }, "Reopen failed", () => restoreWorkOrders(woSnapshot));
    } finally {
      setLoading("reopen_" + woId, false);
    }
  };

  // Staff-only edit of WO header fields. Patches only the fields that
  // actually changed (caller computes the diff). Each change writes its own
  // human-readable activity-log entry (one entry per changed field) so the
  // audit trail is scannable. Priority changes also recompute response +
  // resolution breach timestamps via computeSlaBreaches — otherwise the SLA
  // badge keeps showing the old deadline against the new priority.
  const doEditWorkOrder = async (
    woId: string,
    patch: Record<string, any>,
    activityEntries: string[],
  ) => {
    if (Object.keys(patch).length === 0) return true;
    setLoading("editWO_" + woId, true);
    const snapshot = qc.getQueryData(WORK_ORDERS_KEY);
    try {
      // Optimistically patch the local copy + write a single grouped activity
      // entry per field. The grouped local entries match what we'll write to
      // the DB so the user sees the audit trail immediately.
      const compoundLocal = activityEntries.map((t: string) => localActivity(t, "system"));
      // patchLocalWO appends ONE activity per call — fold in sequence.
      compoundLocal.forEach((act, i) => {
        // Only the first call carries the patch; subsequent calls just append
        // their activity entries.
        patchLocalWO(woId, i === 0 ? patch : {}, act);
      });
      fire(activityEntries.length === 1 ? activityEntries[0] : `Work order updated (${activityEntries.length} changes)`);
      const ok = await dbCall(async () => {
        await updateWorkOrder(woId, patch);
        for (const t of activityEntries) {
          await insertActivity(woId, currentUser.name, t, "system");
        }
      }, "Edit failed", () => restoreWorkOrders(snapshot));
      return !!ok;
    } finally {
      setLoading("editWO_" + woId, false);
    }
  };

  // Manager-side NTE override. Soft cap — no hard stop, contractors can still
  // submit invoices that exceed it (per Jeremy's May 1 directive).
  const doEditNte = async (woId: string, newNte: number, prevNte: number) => {
    const text = `NTE updated by ${currentUser.name}: ${fmt(prevNte)} → ${fmt(newNte)}.`;
    const snapshot = qc.getQueryData(WORK_ORDERS_KEY);
    patchLocalWO(woId, { nte: newNte }, localActivity(text, "system"));
    fire(`NTE set to ${fmt(newNte)}`);
    await dbCall(async () => {
      await updateWorkOrder(woId, { nte: newNte });
      await insertActivity(woId, currentUser.name, text, "system");
    }, "NTE save failed", () => restoreWorkOrders(snapshot));
  };

  // Edit the per-WO NTE early-warning threshold (staff only). If the WO is
  // already flagged and the new threshold is now above current spend, clear
  // the flag so the review queue stays accurate.
  const doEditNteFlag = async (woId: string, newThreshold: number, prevThreshold: number) => {
    const wo = workOrders.find(w => w.id === woId);
    const spend = invoices.reduce((s, i) => i.wot === woId && i.state !== "draft" ? s + (i.total || 0) : s, 0);
    const stillFlagged = spend >= newThreshold;
    const text = `NTE flag threshold updated by ${currentUser.name}: ${fmt(prevThreshold)} → ${fmt(newThreshold)}.`;
    const snapshot = qc.getQueryData(WORK_ORDERS_KEY);
    patchLocalWO(woId, { nteFlagThreshold: newThreshold, nteFlagged: stillFlagged, nteFlagAmount: stillFlagged ? (wo?.nteFlagAmount ?? spend) : null }, localActivity(text, "system"));
    fire(`NTE flag set to ${fmt(newThreshold)}`);
    await dbCall(async () => {
      await updateWorkOrder(woId, { nteFlagThreshold: newThreshold, nteFlagged: stillFlagged, nteFlagAmount: stillFlagged ? (wo?.nteFlagAmount ?? spend) : null });
      await insertActivity(woId, currentUser.name, text, "system");
    }, "NTE flag save failed", () => restoreWorkOrders(snapshot));
  };

  const doCapitalFlag = async (
    woId: string,
    extras?: {
      repairQuote?: number
      installQuote?: number
      assetYear?: number
      capitalNotes?: string
    }
  ) => {
    setLoading("capitalFlag_" + woId, true);
    try {
    const text = "Flagged as capital replacement — pending approval.";
    const patch = {
      status: "capital",
      functionalStatus: "Pending Capital Approval",
      capitalStatus: "Pending approval",
      isCapital: true,
      ...(extras?.repairQuote && { repairQuote: extras.repairQuote }),
      ...(extras?.installQuote && { installQuote: extras.installQuote }),
      ...(extras?.assetYear && { assetYear: extras.assetYear }),
      ...(extras?.capitalNotes && { capitalNotes: extras.capitalNotes }),
    };
    const snapshot = qc.getQueryData(WORK_ORDERS_KEY);
    patchLocalWO(woId, patch, localActivity(text, "system"));
    fire("Flagged for capital");
    await dbCall(async () => {
      await updateWorkOrder(woId, patch);
      await insertActivity(woId, "System", text, "system");
    }, "Capital flag failed", () => restoreWorkOrders(snapshot));
    } finally {
      setLoading("capitalFlag_" + woId, false);
    }
  };

  const doCapitalDecline = async (woId: string) => {
    setLoading("capitalDecline_" + woId, true);
    try {
    const text = `Capital replacement declined by ${currentUser.name}. Work order returned to dispatched.`;
    const patch = {
      status: "assigned",
      functionalStatus: "Dispatched",
      isCapital: false,
      capitalStatus: null,
    };
    const snapshot = qc.getQueryData(WORK_ORDERS_KEY);
    patchLocalWO(woId, patch, localActivity(text, "system"));
    fire("Capital declined - returned to dispatched");
    await dbCall(async () => {
      await updateWorkOrder(woId, patch);
      await insertActivity(woId, currentUser.name, text, "system");
    }, "Capital decline failed", () => restoreWorkOrders(snapshot));
    } finally {
      setLoading("capitalDecline_" + woId, false);
    }
  };


  const doAutoAssign = async () => {
    const unassigned = workOrders.filter(w => w.status === "unassigned");
    if (unassigned.length === 0) { fire("No unassigned calls"); return; }
    let count = 0, skipped = 0;
    const dispatchedAt = new Date().toISOString();
    const snapshot = qc.getQueryData(WORK_ORDERS_KEY);
    let hadError = false;
    const ops = unassigned.map(async w => {
      const trades = SERVICE_TO_TRADES(w.businessService || "", w.category || "");
      const matched = contractorFor(w.city, trades, USERS);
      if (!matched) { skipped++; return; }
      const c = getUser(matched);
      const text = `Auto-dispatched to ${c?.name || matched}. Territory + trade match.`;
      patchLocalWO(w.id, { status: "assigned", contractor: matched, functionalStatus: "Dispatched", dispatchedAt }, localActivity(text, "system"));
      try {
        await updateWorkOrder(w.id, { status: "assigned", contractor: matched, functionalStatus: "Dispatched", dispatchedAt });
        await insertActivity(w.id, "System", text, "system");
        await notifyDispatch(w.id, matched);
        count++;
      } catch (e: any) {
        hadError = true;
        restoreWorkOrders(snapshot);
        fire(`${w.id}: ${e.message || e}`);
      }
    });
    await Promise.all(ops);
    invalidateBoth();
    if (hadError) return;
    fire(skipped > 0 ? `Auto-dispatched ${count} · ${skipped} need manual assignment` : `Auto-dispatched ${count} call${count !== 1 ? "s" : ""}`);
  };

  const doPostNote = async (woId: string) => {
    const text = noteText.trim();
    if (!text) return;
    setLoading("postNote_" + woId, true);
    try {
    const snapshot = qc.getQueryData(WORK_ORDERS_KEY);
    setNoteText("");
    setWorkOrders(prev => prev.map(w => w.id === woId ? { ...w, activities: [{ author: currentUser.name, time: dateNow(), text, type: "note" }, ...w.activities] } : w));
    fire("Note posted");
    await dbCall(async () => {
      await insertActivity(woId, currentUser.name, text, "note");
    }, "Note save failed", () => restoreWorkOrders(snapshot));
    } finally {
      setLoading("postNote_" + woId, false);
    }
  };


  const doAddPhotos = async (woId: string, files: FileList | null) => {
    if (!files || files.length === 0) return;
    setLoading("addPhotos_" + woId, true);
    const limited = Array.from(files).slice(0, 8);
    const snapshot = qc.getQueryData(WORK_ORDERS_KEY);
    fire(`Uploading ${limited.length} photo${limited.length > 1 ? "s" : ""}...`);
    try {
      const paths = await uploadPhotos(woId, limited, currentUser.name);
      const text = `Added ${paths.length} photo${paths.length > 1 ? "s" : ""}.`;
      qc.setQueryData(WORK_ORDERS_KEY, (old: any[]) =>
        old?.map(w => w.id === woId
          ? { ...w, photos: [...(w.photos || []), ...paths] }
          : w)
      );
      setWorkOrders(prev => prev.map(w => w.id === woId ? {
        ...w,
        photos: [...(w.photos || []), ...paths],
        activities: [{ author: currentUser.name, time: dateNow(), text, type: "note" }, ...w.activities],
      } : w));
      fire(`${paths.length} photo${paths.length > 1 ? "s" : ""} uploaded`);
    } catch (e: any) {
      restoreWorkOrders(snapshot);
      fire(`Photo upload failed: ${e.message || e}`);
    } finally {
      invalidateBoth();
      setLoading("addPhotos_" + woId, false);
    }
  };

  const doRemovePhoto = async (woId: string, photo: number | string) => {
    setLoading("removePhoto_" + woId, true);
    try {
    const wo = workOrders.find(w => w.id === woId);
    const path = typeof photo === "number" ? wo?.photos?.[photo] : photo;
    let storagePath: string | null = null;
    if (path && !path.startsWith("data:") && !path.startsWith("http")) {
      storagePath = path;
    } else if (path?.startsWith("http")) {
      // Extract storage path from signed URL if possible
      const match = path.match(/\/photos\/(.+?)\?/);
      if (match) storagePath = decodeURIComponent(match[1]);
    }
    if (!storagePath) {
      fire("Photo cleanup failed: storage path could not be resolved");
      return;
    }
    const snapshot = qc.getQueryData(WORK_ORDERS_KEY);
    const result = await removePhoto(woId, storagePath);
    if (!result.success) {
      restoreWorkOrders(snapshot);
      invalidateBoth();
      fire(`Photo cleanup failed: ${(result.error as any)?.message || result.error}`);
      return;
    }
    qc.setQueryData(WORK_ORDERS_KEY, (old: any[]) =>
      old?.map(w => w.id === woId
        ? { ...w, photos: (w.photos || []).filter((p: string, i: number) => typeof photo === "number" ? i !== photo : p !== photo) }
        : w)
    );
    setWorkOrders(prev => prev.map(w => w.id === woId ? { ...w, photos: (w.photos || []).filter((p: string, i: number) => typeof photo === "number" ? i !== photo : p !== photo) } : w));
    invalidateBoth();
    fire("Photo removed");
    } finally {
      setLoading("removePhoto_" + woId, false);
    }
  };



  return {
    workOrders, setWorkOrders,
    loadingStates,
    patchLocalWO, localActivity, dbCall,
    doAssign, doUnassign, doDeleteWO, doReassign,
    doStartWork, doPauseWork, doCloseComplete,
    doMoveToInvoice, doApproveInvoice, doMarkPaid, doCloseWO, doReopen,
    doEditWorkOrder, doEditNte, doEditNteFlag, doCapitalFlag, doCapitalDecline, doAutoAssign,
    doSetEta, doSetTechnician, doPostNote, doDeleteActivity,
    doAddPhotos, doRemovePhoto,
    doAddPart, doUpdatePart, doDeletePart,
  };
}
