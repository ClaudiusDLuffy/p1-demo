"use client";
// @ts-nocheck

import { apiFetch } from "../../lib/errors/apiFetch";
import { reportClientFailure } from "../../lib/clientDiagnostics";
import { safeErrorMessage } from "../../lib/errors/normalizeUnknown";
import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  updateWorkOrder, insertActivity,
  transitionWorkOrderContractor, administrativelyCloseVisitAndTransfer, declineCapitalWorkOrder,
  deleteActivity, deleteWorkOrder,
  rejectUnassignedWorkOrder, duplicateWorkOrderForReassignment,
  removePhoto,
  insertWoPart, updateWoPart, deleteWoPart,
  requestP1PartOrder, setP1PartOrderStatusWithCost,
  markActivitySevenElevenSynced,
  markActivityContractorAttention, acknowledgeContractorAttention,
  setWorkOrderEta, startWorkOrderVisit, pauseWorkOrderForParts, completeWorkOrderOnce,
  flagWorkOrderCapital,
  moveWorkOrderStraightToBilling,
  completeCapitalWork,
  resumeCapitalWork,
  closeWorkOrderWithoutInvoice,
  closeReopenedWorkOrderWithoutAdditionalBilling,
  reopenWorkOrder,
  finishContractorInvoicing,
  assignContractorTechnician,
  reviewContractorInvoice,
  loadInvoiceSummaryById,
  loadWorkOrderById,
  loadWorkOrdersPage,
} from "../../lib/db";
import { chunkArray, mapChunksWithConcurrency } from "../../lib/cursorPagination";
import { T, PRIORITY, MONTHS } from "../../lib/constants";
import {
  stateCodeFromWorkOrder,
  storeLocalDateTimeToIso,
  timezoneForWorkOrder,
} from "../../lib/billingRules";
import { supabase } from "../../lib/supabase/client";
import {
  CONTRACTOR_WORKLOAD_SUMMARY_KEY,
  PORTAL_NAVIGATION_SUMMARY_KEY,
  WORK_ORDER_BY_ID_KEY,
  WORK_ORDER_DETAILS_KEY,
  WORK_ORDER_PAGES_KEY,
  WORK_ORDERS_KEY,
  WO_PARTS_KEY,
  P1_PART_COSTS_KEY,
  BILLABLE_P1_PARTS_KEY,
  workOrderDetailsKey,
  workOrderByIdKey,
} from "./queries";
import {
  INVOICE_BY_ID_KEY,
  INVOICE_PAGES_KEY,
  INVOICES_KEY,
} from "../invoices/queries";
import { acquireInvoiceMutationLocks } from "../../lib/invoiceMutationGuard";
import {
  isRpcConflict,
  rpcConflictMessage,
  rpcErrorMessage,
} from "../../lib/rpcConflict";
import type { WorkOrderReopenMode } from "../../lib/workOrderReopen";
import { workOrderStatusAfterFieldCompletion } from "../../lib/contractorCompletion";
import {
  contractorAttentionRequestToast,
  contractorNotificationToast,
  shouldAutomaticallyNotifyContractor,
  type ContractorNotificationDelivery,
} from "../../lib/activityNotificationPolicy";
import { assignmentBoundaryPatch } from "../../lib/workOrderAssignmentBoundary";
import { lifecycleContextFor, safeLifecycleError } from "../../lib/workOrderLifecycleCommands";
import { createBillingReadyAttempt } from "../../lib/workOrderBillingCommands";
import { createAssignmentAttempts, safeAssignmentError } from "../../lib/workOrderAssignmentCommands";
import { createWorkOrderPhotoPorts } from "../../lib/privateObjectClient";
import { createPhotoUploadController, PhotoUploadError, type PhotoUploadController, type PhotoUploadItem } from "../photos/photoUploadController";
import { loadAutoAssignmentCandidate, loadDirectorySelection } from "../directory/api";
import { directoryActorScope, workOrderCountKey, workOrderChildCountKey, invoiceCountKey } from "../../lib/counts/queryKeys";

const PART_STATUS_LABEL: Record<string, string> = {
  ordered: "Ordered",
  backordered: "Backordered",
  shipped: "Shipped",
  received: "Received",
};

