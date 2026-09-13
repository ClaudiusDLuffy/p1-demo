import { createClient } from "@supabase/supabase-js";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { safeNoticeError } from "../../features/financial-notifications/contracts";
import { createServerClient } from "../supabase/server";
import type { Database } from "../supabase/database.types";
import { getServerPublicSupabaseConfig } from "../config/server/supabase";
import { ConfigurationError } from "../config/shared";

export function financialHttpError(code: string, error: string, status: number) {
  return NextResponse.json({ code, error }, { status, headers: { "Cache-Control": "no-store" } });
}

export function financialRpcError(error: unknown) {
  const safe = safeNoticeError(error);
  const status = safe.code === "AUTH_REQUIRED" ? 401
    : ["FORBIDDEN", "ACCOUNT_INACTIVE"].includes(safe.code) ? 403
      : ["VALIDATION_FAILED", "REASON_REQUIRED", "INVALID_CURSOR"].includes(safe.code) ? 400
        : safe.uncertain ? 503 : 409;
  if (safe.uncertain) {
    const code = z.object({ code: z.string() }).safeParse(error);
    if (code.success && ["22023", "23514"].includes(code.data.code)) {
      return financialHttpError("VALIDATION_FAILED", "Check the invoice action and reason, then try again.", 400);
    }
    if (code.success && ["40001", "55000", "P0002"].includes(code.data.code)) {
      return financialHttpError("FINANCIAL_EVENT_STALE", "This invoice action is no longer available. Refresh before trying again.", 409);
    }
  }
  return financialHttpError(safe.code, safe.message, status);
}

export async function authorizeFinancialRequest(request: NextRequest, allowController: boolean) {
  const token = request.headers.get("authorization")?.match(/^Bearer\s+(\S+)$/i)?.[1];
  if (!token) return { error: financialHttpError("AUTH_REQUIRED", "Sign in again.", 401) };
  const configuration = getServerPublicSupabaseConfig();
  try {
    const deadline = AbortSignal.timeout(5_000);
    const caller = createClient<Database>(configuration.url, configuration.publishableKey, {
      auth: { autoRefreshToken: false, persistSession: false }, global: {
        headers: { Authorization: `Bearer ${token}` },
        fetch: (input, init) => {
          const timeout = AbortSignal.timeout(5_000);
          return fetch(input, { ...init, signal: init?.signal ? AbortSignal.any([timeout, init.signal]) : timeout });
        },
      },
    });
    const { data: identity, error: identityError } = await caller.auth.getUser(token);
    if (identityError || !identity.user) return { error: financialHttpError("AUTH_REQUIRED", "Sign in again.", 401) };
    const sb = createServerClient();
    const { data: profile, error } = await sb.from("profiles").select("id,role,active")
      .eq("id", identity.user.id).abortSignal(deadline).maybeSingle();
    if (error) return { error: financialHttpError("RESULT_UNCONFIRMED", "Account authorization is temporarily unavailable.", 503) };
    if (!profile) return { error: financialHttpError("FORBIDDEN", "This account cannot perform financial staff actions.", 403) };
    if (!profile.active) return { error: financialHttpError("ACCOUNT_INACTIVE", "Your account is inactive.", 403) };
    if (!["manager", "dispatcher", "back_office"].includes(profile.role)) {
      return { error: financialHttpError("FORBIDDEN", "This account cannot perform financial staff actions.", 403) };
    }
    const permissions = await sb.from("staff_permission_grants").select("permission").eq("profile_id", profile.id).abortSignal(deadline);
    if (permissions.error) return { error: financialHttpError("RESULT_UNCONFIRMED", "Account authorization is temporarily unavailable.", 503) };
    const grants = permissions.data.map(row => row.permission);
    if (!allowController && grants.includes("invoice_controller")) return { error: financialHttpError("FORBIDDEN", "Operational invoice-review permission is required.", 403) };
    // Writes use the authenticated caller, never the service role or a supplied
    // actor. Every RPC repeats the active profile/family permission checks.
    return { caller, canRelease: grants.includes("quickbooks_handoff") };
  } catch (error) {
    if (error instanceof ConfigurationError) throw error;
    return { error: financialHttpError("RESULT_UNCONFIRMED", "Account authorization is temporarily unavailable.", 503) };
  }
}

export async function readFinancialRequest(request: NextRequest): Promise<unknown> {
  if (!request.body) throw new Error("VALIDATION_FAILED");
  const reader = request.body.getReader();
  let timedOut = false;
  const deadline = setTimeout(() => { timedOut = true; void reader.cancel().catch(() => undefined); }, 10_000);
  const chunks: Uint8Array[] = [];
  let size = 0;
  let completed = false;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) { completed = true; break; }
      size += part.value.byteLength;
      if (size > 16_384) throw new Error("VALIDATION_FAILED");
      chunks.push(part.value);
    }
    if (timedOut) throw new Error("VALIDATION_FAILED");
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } finally {
    clearTimeout(deadline);
    if (!completed) void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
