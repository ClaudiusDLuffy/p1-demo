import { createHash, timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";

import { createServerClient } from "../../../../lib/supabase/server";

export const runtime = "nodejs";

const secureEqual = (left: string, right: string) => {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length
    && timingSafeEqual(leftBytes, rightBytes);
};

const zonedClock = (date: Date, timeZone: string) => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find(part => part.type === type)?.value || "";
  return {
    date: `${value("year")}-${value("month")}-${value("day")}`,
    time: `${value("hour")}:${value("minute")}`,
  };
};

const portalUrl = () => {
  const configured = String(process.env.NEXT_PUBLIC_APP_URL || "").replace(/\/$/, "");
  if (configured) return `${configured}/?view=dashboard`;
  const vercel = String(process.env.VERCEL_PROJECT_PRODUCTION_URL || "").replace(/\/$/, "");
  return vercel ? `https://${vercel}/?view=dashboard` : "";
};

const twilioCredentials = () => {
  const accountSid = String(process.env.TWILIO_ACCOUNT_SID || "").trim();
  const apiKeySid = String(process.env.TWILIO_API_KEY_SID || "").trim();
  const apiKeySecret = String(process.env.TWILIO_API_KEY_SECRET || "").trim();
  const authToken = String(process.env.TWILIO_AUTH_TOKEN || "").trim();
  const messagingServiceSid = String(process.env.TWILIO_MESSAGING_SERVICE_SID || "").trim();
  const from = String(process.env.TWILIO_FROM_NUMBER || "").trim();
  const username = apiKeySid && apiKeySecret ? apiKeySid : accountSid;
  const password = apiKeySid && apiKeySecret ? apiKeySecret : authToken;
  if (!accountSid || !username || !password || (!messagingServiceSid && !from)) {
    throw new Error("Twilio SMS credentials are incomplete");
  }
  return { accountSid, username, password, messagingServiceSid, from };
};

async function sendSms(to: string, body: string) {
  const credentials = twilioCredentials();
  const params = new URLSearchParams({ To: to, Body: body });
  if (credentials.messagingServiceSid) {
    params.set("MessagingServiceSid", credentials.messagingServiceSid);
  } else {
    params.set("From", credentials.from);
  }
  const response = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(credentials.accountSid)}/Messages.json`,
    {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params,
      cache: "no-store",
    },
  );
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(String(payload.message || `Twilio returned ${response.status}`));
  }
  return String(payload.sid || "");
}

async function run(request: NextRequest) {
  const expectedSecret = String(process.env.CRON_SECRET || "");
  const providedSecret = request.headers
    .get("authorization")
    ?.match(/^Bearer\s+(.+)$/i)?.[1] || "";
  if (!expectedSecret || !providedSecret || !secureEqual(expectedSecret, providedSecret)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const sb = createServerClient();
  const { data: settings, error: settingsError } = await sb
    .from("p1_parts_alert_settings")
    .select("enabled,timezone,cutoff_time")
    .eq("singleton", true)
    .maybeSingle();
  if (settingsError) {
    return NextResponse.json({ error: settingsError.message }, { status: 500 });
  }

  const timezone = String(settings?.timezone || "America/New_York");
  const cutoff = settings?.cutoff_time ? String(settings.cutoff_time).slice(0, 5) : null;
  const clock = zonedClock(new Date(), timezone);
  const force = request.nextUrl.searchParams.get("force") === "1";
  if (!settings?.enabled || !cutoff) {
    return NextResponse.json({ status: "unscheduled", enabled: Boolean(settings?.enabled), cutoffTime: cutoff });
  }
  if (!force && clock.time < cutoff) {
    return NextResponse.json({ status: "before_cutoff", localTime: clock.time, cutoffTime: cutoff, timezone });
  }

  // Validate configuration before claiming any delivery so a missing secret
  // can be corrected and retried without waiting for a stale-claim timeout.
  twilioCredentials();

  const [partsResult, recipientsResult] = await Promise.all([
    sb
      .from("wo_parts")
      .select("id,work_order_id,description,qty,p1_requested_at,updated_at,work_orders!inner(store_number,deleted_at,status)")
      .eq("ordering_responsibility", "p1")
      .eq("p1_order_status", "requested")
      .is("work_orders.deleted_at", null)
      .neq("work_orders.status", "closed")
      .order("p1_requested_at", { ascending: true }),
    sb
      .from("p1_parts_alert_recipients")
      .select("id,phone_e164")
      .eq("active", true)
      .order("created_at", { ascending: true }),
  ]);
  if (partsResult.error) return NextResponse.json({ error: partsResult.error.message }, { status: 500 });
  if (recipientsResult.error) return NextResponse.json({ error: recipientsResult.error.message }, { status: 500 });

  const parts = partsResult.data || [];
  const recipients = recipientsResult.data || [];
  if (!parts.length) return NextResponse.json({ status: "nothing_to_send", localDate: clock.date });
  if (!recipients.length) return NextResponse.json({ error: "No active SMS recipients are configured" }, { status: 409 });

  const workOrderIds = [...new Set(parts.map(part => String(part.work_order_id)))];
  const signature = createHash("sha256")
    .update(parts
      .map(part => `${part.id}:${part.updated_at || part.p1_requested_at || ""}`)
      .sort()
      .join("|"))
    .digest("hex");
  const previewIds = workOrderIds.slice(0, 8).join(", ");
  const overflow = workOrderIds.length > 8 ? ` +${workOrderIds.length - 8} more` : "";
  const link = portalUrl();
  const body = [
    `P1 parts alert: ${parts.length} part request${parts.length === 1 ? "" : "s"} across ${workOrderIds.length} work order${workOrderIds.length === 1 ? "" : "s"}.`,
    `${previewIds}${overflow}`,
    link,
  ].filter(Boolean).join("\n").slice(0, 1500);

  const results = [];
  for (const recipient of recipients) {
    const { data: deliveryId, error: claimError } = await sb.rpc(
      "claim_p1_parts_alert_delivery",
      {
        p_recipient_id: recipient.id,
        p_local_date: clock.date,
        p_request_signature: signature,
      },
    );
    if (claimError) {
      results.push({ recipientId: recipient.id, status: "claim_failed", error: claimError.message });
      continue;
    }
    if (!deliveryId) {
      results.push({ recipientId: recipient.id, status: "already_sent_or_claimed" });
      continue;
    }

    try {
      const providerMessageId = await sendSms(recipient.phone_e164, body);
      const { error: completionError } = await sb.rpc(
        "complete_p1_parts_alert_delivery",
        {
          p_delivery_id: deliveryId,
          p_status: "sent",
          p_provider_message_id: providerMessageId,
          p_error_message: null,
        },
      );
      if (completionError) throw completionError;
      results.push({ recipientId: recipient.id, status: "sent", providerMessageId });
    } catch (error) {
      const message = error instanceof Error ? error.message : "SMS send failed";
      await sb.rpc("complete_p1_parts_alert_delivery", {
        p_delivery_id: deliveryId,
        p_status: "failed",
        p_provider_message_id: null,
        p_error_message: message,
      });
      results.push({ recipientId: recipient.id, status: "failed", error: message });
    }
  }

  const failures = results.filter(result => result.status === "failed" || result.status === "claim_failed");
  return NextResponse.json(
    { status: failures.length ? "partial" : "sent", localDate: clock.date, parts: parts.length, workOrders: workOrderIds.length, results },
    { status: failures.length ? 207 : 200 },
  );
}

export async function GET(request: NextRequest) {
  try {
    return await run(request);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Parts alert failed" },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    return await run(request);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Parts alert failed" },
      { status: 500 },
    );
  }
}
