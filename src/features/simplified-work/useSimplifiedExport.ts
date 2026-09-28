"use client";

import { useEffect, useRef, useState } from "react";
import { safeErrorMessage } from "../../lib/errors/normalizeUnknown";
import type { WorkOrderPageParams } from "../work-orders/data/workOrderReadContracts";
import { collectSimplifiedExport, SimplifiedExportLimitError } from "./simplifiedExportRead";
import { downloadSimplifiedWorkOrders } from "./simplifiedWorkExport";

export function useSimplifiedExport(params: Omit<WorkOrderPageParams, "cursor" | "limit">, enabled: boolean, actorScope: string) {
  const request = useRef<AbortController | null>(null);
  const identity = JSON.stringify([params, enabled, actorScope]);
  const [state, setState] = useState({ identity, busy: false, count: 0, message: "", error: "" });
  // Discard the previous scope's presentation, including when returning to a
  // mounted tab after its export was aborted. Hiding it alone revives stale busy state.
  if (state.identity !== identity) {
    setState({ identity, busy: false, count: 0, message: "", error: "" });
  }

  useEffect(() => {
    request.current?.abort();
    request.current = null;
    return () => { request.current?.abort(); request.current = null; };
  }, [identity]);

  async function start() {
    if (!enabled || request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setState({ identity, busy: true, count: 0, error: "", message: "" });
    try {
      const rows = await collectSimplifiedExport(params, controller.signal, count => setState(current => ({ ...current, count })));
      controller.signal.throwIfAborted();
      if (rows.length) downloadSimplifiedWorkOrders(rows);
      setState(current => ({ ...current, message: rows.length ? `Exported ${rows.length} matching work orders.` : "No work orders match these filters." }));
    } catch (reason) {
      if (!controller.signal.aborted) setState(current => ({ ...current, error: reason instanceof SimplifiedExportLimitError
        ? reason.message : `Export failed. No partial file was downloaded. ${safeErrorMessage(reason)}` }));
    } finally {
      if (request.current === controller) { request.current = null; setState(current => ({ ...current, busy: false })); }
    }
  }

  function cancel() {
    request.current?.abort(); request.current = null;
    setState(current => ({ ...current, busy: false, message: "Export cancelled. No file was downloaded." }));
  }
  // An inactive/changed scope never exposes or downloads the preceding actor's result.
  const visible = state.identity === identity ? state : { busy: false, count: 0, message: "", error: "" };
  return { start, cancel, ...visible };
}
