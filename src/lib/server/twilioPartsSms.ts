// A runtime Node dependency deliberately makes this credential boundary
// unavailable to the browser graph. Tests use only injected fake fetches.
import { Buffer } from "node:buffer";
import { getTwilioConfig } from "../config/server/twilio";
import { correlatedFetch, withRequestCorrelation } from "./requestOperation";

export const TWILIO_SEND_TIMEOUT_MS = 10_000;
export const TWILIO_STATUS_TIMEOUT_MS = 5_000;
export const TWILIO_RESPONSE_MAX_BYTES = 16_384;
const messageSid = /^(?:SM|MM)[0-9a-f]{32}$/i;
const phone = /^\+[1-9][0-9]{7,14}$/;
const statuses = ["accepted", "queued", "sending", "sent", "delivered", "undelivered", "failed"] as const;
export type TwilioPartsSmsStatus = typeof statuses[number];
export type TwilioSmsSendOutcome =
  | { status: "accepted"; sid: string; providerStatus: TwilioPartsSmsStatus }
  | { status: "known_unsent_retryable"; code: string; retryAfterSeconds?: number }
  | { status: "known_unsent_terminal"; code: string }
  | { status: "unknown"; code: string };
export type TwilioSmsStatusOutcome =
  | { status: "observed"; providerStatus: TwilioPartsSmsStatus }
  | { status: "unavailable"; code: "TWILIO_STATUS_UNAVAILABLE" };
export type TwilioPartsSmsConfiguration = {
  accountSid: string; username: string; password: string; messagingServiceSid: string; from: string;
};
type Transport = { fetch: typeof fetch; sendTimeoutMs: number; statusTimeoutMs: number };
export type PartsSmsProvider = {
  configured: boolean;
  send: (input: { phoneE164: string; body: string }, signal?: AbortSignal) => Promise<TwilioSmsSendOutcome>;
  lookup: (sid: string, signal?: AbortSignal) => Promise<TwilioSmsStatusOutcome>;
};

function providerStatus(value: unknown): TwilioPartsSmsStatus | null {
  return statuses.find(status => status === value) ?? null;
}
function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}
function validConfiguration(value: TwilioPartsSmsConfiguration | null): value is TwilioPartsSmsConfiguration {
  return value !== null && /^AC[0-9a-f]{32}$/i.test(value.accountSid)
    && /^(?:AC|SK)[0-9a-f]{32}$/i.test(value.username)
    && value.password.length > 0 && value.password.length <= 512
    && (/^MG[0-9a-f]{32}$/i.test(value.messagingServiceSid) || (!value.messagingServiceSid && phone.test(value.from)));
}

export function partsSmsProviderConfiguration(): TwilioPartsSmsConfiguration | null {
  const result = getTwilioConfig();
  return result.status === "configured" ? result.value : null;
}

/** One deadline covers headers AND response streaming. It observes late promise
 * rejection even for a test adapter that ignores AbortSignal. Native fetch and
 * the owned reader are actively cancelled; no provider body enters an error. */
async function boundedJson(fetcher: typeof fetch, url: string, init: RequestInit,
  timeout: number, parent?: AbortSignal): Promise<{ status: number; payload: unknown }> {
  const controller = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let rejectDeadline: (reason: Error) => void = () => undefined;
  const deadline = new Promise<never>((_resolve, reject) => { rejectDeadline = reject; });
  const abort = () => {
    controller.abort();
    void reader?.cancel().catch(() => undefined);
    rejectDeadline(new Error("TWILIO_REQUEST_UNCONFIRMED"));
  };
  const timer = setTimeout(abort, timeout);
  parent?.addEventListener("abort", abort, { once: true });
  if (parent?.aborted) abort();
  try {
    const request = (async () => {
      if (controller.signal.aborted) throw new Error("TWILIO_REQUEST_UNCONFIRMED");
      const response = await fetcher(url, { ...init, signal: controller.signal, redirect: "error", cache: "no-store" });
      if (controller.signal.aborted) {
        void response.body?.cancel().catch(() => undefined);
        throw new Error("TWILIO_REQUEST_UNCONFIRMED");
      }
      if (!response.body) return { status: response.status, payload: null };
      reader = response.body.getReader();
      const bytes = new Uint8Array(TWILIO_RESPONSE_MAX_BYTES);
      let size = 0;
      while (true) {
        const chunk = await reader.read();
        if (controller.signal.aborted) throw new Error("TWILIO_REQUEST_UNCONFIRMED");
        if (chunk.done) break;
        if (size + chunk.value.byteLength > bytes.length) throw new Error("TWILIO_REQUEST_UNCONFIRMED");
        bytes.set(chunk.value, size); size += chunk.value.byteLength;
      }
      const payload: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, size)));
      return { status: response.status, payload };
    })();
    return await Promise.race([request, deadline]);
  } finally {
    clearTimeout(timer);
    parent?.removeEventListener("abort", abort);
    controller.abort();
    if (reader) void reader.cancel().catch(() => undefined);
  }
}

