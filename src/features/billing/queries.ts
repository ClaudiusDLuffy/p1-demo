import { useQuery } from "@tanstack/react-query";
import { AppError } from "../../lib/errors/AppError";
import { countReadPolicy, useCountQueryVisibility } from "../../lib/counts/countQueryPolicy";
import { directoryActorScope, invoiceByIdKey } from "../../lib/counts/queryKeys";
import { useDirectoryActor } from "../directory/queries";
import type { DirectoryActor } from "../directory/contracts";
import { billingInvoiceByIdKey, billingInvoiceCountKey, billingInvoicePageKey } from "./billingQueryKeys";
import { billingCountFilters, type BillingCountFilters, type BillingInvoicePageParams } from "./billingReadContracts";
import { readBillingCount, readBillingInvoice, readBillingRows } from "./billingReads";
import {
  mapBillingTaxRule,
  type BillingTaxRule,
  type BillingTaxRuleRow,
} from "../../lib/billingTaxRules";
import { supabase } from "../../lib/supabase/client";
import { canonicalBillingReadUuid } from "./billingReadUuid";

export const BILLING_INVOICES_KEY = ["billing-invoices"] as const;
export { BILLING_INVOICE_PAGES_KEY, BILLING_INVOICE_BY_ID_KEY, BILLING_INVOICE_COUNT_KEY } from "./billingQueryKeys";
export const BILLING_TAX_RULES_KEY = ["billing-tax-rules"] as const;

export type { BillingInvoicePageParams } from "./billingReadContracts";

export function useBillingInvoiceCountQuery(params: BillingCountFilters, enabled = true, actorOverride?: DirectoryActor | null) {
  const contextActor = useDirectoryActor();
  const actor = actorOverride === undefined ? contextActor : actorOverride;
  const allowed = useCountQueryVisibility(Boolean(enabled && actor?.id && actor.active === true));
  const filters = billingCountFilters(params);
  return useQuery({
    queryKey: billingInvoiceCountKey(directoryActorScope(actor), filters),
    queryFn: ({ signal }) => {
      if (!allowed) throw new AppError("FORBIDDEN");
      return readBillingCount(filters, signal);
    },
    ...countReadPolicy, enabled: allowed,
  });
}

export function useBillingInvoicePageQuery(
  params: BillingInvoicePageParams,
  enabled = true,
  actorOverride?: DirectoryActor | null,
) {
  const contextActor = useDirectoryActor();
  const actor = actorOverride === undefined ? contextActor : actorOverride;
  const allowed = Boolean(enabled && actor?.id && actor.active === true);
  return useQuery({
    queryKey: billingInvoicePageKey(directoryActorScope(actor), params),
    queryFn: ({ signal }) => {
      if (!allowed) throw new AppError("FORBIDDEN");
      return readBillingRows(params, signal);
    },
    staleTime: 30_000,
    enabled: allowed,
  });
}

export function useBillingInvoiceByIdQuery(
  invoiceId: string | null | undefined,
  enabled = true,
  actorOverride?: DirectoryActor | null,
) {
  const contextActor = useDirectoryActor();
  const actor = actorOverride === undefined ? contextActor : actorOverride;
  const id = canonicalBillingReadUuid(invoiceId) ?? String(invoiceId || "");
  const allowed = Boolean(enabled && id && actor?.id && actor.active === true);
  return useQuery({
    queryKey: billingInvoiceByIdKey(id, directoryActorScope(actor)),
    queryFn: ({ signal }) => {
      if (!allowed) throw new AppError("FORBIDDEN");
      return readBillingInvoice(id, signal);
    },
    staleTime: 30_000,
    enabled: allowed,
  });
}

/** Staff-authorized source transport, contractor-domain invalidation identity. */
export function useBillingSourceInvoiceByIdQuery(invoiceId: string | null, enabled = true) {
  const actor = useDirectoryActor();
  const id = canonicalBillingReadUuid(invoiceId) ?? (invoiceId || "");
  return useQuery({ queryKey: [...invoiceByIdKey(id, directoryActorScope(actor)), "staff-source-summary-v1"],
    queryFn: ({ signal }) => readBillingInvoice(id, signal), staleTime: 30_000,
    enabled: enabled && Boolean(id) && actor?.active === true });
}

export function useBillingTaxRulesQuery(enabled = true) {
  return useQuery<BillingTaxRule[]>({
    queryKey: BILLING_TAX_RULES_KEY,
    queryFn: async () => {
      const { data, error } = await supabase()
        .from("billing_tax_rules")
        .select("id, rule_key, name, priority, equipment_keywords, line_types, description_keywords, taxable, is_active, created_at, updated_at")
        .order("priority", { ascending: true })
        .order("rule_key", { ascending: true });
      if (error) throw error;
      return ((data || []) as BillingTaxRuleRow[]).map(mapBillingTaxRule);
    },
    staleTime: 60_000,
    enabled,
  });
}
