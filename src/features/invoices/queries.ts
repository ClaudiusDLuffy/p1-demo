import { useQuery } from "@tanstack/react-query";
import {
  loadInvoiceById,
  loadInvoices,
  loadInvoicesPage,
  type InvoicePageParams,
} from "../../lib/db";

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

export function useInvoicesPageQuery(params: InvoicePageParams, enabled = true) {
  return useQuery({
    queryKey: [...INVOICE_PAGES_KEY, params],
    queryFn: () => loadInvoicesPage(params),
    staleTime: 30_000,
    placeholderData: previous => previous,
    enabled,
  });
}

export function useInvoiceByIdQuery(invoiceId: string | null | undefined, enabled = true) {
  const id = String(invoiceId || "");
  return useQuery({
    queryKey: [...INVOICE_BY_ID_KEY, id],
    queryFn: () => loadInvoiceById(id),
    staleTime: 30_000,
    enabled: enabled && id.length > 0,
  });
}
