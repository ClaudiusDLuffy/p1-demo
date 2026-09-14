import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  loadInvoiceSummaryById,
  loadInvoices,
  loadInvoicesPage,
  loadInvoicesCount,
  type InvoicePageParams,
} from "../../lib/db";
import { useDirectoryActor } from "../directory/queries";
import type { DirectoryActor } from "../directory/contracts";
import { countReadPolicy, useCountQueryVisibility } from "../../lib/counts/countQueryPolicy";
import { invoiceCountFilters } from "../../lib/counts/countFilters";
import { directoryActorScope, invoicePagesKey, invoiceCountKey, invoiceByIdKey } from "../../lib/counts/queryKeys";

export const INVOICES_KEY = ["invoices"] as const;
export const INVOICE_PAGES_KEY = ["invoice-pages"] as const;
export const INVOICE_BY_ID_KEY = ["invoice-by-id"] as const;
export const CONTROLLER_INVOICE_HOLDS_KEY = ["controller-invoice-payment-holds"] as const;

export function useInvoicesQuery(enabled = true) {
  return useQuery({
    queryKey: INVOICES_KEY,
    queryFn: loadInvoices,
    staleTime: 30_000,
    enabled,
  });
}

export function useInvoicesPageQuery(params: InvoicePageParams, enabled = true, actorOverride?: DirectoryActor | null,
  options: { countEnabled?: boolean } = {}) {
  const contextActor = useDirectoryActor();
  const actor = actorOverride === undefined ? contextActor : actorOverride;
  const scope = directoryActorScope(actor);
  const countQuery = useInvoicesCountQuery(params, enabled && options.countEnabled !== false, actor);
  const query = useQuery({
    queryKey: invoicePagesKey(scope, params),
    queryFn: ({ signal }) => loadInvoicesPage(params, signal),
    staleTime: 30_000,
    placeholderData: (previous, previousQuery) => previousQuery?.queryKey[1] === scope ? previous : undefined,
    enabled: enabled && !!actor?.id && actor.active === true,
  });
  const data = useMemo(() => query.data ? { ...query.data, totalCount: countQuery.data?.totalCount ?? null } : undefined,
    [query.data, countQuery.data]);
  return { ...query, countQuery, data };
}

export function useInvoicesCountQuery(params: InvoicePageParams, enabled = true, actorOverride?: DirectoryActor | null) {
  const contextActor = useDirectoryActor();
  const actor = actorOverride === undefined ? contextActor : actorOverride;
  const filters = invoiceCountFilters(params);
  const visible = useCountQueryVisibility(enabled && !!actor?.id && actor.active === true);
  return useQuery({ queryKey: invoiceCountKey(directoryActorScope(actor), filters),
    queryFn: ({ signal }) => loadInvoicesCount(filters, signal), ...countReadPolicy, enabled: visible });
}

export function useInvoiceByIdQuery(invoiceId: string | null | undefined, enabled = true, actorOverride?: DirectoryActor | null) {
  const contextActor = useDirectoryActor();
  const actor = actorOverride === undefined ? contextActor : actorOverride;
  const id = String(invoiceId || "");
  return useQuery({
    queryKey: invoiceByIdKey(id, directoryActorScope(actor)),
    queryFn: ({ signal }) => loadInvoiceSummaryById(id, signal),
    staleTime: 30_000,
    enabled: enabled && id.length > 0 && !!actor?.id && actor.active === true,
  });
}
