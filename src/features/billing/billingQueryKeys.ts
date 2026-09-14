import { billingCountFilters, type BillingCountFilters, type BillingInvoicePageParams } from "./billingReadContracts";
import { canonicalBillingReadUuid } from "./billingReadUuid";

export const BILLING_INVOICE_PAGES_KEY = ["billing-invoice-pages"] as const;
export const BILLING_INVOICE_COUNT_KEY = ["billing-invoice-count"] as const;
export const BILLING_INVOICE_BY_ID_KEY = ["billing-invoice-by-id"] as const;
export const billingInvoicePageKey = (scope: string, params?: BillingInvoicePageParams) =>
  params ? [...BILLING_INVOICE_PAGES_KEY, scope, params] as const : [...BILLING_INVOICE_PAGES_KEY, scope] as const;
export const billingInvoiceCountKey = (scope: string, params?: BillingCountFilters) =>
  params ? [...BILLING_INVOICE_COUNT_KEY, scope, billingCountFilters(params)] as const : [...BILLING_INVOICE_COUNT_KEY, scope] as const;
export const billingInvoiceByIdKey = (id: string, scope: string) =>
  [...BILLING_INVOICE_BY_ID_KEY, canonicalBillingReadUuid(id) ?? id, scope] as const;