export default function useWorkOrders({
  currentUser, workOrdersData, invoices, setInvoices, fire,
  selectedWorkOrderId, selectedWorkOrderDetails,
  startDateInput, startTimeInput, pauseDateInput, pauseTimeInput,
  setSelectedWO, setAiNote, setPage, isManager,
  noteText, setNoteText, SERVICE_TO_TRADES,
  dateNow, fmt,
}: any) {
  const qc = useQueryClient();
  const readScope = directoryActorScope(currentUser);
  const [workOrders, setWorkOrders] = useState<any[]>(workOrdersData ?? []);
  const [loadingStates, setLoadingStates] = useState<Record<string, boolean>>({});
  const lifecycleInFlight = useRef(new Set<string>());
  const assignmentAttempts = useRef(createAssignmentAttempts());
  const assignmentInFlight = useRef(new Set<string>());
  const billingReadyAttempts = useRef(new Map<string, ReturnType<typeof createBillingReadyAttempt>>());
  const photoControllers = useRef(new Map<string, { controller: PhotoUploadController; assignmentVersion: number; workflowCycle: number }>());
  const photoUploadInFlight = useRef(new Set<string>());
  const photoDeleteInFlight = useRef(new Set<string>());
  const photoDeleteTargets = useRef(new Map<string, string>());
  const photoSessionGeneration = useRef({ value: 0 });
  const [photoUploadItems, setPhotoUploadItems] = useState<Record<string, readonly PhotoUploadItem[]>>({});
  const [photoDeleteErrors, setPhotoDeleteErrors] = useState<Record<string, string>>({});
  const setLoading = (key: string, val: boolean) =>
    setLoadingStates(prev => ({ ...prev, [key]: val }));

  useEffect(() => {
    const session = photoSessionGeneration.current;
    session.value++;
    setPhotoUploadItems({});
    setPhotoDeleteErrors({});
    setLoadingStates(previous => Object.fromEntries(Object.entries(previous)
      .filter(([key]) => !key.startsWith("addPhotos_") && !key.startsWith("removePhoto_"))));
    const controllers = photoControllers.current;
    const uploads = photoUploadInFlight.current;
    const deletions = photoDeleteInFlight.current;
    const targets = photoDeleteTargets.current;
    return () => {
      session.value++;
      for (const { controller } of controllers.values()) controller.dispose();
      controllers.clear(); uploads.clear(); deletions.clear(); targets.clear();
    };
  }, [currentUser?.id]);

  useEffect(() => {
    if (!workOrdersData) return;
    setWorkOrders(current => {
      const currentById = new Map(current.map(workOrder => [workOrder.id, workOrder]));
      return workOrdersData.map((baseWorkOrder: { id: string; assignmentHistory?: unknown[] }) => {
        const existing = currentById.get(baseWorkOrder.id);
        if (!existing?.detailsLoaded) return baseWorkOrder;
        return {
          ...existing,
          ...baseWorkOrder,
          activities: existing.activities || [],
          photos: existing.photos || [],
          visits: existing.visits || [],
          pendingSevenElevenActivities: existing.pendingSevenElevenActivities || [],
          pendingContractorActivities: existing.pendingContractorActivities || [],
          activityPage: existing.activityPage,
          photoPage: existing.photoPage,
          visitPage: existing.visitPage,
          assignmentHistory: existing.assignmentHistory || baseWorkOrder.assignmentHistory || [],
          detailsLoaded: true,
        };
      });
    });
  }, [workOrdersData]);

  useEffect(() => {
    if (!selectedWorkOrderId || !selectedWorkOrderDetails) return;
    setWorkOrders(current => current.map(workOrder =>
      workOrder.id === selectedWorkOrderId
        ? { ...workOrder, ...selectedWorkOrderDetails }
        : workOrder
    ));
  }, [selectedWorkOrderDetails, selectedWorkOrderId]);

  const restoreWorkOrders = (snapshot: any) => {
    qc.setQueryData(WORK_ORDERS_KEY, snapshot);
    if (snapshot) {
      setWorkOrders((snapshot as any[]).map(workOrder => {
        const cachedDetails = qc.getQueryData(workOrderDetailsKey(workOrder.id, readScope));
        return cachedDetails
          ? { ...workOrder, ...(cachedDetails as Record<string, unknown>) }
          : workOrder;
      }));
    }
  };
  const restoreInvoices = (snapshot: any) => {
    qc.setQueryData(INVOICES_KEY, snapshot);
    if (snapshot) setInvoices(snapshot as any[]);
  };
  const invalidateWorkOrders = () => {
    void qc.invalidateQueries({ queryKey: WORK_ORDERS_KEY });
    void qc.invalidateQueries({ queryKey: WORK_ORDER_PAGES_KEY });
    void qc.invalidateQueries({ queryKey: workOrderCountKey(readScope) });
    void qc.invalidateQueries({ queryKey: workOrderChildCountKey(readScope) });
    void qc.invalidateQueries({ queryKey: WORK_ORDER_BY_ID_KEY });
    void qc.invalidateQueries({ queryKey: WORK_ORDER_DETAILS_KEY });
    void qc.invalidateQueries({ queryKey: PORTAL_NAVIGATION_SUMMARY_KEY });
    void qc.invalidateQueries({ queryKey: CONTRACTOR_WORKLOAD_SUMMARY_KEY });
  };
  const invalidateInvoices = () => {
    void qc.invalidateQueries({ queryKey: INVOICES_KEY });
    void qc.invalidateQueries({ queryKey: INVOICE_PAGES_KEY });
    void qc.invalidateQueries({ queryKey: invoiceCountKey(readScope) });
    void qc.invalidateQueries({ queryKey: INVOICE_BY_ID_KEY });
  };
  const invalidateBoth = () => {
    invalidateWorkOrders();
    invalidateInvoices();
  };
  const invalidatePartsAndWorkOrders = () => {
    void qc.invalidateQueries({ queryKey: WO_PARTS_KEY });
    invalidateWorkOrders();
  };

  const pendingSevenElevenCountFor = (workOrder: any) => Math.max(
    Number(workOrder?.pendingSevenElevenSyncCount || 0),
    Array.isArray(workOrder?.pendingSevenElevenActivities)
      ? workOrder.pendingSevenElevenActivities.length
      : 0,
    Array.isArray(workOrder?.activities)
      ? workOrder.activities.filter(
          (activity: any) => activity.requiresSevenElevenSync && !activity.syncedToSevenElevenAt,
        ).length
      : 0,
  );

  // Local optimistic patch helper (visual update before DB confirms). A new
  // unsynced field note also updates the summary immediately; the invalidated
  // server projection remains authoritative after the write settles.
  const patchLocalWO = (id: string, patch: any, newActivity?: any) => {
    setWorkOrders(prev => prev.map(w => {
      if (w.id !== id) return w;
      const createsPendingSevenElevenUpdate = !!newActivity?.requiresSevenElevenSync
        && !newActivity?.syncedToSevenElevenAt;
      return {
        ...w,
        ...patch,
        ...(createsPendingSevenElevenUpdate
          ? {
              pendingSevenElevenSyncCount: pendingSevenElevenCountFor(w) + 1,
              hasPendingSevenElevenSync: true,
            }
          : {}),
        activities: newActivity ? [newActivity, ...(w.activities || [])] : (w.activities || []),
      };
    }));
  };
  const workflowAuditFor = (
    woId: string,
    eventKey?: string,
    eventData?: import("../../lib/supabase/database.types").Json,
    activityChannel?: "field_note" | "internal_note" | "contractor_message" | "system_event" | "legacy",
    requiresSevenElevenSync = false,
  ) => ({
    staffOverride: !!isManager,
    overrideForContractorId: isManager
      ? workOrders.find(w => w.id === woId)?.contractor || null
      : null,
    eventKey,
    eventData,
    activityChannel,
    requiresSevenElevenSync,
  });
  const localActivity = (
    text: string,
    type: "note" | "system" | "ai" = "system",
    staffOverride = false,
    eventKey?: string,
    requiresSevenElevenSync = false,
    staffOnly = false,
    activityChannel?: "field_note" | "internal_note" | "contractor_message" | "system_event" | "legacy",
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
    activityChannel: activityChannel
      || (requiresSevenElevenSync
        ? "field_note"
        : staffOnly
          ? "internal_note"
          : type === "system"
            ? "system_event"
            : "legacy"),
    requiresSevenElevenSync,
    syncedToSevenElevenAt: null,
  });

  // Wrap a DB call in a try/catch that fires a toast on failure
  const dbCall = async (
    fn: () => Promise<any>,
    errorMsg: string = "Save failed",
    onError?: (error: unknown) => void,
    onSettled?: () => void,
    messageForError?: (error: unknown) => string,
  ) => {
    try { await fn(); return true; }
    catch (e: unknown) {
      if (onError) onError(e);
      fire(messageForError
        ? messageForError(e)
        : `${errorMsg}: ${rpcErrorMessage(e)}`);
      return false;
    }
    finally { if (onSettled) onSettled(); else invalidateBoth(); }
  };

  const notifyDispatch = async (workOrderId: string, contractorId?: string | null) => {
    try {
      const sb = supabase();
      const { data } = await sb.auth.getSession();
      const token = data.session?.access_token;
      if (!token) return;

      await apiFetch("/api/notifications/dispatch", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ workOrderId, contractorId }),
        signal: AbortSignal.timeout(5_000),
      });

    } catch {
      void reportClientFailure({ source: "dispatch_status", message: "WORKER_UNAVAILABLE" });
    }
  };

  const notifyAssignmentRemoval = async (deliveryId?: string | null) => {
    if (!deliveryId) return "not_required";

    try {
      const sb = supabase();
      const { data } = await sb.auth.getSession();
      const token = data.session?.access_token;
      if (!token) return "request_failed";

      const response = await apiFetch("/api/notifications/assignment-removal", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ deliveryId }),
      });
      const payload = await response.json().catch(() => ({}));
      return payload.delivery || (payload.success ? "sent" : "request_failed");
    } catch {
      void reportClientFailure({ source: "assignment_removal", message: "DELIVERY_UNKNOWN" });
      return "request_failed";
    }
  };

  const assignmentRemovalMessage = (delivery: string) => {
    if (delivery === "sent" || delivery === "already_sent") {
      return " The former contractor was notified automatically.";
    }
    if (delivery === "not_required") return "";
    if (delivery === "not_deliverable") {
      return " The former contractor has no deliverable email address; contact them manually.";
    }
    return " The assignment changed, but email delivery could not be confirmed; contact the former contractor manually.";
  };

  const doAssign = async (woId: string, contractorId: string) => {
    if (assignmentInFlight.current.has(woId)) return false;
    assignmentInFlight.current.add(woId);
    setLoading("assign_" + woId, true);
    try {
    // Selection is exact and independently authorized, not dependent on the
    // currently visible search page. The write command revalidates eligibility.
    const c = await loadDirectorySelection("assignable_contractors", contractorId);
    if (!c) { fire("Contractor not found"); return false; }
    let wo = workOrders.find(workOrder => workOrder.id === woId) || null;
    if (!wo) {
      try {
        wo = await loadWorkOrderById(woId);
      } catch (error: unknown) {
        fire(`Could not load work order: ${rpcErrorMessage(error)}`);
        return false;
      }
    }
    if (!wo) { fire("Work order not found"); return false; }
    const text = `Dispatched to ${c.name}${c.company ? ` (${c.company})` : ""}.`;
    let transition: Awaited<ReturnType<typeof transitionWorkOrderContractor>> | undefined;
    const ok = await dbCall(async () => {
      transition = await assignmentAttempts.current.run(wo, "transition", contractorId, context => transitionWorkOrderContractor(
        woId,
        contractorId,
        context.expectedAssignmentVersion,
        context,
      ));
    }, "Dispatch failed");
    if (!ok || !transition) return false;
    patchLocalWO(
      woId,
      assignmentBoundaryPatch(wo, transition),
      localActivity(text, "system", false, "work_order_assignment", false, true),
    );
    fire(`Assigned to ${c.name}. See Receiving dispatch for email delivery status.`);
    void notifyDispatch(woId, contractorId);
    return true;
    } catch (error: unknown) {
      fire(`Dispatch failed: ${safeAssignmentError(error).message}`);
      return false;
    } finally {
      assignmentInFlight.current.delete(woId);
      setLoading("assign_" + woId, false);
    }
  };

  const doUnassign = async (woId: string) => {
    if (assignmentInFlight.current.has(woId)) return false;
    assignmentInFlight.current.add(woId);
    setLoading("unassign_" + woId, true);
    try {
    let wo = workOrders.find(workOrder => workOrder.id === woId) || null;
    if (!wo) {
      try {
        wo = await loadWorkOrderById(woId);
      } catch (error: unknown) {
        fire(`Could not load work order: ${rpcErrorMessage(error)}`);
        return false;
      }
    }
    if (!wo) { fire("Work order not found"); return false; }
    const text = `Work order unassigned by ${currentUser.name}.`;
    let transition: Awaited<ReturnType<typeof transitionWorkOrderContractor>> | undefined;
    const ok = await dbCall(async () => {
      transition = await assignmentAttempts.current.run(wo, "transition", null, context => transitionWorkOrderContractor(
        woId,
        null,
        context.expectedAssignmentVersion,
        context,
      ));
    }, "Unassign failed");
    if (!ok || !transition) return false;
    patchLocalWO(
      woId,
      assignmentBoundaryPatch(wo, transition),
      localActivity(text, "system", false, "work_order_unassigned", false, true),
    );
    const delivery = await notifyAssignmentRemoval(transition.deliveryId);
    fire(`Work order unassigned.${assignmentRemovalMessage(delivery)}`);
    return true;
    } finally {
      assignmentInFlight.current.delete(woId);
      setLoading("unassign_" + woId, false);
    }
  };

  // Soft delete. Optimistically pull the card from every view, drop the
  // detail panel, navigate home. Roll the card back if the DB write fails
  // so a failed delete is never silently swallowed.
  const doDeleteWO = async (woId: string) => {
    let wo = workOrders.find(w => w.id === woId) || null;
    if (!wo) {
      try {
        wo = await loadWorkOrderById(woId);
      } catch (error: any) {
        fire(`Delete failed: ${safeErrorMessage(error)}`);
        return false;
      }
    }
    if (!wo) { fire("Work order not found"); return false; }
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
    return Boolean(ok);
    } finally {
      setLoading("deleteWO_" + woId, false);
    }
  };

  const doRejectUnassignedWO = async (woId: string, reason: string) => {
    const normalizedReason = String(reason || "").trim();
    if (normalizedReason.length < 5 || normalizedReason.length > 500) {
      fire("Enter a rejection reason between 5 and 500 characters.");
      return false;
    }

    if (assignmentInFlight.current.has(woId)) return false;
    assignmentInFlight.current.add(woId);
    setLoading("rejectUnassignedWO_" + woId, true);
    try {
      const wo = workOrders.find(workOrder => workOrder.id === woId) || await loadWorkOrderById(woId);
      await assignmentAttempts.current.run(wo, "reject", normalizedReason,
        context => rejectUnassignedWorkOrder(woId, normalizedReason, context));
      setWorkOrders(prev => prev.filter(workOrder => workOrder.id !== woId));
      qc.removeQueries({ queryKey: workOrderByIdKey(woId, readScope), exact: true });
      qc.removeQueries({ queryKey: workOrderDetailsKey(woId, readScope), exact: true });
      setSelectedWO(null);
      setAiNote(null);
      setPage("dashboard");
      invalidateWorkOrders();
      fire(`Work order ${woId} rejected and removed from dispatch.`);
      return true;
    } catch (error: unknown) {
      invalidateWorkOrders();
      fire(`Reject failed: ${safeAssignmentError(error).message}`);
      return false;
    } finally {
      assignmentInFlight.current.delete(woId);
      setLoading("rejectUnassignedWO_" + woId, false);
    }
  };

  const doDuplicateForReassignment = async (woId: string) => {
    if (assignmentInFlight.current.has(woId)) return null;
    assignmentInFlight.current.add(woId);
    setLoading("duplicateForReassignment_" + woId, true);
    try {
      const wo = workOrders.find(workOrder => workOrder.id === woId) || await loadWorkOrderById(woId);
      const result = await assignmentAttempts.current.run(wo, "duplicate", null,
        context => duplicateWorkOrderForReassignment(woId, context));
      invalidateWorkOrders();
      setAiNote(null);
      setSelectedWO(result.workOrderId);
      setPage("wo_detail");
      const delivery = await notifyAssignmentRemoval(result.deliveryId);
      fire(`Created ${result.workOrderId}. It is unassigned and ready to dispatch.${assignmentRemovalMessage(delivery)}`);
      return result;
    } catch (error: unknown) {
      invalidateWorkOrders();
      fire(`Duplicate failed: ${safeAssignmentError(error).message}`);
      return null;
    } finally {
      assignmentInFlight.current.delete(woId);
      setLoading("duplicateForReassignment_" + woId, false);
    }
  };

  const doReassign = async (woId: string, newContractorId: string) => {
    let wo = workOrders.find(w => w.id === woId) || null;
    if (!wo) {
      try {
        wo = await loadWorkOrderById(woId);
      } catch (error: any) {
        fire(`Could not load work order: ${safeErrorMessage(error)}`);
        return false;
      }
    }
    if (!wo) { fire("Work order not found"); return false; }
    if (wo?.contractor === newContractorId) { fire("Already assigned to that contractor"); return false; }
    if (assignmentInFlight.current.has(woId)) return false;
    assignmentInFlight.current.add(woId);
    setLoading("reassign_" + woId, true);
    try {
    const newC = await loadDirectorySelection("assignable_contractors", newContractorId);
    if (!newC) { fire("Contractor not found"); return false; }
    const previous = wo.contractor
      ? await loadDirectorySelection("profile_labels", wo.contractor) : null;
    const oldName = previous?.name || (wo.contractor ? "Previous contractor" : "Unassigned");
    const text = `Reassigned from ${oldName} to ${newC.name} by ${currentUser.name}.`;
    let transition: Awaited<ReturnType<typeof transitionWorkOrderContractor>> | undefined;
    const ok = await dbCall(async () => {
      transition = await assignmentAttempts.current.run(wo, "transition", newContractorId, context => transitionWorkOrderContractor(
        woId,
        newContractorId,
        context.expectedAssignmentVersion,
        context,
      ));
    }, "Reassign failed");
    if (!ok || !transition) return false;
    patchLocalWO(
      woId,
      assignmentBoundaryPatch(wo, transition),
      localActivity(text, "system", false, "work_order_reassigned", false, true),
    );
    const [delivery] = await Promise.all([
      notifyAssignmentRemoval(transition.deliveryId),
      notifyDispatch(woId, newContractorId),
    ]);
    fire(`Reassigned to ${newC.name}. See Receiving dispatch for the receiving email status.${assignmentRemovalMessage(delivery)}`);
    return true;
    } catch (error: unknown) {
      fire(`Reassign failed: ${safeAssignmentError(error).message}`);
      return false;
    } finally {
      assignmentInFlight.current.delete(woId);
      setLoading("reassign_" + woId, false);
    }
  };

  const doAdministrativeTransfer = async (woId: string, contractorId: string | null, reason: string, confirmed: boolean) => {
    if (assignmentInFlight.current.has(woId)) return false;
    assignmentInFlight.current.add(woId);
    setLoading("administrativeTransfer_" + woId, true);
    try {
      const wo = workOrders.find(w => w.id === woId) || await loadWorkOrderById(woId);
      if (!wo) { fire("Work order not found"); return false; }
      let transition: Awaited<ReturnType<typeof administrativelyCloseVisitAndTransfer>> | undefined;
      const ok = await dbCall(async () => {
        transition = await assignmentAttempts.current.run(wo, "administrative_transfer",
          { contractorId, reason: reason.trim(), confirmed },
          context => administrativelyCloseVisitAndTransfer(context, contractorId, reason, confirmed));
      }, "Administrative transfer failed");
      if (!ok || !transition) return false;
      patchLocalWO(woId, assignmentBoundaryPatch(wo, transition));
      await Promise.all([
        qc.invalidateQueries({ queryKey: workOrderDetailsKey(woId) }),
        qc.invalidateQueries({ queryKey: ["work-order-visits", "billing", woId] }),
      ]);
      const [delivery] = await Promise.all([
        notifyAssignmentRemoval(transition.deliveryId),
        contractorId ? notifyDispatch(woId, contractorId) : Promise.resolve(),
      ]);
      fire(`Visit administratively closed and ${contractorId ? "work transferred" : "contractor unassigned"}. Duration requires review; the receiving contractor must start a new visit.${assignmentRemovalMessage(delivery)}`);
      return true;
    } catch (error) {
      fire(safeAssignmentError(error).message);
      return false;
    } finally {
      assignmentInFlight.current.delete(woId);
      setLoading("administrativeTransfer_" + woId, false);
    }
  };

  const doDeleteActivity = async (woId: string, activityId: string) => {
    const snapshot = qc.getQueryData(WORK_ORDERS_KEY);
    setWorkOrders(prev => prev.map(w => {
      if (w.id !== woId) return w;
      const deleted = (w.activities || []).find((activity: any) => activity.id === activityId);
      const removedPendingSevenElevenUpdate = !!deleted?.requiresSevenElevenSync
        && !deleted?.syncedToSevenElevenAt;
      const pendingCount = removedPendingSevenElevenUpdate
        ? Math.max(0, pendingSevenElevenCountFor(w) - 1)
        : pendingSevenElevenCountFor(w);
      return {
        ...w,
        activities: (w.activities || []).filter((activity: any) => activity.id !== activityId),
        pendingSevenElevenActivities: (w.pendingSevenElevenActivities || []).filter(
          (activity: any) => activity.id !== activityId,
        ),
        pendingSevenElevenSyncCount: pendingCount,
        hasPendingSevenElevenSync: pendingCount > 0,
      };
    }));
    fire("Comment deleted");
    await dbCall(async () => {
      await deleteActivity(activityId);
    }, "Delete failed", () => restoreWorkOrders(snapshot));
  };

  // `eta` arrives as an ISO timestamp (timestamptz column). Persist the ISO
  // value but render a human-friendly version into the activity log.
  const doSetEta = async (woId: string, eta: string) => {
    if (lifecycleInFlight.current.has(woId)) return false;
    lifecycleInFlight.current.add(woId);
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
    return await dbCall(async () => {
      const result = await setWorkOrderEta({
        ...lifecycleContextFor(workOrders.find(w => w.id === woId)), eta,
      });
      patchLocalWO(woId, { lifecycleVersion: result.lifecycleVersion });
    }, "ETA save failed", () => restoreWorkOrders(snapshot));
    } finally {
      lifecycleInFlight.current.delete(woId);
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

  const doStartWork = async (
    woId: string,
    notes: string,
    onFailure?: (message: string) => void,
  ) => {
    if (lifecycleInFlight.current.has(woId)) return false;
    lifecycleInFlight.current.add(woId);
    setLoading("startWork_" + woId, true);
    try {
    const existing = workOrders.find(w => w.id === woId);
    const timeZone = timezoneForWorkOrder(existing);
    const requestedStartIso = !existing?.assignmentTransferPendingVisit && startDateInput && startTimeInput
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
    const patch: Record<string, unknown> = {
      status: ["pending_invoice", "pending_approval", "pending_payment"].includes(existing?.status)
        ? existing.status
        : "wip",
      functionalStatus: "Work in Progress",
    };
    if (!existing?.startTimeRaw) {
      patch.startTime = formattedStart;
      patch.startTimeRaw = firstStartIso;
    }
    const snapshot = qc.getQueryData(WORK_ORDERS_KEY);
    patchLocalWO(woId, patch, localActivity(text, "note", isManager, "check_in", true, false, "field_note"));
    const startFailureMessage = (error: unknown) =>
      `Start work failed: ${safeLifecycleError(error).message}`;
    const started = await dbCall(async () => {
      const result = await startWorkOrderVisit({
        ...lifecycleContextFor(existing), checkedInAt: requestedStartIso, notes: notes.trim(),
      }, existing?.functionalStatus === "Awaiting Parts" || existing?.assignmentTransferPendingVisit === true);
      patchLocalWO(woId, { lifecycleVersion: result.lifecycleVersion, assignmentTransferPendingVisit: false });
    }, "Start work failed", (error) => {
      restoreWorkOrders(snapshot);
      onFailure?.(startFailureMessage(error));
    }, undefined, startFailureMessage);
    if (started) fire("Work started · 7-Eleven update pending");
    return started;
    } finally {
      lifecycleInFlight.current.delete(woId);
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
    partsList?: { description: string; partNumber?: string; qty?: number; expectedReturnDate?: string }[],
    onFailure?: (message: string) => void,
  ) => {
    if (lifecycleInFlight.current.has(woId)) return false;
    lifecycleInFlight.current.add(woId);
    setLoading("pauseWork_" + woId, true);
    try {
    const existing = workOrders.find(w => w.id === woId);
    if (existing?.functionalStatus !== "Work in Progress") {
      const message = "Only work in progress can be paused for parts";
      onFailure?.(message);
      fire(message);
      return false;
    }
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
    const updates: Record<string, unknown> = {
      status: ["pending_invoice", "pending_approval", "pending_payment"].includes(existing?.status)
        ? existing.status
        : "parts",
      functionalStatus: "Awaiting Parts",
    };
    if (partLabel) updates.partNeeded = partLabel;
    if (legacyEta) updates.partEta = legacyEta;
    const snapshot = qc.getQueryData(WORK_ORDERS_KEY);
    const partsSnapshot = qc.getQueryData(WO_PARTS_KEY);
    patchLocalWO(woId, updates, localActivity(text, "note", isManager, "job_paused", true, false, "field_note"));
    const pauseFailureMessage = (error: unknown) =>
      `Pause failed: ${safeLifecycleError(error).message}`;
    const paused = await dbCall(async () => {
      if (reason !== "Awaiting parts" && reason !== "Temporary fix") throw safeLifecycleError({ code: "22023" });
      const result = await pauseWorkOrderForParts({
        ...lifecycleContextFor(existing), checkedOutAt: pauseIso, reason, notes,
        parts: cleanParts.map(part => ({
          description: part.description.trim(), partNumber: (part.partNumber || "").trim(),
          qty: part.qty ?? 1, expectedReturnDate: part.expectedReturnDate || null,
        })),
        legacyPartNeeded: partLabel, legacyPartEta: legacyEta || null,
      });
      patchLocalWO(woId, { lifecycleVersion: result.lifecycleVersion });
      // Parts were committed with the transition. Refresh the authoritative
      // rows without risking a second mutation or duplicate cache append.
      void qc.invalidateQueries({ queryKey: WO_PARTS_KEY });
    }, "Pause failed", (error) => {
      restoreWorkOrders(snapshot);
      if (partsSnapshot) qc.setQueryData(WO_PARTS_KEY, partsSnapshot);
      onFailure?.(pauseFailureMessage(error));
    }, undefined, pauseFailureMessage);
    if (paused) fire("Paused — awaiting parts · 7-Eleven update pending");
    return paused;
    } finally {
      lifecycleInFlight.current.delete(woId);
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
      }, invalidatePartsAndWorkOrders);
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
      }, invalidatePartsAndWorkOrders);
      if (ok && entries.length) fire("Part updated");
      return ok;
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
      }, invalidatePartsAndWorkOrders);
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
      await qc.invalidateQueries({ queryKey: WO_PARTS_KEY });
      invalidateWorkOrders();
      fire("Added to P1 purchasing");
      return true;
    } catch (error: any) {
      fire(`P1 purchasing request failed: ${safeErrorMessage(error)}`);
      return false;
    } finally {
      setLoading("p1Part_" + partId, false);
    }
  };

  const doSetP1PartOrderStatus = async (
    partId: string,
    status: "requested" | "ordered" | "received" | "cancelled",
    unitCost?: number | null,
  ) => {
    setLoading("p1Part_" + partId, true);
    try {
      const updated = await setP1PartOrderStatusWithCost(partId, status, unitCost);
      patchPartsCache(rows => rows.map(row => row.id === partId ? updated : row));
      await qc.invalidateQueries({ queryKey: WO_PARTS_KEY });
      await qc.invalidateQueries({ queryKey: P1_PART_COSTS_KEY });
      await qc.invalidateQueries({ queryKey: BILLABLE_P1_PARTS_KEY });
      invalidateWorkOrders();
      fire(`P1 purchasing marked ${status}`);
      return true;
    } catch (error: any) {
      fire(`P1 purchasing update failed: ${safeErrorMessage(error)}`);
      return false;
    } finally {
      setLoading("p1Part_" + partId, false);
    }
  };

  const doCloseComplete = async (woId: string, make: string, model: string, serial: string, resolution: string, assetYear?: number | null, completedAt?: string, resolutionNotes?: string) => {
    if (lifecycleInFlight.current.has(woId)) return false;
    lifecycleInFlight.current.add(woId);
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
      const patch: Record<string, unknown> = {
        status: workOrderStatusAfterFieldCompletion(existing?.status),
        functionalStatus: "Completed",
        assetMake: make,
        assetModel: model,
        assetSerial: serial,
        endTime: formattedEnd,
        endTimeRaw: endIso,
        resolutionCode: resolution || null,
        resolutionNotes: cleanNotes || null,
      };
      if (assetYear) patch.assetYear = assetYear;

      const snapshot = qc.getQueryData(WORK_ORDERS_KEY);
      patchLocalWO(woId, patch, localActivity(text, "note", isManager, "job_completed", true, false, "field_note"));
      let completionResult: {
        applied: boolean;
        reason?: string;
        workOrderStatus?: string;
      } | undefined;
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
          context: lifecycleContextFor(existing),
        });
      }, "Close failed", () => restoreWorkOrders(snapshot), invalidateWorkOrders);
      if (saved && completionResult?.applied === false) {
        restoreWorkOrders(snapshot);
        invalidateWorkOrders();
        fire("Work order was already completed");
      } else if (saved) {
        fire("Completed");
      }
      return saved;
    } finally {
      lifecycleInFlight.current.delete(woId);
      setLoading("closeComplete_" + woId, false);
    }
  };

  const doMoveToInvoice = async (woId: string) => {
    if (lifecycleInFlight.current.has(woId)) return false;
    lifecycleInFlight.current.add(woId);
    setLoading("moveToInvoice_" + woId, true);
    const snapshot = qc.getQueryData(WORK_ORDERS_KEY);
    try {
      let attempt = billingReadyAttempts.current.get(woId);
      if (!attempt) {
        attempt = createBillingReadyAttempt(workOrders.find(workOrder => workOrder.id === woId));
        billingReadyAttempts.current.set(woId, attempt);
      }
      const result = await attempt((name, args) => supabase().rpc(name, args));
      billingReadyAttempts.current.delete(woId);
      patchLocalWO(woId, { status: result.workOrderStatus, lifecycleVersion: result.lifecycleVersion },
        result.applied ? localActivity("7-Eleven portal updated. Moved to Pending 7-Eleven Submission.",
          "system", false, "staff_billing", false, true) : undefined);
      invalidateWorkOrders();
      fire("Moved to Pending 7-Eleven Submission");
      return true;
    } catch (error) {
      const safe = safeLifecycleError(error);
      if (["PT409", "42501", "22023"].includes(safe.code)) billingReadyAttempts.current.delete(woId);
      restoreWorkOrders(snapshot);
      invalidateWorkOrders();
      fire(`Update failed: ${safe.message}`);
      return false;
    } finally {
      lifecycleInFlight.current.delete(woId);
      setLoading("moveToInvoice_" + woId, false);
    }
  };

  const doFinishContractorInvoicing = async (woId: string) => {
    setLoading("finishInvoicing_" + woId, true);
    try {
      const result = await finishContractorInvoicing(woId);
      patchLocalWO(
        woId,
        {
          status: result.workOrderStatus,
          contractorInvoicingCompletedAt: result.completedAt,
          contractorInvoicingCompletedBy: result.completedBy || currentUser?.id || null,
          contractorInvoicingAssignmentVersion:
            workOrders.find(workOrder => workOrder.id === woId)?.contractorAssignmentVersion ?? null,
          contractorInvoicingWorkflowCycle:
            workOrders.find(workOrder => workOrder.id === woId)?.workflowCycle ?? null,
          contractorInvoicingCompletionSource: result.source || "contractor",
        },
        result.applied
          ? localActivity(
              `Invoicing marked complete by ${currentUser?.name || "contractor"}.`,
              "system",
              false,
              "contractor_invoicing_completed",
            )
          : undefined,
      );
      invalidateBoth();
      fire(result.applied
        ? "Contractor job closed for invoicing — staff can continue approval and billing"
        : "This contractor job was already closed for invoicing");
      return true;
    } catch (error: any) {
      invalidateBoth();
      fire(`Could not finish invoicing: ${rpcErrorMessage(error)}`);
      return false;
    } finally {
      setLoading("finishInvoicing_" + woId, false);
    }
  };

  // The guarded review command checks current state, approves, recomputes the parent WO, and writes one structured
  // activity entry. Rejected siblings keep the WO in pending_approval.
  const doApproveInvoice = async (invoiceId: string) => {
    const releaseInvoiceLock = acquireInvoiceMutationLocks([invoiceId]);
    if (!releaseInvoiceLock) {
      fire("This invoice already has a review in progress");
      return false;
    }
    setLoading("approveInvoice_" + invoiceId, true);
    try {
    const inv = invoices.find((i: any) => i.id === invoiceId)
      || await loadInvoiceSummaryById(invoiceId);
    if (!inv) { fire("Invoice not found"); return false; }
    const woSnapshot = qc.getQueryData(WORK_ORDERS_KEY);
    const invSnapshot = qc.getQueryData(INVOICES_KEY);
    const cachedInvoices = invoices.some((i: any) => i.id === invoiceId)
      ? invoices
      : [...invoices, inv];
    const nextInvoices = cachedInvoices.map((i: any) => i.id === invoiceId ? { ...i, state: "approved" } : i);
    setInvoices(nextInvoices);
    patchLocalWO(
      inv.wot,
      {},
      localActivity(
        `Invoice #${inv.num} approved by ${currentUser.name}.`,
        "system",
        false,
        "invoice_approved",
      ),
    );
    let approvedWorkOrderStatus: string | null = null;
    const ok = await dbCall(async () => {
      const result = await reviewContractorInvoice(inv.id, "approve");
      approvedWorkOrderStatus = result.workOrderStatus || null;
      if (result.workOrderStatus) {
        patchLocalWO(inv.wot, { status: result.workOrderStatus });
      }
    }, "Approval failed", () => {
      restoreWorkOrders(woSnapshot);
      restoreInvoices(invSnapshot);
    }, undefined, error => isRpcConflict(error)
      ? rpcConflictMessage("Invoice")
      : `Approval failed: ${rpcErrorMessage(error)}`);
    if (ok) {
      fire(approvedWorkOrderStatus === "pending_invoice"
        ? `Invoice #${inv.num} approved — ready for P1 billing`
        : `Invoice #${inv.num} approved`);
    }
    return Boolean(ok);
    } catch (error: any) {
      fire(`Approval failed: ${safeErrorMessage(error)}`);
      return false;
    } finally {
      setLoading("approveInvoice_" + invoiceId, false);
      releaseInvoiceLock();
    }
  };

  // Per-invoice QuickBooks handoff. The internal 'paid' value is retained for
  // database compatibility while the portal presents "Entered in QuickBooks".
  // status. The WO is NEVER auto-closed here — capital jobs receive
  // additional invoices for weeks after payments start landing. Operational
  // closure remains in the billing, capital, or guarded no-billing workflows.
  const doMarkPaid = async (invoiceId: string) => {
    setLoading("markPaid_" + invoiceId, true);
    try {
      // Retained compatibility callback; no current UI invokes this legacy
      // shortcut. The revision-bound payables package owns handoff evidence.
      fire("Use the contractor-bill payables package workflow to confirm QuickBooks entry.");
      return false;
    } finally {
      setLoading("markPaid_" + invoiceId, false);
    }
  };
  // Staff-only no-billing terminal path. The database locks the work order,
  // confirms that no live contractor or P1 invoice exists, closes every open
  // visit, and writes the audit event in one transaction.
  const doCloseWithoutInvoice = async (
    woId: string,
    expectedWorkflowCycle: number,
    expectedContractorAssignmentVersion: number,
    expectedUpdatedAt: string,
  ) => {
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
        () => closeWorkOrderWithoutInvoice(
          woId,
          expectedWorkflowCycle,
          expectedContractorAssignmentVersion,
          expectedUpdatedAt,
        ),
        "Close without invoice failed",
        () => restoreWorkOrders(snapshot),
      );
      if (ok) fire("Work order closed without an invoice");
      return Boolean(ok);
    } finally {
      setLoading("closeWithoutInvoice_" + woId, false);
    }
  };

  // Staff-only terminal path for an already-billed work order that was
  // reopened for field follow-up. The RPC validates the expected reopen
  // cycle, prior billing, current-cycle invoices, pending 7-Eleven updates,
  // and closes the work order plus open visits atomically.
  const doCloseReopenedFollowUp = async (
    woId: string,
    expectedWorkflowCycle: number,
    expectedContractorAssignmentVersion: number,
    expectedUpdatedAt: string,
    reason: string,
  ) => {
    setLoading("closeReopenedFollowUp_" + woId, true);
    try {
      const result = await closeReopenedWorkOrderWithoutAdditionalBilling(
        woId,
        expectedWorkflowCycle,
        expectedContractorAssignmentVersion,
        expectedUpdatedAt,
        reason,
      );
      if (!result.applied && result.reason === "already_closed") {
        invalidateWorkOrders();
        fire("Work order is already closed");
        return true;
      }
      if (!result.applied) {
        invalidateWorkOrders();
        fire("The follow-up was not closed. Refresh the work order and try again.");
        return false;
      }

      const text = `Reopened follow-up closed by ${currentUser.name} with no additional billing. Reason: ${reason.trim()}`;
      patchLocalWO(
        woId,
        {
          status: result.workOrderStatus,
          functionalStatus: result.functionalStatus,
          closedAt: result.closedAt,
          workflowCycle: result.workflowCycle,
        },
        {
          ...localActivity(
            text,
            "system",
            false,
            "work_order_follow_up_closed_without_additional_billing",
            false,
            true,
            "internal_note",
          ),
          author: currentUser.name,
          workflowCycle: result.workflowCycle,
          eventData: {
            action: "closed_without_additional_billing",
            reason: reason.trim(),
            workflowCycle: result.workflowCycle,
            invoicesChanged: false,
          },
        },
      );
      invalidateWorkOrders();
      fire("Follow-up closed with no additional billing");
      return true;
    } catch (error: unknown) {
      invalidateWorkOrders();
      fire(`Follow-up close failed: ${rpcErrorMessage(error)}`);
      return false;
    } finally {
      setLoading("closeReopenedFollowUp_" + woId, false);
    }
  };

  // Reopening is one locked server-side lifecycle transition. The RPC owns
  // authorization, mode-specific status selection, repeat-completion
  // boundaries, and the audit record. Apply local state only after commit;
  // invoices, assignments, technicians, and prior visits remain untouched.
  const doReopen = async (
    woId: string,
    mode: WorkOrderReopenMode,
    reason: string,
  ) => {
    setLoading("reopen_" + woId, true);
    try {
      const result = await reopenWorkOrder(woId, mode, reason);
      if (!result.applied && result.reason === "already_open") {
        invalidateWorkOrders();
        fire("Work order is already open");
        return true;
      }

      const purpose = mode === "resume_work" ? "field work" : "billing follow-up";
      const text = `Work order reopened by ${currentUser.name} for ${purpose}. Reason: ${reason.trim()}`;
      patchLocalWO(
        woId,
        {
          status: result.workOrderStatus,
          functionalStatus: result.functionalStatus,
          closedAt: result.closedAt,
          billingReadyAt: result.billingReadyAt ?? null,
          workflowCycle: result.workflowCycle,
        },
        localActivity(
          text,
          "system",
          false,
          "work_order_reopened",
          false,
          true,
        ),
      );
      invalidateWorkOrders();
      fire(mode === "resume_work"
        ? "Work order reopened for field work"
        : "Work order reopened for billing follow-up");
      return true;
    } catch (error: any) {
      // A network interruption can hide a committed response. Refetch the
      // authoritative server state before the user retries.
      invalidateWorkOrders();
      fire(`Reopen failed: ${safeErrorMessage(error)}`);
      return false;
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
      const text = "Marked as a capital replacement and ready for quote preparation.";
      let confirmedLifecycleVersion = 0;
      const saved = await dbCall(async () => {
        const authoritativeWorkOrder = await loadWorkOrderById(woId);
        if (!authoritativeWorkOrder) throw new Error("Work order not found");
        const context = lifecycleContextFor(authoritativeWorkOrder);
        await flagWorkOrderCapital(context);
        confirmedLifecycleVersion = context.expectedLifecycleVersion + 1;
      }, "Capital flag failed");
      if (!saved) return false;
      patchLocalWO(woId, {
        status: "capital",
        functionalStatus: "Work in Progress",
        capitalStatus: null,
        isCapital: true,
        lifecycleVersion: confirmedLifecycleVersion,
      }, localActivity(text, "system"));
      fire("Flagged for capital");
      return true;
    } finally {
      setLoading("capitalFlag_" + woId, false);
    }
  };

  const doCapitalDecline = async (woId: string) => {
    setLoading("capitalDecline_" + woId, true);
    try {
    const workOrder = workOrders.find(item => item.id === woId)
      || await loadWorkOrderById(woId);
    if (!workOrder) { fire("Work order not found"); return false; }
    const result = await declineCapitalWorkOrder(
      woId,
      Number(workOrder.contractorAssignmentVersion || 0),
    );
    if (!result.applied) {
      fire("Capital decline was not applied. Refresh and try again.");
      return false;
    }
    const destination = result.contractorId ? "dispatched" : "the unassigned queue";
    const text = `Capital replacement declined by ${currentUser.name}. Work order returned to ${destination}.`;
    const patch = {
      status: result.status,
      functionalStatus: result.functionalStatus,
      contractor: result.contractorId,
      contractorAssignmentVersion: result.assignmentVersion,
      isCapital: result.isCapital,
      capitalStatus: result.capitalStatus,
    };
    patchLocalWO(woId, patch, localActivity(text, "system"));
    fire(`Capital declined - returned to ${destination}`);
    invalidateWorkOrders();
    return true;
    } catch (error: unknown) {
      invalidateWorkOrders();
      fire(`Capital decline failed: ${rpcErrorMessage(error)}`);
      return false;
    } finally {
      setLoading("capitalDecline_" + woId, false);
    }
  };

  const doCapitalComplete = async (woId: string) => {
    setLoading("capitalComplete_" + woId, true);
    try {
      const workOrder = workOrders.find((item: any) => item.id === woId)
        || await loadWorkOrderById(woId);
      if (!workOrder || workOrder.status !== "pending_capital_completion") {
        fire("This work order is not pending capital completion");
        return false;
      }
      const completedAt = new Date().toISOString();
      const patch = {
        status: "pending_invoice",
        functionalStatus: "Completed",
        capitalStatus: "Installed",
        isCapital: true,
        billingReadyAt: completedAt,
        billingReadyBy: currentUser.id,
      };
      const snapshot = qc.getQueryData(WORK_ORDERS_KEY);
      patchLocalWO(
        woId,
        patch,
        localActivity(
          `Capital work marked completed by ${currentUser.name} and moved to final billing.`,
          "system",
        ),
      );
      const completed = await dbCall(
        () => completeCapitalWork(woId),
        "Capital completion failed",
        () => restoreWorkOrders(snapshot),
      );
      if (completed) fire("Capital completed — ready for final billing");
      return completed;
    } catch (error: any) {
      fire(`Capital completion failed: ${safeErrorMessage(error)}`);
      return false;
    } finally {
      setLoading("capitalComplete_" + woId, false);
    }
  };

  const doCapitalResume = async (woId: string) => {
    setLoading("capitalResume_" + woId, true);
    try {
      const result = await resumeCapitalWork(woId);
      patchLocalWO(woId, {
        status: result.status,
        functionalStatus: result.functional_status,
        capitalStatus: result.capital_status,
        isCapital: result.is_capital,
        contractorAssignmentVersion: result.contractor_assignment_version,
        lifecycleVersion: result.lifecycle_version,
      }, localActivity(
        `Capital work authorized by 7-Eleven and released for the next field visit by ${currentUser.name}.`,
        "system",
      ));
      invalidateWorkOrders();
      fire("Capital work authorized — contractor can begin the next visit");
      return true;
    } catch (error: unknown) {
      invalidateWorkOrders();
      fire(`Capital authorization failed: ${rpcErrorMessage(error)}`);
      return false;
    } finally {
      setLoading("capitalResume_" + woId, false);
    }
  };


  const doAutoAssign = async () => {
    const unassigned: any[] = [];
    let cursor: string | null = null;
    try {
      do {
        const page = await loadWorkOrdersPage({
          scope: "active",
          status: "unassigned",
          sort: "priority",
          limit: 100,
          cursor,
        });
        unassigned.push(...page.items);
        cursor = page.hasMore ? page.nextCursor : null;
      } while (cursor);
    } catch (error: any) {
      fire(`Auto-dispatch could not load the unassigned queue: ${safeErrorMessage(error)}`);
      return;
    }
    if (unassigned.length === 0) { fire("No unassigned calls"); return; }
    let count = 0;
    let skipped = unassigned.filter(w =>
      ["TX", "FL"].includes(stateCodeFromWorkOrder(w)),
    ).length;
    let hadError = false;
    const chunks = chunkArray(unassigned, 10);
    await mapChunksWithConcurrency(chunks, async chunk => {
      for (const w of chunk) {
        if (["TX", "FL"].includes(stateCodeFromWorkOrder(w))) continue;
        const trades = SERVICE_TO_TRADES(w.businessService || "", w.category || "");
        try {
          // The database ranks the whole authorized candidate set and returns
          // only its best match; a loaded directory page is never the universe.
          const c = await loadAutoAssignmentCandidate(w.city || "", trades);
          if (!c) { skipped++; continue; }
          const matched = c.id;
          const text = `Dispatched to ${c.name}${c.company ? ` (${c.company})` : ""}.`;
          const transition = await assignmentAttempts.current.run(w, "transition", matched, context => transitionWorkOrderContractor(
            w.id,
            matched,
            context.expectedAssignmentVersion,
            context,
          ));
          patchLocalWO(
            w.id,
            assignmentBoundaryPatch(w, transition),
            localActivity(text, "system", false, "work_order_assignment", false, true),
          );
          await notifyDispatch(w.id, matched);
          count++;
        } catch (e: any) {
          hadError = true;
          fire(`${w.id}: ${safeErrorMessage(e)}`);
        }
      }
    }, 3);
    invalidateBoth();
    if (hadError) return;
    fire(skipped > 0 ? `Auto-dispatched ${count} · ${skipped} need manual assignment` : `Auto-dispatched ${count} call${count !== 1 ? "s" : ""}`);
  };

  const doPostNote = async (
    woId: string,
    requestedChannel: "field_note" | "internal_note" | "contractor_message" = currentUser?.role === "contractor"
      ? "field_note"
      : "internal_note",
    explicitText?: string,
  ) => {
    const text = (explicitText ?? noteText).trim();
    if (!text) return false;
    const channel = currentUser?.role === "contractor" && requestedChannel === "internal_note"
      ? "contractor_message"
      : requestedChannel;
    const isStaffOnly = channel === "internal_note";
    const automaticallyNotifyContractor = shouldAutomaticallyNotifyContractor(
      currentUser?.role,
      channel,
    );
    setLoading("postNote_" + woId, true);
    try {
    const snapshot = qc.getQueryData(WORK_ORDERS_KEY);
    if (explicitText === undefined) setNoteText("");
    patchLocalWO(woId, {}, { author: currentUser.name, time: dateNow(), text, type: "note", activityChannel: channel, enteredByRole: currentUser?.role || "system", isStaffOverride: false, isStaffOnly, requiresSevenElevenSync: channel === "field_note", syncedToSevenElevenAt: null, requiresContractorAttention: automaticallyNotifyContractor, contractorAcknowledgedAt: null });
    if (!automaticallyNotifyContractor) {
      fire(channel === "internal_note" ? "Internal note posted" : channel === "contractor_message" ? "Message posted" : "Field note posted");
    }
    let activityId: string | null = null;
    const saved = await dbCall(async () => {
      activityId = await insertActivity(woId, currentUser.name, text, "note", {
        eventKey: "note",
        activityChannel: channel,
        staffOnly: isStaffOnly,
        requiresSevenElevenSync: channel === "field_note",
        requiresContractorAttention: automaticallyNotifyContractor,
      });
    }, "Note save failed", () => restoreWorkOrders(snapshot));
    if (!saved) return false;

    if (automaticallyNotifyContractor && activityId) {
      try {
        const delivery = await notifyContractorAttention(woId, activityId);
        fire(contractorNotificationToast(delivery));
      } catch (emailError: any) {
        fire(`Message posted and contractor alert saved, but notification delivery needs review: ${emailError.message || emailError}`);
      }
    }
    return saved;
    } finally {
      setLoading("postNote_" + woId, false);
    }
  };


  const refreshPhotoDetails = (woId: string) => {
    void qc.invalidateQueries({ queryKey: workOrderDetailsKey(woId) });
    void qc.invalidateQueries({ queryKey: workOrderByIdKey(woId) });
    void qc.invalidateQueries({ queryKey: workOrderChildCountKey(readScope, woId, "photos") });
  };
  const patchConfirmedPhotos = (woId: string, paths: readonly string[]) => {
    if (!paths.length) return;
    const merge = (current: readonly string[] = []) => [...new Set([...current, ...paths])];
    qc.setQueryData<{ id: string; photos?: string[] }[]>(WORK_ORDERS_KEY, old => old?.map(workOrder =>
      workOrder.id === woId ? { ...workOrder, photos: merge(workOrder.photos) } : workOrder));
    qc.setQueryData<{ photos?: string[] }>(workOrderDetailsKey(woId, readScope), old => old ? { ...old, photos: merge(old.photos) } : old);
    setWorkOrders(previous => previous.map(workOrder => workOrder.id === woId
      ? { ...workOrder, photos: merge(workOrder.photos) } : workOrder));
  };
  const photoSummary = (items: readonly PhotoUploadItem[]) => {
    const confirmed = items.filter(item => item.status === "confirmed").length;
    const unfinished = items.filter(item => item.status === "failed" || item.status === "cleanup_required").length;
    fire(unfinished ? `${confirmed} photo${confirmed === 1 ? "" : "s"} uploaded; ${unfinished} need attention. Retry or cancel the affected photos.`
      : confirmed ? `${confirmed} photo${confirmed === 1 ? "" : "s"} uploaded` : "Photo upload cancelled");
  };
  const doAddPhotos = async (woId: string, files: FileList | null) => {
    if (!files?.length || photoUploadInFlight.current.has(woId)) return;
    photoUploadInFlight.current.add(woId);
    const generation = photoSessionGeneration.current.value;
    setLoading("addPhotos_" + woId, true);
    try {
      const existing = photoControllers.current.get(woId);
      let controller = existing?.controller;
      if (!controller || controller.snapshot().every(item => item.status === "confirmed" || item.status === "cancelled")) {
        const workOrder = workOrders.find(row => row.id === woId) ?? await loadWorkOrderById(woId);
        if (generation !== photoSessionGeneration.current.value) return;
        const assignmentVersion: unknown = workOrder?.contractorAssignmentVersion;
        const workflowCycle: unknown = workOrder?.workflowCycle;
        if (!workOrder || typeof assignmentVersion !== "number" || !Number.isSafeInteger(assignmentVersion) || assignmentVersion < 0
          || typeof workflowCycle !== "number" || !Number.isSafeInteger(workflowCycle) || workflowCycle < 0) {
          throw new PhotoUploadError("Refresh the work order before adding photos.", false);
        }
        if (!existing || existing.assignmentVersion !== assignmentVersion || existing.workflowCycle !== workflowCycle) {
          const displayedPaths = new Set<string>();
          controller = createPhotoUploadController(createWorkOrderPhotoPorts(woId, assignmentVersion, workflowCycle), {
            onChange: items => {
              if (generation !== photoSessionGeneration.current.value) return;
              setPhotoUploadItems(previous => ({ ...previous, [woId]: items }));
              const newlyConfirmed: string[] = [];
              for (const item of items) {
                if (item.status === "confirmed" && item.storagePath && !displayedPaths.has(item.storagePath)) {
                  displayedPaths.add(item.storagePath); newlyConfirmed.push(item.storagePath);
                }
              }
              patchConfirmedPhotos(woId, newlyConfirmed);
            },
          });
          photoControllers.current.set(woId, { controller, assignmentVersion, workflowCycle });
        }
      }
      if (!controller) throw new PhotoUploadError("Refresh the work order before adding photos.", false);
      if (controller.busy) throw new PhotoUploadError("Wait for the current photo operation to finish before choosing another batch.", false);
      fire(`Uploading ${files.length} photo${files.length > 1 ? "s" : ""}...`);
      const items = await controller.start(Array.from(files));
      if (generation === photoSessionGeneration.current.value) photoSummary(items);
    } catch (error: unknown) {
      if (generation === photoSessionGeneration.current.value) fire(error instanceof PhotoUploadError ? error.message : "Photo upload could not be confirmed. Check the per-photo status before retrying.");
    } finally {
      if (generation === photoSessionGeneration.current.value) {
        refreshPhotoDetails(woId);
        setLoading("addPhotos_" + woId, false);
        photoUploadInFlight.current.delete(woId);
      }
    }
  };
  const retryPhotoUploads = async (woId: string, operationIds?: readonly string[]) => {
    const controller = photoControllers.current.get(woId)?.controller;
    if (!controller || photoUploadInFlight.current.has(woId)) return;
    photoUploadInFlight.current.add(woId);
    const generation = photoSessionGeneration.current.value;
    setLoading("addPhotos_" + woId, true);
    try {
      const items = await controller.retry(operationIds);
      if (generation === photoSessionGeneration.current.value) photoSummary(items);
    }
    finally {
      if (generation === photoSessionGeneration.current.value) {
        refreshPhotoDetails(woId);
        setLoading("addPhotos_" + woId, false);
        photoUploadInFlight.current.delete(woId);
      }
    }
  };
  const cancelPhotoUploads = async (woId: string, operationIds?: readonly string[]) => {
    const controller = photoControllers.current.get(woId)?.controller;
    if (!controller) return;
    const generation = photoSessionGeneration.current.value;
    setLoading("addPhotos_" + woId, true);
    try { await controller.cancel(operationIds); }
    finally {
      if (generation === photoSessionGeneration.current.value) { refreshPhotoDetails(woId); setLoading("addPhotos_" + woId, false); }
    }
  };

  const doRemovePhoto = async (woId: string, photo: number | string) => {
    if (photoDeleteInFlight.current.has(woId)) return;
    photoDeleteInFlight.current.add(woId);
    const generation = photoSessionGeneration.current.value;
    setLoading("removePhoto_" + woId, true);
    setPhotoDeleteErrors(previous => ({ ...previous, [woId]: "" }));
    try {
    const wo = workOrders.find(w => w.id === woId);
    const path: string | undefined = typeof photo === "number" ? wo?.photos?.[photo] : photo;
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
    photoDeleteTargets.current.set(woId, storagePath);
    const result = await removePhoto(woId, storagePath);
    if (generation !== photoSessionGeneration.current.value) return;
    if (!result.success) {
      const message = "Photo removal is not confirmed. Retry removing this photo to check cleanup; do not upload a replacement yet.";
      setPhotoDeleteErrors(previous => ({ ...previous, [woId]: message }));
      fire(message);
      return;
    }
    qc.setQueryData<{ id: string; photos?: string[] }[]>(WORK_ORDERS_KEY, old =>
      old?.map(w => w.id === woId
          ? { ...w, photos: (w.photos || []).filter(p => p !== path && p !== storagePath) }
        : w)
    );
    setWorkOrders(prev => prev.map(w => w.id === woId ? { ...w, photos: (w.photos || []).filter((p: string) => p !== path && p !== storagePath) } : w));
    qc.setQueryData<{ photos?: string[] }>(workOrderDetailsKey(woId, readScope), old => old
      ? { ...old, photos: (old.photos || []).filter(candidate => candidate !== path && candidate !== storagePath) } : old);
    photoDeleteTargets.current.delete(woId);
    fire("Photo removed");
    } catch {
      if (generation !== photoSessionGeneration.current.value) return;
      const message = "Photo removal is not confirmed. Retry removing this photo to check cleanup.";
      setPhotoDeleteErrors(previous => ({ ...previous, [woId]: message }));
      fire(message);
    } finally {
      if (generation === photoSessionGeneration.current.value) {
        refreshPhotoDetails(woId);
        setLoading("removePhoto_" + woId, false);
        photoDeleteInFlight.current.delete(woId);
      }
    }
  };
  const retryPhotoDeletion = async (woId: string) => {
    const storagePath = photoDeleteTargets.current.get(woId);
    if (storagePath) await doRemovePhoto(woId, storagePath);
  };

  const doStraightToBilling = async (woId: string) => {
    let workOrder = workOrders.find(wo => wo.id === woId) || null;
    if (!workOrder) {
      try {
        workOrder = await loadWorkOrderById(woId);
      } catch (error: any) {
        fire(`Could not load work order: ${safeErrorMessage(error)}`);
        return false;
      }
    }
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
        const changedActivity = (w.activities || []).find((activity: any) => activity.id === activityId);
        const wasPending = !!changedActivity?.requiresSevenElevenSync
          && !changedActivity?.syncedToSevenElevenAt;
        const willBePending = !!changedActivity?.requiresSevenElevenSync && !synced;
        const pendingDelta = Number(willBePending) - Number(wasPending);
        const pendingCount = Math.max(0, pendingSevenElevenCountFor(w) + pendingDelta);
        const activities = (w.activities || []).map((activity: any) =>
          activity.id === activityId
            ? { ...activity, syncedToSevenElevenAt: synced ? new Date().toISOString() : null }
            : activity
        );
        const pending = (w.pendingSevenElevenActivities || [])
          .filter((activity: any) => activity.id !== activityId);
        if (willBePending && changedActivity) {
          pending.unshift({
            ...changedActivity,
            syncedToSevenElevenAt: null,
          });
        }
        return {
          ...w,
          activities,
          pendingSevenElevenActivities: pending,
          pendingSevenElevenSyncCount: pendingCount,
          hasPendingSevenElevenSync: pendingCount > 0,
        };
      }));
      invalidateWorkOrders();
      fire(synced ? "Marked updated in 7-Eleven" : "7-Eleven update reopened");
    } catch (e: any) {
      fire(`7-Eleven sync update failed: ${safeErrorMessage(e)}`);
    } finally {
      setLoading("sync711_" + activityId, false);
    }
  };

  const notifyContractorAttention = async (
    workOrderId: string,
    activityId: string,
  ): Promise<ContractorNotificationDelivery> => {
    const sb = supabase();
    const { data } = await sb.auth.getSession();
    const token = data.session?.access_token;
    if (!token) throw new Error("Authentication session is unavailable");

    const res = await apiFetch("/api/notifications/contractor-attention", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ workOrderId, activityId }),
    });

    const payload = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(payload.error || res.statusText || "Email request failed");
    }

    const delivery = payload.delivery as ContractorNotificationDelivery | undefined;
    if (!delivery || ![
      "sent",
      "already_sent",
      "pending_or_unknown",
      "delivery_unknown",
    ].includes(delivery)) {
      throw new Error("Email delivery returned an unknown state");
    }
    return delivery;
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
          const delivery = await notifyContractorAttention(woId, activityId);
          fire(contractorAttentionRequestToast(delivery));
        } catch (emailError: any) {
          fire(`Attention saved, but email failed: ${emailError.message || emailError}`);
        }
      } else {
        fire("Contractor attention cleared");
      }
    } catch (e: any) {
      fire(`Contractor attention update failed: ${safeErrorMessage(e)}`);
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
      fire(`Attention acknowledgement failed: ${safeErrorMessage(e)}`);
    } finally {
      setLoading("contractorAck_" + activityId, false);
    }
  };



  return {
    workOrders, setWorkOrders,
    loadingStates,
    patchLocalWO, localActivity, dbCall,
    doAssign, doStraightToBilling, doUnassign, doDeleteWO,
    doRejectUnassignedWO, doDuplicateForReassignment, doReassign, doAdministrativeTransfer,
    doStartWork, doPauseWork, doCloseComplete,
    doMoveToInvoice, doFinishContractorInvoicing,
    doApproveInvoice, doMarkPaid, doCloseWithoutInvoice,
    doCloseReopenedFollowUp, doReopen,
    doEditWorkOrder, doCapitalFlag, doCapitalDecline, doCapitalResume, doCapitalComplete, doAutoAssign,
    doSetEta, doSetTechnician, doAssignPortalTechnician, doPostNote, doDeleteActivity,
    doAddPhotos, doRemovePhoto, photoUploadItems, retryPhotoUploads, cancelPhotoUploads, photoDeleteErrors, retryPhotoDeletion,
    doAddPart, doUpdatePart, doDeletePart,
    doRequestP1PartOrder, doSetP1PartOrderStatus,
    doMarkSevenElevenSynced,
    doMarkContractorAttention,
    doAcknowledgeContractorAttention,
  };
}
