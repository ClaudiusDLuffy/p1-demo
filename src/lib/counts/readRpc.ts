import { supabase } from "../supabase/client";
import { normalizeUnknownError } from "../errors/normalizeUnknown";

/** Narrow additive-RPC boundary until generated database types are refreshed. */
export async function boundedReadRpc(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
  signal?.throwIfAborted();
  type Result = { data: unknown; error: unknown };
  type Request = PromiseLike<Result> & { abortSignal(signal: AbortSignal): Request };
  const client = supabase() as unknown as { rpc(name: string, args: Record<string, unknown>): Request };
  let request = client.rpc(name, args);
  if (signal) request = request.abortSignal(signal);
  const { data, error } = await request;
  signal?.throwIfAborted();
  if (error) throw normalizeUnknownError(error);
  return data;
}
