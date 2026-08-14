"use client";
// @ts-nocheck

import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  updateWorkOrder, insertActivity, updateInvoiceState,
  unassignWorkOrder, reassignWorkOrder, deleteActivity, deleteWorkOrder,
  uploadPhotos, removePhoto,
  insertWoPart, updateWoPart, deleteWoPart,
  requestP1PartOrder, setP1PartOrderStatus,
  markActivitySevenElevenSynced,
  markActivityContractorAttention, acknowledgeContractorAttention,
  openWorkOrderVisit, closeWorkOrderVisit, completeWorkOrderOnce,
  moveWorkOrderStraightToBilling,
  resumeCapitalWork,
  closeWorkOrderWithoutInvoice,
  assignContractorTechnician,
  reviewContractorInvoice,
} from "../../lib/db";
import { T, PRIORITY, MONTHS } from "../../lib/constants";
import {
  stateCodeFromWorkOrder,
  storeLocalDateTimeToIso,
  timezoneForWorkOrder,
} from "../../lib/billingRules";
import { supabase } from "../../lib/supabase/client";
import { WORK_ORDERS_KEY, WO_PARTS_KEY } from "./queries";
import { INVOICES_KEY } from "../invoices/queries";
import { contractorInvoiceWorkOrderStatus } from "../../lib/contractorInvoiceReview";

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
  getUser, dateNow, fmt,
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
  const workflowAuditFor = (
    woId: string,
    eventKey?: string,
    eventData?: import("../../lib/supabase/database.types").Json,
  ) => ({
    staffOverride: !!isManager,
    overrideForContractorId: isManager
      ? workOrders.find(w => w.id === woId)?.contractor || null
      : null,
    eventKey,
    eventData,
  });
  const localActivity = (
    text: string,
    type: "note" | "system" | "ai" = "system",
    staffOverride = false,
    eventKey?: string,
    requiresSevenElevenSync = false,
    staffOnly = false,
  ) => ({
    author: type === "system" ? "System" : currentUser.name,
    time: dateNow(),
    text,
    type,
    enteredByRole: currentUser?.role || "system",
    isStaffOverride: staffOverride,
    isStaffOnly: staffOnly,
    overrideForContractorId: null,
    eventKey: eventKey || (type === "system" ? "system" : "note"),
    eventData: {},
    requiresSevenElevenSync,
    syncedToSevenElevenAt: null,
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
    patchLocalWO(
      woId,
      { status: "assigned", contractor: contractorId, dispatchedAt, functionalStatus: "Dispatched" },
      localActivity(text, "system", false, "work_order_assignment", false, true),
    );
    fire(`Dispatched to ${c.name}`);
    const ok = await dbCall(async () => {
      await updateWorkOrder(woId, { status: "assigned", contractor: contractorId, dispatchedAt, functionalStatus: "Dispatched" });
      await insertActivity(woId, "System", text, "system", {
        staffOnly: true,
        eventKey: "work_order_assignment",
      });
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
    patchLocalWO(
      woId,
      { status: "unassigned", contractor: null, eta: null, dispatchedAt: null, functionalStatus: "New" },
      localActivity(text, "system", false, "work_order_unassigned", false, true),
    );
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
    patchLocalWO(
      woId,
      {
        contractor: newContractorId,
        status: "assigned",
        functionalStatus: "Dispatched",
        dispatchedAt: new Date().toISOString(),
        eta: null,
        startTime: null,
        startTimeRaw: null,
        endTime: null,
        endTimeRaw: null,
        technicianOnJob: null,
        assetMake: null,
        assetModel: null,
        assetSerial: null,
        assetYear: null,
        resolutionCode: null,
        resolutionNotes: null,
        partNeeded: null,
        partEta: null,
        invoiceTotal: null,
        repairQuote: null,
        installQuote: null,
        capitalNotes: null,
        isCapital: false,
        capitalStatus: null,
      },
      localActivity(text, "system", false, "work_order_reassigned", false, true),
    );
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
    patchLocalWO(woId, { eta }, localActivity(text, "system", isManager));
    fire("ETA set");
    await dbCall(async () => {
      await updateWorkOrder(woId, { eta });
      await insertActivity(woId, currentUser.name, text, "system", workflowAuditFor(woId, "eta_updated", { eta }));
    }, "ETA save failed", () => restoreWorkOrders(snapshot));
    } finally {
      setLoading("setEta_" + woId, false);
    }
  };

  // Contractor records who was on the job (text snapshot). Blank clears it.
  const doSetTechnician = async (woId: string, name: string) => {
    const snapshot = qc.getQueryData(WORK_ORDERS_KEY);
    const text = name ? `Technician on job set to ${name}.` : "Technician on job cleared.";
    patchLocalWO(woId, { technicianOnJob: name || null }, localActivity(text, "note", isManager));
    await dbCall(async () => {
      await updateWorkOrder(woId, { technicianOnJob: name || null });
      await insertActivity(woId, currentUser.name, text, "note", workflowAuditFor(woId, "technician_updated", { technician: name || null }));
    }, "Technician save failed", () => restoreWorkOrders(snapshot));
  };

  // Portal-backed technician assignment controls both the display snapshot
  // and the technician login's work-order access. The database RPC validates
  // company membership and writes the audit/history record atomically.
  const doAssignPortalTechnician = async (
    woId: string,
    profileId: string | null,
    name: string | null,
  ) => {
    const snapshot = qc.getQueryData(WORK_ORDERS_KEY);
    const text = name ? `Technician on job set to ${name}.` : "Technician assignment cleared.";
    patchLocalWO(
      woId,
      {
        technicianOnJob: name || null,
        assignedTechnicianProfileId: profileId,
      },
      localActivity(text, "note", isManager, "technician_updated"),
    );
    await dbCall(async () => {
      await assignContractorTechnician(woId, profileId);
    }, "Technician assignment failed", () => restoreWorkOrders(snapshot));
  };

  const doStartWork = async (woId: string, notes: string) => {
    setLoading("startWork_" + woId, true);
    try {
    const existing = workOrders.find(w => w.id === woId);
    const timeZone = timezoneForWorkOrder(existing);
    const requestedStartIso = startDateInput && startTimeInput
      ? storeLocalDateTimeToIso(startDateInput, startTimeInput, timeZone)
      : new Date().toISOString();
    const firstStartIso = existing?.startTimeRaw || requestedStartIso;
    const formattedStart = new Date(requestedStartIso).toLocaleString("en-US", {
      timeZone,
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
    const text = `Checked in and started work at ${formattedStart}.${notes.trim() ? ` Notes: ${notes.trim()}` : ""}`;
    const patch: any = { status: "wip", functionalStatus: "Work in Progress" };
    if (!existing?.startTimeRaw) {
      patch.startTime = formattedStart;
      patch.startTimeRaw = firstStartIso;
    }
    const snapshot = qc.getQueryData(WORK_ORDERS_KEY);
    patchLocalWO(woId, patch, localActivity(text, "note", isManager, "check_in", true));
    fire("Work started · 7-Eleven update pending");
    await dbCall(async () => {
      const dbPatch: any = { status: "wip", functionalStatus: "Work in Progress" };
      if (!existing?.startTimeRaw) dbPatch.startTime = firstStartIso;
      await updateWorkOrder(woId, dbPatch);
      await openWorkOrderVisit(woId, requestedStartIso);
      await insertActivity(woId, currentUser.name, text, "note", workflowAuditFor(woId, "check_in", { checkedInAt: requestedStartIso, notes: notes.trim() || null }));
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
    const existing = workOrders.find(w => w.id === woId);
    const timeZone = timezoneForWorkOrder(existing);
    const pauseIso = pauseDateInput && pauseTimeInput
      ? storeLocalDateTimeToIso(pauseDateInput, pauseTimeInput, timeZone)
      : new Date().toISOString();
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
    const formattedPause = new Date(pauseIso).toLocaleString("en-US", {
      timeZone,
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
    const text = `Work paused at ${formattedPause}: ${reason}.${partsSummary}${notes.trim() ? ` Notes: ${notes.trim()}` : ""}`;
    const updates: any = { status: "parts", functionalStatus: "Awaiting Parts" };
    if (partLabel) updates.partNeeded = partLabel;
    if (legacyEta) updates.partEta = legacyEta;
    const snapshot = qc.getQueryData(WORK_ORDERS_KEY);
    const partsSnapshot = qc.getQueryData(WO_PARTS_KEY);
    patchLocalWO(woId, updates, localActivity(text, "note", isManager));
    fire("Paused — awaiting parts");
    await dbCall(async () => {
      await updateWorkOrder(woId, updates);
      await closeWorkOrderVisit(woId, pauseIso);
      await insertActivity(woId, currentUser.name, text, "note", workflowAuditFor(woId, "job_paused", { pausedAt: pauseIso, reason, notes: notes || null }));
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
      patchLocalWO(woId, {}, localActivity(text, "note", isManager));
      const ok = await dbCall(async () => {
        const row = await insertWoPart({ workOrderId: woId, ...part });
        patchPartsCache(rows => rows.map(r => r.id === tempId ? row : r));
        await insertActivity(woId, currentUser.name, text, "note", workflowAuditFor(woId, "part_added", { partId: row.id, description: part.description }));
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
      if (entries.length) patchLocalWO(woId, {}, localActivity(text, "note", isManager));
      const ok = await dbCall(async () => {
        await updateWoPart(partId, patch);
        if (entries.length) await insertActivity(woId, currentUser.name, text, "note", workflowAuditFor(woId, "part_updated", { partId, changes: patch }));
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
      patchLocalWO(woId, {}, localActivity(text, "note", isManager));
      const ok = await dbCall(async () => {
        await deleteWoPart(partId);
        await insertActivity(woId, currentUser.name, text, "note", workflowAuditFor(woId, "part_removed", { partId }));
      }, "Remove part failed", () => {
        if (snapshot) qc.setQueryData(WO_PARTS_KEY, snapshot);
      }, () => qc.invalidateQueries({ queryKey: WO_PARTS_KEY }));
      if (ok) fire("Part removed");
    } finally {
      setLoading("deletePart_" + partId, false);
    }
  };

  const doRequestP1PartOrder = async (partId: string) => {
    setLoading("p1Part_" + partId, true);
    try {
      const updated = await requestP1PartOrder(partId);
      patchPartsCache(rows => rows.map(row => row.id === partId ? updated : row));
      await Promise.all([
        qc.invalidateQueries({ queryKey: WO_PARTS_KEY }),
        qc.invalidateQueries({ queryKey: WORK_ORDERS_KEY }),
      ]);
      fire("Added to P1 purchasing");
      return true;
    } catch (error: any) {
      fire(`P1 purchasing request failed: ${error.message || error}`);
      return false;
    } finally {
      setLoading("p1Part_" + partId, false);
    }
  };

  const doSetP1PartOrderStatus = async (
    partId: string,
    status: "requested" | "ordered" | "received" | "cancelled",
  ) => {
    setLoading("p1Part_" + partId, true);
    try {
      const updated = await setP1PartOrderStatus(partId, status);
      patchPartsCache(rows => rows.map(row => row.id === partId ? updated : row));
      await Promise.all([
        qc.invalidateQueries({ queryKey: WO_PARTS_KEY }),
        qc.invalidateQueries({ queryKey: WORK_ORDERS_KEY }),
      ]);
      fire(`P1 purchasing marked ${status}`);
      return true;
    } catch (error: any) {
      fire(`P1 purchasing update failed: ${error.message || error}`);
      return false;
    } finally {
      setLoading("p1Part_" + partId, false);
    }
  };

  const doCloseComplete = async (woId: string, make: string, model: string, serial: string, resolution: string, assetYear?: number | null, completedAt?: string, resolutionNotes?: string) => {
    setLoading("closeComplete_" + woId, true);
    try {
    const endIso = completedAt || new Date().toISOString();
    const existing = workOrders.find(w => w.id === woId);
    const timeZone = timezoneForWorkOrder(existing);
    const formattedEnd = new Date(endIso).toLocaleString("en-US", {
      timeZone,
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
    const cleanNotes = (resolutionNotes || "").trim();
    const text = `Job completed and clocked out at ${formattedEnd}. Asset: ${[make, model].filter(Boolean).join(" ")} / ${serial}. Resolution: ${resolution || "Repaired"}.${cleanNotes ? ` Closing notes: ${cleanNotes}` : ""}`;
    const patch: any = { status: "completed", functionalStatus: "Completed", assetMake: make, assetModel: model, assetSerial: serial, endTime: formattedEnd, endTimeRaw: endIso, resolutionCode: resolution || null, resolutionNotes: cleanNotes || null };
    if (assetYear) patch.assetYear = assetYear;
    const snapshot = qc.getQueryData(WORK_ORDERS_KEY);
    patchLocalWO(woId, patch, localActivity(text, "note", isManager, "job_completed", true));
    let completionResult: { applied: boolean; reason?: string } | null = null;
    const saved = await dbCall(async () => {
      completionResult = await completeWorkOrderOnce(woId, {
        completedAt: endIso,
        assetMake: make,
        assetModel: model,
        assetSerial: serial,
        assetYear: assetYear || null,
        resolutionCode: resolution || null,
        resolutionNotes: cleanNotes || null,
        activityText: text,
      });
    }, "Close failed", () => restoreWorkOrders(snapshot), invalidateWorkOrders);
    if (saved && completionResult?.applied === false) {
      restoreWorkOrders(snapshot);
      invalidateWorkOrders();
      fire("Work order was already completed");
    } else if (saved) {
      fire("Completed");
    }
    } finally {
      setLoading("closeComplete_" + woId, false);
    }
  };

  const doMoveToInvoice = async (woId: string) => {
    setLoading("moveToInvoice_" + woId, true);
    try {
    const text = "7-Eleven portal updated. Moved to Pending 7-Eleven Submission.";
    const snapshot = qc.getQueryData(WORK_ORDERS_KEY);
    patchLocalWO(
      woId,
      { status: "pending_invoice" },
      localActivity(text, "system", false, "staff_billing", false, true),
    );
    fire("Moved to Pending 7-Eleven Submission");
    await dbCall(async () => {
      await updateWorkOrder(woId, { status: "pending_invoice" });
      await insertActivity(woId, "System", text, "system", {
        eventKey: "staff_billing",
        staffOnly: true,
      });
    }, "Update failed", () => restoreWorkOrders(snapshot));
    } finally {
      setLoading("moveToInvoice_" + woId, false);
    }
  };

  // Multi-invoice rule:
  // - WO returns to pending_invoice only when every non-draft invoice is
  //   approved or sent to QuickBooks. A rejection is unresolved review work.
  // - QuickBooks handoff NEVER closes the WO. Capital jobs run for weeks with
  //   the contractor sending more invoices as work continues; a person
  //   decides when the job is actually done (manual "Close work order"
  //   button below). This helper therefore never returns "closed".
  // - When no live invoices exist, returns null so the WO is left alone.
  const computeWoStatusFromInvoices = (woId: string, override?: any[]) => {
    return contractorInvoiceWorkOrderStatus(override ?? invoices, woId);
  };

  // Per-invoice approval is one atomic database operation: validate the
  // current state, approve, recompute the parent WO, and write one structured
  // activity entry. Rejected siblings keep the WO in pending_approval.
  const doApproveInvoice = async (invoiceId: string) => {
    setLoading("approveInvoice_" + invoiceId, true);
    try {
    const inv = invoices.find((i: any) => i.id === invoiceId);
    if (!inv) { fire("Invoice not found"); return false; }
    const woSnapshot = qc.getQueryData(WORK_ORDERS_KEY);
    const invSnapshot = qc.getQueryData(INVOICES_KEY);
    const nextInvoices = invoices.map((i: any) => i.id === invoiceId ? { ...i, state: "approved" } : i);
    const nextWoStatus = computeWoStatusFromInvoices(inv.wot, nextInvoices);
    setInvoices(nextInvoices);
    const localUpdates: any = {};
    if (nextWoStatus) localUpdates.status = nextWoStatus;
    patchLocalWO(
      inv.wot,
      localUpdates,
      localActivity(
        `Invoice #${inv.num} approved by ${currentUser.name}.`,
        "system",
        false,
        "invoice_approved",
      ),
    );
    const ok = await dbCall(async () => {
      const result = await reviewContractorInvoice(inv.id, "approve");
      if (result.workOrderStatus) {
        patchLocalWO(inv.wot, { status: result.workOrderStatus });
      }
    }, "Approval failed", () => {
      restoreWorkOrders(woSnapshot);
      restoreInvoices(invSnapshot);
    });
    if (ok) {
      fire(nextWoStatus === "pending_invoice"
        ? `Invoice #${inv.num} approved — ready for P1 billing`
        : `Invoice #${inv.num} approved`);
    }
    return Boolean(ok);
    } finally {
      setLoading("approveInvoice_" + invoiceId, false);
    }
  };

  // Per-invoice QuickBooks handoff. The internal 'paid' value is retained for
  // database compatibility while the portal presents "Sent to QuickBooks".
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
    const workOrder = workOrders.find((item: any) => item.id === inv.wot);
    const nextWoStatus = workOrder?.status === "closed"
      ? null
      : computeWoStatusFromInvoices(inv.wot, nextInvoices);
    const woSnapshot = qc.getQueryData(WORK_ORDERS_KEY);
    const invSnapshot = qc.getQueryData(INVOICES_KEY);
    setInvoices(nextInvoices);
    const localPatch: any = {};
    if (nextWoStatus) localPatch.status = nextWoStatus;
    patchLocalWO(inv.wot, localPatch, localActivity(`Invoice #${inv.num} sent to QuickBooks by ${currentUser.name}.`, "system"));
    fire(`Invoice #${inv.num} sent to QuickBooks`);
    await dbCall(async () => {
      await updateInvoiceState(inv.id, "paid", { paid_at: paidAt });
      await insertActivity(inv.wot, currentUser.name, `Invoice #${inv.num} sent to QuickBooks by ${currentUser.name}.`, "system");
      if (nextWoStatus) {
        await updateWorkOrder(inv.wot, { status: nextWoStatus });
      }
    }, "QuickBooks handoff failed", () => {
      restoreWorkOrders(woSnapshot);
      restoreInvoices(invSnapshot);
    });
    } finally {
      setLoading("markPaid_" + invoiceId, false);
    }
  };

  // Staff-only: explicit "this job is done" decision. Stamps closed_at and
  // drops the WO into the 24h linger / History bucket.
  const doCloseWO = async (woId: string) => {
    setLoading("closeWO_" + woId, true);
    try {
    const closedAt = new Date().toISOString();
    const text = `Work order closed by ${currentUser.name}.`;
    const woSnapshot = qc.getQueryData(WORK_ORDERS_KEY);
    patchLocalWO(woId, { status: "closed", closedAt }, localActivity(text, "system"));
    fire("Work order closed");
    await dbCall(async () => {
      await closeWorkOrderVisit(woId, closedAt);
      await updateWorkOrder(woId, { status: "closed", closedAt });
      await insertActivity(woId, currentUser.name, text, "system");
    }, "Close failed", () => restoreWorkOrders(woSnapshot));
    } finally {
      setLoading("closeWO_" + woId, false);
    }
  };

  // Staff-only no-billing terminal path. The database locks the work order,
  // confirms that no live contractor or P1 invoice exists, closes every open
  // visit, and writes the audit event in one transaction.
  const doCloseWithoutInvoice = async (woId: string) => {
    setLoading("closeWithoutInvoice_" + woId, true);
    const closedAt = new Date().toISOString();
    const text = `Work order closed without an invoice by ${currentUser.name}.`;
    const snapshot = qc.getQueryData(WORK_ORDERS_KEY);
    try {
      patchLocalWO(
        woId,
        { status: "closed", closedAt },
        localActivity(
          text,
          "system",
          false,
          "work_order_closed_without_invoice",
          false,
          true,
        ),
      );
      const ok = await dbCall(
        () => closeWorkOrderWithoutInvoice(woId),
        "Close without invoice failed",
        () => restoreWorkOrders(snapshot),
      );
      if (ok) fire("Work order closed without an invoice");
      return Boolean(ok);
    } finally {
      setLoading("closeWithoutInvoice_" + woId, false);
    }
  };

  // Staff-only fail-safe: pull a closed WO back onto the active board by
  // pulling it back onto the active board. Now that closing is a manual
  // staff decision (not "all invoices paid"), reopening does NOT touch
  // invoice states — a closed WO can have any mix (paid, approved,
  // submitted, none). We just clear closed_at and recompute WO status from
  // whatever invoices currently exist; defaults to pending_invoice when
  // there are none.
  const doReopen = async (woId: string) => {
    setLoading("reopen_" + woId, true);
    try {
    const nextWoStatus = computeWoStatusFromInvoices(woId, invoices) || "pending_invoice";
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

  const doCapitalFlag = async (woId: string) => {
    setLoading("capitalFlag_" + woId, true);
    try {
    const text = "Flagged as capital replacement — pending approval.";
    const patch = {
      status: "capital",
      functionalStatus: "Pending Capital Approval",
      capitalStatus: "Pending approval",
      isCapital: true,
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

  const doCapitalResume = async (woId: string) => {
    setLoading("capitalResume_" + woId, true);
    try {
      const workOrder = workOrders.find((item: any) => item.id === woId);
      if (!workOrder || workOrder.status !== "pending_capital_completion") {
        fire("This work order is not waiting for capital approval");
        return;
      }
      const patch = {
        status: workOrder.contractor ? "assigned" : "unassigned",
        functionalStatus: workOrder.contractor ? "Dispatched" : "New",
        capitalStatus: "Approved - work authorized",
        isCapital: true,
      };
      const snapshot = qc.getQueryData(WORK_ORDERS_KEY);
      patchLocalWO(
        woId,
        patch,
        localActivity(
          `Capital work authorized by 7-Eleven and resumed by ${currentUser.name}.`,
          "system",
        ),
      );
      const resumed = await dbCall(async () => {
        await resumeCapitalWork(woId);
      }, "Capital resume failed", () => restoreWorkOrders(snapshot));
      if (resumed) fire("Capital approved — work can resume");
    } finally {
      setLoading("capitalResume_" + woId, false);
    }
  };


  const doAutoAssign = async () => {
    const unassigned = workOrders.filter(w => w.status === "unassigned");
    if (unassigned.length === 0) { fire("No unassigned calls"); return; }
    let count = 0;
    let skipped = unassigned.filter(w =>
      ["TX", "FL"].includes(stateCodeFromWorkOrder(w)),
    ).length;
    const dispatchedAt = new Date().toISOString();
    const snapshot = qc.getQueryData(WORK_ORDERS_KEY);
    let hadError = false;
    const ops = unassigned.map(async w => {
      if (["TX", "FL"].includes(stateCodeFromWorkOrder(w))) return;
      const trades = SERVICE_TO_TRADES(w.businessService || "", w.category || "");
      const matched = contractorFor(
        w.city,
        trades,
        USERS.filter((user: any) =>
          user.role !== "contractor" || user.isAssignable !== false,
        ),
      );
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
    setWorkOrders(prev => prev.map(w => w.id === woId ? { ...w, activities: [{ author: currentUser.name, time: dateNow(), text, type: "note", enteredByRole: currentUser?.role || "system", isStaffOverride: false }, ...w.activities] } : w));
    fire("Note posted");
    await dbCall(async () => {
      await insertActivity(woId, currentUser.name, text, "note", { eventKey: "note" });
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
      const paths = await uploadPhotos(woId, limited, currentUser.name, workflowAuditFor(woId, "photo_added", { count: limited.length }));
      const text = `Added ${paths.length} photo${paths.length > 1 ? "s" : ""}.`;
      qc.setQueryData(WORK_ORDERS_KEY, (old: any[]) =>
        old?.map(w => w.id === woId
          ? { ...w, photos: [...(w.photos || []), ...paths] }
          : w)
      );
      setWorkOrders(prev => prev.map(w => w.id === woId ? {
        ...w,
        photos: [...(w.photos || []), ...paths],
        activities: [{ author: currentUser.name, time: dateNow(), text, type: "note", enteredByRole: currentUser?.role || "system", isStaffOverride: !!isManager }, ...w.activities],
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
    await insertActivity(woId, currentUser.name, "Photo removed.", "note", workflowAuditFor(woId, "photo_removed"));
    invalidateBoth();
    fire("Photo removed");
    } finally {
      setLoading("removePhoto_" + woId, false);
    }
  };

  const doStraightToBilling = async (woId: string) => {
    const workOrder = workOrders.find(wo => wo.id === woId);
    if (!workOrder || workOrder.status !== "unassigned") {
      fire("Only an unassigned work order can go straight to Billing");
      return false;
    }

    setLoading("straightToBilling_" + woId, true);
    const readyAt = new Date().toISOString();
    const text = "Moved straight to Billing. No contractor was dispatched.";
    const snapshot = qc.getQueryData(WORK_ORDERS_KEY);
    patchLocalWO(
      woId,
      {
        status: "pending_invoice",
        functionalStatus: "Completed",
        contractor: null,
        eta: null,
        dispatchedAt: null,
        billingOnly: true,
        billingReadyAt: readyAt,
        billingReadyBy: currentUser?.id || null,
      },
      localActivity(text, "system", false, "straight_to_billing", false, true),
    );

    try {
      const ok = await dbCall(
        () => moveWorkOrderStraightToBilling(woId),
        "Could not move work order to Billing",
        () => restoreWorkOrders(snapshot),
      );
      if (ok) fire(`${woId} is ready to bill`);
      return ok;
    } finally {
      setLoading("straightToBilling_" + woId, false);
    }
  };

  const doMarkSevenElevenSynced = async (woId: string, activityId: string, synced = true) => {
    setLoading("sync711_" + activityId, true);
    try {
      await markActivitySevenElevenSynced(activityId, synced);
      setWorkOrders(prev => prev.map(w => {
        if (w.id !== woId) return w;
        const activities = (w.activities || []).map((activity: any) =>
          activity.id === activityId
            ? { ...activity, syncedToSevenElevenAt: synced ? new Date().toISOString() : null }
            : activity
        );
        const pending = activities.filter((activity: any) => activity.requiresSevenElevenSync && !activity.syncedToSevenElevenAt);
        return {
          ...w,
          activities,
          pendingSevenElevenActivities: pending,
          pendingSevenElevenSyncCount: pending.length,
          hasPendingSevenElevenSync: pending.length > 0,
        };
      }));
      invalidateWorkOrders();
      fire(synced ? "Marked updated in 7-Eleven" : "7-Eleven update reopened");
    } catch (e: any) {
      fire(`7-Eleven sync update failed: ${e.message || e}`);
    } finally {
      setLoading("sync711_" + activityId, false);
    }
  };

  const notifyContractorAttention = async (workOrderId: string, activityId: string) => {
    const sb = supabase();
    const { data } = await sb.auth.getSession();
    const token = data.session?.access_token;
    if (!token) throw new Error("Authentication session is unavailable");

    const res = await fetch("/api/notifications/contractor-attention", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ workOrderId, activityId }),
    });

    if (!res.ok) {
      const payload = await res.json().catch(() => ({}));
      throw new Error(payload.error || res.statusText || "Email request failed");
    }
  };

  const patchContractorAttention = (
    woId: string,
    activityId: string,
    patch: Record<string, unknown>,
  ) => {
    setWorkOrders(prev => prev.map(w => {
      if (w.id !== woId) return w;
      const activities = (w.activities || []).map((activity: any) =>
        activity.id === activityId ? { ...activity, ...patch } : activity
      );
      const pending = activities.filter((activity: any) =>
        activity.requiresContractorAttention && !activity.contractorAcknowledgedAt
      );
      return {
        ...w,
        activities,
        pendingContractorActivities: pending,
        pendingContractorAttentionCount: pending.length,
        hasPendingContractorAttention: pending.length > 0,
      };
    }));
  };

  const doMarkContractorAttention = async (
    woId: string,
    activityId: string,
    required: boolean,
  ) => {
    setLoading("contractorAttention_" + activityId, true);
    try {
      await markActivityContractorAttention(activityId, required);
      patchContractorAttention(woId, activityId, {
        requiresContractorAttention: required,
        contractorAcknowledgedAt: null,
        contractorAcknowledgedBy: null,
      });
      invalidateWorkOrders();
      if (required) {
        try {
          await notifyContractorAttention(woId, activityId);
          fire("Contractor attention requested and portal email sent");
        } catch (emailError: any) {
          fire(`Attention saved, but email failed: ${emailError.message || emailError}`);
        }
      } else {
        fire("Contractor attention cleared");
      }
    } catch (e: any) {
      fire(`Contractor attention update failed: ${e.message || e}`);
    } finally {
      setLoading("contractorAttention_" + activityId, false);
    }
  };

  const doAcknowledgeContractorAttention = async (
    woId: string,
    activityId: string,
    acknowledged: boolean,
  ) => {
    if (!acknowledged) return;
    setLoading("contractorAck_" + activityId, true);
    try {
      await acknowledgeContractorAttention(activityId);
      patchContractorAttention(woId, activityId, {
        contractorAcknowledgedAt: acknowledged ? new Date().toISOString() : null,
        contractorAcknowledgedBy: acknowledged ? currentUser?.id || null : null,
      });
      invalidateWorkOrders();
      fire(acknowledged ? "Marked reviewed" : "Attention item reopened");
    } catch (e: any) {
      fire(`Attention acknowledgement failed: ${e.message || e}`);
    } finally {
      setLoading("contractorAck_" + activityId, false);
    }
  };



  return {
    workOrders, setWorkOrders,
    loadingStates,
    patchLocalWO, localActivity, dbCall,
    doAssign, doStraightToBilling, doUnassign, doDeleteWO, doReassign,
    doStartWork, doPauseWork, doCloseComplete,
    doMoveToInvoice, doApproveInvoice, doMarkPaid, doCloseWO, doCloseWithoutInvoice, doReopen,
    doEditWorkOrder, doCapitalFlag, doCapitalDecline, doCapitalResume, doAutoAssign,
    doSetEta, doSetTechnician, doAssignPortalTechnician, doPostNote, doDeleteActivity,
    doAddPhotos, doRemovePhoto,
    doAddPart, doUpdatePart, doDeletePart,
    doRequestP1PartOrder, doSetP1PartOrderStatus,
    doMarkSevenElevenSynced,
    doMarkContractorAttention,
    doAcknowledgeContractorAttention,
  };
}
