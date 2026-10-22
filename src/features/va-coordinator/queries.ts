import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { VA_COORDINATOR_CHILD_LIMIT, VA_COORDINATOR_PAGE_SIZE } from "./contracts";
import {
  loadVaCoordinatorAttachments,
  loadVaCoordinatorTechnicianNotes,
  loadVaCoordinatorWorkOrder,
  loadVaCoordinatorWorkOrders,
} from "./data/vaCoordinatorReadRepository";
import { runTechnicianNoteTransfer } from "./technicianNoteTransfer";

export type VaCoordinatorActor = Readonly<{ id: string; active: boolean }>;

export const vaCoordinatorQueryKeys = {
  root: (actorId: string) => ["va-coordinator", actorId] as const,
  workOrders: (actorId: string, search: string, cursor: string | null) => ["va-coordinator", actorId, "work-orders", search, cursor] as const,
  workOrder: (actorId: string, workOrderId: string) => ["va-coordinator", actorId, "work-order", workOrderId] as const,
  notes: (actorId: string, workOrderId: string) => ["va-coordinator", actorId, "notes", workOrderId] as const,
  attachments: (actorId: string, workOrderId: string) => ["va-coordinator", actorId, "attachments", workOrderId] as const,
};

export function useVaCoordinatorWorkOrders(actor: VaCoordinatorActor, search: string, cursor: string | null) {
  return useQuery({
    queryKey: vaCoordinatorQueryKeys.workOrders(actor.id, search, cursor),
    queryFn: ({ signal }) => loadVaCoordinatorWorkOrders(search, cursor, VA_COORDINATOR_PAGE_SIZE, signal),
    enabled: actor.active,
    staleTime: 30_000,
  });
}

export function useVaCoordinatorWorkOrder(actor: VaCoordinatorActor, workOrderId: string | null) {
  return useQuery({
    queryKey: vaCoordinatorQueryKeys.workOrder(actor.id, workOrderId || ""),
    queryFn: ({ signal }) => loadVaCoordinatorWorkOrder(workOrderId || "", signal),
    enabled: actor.active && Boolean(workOrderId),
    staleTime: 30_000,
  });
}

export function useVaCoordinatorTechnicianNotes(actor: VaCoordinatorActor, workOrderId: string | null) {
  return useQuery({
    queryKey: vaCoordinatorQueryKeys.notes(actor.id, workOrderId || ""),
    queryFn: ({ signal }) => loadVaCoordinatorTechnicianNotes(workOrderId || "", VA_COORDINATOR_CHILD_LIMIT, signal),
    enabled: actor.active && Boolean(workOrderId),
    staleTime: 15_000,
  });
}

export function useVaCoordinatorAttachments(actor: VaCoordinatorActor, workOrderId: string | null) {
  return useQuery({
    queryKey: vaCoordinatorQueryKeys.attachments(actor.id, workOrderId || ""),
    queryFn: ({ signal }) => loadVaCoordinatorAttachments(workOrderId || "", VA_COORDINATOR_CHILD_LIMIT, signal),
    enabled: actor.active && Boolean(workOrderId),
    staleTime: 60_000,
  });
}

export function useTransferTechnicianNote(actor: VaCoordinatorActor, workOrderId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ note, confirmed }: { note: Parameters<typeof runTechnicianNoteTransfer>[0]; confirmed: boolean }) =>
      runTechnicianNoteTransfer(note, confirmed),
    onSuccess: async () => {
      if (!workOrderId) return;
      await queryClient.invalidateQueries({ queryKey: vaCoordinatorQueryKeys.notes(actor.id, workOrderId) });
    },
  });
}
