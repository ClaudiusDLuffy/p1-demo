"use client";

import { useQuery } from "@tanstack/react-query";
import { useDirectoryActor } from "../directory/queries";
import { countReadPolicy, useCountQueryVisibility } from "../../lib/counts/countQueryPolicy";
import { directoryActorScope } from "../../lib/counts/queryKeys";
import { invoicePartHintsKey, readInvoicePartHints } from "./invoicePartHints";

/** One bounded authorized presence read, not invoice-document hydration. */
export function useInvoicePartHints(workOrderId: string | null | undefined,
  parts: readonly { id: string }[], enabled: boolean) {
  const actor = useDirectoryActor();
  const visible = useCountQueryVisibility(enabled && !!workOrderId && actor?.active === true);
  const partIds = [...new Set(parts.map(part => part.id))].sort();
  return useQuery({
    queryKey: invoicePartHintsKey(workOrderId || "", directoryActorScope(actor), partIds),
    queryFn: ({ signal }) => readInvoicePartHints(workOrderId || "", parts, signal),
    enabled: visible && parts.length > 0,
    ...countReadPolicy,
  });
}
