"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useDirectoryActor } from "../directory/queries";
import { directoryActorScope, invoiceByIdKey } from "../../lib/counts/queryKeys";
import { billingInvoiceByIdKey } from "../billing/billingQueryKeys";
import { usePortalVisibility } from "../../lib/realtime/browserVisibility";
import { readInvoiceLines } from "./invoiceReads";
import { readBillingLines } from "../billing/billingReads";
import { invoiceLineForLegacyUi } from "./invoiceReadContracts";
import { canonicalBillingReadUuid } from "../billing/billingReadUuid";

export function invoiceLinesKey(id: string, scope: string, version: number, cursor: string | null, staff: boolean, source = false) {
  if (staff) id = canonicalBillingReadUuid(id) ?? id;
  const exact = staff && !source ? billingInvoiceByIdKey(id, scope) : invoiceByIdKey(id, scope);
  return [...exact, source ? "staff-source-lines-v1" : "lines-v1", version, cursor] as const;
}
export function useInvoiceLinePage(input: { id?: string | null; invoiceVersion?: number | null; projection?: string;
  lineCount?: number; staff?: boolean; source?: boolean }, enabled = true) {
  const actor = useDirectoryActor();
  const scope = directoryActorScope(actor);
  const visible = usePortalVisibility();
  const qc = useQueryClient();
  const version = input.invoiceVersion ?? -1;
  const staff = input.staff === true;
  const source = input.source === true;
  const id = (staff ? canonicalBillingReadUuid(input.id) : null) ?? (input.id || "");
  const identity = JSON.stringify([id, scope, version, staff, source]);
  const [position, setPosition] = useState({ identity, cursor: null as string | null, page: 1, offset: 0 });
  const current = position.identity === identity ? position : { identity, cursor: null, page: 1, offset: 0 };
  const query = useQuery({ queryKey: invoiceLinesKey(id, scope, version, current.cursor, staff, source),
    queryFn: ({ signal }) => staff ? readBillingLines(id, version, current.cursor, signal) : readInvoiceLines(id, version, current.cursor, signal),
    enabled: enabled && visible && input.projection === "summary" && Boolean(id) && version >= 0 && actor?.active === true,
    staleTime: 30_000 });
  return { ...query, lines: query.data?.items.map(invoiceLineForLegacyUi) ?? [], page: current.page, lineOffset: current.offset,
    next: () => {
      if (!query.data?.hasMore || !query.data.nextCursor || query.isFetching) return;
      setPosition({ identity, page: current.page + 1, cursor: query.data.nextCursor, offset: current.offset + query.data.items.length });
    },
    first: () => setPosition({ identity, page: 1, cursor: null, offset: 0 }),
    refresh: () => {
      setPosition({ identity, page: 1, cursor: null, offset: 0 });
      return qc.invalidateQueries({ queryKey: staff && !source ? billingInvoiceByIdKey(id, scope) : invoiceByIdKey(id, scope) });
    },
  };
}
