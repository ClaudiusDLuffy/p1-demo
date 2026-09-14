import "server-only";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import { PrivateObjectError, type PrivateObjectServerDatabase } from "../privateObjectContracts";
import { createServerClient } from "../supabase/server";
import { readBoundedBytes } from "./privateObjectStorage";
import { getServerPublicSupabaseConfig } from "../config/server/supabase";
import { ConfigurationError } from "../config/shared";

export const privateObjectFetch: typeof fetch = (input, init) => fetch(input, { ...init,
  signal: init?.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000),
});

export async function requirePrivateObjectActor(request: Request) {
  const token = request.headers.get("authorization")?.match(/^Bearer\s+(\S+)$/i)?.[1];
  if (!token) throw new PrivateObjectError("UNAUTHORIZED", "Please sign in again.", 401);
  const configuration = getServerPublicSupabaseConfig();
  const actor = createClient<PrivateObjectServerDatabase>(configuration.url,
    configuration.publishableKey, {
      auth: { persistSession: false, autoRefreshToken: false }, global: { headers: { Authorization: `Bearer ${token}` }, fetch: privateObjectFetch },
    });
  const identity = await actor.auth.getUser(token);
  if (identity.error || !identity.data.user) throw new PrivateObjectError("UNAUTHORIZED", "Please sign in again.", 401);
  const service = createServerClient({ fetch: privateObjectFetch });
  const profile = await service.from("profiles").select("id,active").eq("id", identity.data.user.id).maybeSingle();
  if (profile.error) throw new PrivateObjectError("AUTHORIZATION_UNAVAILABLE", undefined, 503);
  if (!profile.data?.active) throw new PrivateObjectError("FORBIDDEN", "This account cannot perform this file operation.", 403);
  // Actor RPCs recheck current profile and parent access; no claim role is used.
  return { actor, service };
}

export async function parseObjectRequest<T>(request: Request, schema: z.ZodType<T>): Promise<T> {
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
    throw new PrivateObjectError("INVALID_REQUEST", "A valid file request is required.", 422);
  }
  try {
    const bytes = await readBoundedBytes(new Response(request.body), 16 * 1024,
      AbortSignal.any([request.signal, AbortSignal.timeout(10_000)]));
    const raw: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    return schema.parse(raw);
  } catch { throw new PrivateObjectError("INVALID_REQUEST", "A valid file request is required.", 422); }
}

export function privateObjectFailure(error: unknown): Response {
  if (error instanceof ConfigurationError) throw error;
  const safe = error instanceof PrivateObjectError ? error : new PrivateObjectError("FILE_OPERATION_UNAVAILABLE", undefined, 503);
  return Response.json({ code: safe.code, message: safe.message }, { status: safe.httpStatus, headers: { "Cache-Control": "no-store" } });
}
