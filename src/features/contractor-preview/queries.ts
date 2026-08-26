import { useQuery } from "@tanstack/react-query";

import { supabase } from "../../lib/supabase/client";

export const STAFF_CONTRACTOR_PREVIEW_KEY = ["staff-contractor-preview"] as const;

export type StaffContractorPreviewCursor = {
  createdAt: string;
  id: string;
};

export type StaffContractorPreviewPage<T> = {
  items: T[];
  hasMore: boolean;
  nextCursor: string | null;
};

export type StaffContractorPreviewWorkOrder = {
  id: string;
  status: string;
  functionalStatus: string | null;
  priority: string;
  store: string | null;
  city: string | null;
  address: string | null;
  state: string | null;
  summary: string | null;
  description: string | null;
  category: string | null;
  subCategory: string | null;
  businessService: string | null;
  isCapital: boolean | null;
  technicianName: string | null;
  invoicingCompletedAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  closedAt: string | null;
};

export type StaffContractorPreviewInvoice = {
  id: string;
  number: string;
  workOrderId: string | null;
  state: string;
  documentKind: string;
  invoiceDate: string;
  serviceDate: string | null;
  storeAddress: string | null;
  subtotal: number | null;
  salesTax: number | null;
  total: number | null;
  rejectionReason: string | null;
  createdAt: string | null;
  updatedAt: string | null;
};

const parseCursor = (cursor: string | null | undefined): StaffContractorPreviewCursor | null => {
  if (!cursor) return null;
  try {
    const value = JSON.parse(cursor) as Partial<StaffContractorPreviewCursor>;
    if (typeof value.createdAt !== "string" || typeof value.id !== "string") return null;
    return { createdAt: value.createdAt, id: value.id };
  } catch {
    return null;
  }
};

const mapPage = <T,>(value: unknown): StaffContractorPreviewPage<T> => {
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("The server returned an invalid contractor preview page");
  }
  const page = parsed as Record<string, unknown>;
  const next = page.nextCursor;
  return {
    items: Array.isArray(page.items) ? page.items as T[] : [],
    hasMore: page.hasMore === true,
    nextCursor: next && typeof next === "object" && !Array.isArray(next)
      ? JSON.stringify(next)
      : null,
  };
};

export function useStaffContractorPreviewWorkOrdersQuery(input: {
  contractorId: string;
  scope: "active" | "history" | "all";
  search: string;
  cursor: string | null;
  enabled: boolean;
}) {
  return useQuery({
    queryKey: [...STAFF_CONTRACTOR_PREVIEW_KEY, "work-orders", input],
    queryFn: async () => {
      const cursor = parseCursor(input.cursor);
      const { data, error } = await supabase().rpc(
        "list_staff_contractor_preview_work_orders",
        {
          p_contractor_id: input.contractorId,
          p_scope: input.scope,
          p_search: input.search || null,
          p_limit: 50,
          p_cursor_created_at: cursor?.createdAt || null,
          p_cursor_id: cursor?.id || null,
        },
      );
      if (error) throw error;
      return mapPage<StaffContractorPreviewWorkOrder>(data);
    },
    staleTime: 30_000,
    placeholderData: previous => previous,
    enabled: input.enabled && Boolean(input.contractorId),
  });
}

export function useStaffContractorPreviewInvoicesQuery(input: {
  contractorId: string;
  state: "all" | "draft" | "submitted" | "revised" | "rejected" | "approved" | "paid";
  search: string;
  cursor: string | null;
  enabled: boolean;
}) {
  return useQuery({
    queryKey: [...STAFF_CONTRACTOR_PREVIEW_KEY, "invoices", input],
    queryFn: async () => {
      const cursor = parseCursor(input.cursor);
      const { data, error } = await supabase().rpc(
        "list_staff_contractor_preview_invoices",
        {
          p_contractor_id: input.contractorId,
          p_state: input.state,
          p_search: input.search || null,
          p_limit: 50,
          p_cursor_created_at: cursor?.createdAt || null,
          p_cursor_id: cursor?.id || null,
        },
      );
      if (error) throw error;
      return mapPage<StaffContractorPreviewInvoice>(data);
    },
    staleTime: 30_000,
    placeholderData: previous => previous,
    enabled: input.enabled && Boolean(input.contractorId),
  });
}
