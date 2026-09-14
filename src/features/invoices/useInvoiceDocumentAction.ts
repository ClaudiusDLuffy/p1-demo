"use client";

import { useEffect, useRef } from "react";
import type { DirectoryActor } from "../directory/contracts";
import { directoryActorScope } from "../../lib/counts/queryKeys";
import { readBillingDocument, readBillingSourceSummaries, readBillingSummary } from "../billing/billingReads";
import { readInvoiceDocument, readInvoiceSummary } from "./invoiceReads";
import { invoiceDocumentForLegacyUi, invoiceSummaryForLegacyUi } from "./invoiceReadContracts";
import type { InvoiceDocumentPurpose } from "./invoiceDocumentRead";
import { AppError } from "../../lib/errors/AppError";

/** Explicit action lifetime, independent of ordinary summary query caches. */
export function useInvoiceDocumentAction(actor: DirectoryActor | null | undefined, lifetimeKey = "") {
  const scope = directoryActorScope(actor);
  const identity = JSON.stringify([scope, lifetimeKey]);
  const currentScope = useRef(identity);
  currentScope.current = identity;
  const pending = useRef(new Set<AbortController>());
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    const requests = pending.current;
    return () => { active.current = false; requests.forEach(controller => controller.abort()); requests.clear(); };
  }, [identity]);
  const assertCurrent = () => {
    if (!active.current || currentScope.current !== identity) throw new AppError("REQUEST_ABORTED");
  };
  const scopedRequest = async <Result,>(request: (signal: AbortSignal) => Promise<Result>): Promise<Result> => {
    assertCurrent();
    if (!actor?.id || actor.active !== true) throw new AppError("AUTH_REQUIRED");
    if (pending.current.size >= 4) throw new AppError("RATE_LIMITED");
    const controller = new AbortController();
    pending.current.add(controller);
    try {
      const result = await request(controller.signal);
      if (currentScope.current !== identity) controller.abort();
      controller.signal.throwIfAborted();
      return result;
    } finally { pending.current.delete(controller); }
  };
  const read = (id: string, purpose: InvoiceDocumentPurpose, staff = false, maxLines?: number) => scopedRequest(async signal => {
    const document = staff ? await readBillingDocument(id, purpose, signal, maxLines) : await readInvoiceDocument(id, purpose, signal);
    if (!document) throw new AppError("NOT_FOUND");
    return invoiceDocumentForLegacyUi(document);
  });
  const sourceSummaries = (ids: readonly string[]) => scopedRequest(signal => readBillingSourceSummaries(ids, signal));
  const summary = (id: string, staff = false) => scopedRequest(async signal => {
    const header = staff ? await readBillingSummary(id, signal) : await readInvoiceSummary(id, signal);
    if (!header) throw new AppError("NOT_FOUND");
    return invoiceSummaryForLegacyUi(header);
  });
  return Object.assign(read, { assertCurrent, sourceSummaries, summary });
}