export function createTwilioPartsSms(configuration: TwilioPartsSmsConfiguration | null = partsSmsProviderConfiguration(),
  injected: Partial<Transport> = {}): PartsSmsProvider {
  const transport: Transport = {
    fetch: injected.fetch ? withRequestCorrelation(injected.fetch) : correlatedFetch,
    sendTimeoutMs: Math.min(Math.max(injected.sendTimeoutMs ?? TWILIO_SEND_TIMEOUT_MS, 1), TWILIO_SEND_TIMEOUT_MS),
    statusTimeoutMs: Math.min(Math.max(injected.statusTimeoutMs ?? TWILIO_STATUS_TIMEOUT_MS, 1), TWILIO_STATUS_TIMEOUT_MS),
  };
  const configured = validConfiguration(configuration);
  const base = configuration ? `https://api.twilio.com/2010-04-01/Accounts/${configuration.accountSid}/Messages` : "";
  const authorization = configuration ? `Basic ${Buffer.from(`${configuration.username}:${configuration.password}`).toString("base64")}` : "";
  return {
    configured,
    async send(input, signal) {
      if (!configured || !configuration) return { status: "known_unsent_terminal", code: "TWILIO_NOT_CONFIGURED" };
      if (!phone.test(input.phoneE164)) return { status: "known_unsent_terminal", code: "RECIPIENT_NOT_DELIVERABLE" };
      if (!input.body.trim() || input.body.length > 1500) return { status: "known_unsent_terminal", code: "PARTS_SMS_MESSAGE_INVALID" };
      if (signal?.aborted) return { status: "known_unsent_retryable", code: "TWILIO_BEFORE_SEND_CANCELLED" };
      const params = new URLSearchParams({ To: input.phoneE164, Body: input.body });
      if (configuration.messagingServiceSid) params.set("MessagingServiceSid", configuration.messagingServiceSid);
      else params.set("From", configuration.from);
      try {
        const result = await boundedJson(transport.fetch, `${base}.json`, {
          method: "POST", headers: { Authorization: authorization, "Content-Type": "application/x-www-form-urlencoded" }, body: params,
        }, transport.sendTimeoutMs, signal);
        const payload = object(result.payload);
        if (result.status === 201 && typeof payload?.sid === "string" && messageSid.test(payload.sid)) {
          // A valid creation receipt proves provider acceptance, not handset
          // delivery. An unfamiliar/missing lifecycle status retains that SID
          // for lookup without inventing a later transport outcome.
          return { status: "accepted", sid: payload.sid, providerStatus: providerStatus(payload.status) ?? "accepted" };
        }
        // No repository-local Twilio error contract proves acceptance absent.
        // Do not infer retry safety from status alone (including 429/5xx).
        // Promotion must verify provider semantics before adding a whitelist.
        return { status: "unknown", code: "TWILIO_RESPONSE_UNCONFIRMED" };
      } catch {
        return { status: "unknown", code: "TWILIO_UNKNOWN" };
      }
    },
    async lookup(sid, signal) {
      const unavailable: TwilioSmsStatusOutcome = { status: "unavailable", code: "TWILIO_STATUS_UNAVAILABLE" };
      if (!configured || !messageSid.test(sid) || signal?.aborted) return unavailable;
      try {
        const result = await boundedJson(transport.fetch, `${base}/${sid}.json`, {
          method: "GET", headers: { Authorization: authorization },
        }, transport.statusTimeoutMs, signal);
        const payload = object(result.payload);
        const status = providerStatus(payload?.status);
        if (result.status !== 200 || payload?.sid !== sid || !status) return unavailable;
        return { status: "observed", providerStatus: status };
      } catch { return unavailable; }
    },
  };
}
