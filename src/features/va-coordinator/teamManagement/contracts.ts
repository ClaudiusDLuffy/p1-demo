import { z } from "zod";

const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
const person = z.object({ id: uuid, name: z.string().min(1).max(500), active: z.boolean() }).strict();
const technician = person.extend({ company: z.string().max(500).nullable() }).strict();
const team = z.object({
  id: uuid,
  name: z.string().min(1).max(120),
  coordinators: z.array(person).max(100),
  technicians: z.array(technician).max(500),
}).strict();

export const vaCoordinatorTeamManagementSchema = z.object({
  teams: z.array(team).max(200),
  coordinators: z.array(person).max(100),
  technicians: z.array(technician).max(500),
}).strict();

export type VaCoordinatorPerson = z.infer<typeof person>;
export type VaCoordinatorTechnician = z.infer<typeof technician>;
export type VaCoordinatorTeam = z.infer<typeof team>;
export type VaCoordinatorTeamManagement = z.infer<typeof vaCoordinatorTeamManagementSchema>;

export function parseVaCoordinatorTeamManagement(value: unknown): VaCoordinatorTeamManagement {
  const parsed = vaCoordinatorTeamManagementSchema.safeParse(value);
  if (!parsed.success) throw new Error("VA team data could not be verified.");
  const { teams, coordinators, technicians } = parsed.data;
  if (new Set(teams.map(row => row.id)).size !== teams.length
    || new Set(coordinators.map(row => row.id)).size !== coordinators.length
    || new Set(technicians.map(row => row.id)).size !== technicians.length) {
    throw new Error("VA team data could not be verified.");
  }
  return parsed.data;
}
