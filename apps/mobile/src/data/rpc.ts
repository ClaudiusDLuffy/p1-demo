import type { SupabaseClient } from "@supabase/supabase-js";
import { mapPublicError } from "@p1/mobile-contracts";
type RpcBuilder = PromiseLike<{ data: unknown; error: unknown }> & { abortSignal(signal: AbortSignal): RpcBuilder };
export function createRpcReader(client: SupabaseClient) {
  return async (name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> => {
    let request = client.rpc(name, args) as unknown as RpcBuilder;
    if (signal) request = request.abortSignal(signal);
    const result = await request;
    if (result.error) throw mapPublicError(result.error);
    return result.data;
  };
}
