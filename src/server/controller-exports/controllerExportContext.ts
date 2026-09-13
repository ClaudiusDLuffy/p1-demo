import "server-only";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import { AppError } from "../../lib/errors/AppError";
import { getServerPublicSupabaseConfig } from "../../lib/config/server/supabase";
import { canHandoffQuickBooksProfile, STAFF_ROLES } from "../../lib/server/staffAuthorization";
import { createServerClient } from "../../lib/supabase/server";
import type { Database } from "../../lib/supabase/database.types";

export type ControllerExportContext = {
  actor: { userId: string; profileId: string; role: string; canHandoff: boolean };
  requestId: string | null;
  signal: AbortSignal | null;
  dataSession: ReturnType<typeof createServerClient>;
};
const profileSchema = z.object({ id: z.string().uuid(), name: z.string().nullable(),
  role: z.string().nullable(), active: z.boolean().nullable() });
const userSchema = z.object({ data: z.object({ user: z.object({ id: z.string().uuid() }).nullable() }), error: z.null() });
const readEnvelope = z.object({ data: z.unknown(), error: z.null() }).refine(value => Object.hasOwn(value, "data"));

/** Private session is created only after the bearer has been authenticated. */
export async function authorizeControllerExport(request: Request): Promise<ControllerExportContext> {
  request.signal.throwIfAborted();
  const token = request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) throw new AppError("AUTH_REQUIRED");
  const scopedFetch: typeof fetch = (input, init) => fetch(input, { ...init,
    signal: init?.signal && init.signal !== request.signal ? AbortSignal.any([request.signal, init.signal]) : request.signal });
  const configuration = getServerPublicSupabaseConfig();
  const auth = createClient<Database>(configuration.url, configuration.publishableKey, {
    auth: { autoRefreshToken: false, persistSession: false }, global: { fetch: scopedFetch },
  });
  const raw: unknown = await auth.auth.getUser(token);
  request.signal.throwIfAborted();
  const parsedUser = userSchema.safeParse(raw);
  if (!parsedUser.success || !parsedUser.data.data.user) throw new AppError("AUTH_REQUIRED");
  const userId = parsedUser.data.data.user.id;
  const dataSession = createServerClient({ fetch: scopedFetch });
  const result = await dataSession.from("profiles").select("id,name,role,active")
    .eq("id", userId).retry(false).abortSignal(request.signal).maybeSingle();
  request.signal.throwIfAborted();
  const envelope = readEnvelope.safeParse(result);
  if (!envelope.success) throw new AppError("INTERNAL_ERROR");
  if (envelope.data.data === null) throw new AppError("FORBIDDEN");
  const profile = profileSchema.safeParse(envelope.data.data);
  if (!profile.success || profile.data.id.toLowerCase() !== userId.toLowerCase()) throw new AppError("INTERNAL_ERROR");
  if (profile.data.active !== true || !profile.data.role || !STAFF_ROLES.has(profile.data.role)) throw new AppError("FORBIDDEN");
  const grants = readEnvelope.safeParse(await dataSession.from("staff_permission_grants")
    .select("permission").eq("profile_id", profile.data.id).retry(false).abortSignal(request.signal));
  request.signal.throwIfAborted();
  if (!grants.success) throw new AppError("INTERNAL_ERROR");
  const permissions = z.array(z.object({ permission: z.string().max(100) })).safeParse(grants.data.data);
  if (!permissions.success) throw new AppError("INTERNAL_ERROR");
  const staffPermissions = permissions.data.map(grant => grant.permission);
  return { actor: { userId, profileId: profile.data.id, role: profile.data.role,
    canHandoff: canHandoffQuickBooksProfile({ staffPermissions }) },
    requestId: request.headers.get("x-request-id"), signal: request.signal, dataSession };
}

export function requireControllerExportHandoff(context: ControllerExportContext): void {
  if (!context.actor.canHandoff) throw new AppError("FORBIDDEN");
}
