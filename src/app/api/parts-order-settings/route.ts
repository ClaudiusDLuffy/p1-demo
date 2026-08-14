import { NextRequest, NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";

import { requireStaffRequest } from "../../../lib/server/staffAuthorization";
import type { Database } from "../../../lib/supabase/database.types";

export const runtime = "nodejs";

const jsonError = (message: string, status: number) =>
  NextResponse.json({ error: message }, { status });

const normalizeCutoff = (value: unknown) => {
  const cutoff = String(value || "").trim();
  if (!cutoff) return null;
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(cutoff)) {
    throw new Error("Cutoff time must use 24-hour HH:MM format");
  }
  return cutoff;
};

const validateTimeZone = (value: unknown) => {
  const timeZone = String(value || "").trim();
  if (!timeZone || timeZone.length > 100) throw new Error("Timezone is required");
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date());
  } catch {
    throw new Error("Timezone must be a valid IANA timezone");
  }
  return timeZone;
};

type RecipientInput = {
  profileId: string;
  phoneE164: string;
  active: boolean;
};

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};

async function loadConfiguration(sb: SupabaseClient<Database>) {
  const [settingsResult, recipientsResult] = await Promise.all([
    sb
      .from("p1_parts_alert_settings")
      .select("enabled,timezone,cutoff_time,updated_at")
      .eq("singleton", true)
      .maybeSingle(),
    sb
      .from("p1_parts_alert_recipients")
      .select("id,profile_id,phone_e164,active,profiles!p1_parts_alert_recipients_profile_id_fkey(name,email)")
      .eq("active", true)
      .order("created_at", { ascending: true }),
  ]);
  if (settingsResult.error) throw settingsResult.error;
  if (recipientsResult.error) throw recipientsResult.error;

  return {
    enabled: Boolean(settingsResult.data?.enabled),
    timezone: settingsResult.data?.timezone || "America/New_York",
    cutoffTime: settingsResult.data?.cutoff_time
      ? String(settingsResult.data.cutoff_time).slice(0, 5)
      : null,
    updatedAt: settingsResult.data?.updated_at || null,
    recipients: (recipientsResult.data || []).map(recipient => ({
      id: recipient.id,
      profileId: recipient.profile_id,
      phoneE164: recipient.phone_e164,
      active: recipient.active,
      name: recipient.profiles?.name || "Staff member",
      email: recipient.profiles?.email || null,
    })),
  };
}

export async function GET(request: NextRequest) {
  const auth = await requireStaffRequest(request);
  if ("error" in auth) return auth.error;

  try {
    return NextResponse.json(await loadConfiguration(auth.sb));
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Could not load parts alert settings", 500);
  }
}

export async function PATCH(request: NextRequest) {
  const auth = await requireStaffRequest(request);
  if ("error" in auth) return auth.error;

  try {
    const body = record(await request.json().catch(() => ({})));
    const recipients = Array.isArray(body.recipients) ? body.recipients : [];
    if (recipients.length > 25) {
      return jsonError("A maximum of 25 parts-alert recipients is supported", 400);
    }

    const normalizedRecipients: RecipientInput[] = recipients.map((value: unknown) => {
      const recipient = record(value);
      const profileId = String(recipient.profileId || "").trim();
      const phoneE164 = String(recipient.phoneE164 || "").replace(/[\s()-]/g, "");
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(profileId)) {
        throw new Error("Every recipient must reference a valid staff profile");
      }
      if (!/^\+[1-9][0-9]{7,14}$/.test(phoneE164)) {
        throw new Error("Recipient phone numbers must use E.164 format, such as +18135551212");
      }
      return { profileId, phoneE164, active: recipient.active !== false };
    });

    if (new Set(normalizedRecipients.map(recipient => recipient.profileId)).size !== normalizedRecipients.length) {
      return jsonError("Each staff recipient may appear only once", 400);
    }

    const enabled = Boolean(body.enabled);
    const timezone = validateTimeZone(body.timezone || "America/New_York");
    const cutoffTime = normalizeCutoff(body.cutoffTime);
    if (enabled && !cutoffTime) {
      return jsonError("Set a cutoff time before enabling the SMS alert", 400);
    }
    if (enabled && normalizedRecipients.length === 0) {
      return jsonError("Add at least one recipient before enabling the SMS alert", 400);
    }

    const { error } = await auth.sb.rpc("configure_p1_parts_alerts", {
      p_actor_id: auth.profile.id,
      p_enabled: enabled,
      p_timezone: timezone,
      p_cutoff_time: cutoffTime,
      p_recipients: normalizedRecipients,
    });
    if (error) throw error;

    return NextResponse.json(await loadConfiguration(auth.sb));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not save parts alert settings";
    return jsonError(message, /required|valid|maximum|format|recipient/i.test(message) ? 400 : 500);
  }
}
