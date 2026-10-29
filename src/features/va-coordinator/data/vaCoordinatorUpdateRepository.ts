import { normalizeUnknownError } from "../../../lib/errors/normalizeUnknown";
import { supabase } from "../../../lib/supabase/client";
import { vaCoordinatorNoteSchema } from "../contracts";
import { prepareVaCoordinatorSevenElevenUpdate } from "../sevenElevenUpdate";

type UpdateRpc = (
  name: "post_va_coordinator_seven_eleven_update_v1",
  args: { p_work_order_id: string; p_text: string },
) => PromiseLike<{ data: unknown; error: unknown }>;

export function createVaCoordinatorUpdateRepository(dependencies: { rpc: UpdateRpc }) {
  return {
    async post(workOrderId: string, text: string) {
      const args = prepareVaCoordinatorSevenElevenUpdate(workOrderId, text);
      const { data, error } = await dependencies.rpc("post_va_coordinator_seven_eleven_update_v1", args);
      if (error) throw normalizeUnknownError(error);
      const parsed = vaCoordinatorNoteSchema.safeParse(data);
      if (!parsed.success || parsed.data.workOrderId !== workOrderId || parsed.data.text !== args.p_text
        || parsed.data.enteredByRole !== "va_coordinator" || !parsed.data.requiresSevenElevenSync
        || parsed.data.syncedToSevenElevenAt !== null) {
        throw new Error("The update could not be verified. Refresh the work order before retrying.");
      }
      return parsed.data;
    },
  };
}

const production = createVaCoordinatorUpdateRepository({
  rpc: (name, args) => supabase().rpc(name, args),
});

export const postVaCoordinatorSevenElevenUpdate = production.post;
