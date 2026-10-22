import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { VaCoordinatorTeamManagement } from "./contracts";
import { loadVaCoordinatorTeamManagement, saveVaCoordinatorTeam } from "./data/vaCoordinatorTeamManagementRepository";
import type { SaveVaCoordinatorTeamCommand } from "./teamManagementBusiness";

const teamManagementKey = (actorId: string) => ["va-coordinator", actorId, "team-management"] as const;

export function useVaCoordinatorTeamManagement(actorId: string, enabled: boolean) {
  return useQuery({
    queryKey: teamManagementKey(actorId),
    queryFn: ({ signal }) => loadVaCoordinatorTeamManagement(signal),
    enabled,
    staleTime: 30_000,
  });
}

export function useSaveVaCoordinatorTeam(actorId: string, directory: VaCoordinatorTeamManagement | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (command: SaveVaCoordinatorTeamCommand) => {
      if (!directory) throw new Error("Reload the VA team directory before saving.");
      return saveVaCoordinatorTeam(command, directory);
    },
    onSuccess: async () => queryClient.invalidateQueries({ queryKey: teamManagementKey(actorId) }),
  });
}
