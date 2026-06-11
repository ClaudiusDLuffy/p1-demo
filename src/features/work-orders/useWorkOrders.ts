"use client";
// @ts-nocheck

import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  updateWorkOrder, insertActivity, updateInvoiceState,
  unassignWorkOrder, reassignWorkOrder, deleteActivity, deleteWorkOrder,
  uploadPhotos, removePhoto,
} from "../../lib/db";
import { T, PRIORITY, MONTHS } from "../../lib/constants";
import { WORK_ORDERS_KEY } from "./queries";
import { INVOICES_KEY } from "../invoices/queries";

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
    await dbCall(async () => {
      await updateWorkOrder(woId, { status: "assigned", contractor: contractorId, dispatchedAt, functionalStatus: "Dispatched" });
      await insertActivity(woId, "System", text, "system");
    }, "Dispatch failed", () => restoreWorkOrders(snapshot));
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
    await dbCall(async () => {
      await reassignWorkOrder(woId, newContractorId, oldName, newC.name, currentUser.name);
    }, "Reassign failed", () => restoreWorkOrders(snapshot));
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

  const doSetEta = async (woId: string, eta: string) => {
    setLoading("setEta_" + woId, true);
    try {
    const text = `ETA set: ${eta}`;
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

  const doPauseWork = async (woId: string, reason: string, partDesc: string, partNum: string, partEta: string, notes: string) => {
    setLoading("pauseWork_" + woId, true);
    try {
    const pauseIso = pauseDateInput && pauseTimeInput ? new Date(`${pauseDateInput}T${pauseTimeInput}`).toISOString() : new Date().toISOString();
    const partLabel = partDesc ? `${partDesc}${partNum ? ` (${partNum})` : ""}` : null;
    const text = notes || `Work paused: ${reason}.${partLabel ? ` Part needed: ${partLabel}.` : ""}`;
    const updates: any = { status: "parts", functionalStatus: "Awaiting Parts", endTime: pauseIso };
    if (partLabel) updates.partNeeded = partLabel;
    if (partEta) updates.partEta = partEta; // ISO date string from input type=date
    const snapshot = qc.getQueryData(WORK_ORDERS_KEY);
    patchLocalWO(woId, updates, localActivity(text, "note"));
    fire("Paused — awaiting parts");
    await dbCall(async () => {
      await updateWorkOrder(woId, updates);
      await insertActivity(woId, currentUser.name, text, "note");
    }, "Pause failed", () => restoreWorkOrders(snapshot));
    } finally {
      setLoading("pauseWork_" + woId, false);
    }
  };

  const doCloseComplete = async (woId: string, make: string, model: string, serial: string, resolution: string, assetYear?: number | null) => {
    setLoading("closeComplete_" + woId, true);
    try {
    const endIso = new Date().toISOString();
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

  // Owner approves on behalf of AFM (Phase 1 has no AFM role). Clears the
  // submitted invoice for payment and carries the WO to Pending Payment.
  const doApproveInvoice = async (woId: string) => {
    setLoading("approveInvoice_" + woId, true);
    try {
    const inv = invoices.find(i => i.wot === woId && (i.state === "submitted" || i.state === "revised"));
    const text = `Approved on behalf of AFM by ${currentUser.name}.${inv ? ` Invoice #${inv.num} cleared for payment.` : ""}`;
    const woSnapshot = qc.getQueryData(WORK_ORDERS_KEY);
    const invSnapshot = qc.getQueryData(INVOICES_KEY);
    if (inv) setInvoices(prev => prev.map(i => i.num === inv.num ? { ...i, state: "approved" } : i));
    patchLocalWO(woId, { status: "pending_payment" }, localActivity(text, "system"));
    fire("Approved — moved to Pending Payment");
    await dbCall(async () => {
      if (inv) await updateInvoiceState(inv.num, "approved");
      await updateWorkOrder(woId, { status: "pending_payment" });
      await insertActivity(woId, currentUser.name, text, "system");
    }, "Approval failed", () => {
      restoreWorkOrders(woSnapshot);
      restoreInvoices(invSnapshot);
    });
    } finally {
      setLoading("approveInvoice_" + woId, false);
    }
  };

  // Owner records payment received → WO is fully closed. Stamp closed_at
  // (drives the 24h board linger + History) and clear any NTE flag so a
  // closed job leaves the "NTE Approval Needed" bucket.
  const doMarkPaid = async (woId: string) => {
    setLoading("markPaid_" + woId, true);
    try {
    const inv = invoices.find(i => i.wot === woId);
    const paidAt = new Date().toISOString();
    const text = `Marked paid by ${currentUser.name}. Work order closed.`;
    const woSnapshot = qc.getQueryData(WORK_ORDERS_KEY);
    const invSnapshot = qc.getQueryData(INVOICES_KEY);
    if (inv) setInvoices(prev => prev.map(i => i.num === inv.num ? { ...i, state: "paid" } : i));
    patchLocalWO(woId, { status: "closed", closedAt: paidAt, nteFlagged: false }, localActivity(text, "system"));
    fire("Marked paid — work order closed");
    await dbCall(async () => {
      if (inv) await updateInvoiceState(inv.num, "paid", { paid_at: paidAt });
      await updateWorkOrder(woId, { status: "closed", closedAt: paidAt, nteFlagged: false });
      await insertActivity(woId, currentUser.name, text, "system");
    }, "Mark paid failed", () => {
      restoreWorkOrders(woSnapshot);
      restoreInvoices(invSnapshot);
    });
    } finally {
      setLoading("markPaid_" + woId, false);
    }
  };

  // Staff-only fail-safe: pull a closed WO back onto the active board. Re-enters
  // at Pending Payment (the state it closed from) and reverts the invoice from
  // paid→approved so Mark Paid works again. Clears closed_at so the 24h/History
  // logic treats it as active.
  const doReopen = async (woId: string) => {
    setLoading("reopen_" + woId, true);
    try {
    const inv = invoices.find(i => i.wot === woId && i.state === "paid");
    const text = `Work order reopened by ${currentUser.name}.`;
    const woSnapshot = qc.getQueryData(WORK_ORDERS_KEY);
    const invSnapshot = qc.getQueryData(INVOICES_KEY);
    if (inv) setInvoices(prev => prev.map(i => i.num === inv.num ? { ...i, state: "approved" } : i));
    patchLocalWO(woId, { status: "pending_payment", closedAt: null }, localActivity(text, "system"));
    fire("Work order reopened — back on the active board");
    await dbCall(async () => {
      if (inv) await updateInvoiceState(inv.num, "approved");
      await updateWorkOrder(woId, { status: "pending_payment", closedAt: null });
      await insertActivity(woId, currentUser.name, text, "system");
    }, "Reopen failed", () => {
      restoreWorkOrders(woSnapshot);
      restoreInvoices(invSnapshot);
    });
    } finally {
      setLoading("reopen_" + woId, false);
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
    doMoveToInvoice, doApproveInvoice, doMarkPaid, doReopen,
    doEditNte, doEditNteFlag, doCapitalFlag, doCapitalDecline, doAutoAssign,
    doSetEta, doSetTechnician, doPostNote, doDeleteActivity,
    doAddPhotos, doRemovePhoto,
  };
}
