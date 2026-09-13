import { getServerPublicSupabaseConfig } from "../config/server/supabase";
import { z } from "zod";
import { awaitInvoicePdfRequest, createInvoicePdfDeadline, INVOICE_PDF_AUTH_TIMEOUT_MS, InvoicePdfRequestError, readInvoicePdfRequestBytes } from "./invoicePdfRequest";

const identitySchema = z.object({ id: z.uuid() });
const profileSchema = z.array(z.object({ id: z.uuid(), active: z.boolean(),
  role: z.enum(["manager", "dispatcher", "back_office", "contractor"]) })).length(1);
const invoiceScopeSchema = z.object({ canInvoice: z.literal(true), contractorAccountId: z.uuid() });

/** Stateless uploaded-byte utility: no parent is read or authorized here.
 * Staff (including controllers) and current invoice-capable contractor actors
 * may parse their own uploads. Parent assignment remains enforced by separate
 * read/write commands; get_my_contractor_scope uses the current0105 policy. */
export async function requireInvoicePdfActor(request: Request, options: {
  fetch?: typeof fetch; timeoutMs?: number;
} = {}): Promise<{ id: string; role: "manager" | "dispatcher" | "back_office" | "contractor" }> {
  const authorization = request.headers.get("authorization");
  const token = authorization?.match(/^Bearer\s+(\S+)$/i)?.[1];
  if (!authorization) throw new InvoicePdfRequestError("AUTH_REQUIRED");
  if (!token) throw new InvoicePdfRequestError("AUTH_INVALID");
  const { url: projectUrl, publishableKey } = getServerPublicSupabaseConfig();
  const deadline = createInvoicePdfDeadline(request.signal, options.timeoutMs ?? INVOICE_PDF_AUTH_TIMEOUT_MS, "AUTH_TIMEOUT");
  const { signal } = deadline;
  const send = options.fetch ?? fetch;
  const headers = { Accept: "application/json", apikey: publishableKey, Authorization: `Bearer ${token}` };
  const fetchJson = async (url: URL, method: "GET" | "POST" = "GET",
    denial: "AUTH_INVALID" | "FORBIDDEN" = "AUTH_INVALID"): Promise<unknown> => {
    if (signal.aborted) await awaitInvoicePdfRequest(Promise.resolve(), signal);
    const response = await awaitInvoicePdfRequest(send(url, { method, cache: "no-store", signal,
      headers: method === "POST" ? { ...headers, "Content-Type": "application/json" } : headers,
      ...(method === "POST" ? { body: "{}" } : {}),
    }), signal);
    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined);
      throw new InvoicePdfRequestError(denial);
    }
    const bytes = await readInvoicePdfRequestBytes(response.body, 64 * 1024, signal);
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  };
  try {
    const identity = identitySchema.safeParse(await fetchJson(new URL("/auth/v1/user", projectUrl)));
    if (!identity.success) throw new InvoicePdfRequestError("AUTH_INVALID");
    const profileUrl = new URL("/rest/v1/profiles", projectUrl);
    profileUrl.searchParams.set("select", "id,active,role");
    profileUrl.searchParams.set("id", `eq.${identity.data.id}`);
    profileUrl.searchParams.set("limit", "1");
    const profiles = profileSchema.safeParse(await fetchJson(profileUrl, "GET", "FORBIDDEN"));
    const profile = profiles.success ? profiles.data[0] : undefined;
    if (!profile || profile.id !== identity.data.id) throw new InvoicePdfRequestError("FORBIDDEN");
    if (!profile.active) throw new InvoicePdfRequestError("ACCOUNT_INACTIVE");
    if (profile.role === "contractor") {
      const scope = invoiceScopeSchema.safeParse(await fetchJson(new URL("/rest/v1/rpc/get_my_contractor_scope", projectUrl), "POST", "FORBIDDEN"));
      if (!scope.success) throw new InvoicePdfRequestError("FORBIDDEN");
    }
    return { id: profile.id, role: profile.role };
  } catch (error: unknown) {
    if (error instanceof InvoicePdfRequestError && ["REQUEST_ABORTED", "AUTH_TIMEOUT", "AUTH_INVALID", "ACCOUNT_INACTIVE", "FORBIDDEN"].includes(error.code)) throw error;
    if (signal.aborted) await awaitInvoicePdfRequest(Promise.resolve(), signal);
    throw new InvoicePdfRequestError("AUTH_INVALID");
  } finally { deadline.dispose(); }
}
