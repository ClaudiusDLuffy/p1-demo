import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { createInvoicePaymentHoldNotificationPlan, createInvoiceReviewNotificationPlan } from "../notificationService";

type Row = Record<string, unknown>;
type QueryResult = { data: Row | Row[] | null; error: null };
interface Query extends PromiseLike<QueryResult> {
  select: (columns: string) => Query;
  eq: (key: string, value: unknown) => Query;
  is: (key: string, value: unknown) => Query;
  in: (key: string, values: unknown[]) => Query;
  contains: (key: string, values: Row) => Query;
  limit: (count: number) => Query;
  order: (key: string, options: unknown) => Query;
  maybeSingle: () => Promise<QueryResult>;
}
type Plan = { recipients: string[]; subject: string; body: string };
type Handler = (request: Request) => Promise<Response>;
const staffId = "40000000-0000-4000-8000-000000000001";
export const baselineContractorId = "40000000-0000-4000-8000-000000000004";
export const baselineCreatorId = "62000000-0000-4000-8000-000000000004";
const organizationId = "61000000-0000-4000-8000-000000000001";
const invoiceId = "81000000-0000-4000-8000-000000000001";
const handoffId = "62000000-0000-4000-8000-000000000008";

// Frozen first-party source from the pre-3B snapshot executes unchanged. Only
// database/Auth IO and provider send are replaced. There is no live network.
export function baselineFinancialRoute(kind: "review" | "holds") {
  const rows: Record<string, Row[]> = {
    profiles: [
      { id: staffId, name: "Synthetic staff", email: "staff@example.invalid", role: "manager", active: true },
      { id: baselineContractorId, name: "Synthetic contractor", company: "Synthetic contractor", email: "contractor@example.invalid", role: "contractor", active: true, contractor_organization_id: null, contractor_tier: "direct" },
      { id: handoffId, name: "Synthetic handoff", email: "handoff@example.invalid", role: "back_office", active: true },
    ],
    invoices: [{ id: invoiceId, num: "SYNTHETIC-1", state: kind === "review" ? "rejected" : "approved",
      rejection_reason: "Synthetic correction required", work_order_id: "WOT-SYNTHETIC-1", store_number: "99999",
      contractor_id: baselineContractorId, created_by: baselineContractorId, review_revision: 1, invoice_type: "contractor", deleted_at: null, total: 100 }],
    work_orders: [{ id: "WOT-SYNTHETIC-1", duplicate_root_work_order_id: null }],
    activities: ["invoice_rejected", "invoice_rejection_retracted"].map((key, index) => ({ id: `event-${index}`, work_order_id: "WOT-SYNTHETIC-1", event_key: key, event_data: { invoiceId, revision: 1 }, deleted_at: null })),
    staff_permission_grants: [{ profile_id: handoffId, permission: "quickbooks_handoff" }],
    organizations: [], contractor_technicians: [], contractor_invoice_payment_holds: [],
  };
  const accepted: Plan[] = [];
  const attempts: Plan[] = [];
  const rpcCalls: string[] = [];
  const holdEvents: { action: string; reason: string }[] = [];
  let failAfterAcceptance = false;
  let currentHold: string | null = null;
  let bodyReads = 0;
  let allowed = true;
  function from(table: string): Query {
    const filters: ((row: Row) => boolean)[] = [];
    let limit = Number.POSITIVE_INFINITY;
    const run = (single: boolean): QueryResult => {
      const data = (rows[table] || []).filter(row => filters.every(filter => filter(row))).slice(0, limit);
      return { data: single ? data[0] || null : data, error: null };
    };
    const query: Query = {
      select: () => query,
      eq: (key, value) => { filters.push(row => row[key] === value); return query; },
      is: (key, value) => { filters.push(row => row[key] === value); return query; },
      in: (key, values) => { filters.push(row => values.includes(row[key])); return query; },
      contains: (key, values) => {
        filters.push(row => {
          const field = row[key];
          return field !== null && typeof field === "object"
            && Object.entries(values).every(([name, value]) => Reflect.get(field, name) === value);
        });
        return query;
      },
      limit: count => { limit = count; return query; },
      order: () => query,
      maybeSingle: async () => run(true),
      then: (fulfilled, rejected) => Promise.resolve(run(false)).then(fulfilled, rejected),
    };
    return query;
  }
  const sb = {
    from,
    rpc: async (name: string, args: { p_reason: string }) => {
      rpcCalls.push(name);
      const placing = name === "place_contractor_invoice_payment_hold";
      if (placing && currentHold !== null) return { data: { applied: false, reason: "already_held", holdReason: currentHold }, error: null };
      if (!placing && currentHold === null) return { data: { applied: false, reason: "not_held" }, error: null };
      currentHold = placing ? args.p_reason : null;
      holdEvents.push({ action: placing ? "placed" : "released", reason: args.p_reason });
      return { data: { applied: true, invoiceId }, error: null };
    },
  };
  async function send(plan: Plan) {
    attempts.push(plan);
    if (!plan.recipients.length) throw new Error("Synthetic missing notification recipients");
    accepted.push(plan);
    if (failAfterAcceptance) throw new Error("Synthetic provider accepted before response timeout");
  }
  const exports: { POST?: Handler; PATCH?: Handler } = {};
  const filename = resolve(`src/lib/financial-notification-test-support/${kind}-route.fixture`);
  const compiled = ts.transpileModule(readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const nextResponse = { json: (value: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(value), {
    ...init, headers: { "content-type": "application/json", ...Object.fromEntries(new Headers(init.headers)) },
  }) };
  runInNewContext(compiled, {
    exports, Error, console: { error: () => undefined }, process: { env: {} },
    require: (name: string) => {
      if (name === "next/server") return { NextResponse: nextResponse };
      if (name === "@supabase/supabase-js") return { createClient: () => ({ auth: { getUser: async () => ({ data: { user: allowed ? { id: staffId } : null }, error: null }) } }) };
      if (name.endsWith("/supabase/server")) return { createServerClient: () => sb };
      if (name.endsWith("/notificationService")) return {
        sendInvoiceReviewNotification: (input: Parameters<typeof createInvoiceReviewNotificationPlan>[0]) => send(createInvoiceReviewNotificationPlan(input)),
        sendInvoicePaymentHoldNotification: (input: Parameters<typeof createInvoicePaymentHoldNotificationPlan>[0]) => send(createInvoicePaymentHoldNotificationPlan(input)),
      };
      if (name.endsWith("/server/staffAuthorization")) return {
        STAFF_ROLES: new Set(["manager", "dispatcher", "back_office"]),
        loadStaffPermissions: async () => [], isInvoiceControllerProfile: () => false,
        canHandoffQuickBooksProfile: () => true,
        requireStaffRequest: async () => allowed ? { sb, profile: { ...rows.profiles[0], staffPermissions: ["quickbooks_handoff"] } }
          : { error: nextResponse.json({ error: "Unauthorized" }, { status: 401 }) },
      };
      throw new Error(`Unexpected frozen fixture dependency: ${name}`);
    },
  }, { filename });
  const handler = kind === "review" ? exports.POST : exports.PATCH;
  if (!handler) throw new Error("Synthetic fixture handler missing");
  const executeHandler = handler;
  async function request(patch: Row = {}, authorization = true) {
    const request = new Request("http://synthetic.invalid/notification", {
      method: kind === "review" ? "POST" : "PATCH",
      headers: { "Content-Type": "application/json", ...(authorization ? { Authorization: "Bearer synthetic-valid-session" } : {}) },
      body: JSON.stringify({ invoiceId, ...(kind === "review" ? { event: "rejected" } : { action: "hold", reason: "Synthetic original hold reason" }), ...patch }),
    });
    const json = request.json.bind(request);
    request.json = async () => { bodyReads++; return json(); };
    return executeHandler(request);
  }
  function companyCreator(access = "invoice", active = true, linked = true, sameCompany = true) {
    rows.profiles[1].contractor_organization_id = organizationId;
    rows.organizations = [{ id: organizationId, canonical_contractor_id: baselineContractorId, active: true }];
    rows.invoices[0].created_by = baselineCreatorId;
    rows.profiles.push({ id: baselineCreatorId, name: "Synthetic creator", role: "contractor", email: "creator@example.invalid", active,
      contractor_access_level: access, contractor_organization_id: sameCompany ? organizationId : "different-synthetic-company" });
    rows.contractor_technicians = linked ? [{ id: "synthetic-technician", profile_id: baselineCreatorId, contractor_id: baselineContractorId, is_active: true }] : [];
  }
  return { rows, accepted, attempts, rpcCalls, holdEvents, request, companyCreator,
    failAfterAcceptance: () => { failAfterAcceptance = true; }, invalidSession: () => { allowed = false; }, bodyReads: () => bodyReads,
    setCurrentHold: (reason: string | null) => { currentHold = reason; },
    getCurrentHold: () => currentHold,
  };
}
