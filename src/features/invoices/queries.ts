import { useQuery } from "@tanstack/react-query";
import { loadInvoices } from "../../lib/db";

export const INVOICES_KEY = ["invoices"] as const;

export function useInvoicesQuery(enabled = true) {
  return useQuery({
    queryKey: INVOICES_KEY,
    queryFn: loadInvoices,
    staleTime: 30_000,
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
    enabled,
  });
}
