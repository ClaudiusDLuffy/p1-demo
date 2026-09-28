"use client";

import { useCallback, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { timezoneForWorkOrder, storeLocalDateTimeToIso } from "../../lib/billingRules";
import { setWorkOrderEta } from "../../lib/db";
import { safeLifecycleError, lifecycleContextFor } from "../../lib/workOrderLifecycleCommands";
import { canSetWorkOrderEta } from "../../lib/workOrderDispatchActions";
import type { WorkOrderReadModel } from "../work-orders/data/workOrderReadContracts";
import {
  PORTAL_NAVIGATION_SUMMARY_KEY,
  WORK_ORDER_BY_ID_KEY,
  WORK_ORDER_PAGES_KEY,
} from "../work-orders/queries";
import { toDateKey } from "./scheduleModel";

type UseWorkOrderSchedulingOptions = {
  onScheduled: (date: string) => void;
};

export function useWorkOrderScheduling({ onScheduled }: UseWorkOrderSchedulingOptions) {
  const queryClient = useQueryClient();
  const [target, setTarget] = useState<WorkOrderReadModel | null>(null);
  const [date, setDate] = useState(() => toDateKey(new Date()));
  const [time, setTime] = useState("09:00");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const inFlight = useRef(false);
  const changeDate = useCallback((value: string) => { setDate(value); setError(""); }, []);
  const changeTime = useCallback((value: string) => { setTime(value); setError(""); }, []);

  const open = useCallback((workOrder: WorkOrderReadModel, targetDate: string) => {
    setTarget(workOrder);
    setDate(targetDate);
    setTime("09:00");
    setError("");
  }, []);

  const close = useCallback(() => {
    if (saving) return;
    setTarget(null);
    setError("");
  }, [saving]);

  const save = useCallback(async () => {
    if (!target || inFlight.current) return;
    if (!date || !time) {
      setError("Choose both a date and a time.");
      return;
    }
    const scheduleEligible = canSetWorkOrderEta({
      contractorId: target.contractor,
      status: target.status,
      functionalStatus: target.functionalStatus,
      assignmentTransferPendingVisit: target.assignmentTransferPendingVisit,
    });
    if (!scheduleEligible) {
      setError("This work order changed and can no longer be scheduled from this view. Refresh and review it.");
      return;
    }

    inFlight.current = true;
    setSaving(true);
    setError("");
    try {
      const eta = storeLocalDateTimeToIso(date, time, timezoneForWorkOrder(target));
      await setWorkOrderEta({ ...lifecycleContextFor(target), eta });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: WORK_ORDER_PAGES_KEY }),
        queryClient.invalidateQueries({ queryKey: WORK_ORDER_BY_ID_KEY }),
        queryClient.invalidateQueries({ queryKey: PORTAL_NAVIGATION_SUMMARY_KEY }),
      ]);
      setTarget(null);
      onScheduled(date);
    } catch (reason) {
      setError(safeLifecycleError(reason).message);
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  }, [date, onScheduled, queryClient, target, time]);

  return {
    close,
    date,
    error,
    open,
    save,
    saving,
    setDate: changeDate,
    setTime: changeTime,
    target,
    time,
  };
}

export type WorkOrderSchedulingController = ReturnType<typeof useWorkOrderScheduling>;
