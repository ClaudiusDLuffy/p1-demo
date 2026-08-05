import { createClient } from "@supabase/supabase-js";
import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "../../../lib/supabase/server";
import type { Database } from "../../../lib/supabase/database.types";

const STAFF_ROLES = new Set(["manager", "dispatcher", "back_office"]);
const CONTROLLER_EMAIL = "emilyb@phospitality.com";

const jsonError = (message: string, status: number) =>
  NextResponse.json({ error: message }, { status });

const bearerToken = (request: NextRequest) =>
  request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1] || "";

const authClient = () => createClient<Database>(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

async function requireInvoiceStaff(request: NextRequest) {
  const token = bearerToken(request);
  if (!token) return { error: jsonError("Unauthorized", 401) };

  const auth = authClient();
  const { data, error } = await auth.auth.getUser(token);
  if (error || !data.user) return { error: jsonError("Unauthorized", 401) };
  if (String(data.user.email || "").trim().toLowerCase() === CONTROLLER_EMAIL) {
    return { error: jsonError("The controller cannot delete contractor invoices", 403) };
  }

  const sb = createServerClient();
  const { data: profile, error: profileError } = await sb
    .from("profiles")
    .select("id, role, name")
    .eq("id", data.user.id)
    .maybeSingle();
  if (profileError) return { error: jsonError(profileError.message, 500) };
  if (!profile || !STAFF_ROLES.has(profile.role || "")) {
    return { error: jsonError("Forbidden", 403) };
  }
  return { sb, user: data.user, profile };
}

export async function DELETE(request: NextRequest) {
  const auth = await requireInvoiceStaff(request);
  if ("error" in auth) return auth.error;

  const id = request.nextUrl.searchParams.get("id")?.trim();
  if (!id) return jsonError("Invoice id is required", 400);

  try {
    const { data: invoice, error: invoiceError } = await auth.sb
      .from("invoices")
      .select("id, num, work_order_id, deleted_at")
      .eq("id", id)
      .eq("invoice_type", "contractor")
      .is("deleted_at", null)
      .maybeSingle();
    if (invoiceError) throw invoiceError;
    if (!invoice) return jsonError("Contractor invoice not found or already deleted", 404);

    const { data: sourceLinks, error: sourceError } = await auth.sb
      .from("staff_invoice_sources")
      .select("staff_invoice_id")
      .eq("contractor_invoice_id", id);
    if (sourceError) throw sourceError;

    const linkedStaffIds = Array.from(new Set<string>(
      (sourceLinks || []).map(link => String(link.staff_invoice_id)),
    ));
    if (linkedStaffIds.length > 0) {
      const { data: activeStaffInvoices, error: linkedError } = await auth.sb
        .from("invoices")
        .select("id, num")
        .in("id", linkedStaffIds)
        .eq("invoice_type", "staff")
        .is("deleted_at", null)
        .limit(1);
      if (linkedError) throw linkedError;
      if (activeStaffInvoices?.length) {
        return jsonError(
          `Invoice #${invoice.num} is used by billing invoice #${activeStaffInvoices[0].num}. Delete or unlink that billing invoice first.`,
          409,
        );
      }
    }

    const deletedAt = new Date().toISOString();
    const { data: deleted, error: deleteError } = await auth.sb
      .from("invoices")
      .update({ deleted_at: deletedAt, deleted_by: auth.user.id })
      .eq("id", id)
      .eq("invoice_type", "contractor")
      .is("deleted_at", null)
      .select("id, num, work_order_id, deleted_at")
      .maybeSingle();
    if (deleteError) throw deleteError;
    if (!deleted) return jsonError("Invoice changed before it could be deleted", 409);

    if (deleted.work_order_id) {
      const { error: auditError } = await auth.sb
        .from("activities")
        .insert({
          work_order_id: deleted.work_order_id,
          author_id: auth.user.id,
          author_name: auth.profile.name || "P1 staff",
          text: `Invoice #${deleted.num} deleted by ${auth.profile.name || "P1 staff"}.`,
          type: "system",
          is_staff_override: false,
          is_staff_only: true,
          event_key: "invoice_deleted",
          event_data: { invoiceId: deleted.id, invoiceNum: deleted.num },
        });
      // The invoice deletion is the primary action. A logging outage must not
      // turn a completed soft-delete into a false error in the UI.
      if (auditError) console.error("Contractor invoice delete audit failed", auditError);
    }

    return NextResponse.json({ invoice: deleted });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invoice delete failed";
    return jsonError(message, 500);
  }
}
