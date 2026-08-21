import { useQuery } from "@tanstack/react-query";
import { loadContractorEstimatesForWorkOrder } from "../../lib/db";

export const CONTRACTOR_ESTIMATES_KEY = ["contractor-estimates"] as const;

export const contractorEstimatesKey = (workOrderId: string) => [
  ...CONTRACTOR_ESTIMATES_KEY,
  workOrderId,
] as const;

export function useContractorEstimatesQuery(
  workOrderId: string | null | undefined,
  enabled = true,
) {
  const id = String(workOrderId || "");
  return useQuery({
    queryKey: contractorEstimatesKey(id),
    queryFn: () => loadContractorEstimatesForWorkOrder(id),
    staleTime: 30_000,
    enabled: enabled && id.length > 0,
  });
}
