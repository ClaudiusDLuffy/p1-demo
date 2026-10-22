import { supabase } from "../../../../lib/supabase/client";
import { normalizeUnknownError } from "../../../../lib/errors/normalizeUnknown";
import { parseVaCoordinatorTeamManagement, type VaCoordinatorTeamManagement } from "../contracts";
import { prepareSaveVaCoordinatorTeam, type SaveVaCoordinatorTeamCommand } from "../teamManagementBusiness";

type RpcResult = { data: unknown; error: unknown | null };
type RpcRequest = PromiseLike<RpcResult> & { abortSignal?: (signal: AbortSignal) => RpcRequest };
type RpcClient = { rpc: (name: string, args?: Record<string, unknown>) => RpcRequest };

export function createVaCoordinatorTeamManagementRepository(client?: RpcClient) {
  const rpcClient = () => client || supabase() as unknown as RpcClient;
  return {
    async load(signal?: AbortSignal): Promise<VaCoordinatorTeamManagement> {
      signal?.throwIfAborted();
      const request = rpcClient().rpc("list_va_coordinator_team_management_v1");
      const { data, error } = await (signal && request.abortSignal ? request.abortSignal(signal) : request);
      signal?.throwIfAborted();
      if (error) throw normalizeUnknownError(error);
      try { return parseVaCoordinatorTeamManagement(data); }
      catch (cause) { throw normalizeUnknownError(cause); }
    },
    async save(command: SaveVaCoordinatorTeamCommand, directory: VaCoordinatorTeamManagement) {
      const args = prepareSaveVaCoordinatorTeam(command, directory);
      const { data, error } = await rpcClient().rpc("configure_va_coordinator_team_v1", args);
      if (error) throw normalizeUnknownError(error);
      if (!data || typeof data !== "object" || Array.isArray(data)
        || typeof (data as Record<string, unknown>).teamId !== "string") {
        throw normalizeUnknownError(new Error("Invalid VA team save result"));
      }
      return data as { teamId: string };
    },
  };
}

const repository = createVaCoordinatorTeamManagementRepository();
export const loadVaCoordinatorTeamManagement = repository.load;
export const saveVaCoordinatorTeam = repository.save;
