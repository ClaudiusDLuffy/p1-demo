import type { VaCoordinatorTeamManagement } from "./contracts";

export function canManageVaCoordinatorTeams(role: string | null | undefined): boolean {
  return role === "manager" || role === "back_office";
}

export type SaveVaCoordinatorTeamCommand = Readonly<{
  teamId: string | null;
  name: string;
  coordinatorProfileIds: readonly string[];
  technicianProfileIds: readonly string[];
}>;

export function prepareSaveVaCoordinatorTeam(
  command: SaveVaCoordinatorTeamCommand,
  directory: VaCoordinatorTeamManagement,
) {
  const name = command.name.trim();
  if (!name || name.length > 120) throw new Error("Enter a team name of 1–120 characters.");
  const coordinatorIds = [...new Set(command.coordinatorProfileIds)];
  const technicianIds = [...new Set(command.technicianProfileIds)];
  if (coordinatorIds.some(id => !directory.coordinators.some(row => row.id === id && row.active))) {
    throw new Error("Remove inactive or unavailable VA coordinators before saving.");
  }
  if (technicianIds.some(id => !directory.technicians.some(row => row.id === id && row.active))) {
    throw new Error("Remove inactive or unavailable technicians before saving.");
  }
  return {
    p_team_id: command.teamId,
    p_name: name,
    p_coordinator_profile_ids: coordinatorIds,
    p_technician_profile_ids: technicianIds,
  };
}
