import { useQuery } from "@tanstack/react-query";
import { billingApiFetch } from "../../lib/billingApi";
import {
  mapBillingTaxRule,
  type BillingTaxRule,
  type BillingTaxRuleRow,
} from "../../lib/billingTaxRules";
import { supabase } from "../../lib/supabase/client";

export const BILLING_INVOICES_KEY = ["billing-invoices"] as const;
export const BILLING_INVOICE_PAGES_KEY = ["billing-invoice-pages"] as const;
export const BILLING_INVOICE_BY_ID_KEY = ["billing-invoice-by-id"] as const;
export const BILLING_TAX_RULES_KEY = ["billing-tax-rules"] as const;

export type BillingInvoicePageParams = {
  queue: "active" | "all" | "draft" | "submitted" | "sent" | "work_order";
  search?: string;
  sort?: "invoice" | "date" | "work_order" | "store" | "territory" | "total" | "status" | "recent";
  direction?: "asc" | "desc";
  limit?: number;
  cursor?: string | null;
  workOrderId?: string | null;
};

const pageUrl = (params: BillingInvoicePageParams) => {
  const search = new URLSearchParams({
    queue: params.queue,
    sort: params.sort || "invoice",
    direction: params.direction || "desc",
    limit: String(params.limit || 25),
  });
  if (params.search?.trim()) search.set("search", params.search.trim());
  if (params.cursor) search.set("cursor", params.cursor);
  if (params.workOrderId) search.set("workOrderId", params.workOrderId);
  return `/api/billing-invoices?${search.toString()}`;
};

export function useBillingInvoicePageQuery(
  params: BillingInvoicePageParams,
  enabled = true,
) {
  return useQuery({
    queryKey: [...BILLING_INVOICE_PAGES_KEY, params],
    queryFn: async () => {
      const payload = await billingApiFetch(pageUrl(params));
      return {
        items: payload.items || payload.invoices || [],
        nextCursor: payload.nextCursor || null,
        hasMore: Boolean(payload.hasMore),
        totalCount: Number(payload.totalCount || 0),
      };
    },
    staleTime: 30_000,
    placeholderData: previous => previous,
    enabled,
  });
}

export function useBillingInvoiceByIdQuery(
  invoiceId: string | null | undefined,
  enabled = true,
) {
  const id = String(invoiceId || "");
  return useQuery({
    queryKey: [...BILLING_INVOICE_BY_ID_KEY, id],
    queryFn: async () => {
      const payload = await billingApiFetch(
        `/api/billing-invoices?invoiceId=${encodeURIComponent(id)}`,
      );
      return payload.invoice || null;
    },
    staleTime: 30_000,
    enabled: enabled && Boolean(id),
  });
}

export function useBillingTaxRulesQuery(enabled = true) {
  return useQuery<BillingTaxRule[]>({
    queryKey: BILLING_TAX_RULES_KEY,
    queryFn: async () => {
      const { data, error } = await (supabase() as any)
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
