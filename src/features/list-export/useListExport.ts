"use client";

import { useEffect, useRef, useState } from "react";
import { safeErrorMessage } from "../../lib/errors/normalizeUnknown";
import { downloadListCsv, ListExportLimitError } from "./listExport";

export type ListExportOptions<T> = {
  identity: string; enabled: boolean;
  read(signal: AbortSignal, progress: (count: number) => void): Promise<readonly T[]>;
  format(rows: readonly T[]): string; fileName: string;
};
export function useListExport<T>(options: ListExportOptions<T>) {
  const identity = JSON.stringify([options.identity, options.enabled]);
  const latest = useRef(identity); latest.current = identity;
  const request = useRef<{ identity: string; controller: AbortController } | null>(null);
  const [state, setState] = useState({ identity, busy: false, count: 0, message: "", error: "" });
  if (state.identity !== identity) setState({ identity, busy: false, count: 0, message: "", error: "" });
  useEffect(() => () => {
    const current = request.current;
    if (current?.identity === identity) { request.current = null; current.controller.abort(); }
  }, [identity]);

  async function start() {
    if (!options.enabled || request.current) return;
    const pending = { identity, controller: new AbortController() };
    request.current = pending;
    const current = () => request.current === pending && latest.current === identity && !pending.controller.signal.aborted;
    setState({ identity, busy: true, count: 0, message: "", error: "" });
    try {
      const rows = await options.read(pending.controller.signal, count => {
        if (current()) setState(value => ({ ...value, count }));
      });
      if (!current()) return;
      if (rows.length) {
        const data = options.format(rows);
        if (!current()) return;
        downloadListCsv(data, options.fileName);
      }
      if (current()) setState(value => ({ ...value,
        message: rows.length ? `Exported ${rows.length} matching records.` : "No records match these filters." }));
    } catch (cause) {
      if (current()) setState(value => ({ ...value, error: cause instanceof ListExportLimitError
        ? cause.message : `Export failed. No partial file was downloaded. ${safeErrorMessage(cause)}` }));
    } finally {
      if (request.current === pending) {
        request.current = null;
        if (latest.current === identity) setState(value => ({ ...value, busy: false }));
      }
    }
  }
  function cancel() {
    const pending = request.current;
    request.current = null; pending?.controller.abort();
    setState({ identity, busy: false, count: 0, error: "", message: "Export cancelled. No file was downloaded." });
  }
  return { ...state, start, cancel };
}
