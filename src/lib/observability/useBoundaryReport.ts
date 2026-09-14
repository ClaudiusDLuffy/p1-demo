"use client";
import { useEffect, useState } from "react";
import { reportClientFailure } from "../clientDiagnostics";
import { reportOutcomeText, type ClientReportResult } from "./clientReportContracts";

export function useBoundaryReport(error: Error, source: string): string {
  const [receipt, setReceipt] = useState<{ error: Error; result: ClientReportResult } | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void reportClientFailure({ source, message: error.message }, controller.signal).then(result => {
      if (!controller.signal.aborted) setReceipt({ error, result });
    });
    return () => controller.abort();
  }, [error, source]);
  return reportOutcomeText(receipt?.error === error ? receipt.result : null);
}
