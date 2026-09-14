import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import ts from "typescript";

type Row = Record<string, unknown>;
type QueryResult = { data: Row | Row[] | null; error: Error | null };
interface Query extends PromiseLike<QueryResult> {
  select: (columns: string) => Query;
  eq: (key: string, value: unknown) => Query;
  neq: (key: string, value: unknown) => Query;
  is: (key: string, value: unknown) => Query;
  order: (key: string, options: { ascending: boolean }) => Query;
  maybeSingle: () => Promise<QueryResult>;
}
type LegacyDelivery = {
  id: string; recipientId: string; localDate: string; signature: string;
  status: "claimed" | "sent" | "failed"; attemptCount: number;
  claimedAt: number; providerMessageId: string | null;
};
type Handler = (request: Request & { nextUrl: URL }) => Promise<Response>;
export type LegacyProviderMode = "accepted" | "accepted_then_lost" | "rejected" | "missing_sid" | "malformed_json" | "hanging";
export const syntheticSmsRecipient = "76000000-0000-4000-8000-000000000001";
export const syntheticSmsSid = `SM${"a".repeat(32)}`;

// Executes the complete frozen pre-3C first-party route. Only IO is replaced.
// Every number, account value, work order and provider response is synthetic.
export function legacyPartsSmsRoute() {
  const rows: Record<string, Row[]> = {
    p1_parts_alert_settings: [{ singleton: true, enabled: true, timezone: "America/New_York", cutoff_time: "17:00:00" }],
    p1_parts_alert_recipients: [{ id: syntheticSmsRecipient, phone_e164: "+12025550123", active: true, created_at: "2026-01-01T00:00:00Z" }],
    wo_parts: [{ id: "77000000-0000-4000-8000-000000000001", work_order_id: "WOT-SYNTHETIC-1", description: "Synthetic part", qty: 1,
      ordering_responsibility: "p1", p1_order_status: "requested", p1_requested_at: "2026-09-09T16:00:00+00:00",
      updated_at: "2026-09-09T16:00:00+00:00", work_orders: { store_number: "99999", status: "awaiting_parts", deleted_at: null } }],
  };
  let now = Date.parse("2026-09-09T22:00:00Z");
  let failSentCompletion = false;
  let mode: LegacyProviderMode = "accepted";
  const modes: LegacyProviderMode[] = [];
  const deliveries: LegacyDelivery[] = [];
  const rpcCalls: { name: string; args: Row }[] = [];
  const accepted: { body: string; to: string }[] = [];
  const providerRequests: { signal: AbortSignal | null | undefined; body: string }[] = [];
  const releaseWaiters: (() => void)[] = [];
  const env: Record<string, string> = {
    CRON_SECRET: "synthetic-cron-token",
    TWILIO_ACCOUNT_SID: "synthetic-account",
    TWILIO_AUTH_TOKEN: "synthetic-token",
    TWILIO_FROM_NUMBER: "+12025550124",
    NEXT_PUBLIC_APP_URL: "https://portal.example.invalid/",
  };
  const get = (row: Row, key: string): unknown => key.split(".").reduce<unknown>((value, field) =>
    value && typeof value === "object" ? Reflect.get(value, field) : undefined, row);
  function from(table: string): Query {
    const filters: ((row: Row) => boolean)[] = [];
    let ordering: { key: string; ascending: boolean } | undefined;
    const run = (single: boolean): QueryResult => {
      const data = (rows[table] || []).filter(row => filters.every(filter => filter(row)));
      if (ordering) {
        const { key, ascending } = ordering;
        data.sort((left, right) => String(get(left, key) ?? "").localeCompare(String(get(right, key) ?? "")) * (ascending ? 1 : -1));
      }
      return { data: single ? data[0] || null : data, error: null };
    };
    const query: Query = {
      select: () => query,
      eq: (key, value) => { filters.push(row => get(row, key) === value); return query; },
      neq: (key, value) => { filters.push(row => get(row, key) !== value); return query; },
      is: (key, value) => { filters.push(row => get(row, key) === value); return query; },
      order: (key, options) => { ordering = { key, ascending: options.ascending }; return query; },
      maybeSingle: async () => run(true),
      then: (fulfilled, rejected) => Promise.resolve(run(false)).then(fulfilled, rejected),
    };
    return query;
  }
  const sb = {
    from,
    rpc: async (name: string, args: Row) => {
      rpcCalls.push({ name, args });
      if (name === "claim_p1_parts_alert_delivery") {
        const recipientId = String(args.p_recipient_id);
        const localDate = String(args.p_local_date);
        const signature = String(args.p_request_signature);
        const existing = deliveries.find(row => row.recipientId === recipientId && row.localDate === localDate);
        if (existing) {
          if (existing.status === "sent" || (existing.status === "claimed" && existing.claimedAt > now - 15 * 60_000)) {
            return { data: null, error: null };
          }
          Object.assign(existing, { status: "claimed", signature, claimedAt: now, attemptCount: existing.attemptCount + 1, providerMessageId: null });
          return { data: existing.id, error: null };
        }
        const created: LegacyDelivery = { id: `synthetic-delivery-${deliveries.length + 1}`, recipientId, localDate,
          signature, status: "claimed", attemptCount: 1, claimedAt: now, providerMessageId: null };
        deliveries.push(created);
        return { data: created.id, error: null };
      }
      if (name === "complete_p1_parts_alert_delivery") {
        if (args.p_status === "sent" && failSentCompletion) {
          failSentCompletion = false;
          return { data: null, error: new Error("Synthetic database completion failure") };
        }
        const delivery = deliveries.find(row => row.id === args.p_delivery_id && row.status === "claimed");
        if (!delivery) return { data: null, error: new Error("Synthetic claimed delivery missing") };
        if (args.p_status !== "sent" && args.p_status !== "failed") throw new Error("Unexpected legacy completion state");
        delivery.status = args.p_status;
        delivery.providerMessageId = typeof args.p_provider_message_id === "string" ? args.p_provider_message_id || null : null;
        return { data: null, error: null };
      }
      throw new Error(`Unexpected frozen legacy RPC ${name}`);
    },
  };
  async function fakeFetch(_url: string, init: RequestInit): Promise<Response> {
    const params = new URLSearchParams(String(init.body));
    providerRequests.push({ signal: init.signal, body: params.get("Body") || "" });
    const currentMode = modes.shift() ?? mode;
    if (currentMode === "rejected") return new Response(JSON.stringify({ message: "Synthetic rejection" }), { status: 400 });
    accepted.push({ body: params.get("Body") || "", to: params.get("To") || "" });
    if (currentMode === "accepted_then_lost") throw new Error("Synthetic provider accepted before connection loss");
    if (currentMode === "hanging") await new Promise<void>(resolveWait => releaseWaiters.push(resolveWait));
    if (currentMode === "malformed_json") return new Response("not-json", { status: 201 });
    return new Response(JSON.stringify(currentMode === "missing_sid" ? {} : { sid: syntheticSmsSid, status: "queued" }), { status: 201 });
  }
  class Clock extends Date {
    constructor(value?: string | number | Date) { super(value === undefined ? now : value instanceof Date ? value.valueOf() : value); }
    static now() { return now; }
  }
  const exports: { GET?: Handler; POST?: Handler } = {};
  const filename = resolve("src/lib/parts-sms-test-support/legacy-route.fixture");
  const compiled = ts.transpileModule(readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  runInNewContext(compiled, {
    exports, Date: Clock, Intl, Error, Buffer, URLSearchParams, fetch: fakeFetch,
    process: { env },
    require: (name: string) => {
      if (name === "node:crypto") return { createHash, timingSafeEqual };
      if (name === "next/server") return { NextResponse: { json: (value: unknown, init?: ResponseInit) => Response.json(value, init) } };
      if (name.endsWith("/supabase/server")) return { createServerClient: () => sb };
      throw new Error(`Unexpected frozen legacy dependency ${name}`);
    },
  }, { filename });
  async function request(options: { method?: "GET" | "POST"; secret?: string | null; force?: boolean } = {}) {
    const url = new URL(`https://synthetic.invalid/api/notifications/parts-order${options.force ? "?force=1" : ""}`);
    const method = options.method ?? "GET";
    const handler = exports[method];
    if (!handler) throw new Error("Frozen legacy handler missing");
    const secret = options.secret === undefined ? "synthetic-cron-token" : options.secret;
    return handler(Object.assign(new Request(url, { method, headers: secret ? { authorization: `Bearer ${secret}` } : {} }), { nextUrl: url }));
  }
  return {
    rows, env, deliveries, rpcCalls, accepted, providerRequests, request,
    setNow: (date: string) => { now = Date.parse(date); },
    providerMode: (value: LegacyProviderMode) => { mode = value; },
    providerModes: (...values: LegacyProviderMode[]) => { modes.push(...values); },
    failNextSentCompletion: () => { failSentCompletion = true; },
    releaseProvider: () => { releaseWaiters.splice(0).forEach(release => release()); },
  };
}
