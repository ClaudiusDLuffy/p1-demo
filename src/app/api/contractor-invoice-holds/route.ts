import { NextRequest, NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";

import { sendInvoicePaymentHoldNotification } from "../../../lib/notificationService";
import {
  canHandoffQuickBooksProfile,
  requireStaffRequest,
} from "../../../lib/server/staffAuthorization";
import type { Database } from "../../../lib/supabase/database.types";

export const runtime = "nodejs";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const jsonError = (message: string, status: number) =>
  NextResponse.json({ error: message }, { status });

const rpcStatus = (error: unknown) => {
  const code = error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code || "")
    : "";
  if (code === "42501") return 403;
  if (code === "P0002") return 404;
  if (code === "22023") return 400;
  if (["40001", "55000"].includes(code)) return 409;
  return 500;
};

async function controllerRecipients(
  sb: SupabaseClient<Database>,
) {
  const { data: grants, error: grantError } = await sb
    .from("staff_permission_grants")
    .select("profile_id")
    .eq("permission", "quickbooks_handoff");
  if (grantError) throw grantError;
  const profileIds = [...new Set((grants || []).map(grant => grant.profile_id))];
  if (profileIds.length === 0) return [];

  const { data: profiles, error: profileError } = await sb
    .from("profiles")
    .select("email")
    .in("id", profileIds)
    .eq("active", true);
  if (profileError) throw profileError;
  return [...new Set((profiles || [])
    .map(profile => String(profile.email || "").trim().toLowerCase())
    .filter(Boolean))];
}

export async function GET(request: NextRequest) {
  const auth = await requireStaffRequest(request, { allowInvoiceController: true });
  if ("error" in auth) return auth.error;

  const { data: holds, error: holdError } = await auth.sb
    .from("contractor_invoice_payment_holds")
    .select("invoice_id,placed_at,placed_by,reason")
    .order("placed_at", { ascending: false })
    .order("invoice_id", { ascending: false })
    .limit(100);
  if (holdError) return jsonError(holdError.message, 500);

  const invoiceIds = (holds || []).map(hold => hold.invoice_id);
  const { data: invoices, error: invoiceError } = invoiceIds.length > 0
    ? await auth.sb
      .from("invoices")
      .select("id,num,work_order_id,contractor_id,total")
      .eq("invoice_type", "contractor")
      .is("deleted_at", null)
      .in("id", invoiceIds)
    : { data: [], error: null };
  if (invoiceError) return jsonError(invoiceError.message, 500);

  const invoiceById = new Map(
    (invoices || []).map(invoice => [invoice.id, invoice]),
  );

  const workOrderIds = [...new Set(
    (invoices || []).map(invoice => invoice.work_order_id).filter(Boolean),
  )];
  const { data: workOrderIdentities, error: workOrderIdentityError } = workOrderIds.length > 0
    ? await auth.sb
      .from("work_orders")
      .select("id,duplicate_root_work_order_id")
      .in("id", workOrderIds)
    : { data: [], error: null };
  if (workOrderIdentityError) return jsonError(workOrderIdentityError.message, 500);
  const externalWorkOrderIdById = new Map(
    (workOrderIdentities || []).map(workOrder => [
      workOrder.id,
      workOrder.duplicate_root_work_order_id || workOrder.id,
    ]),
  );

  const profileIds = [...new Set([
    ...(invoices || []).map(invoice => invoice.contractor_id),
    ...(holds || []).map(hold => hold.placed_by),
  ].filter((value): value is string => Boolean(value)))];
  const { data: profiles, error: profileError } = profileIds.length > 0
    ? await auth.sb
      .from("profiles")
      .select("id,name,company")
      .in("id", profileIds)
    : { data: [], error: null };
  if (profileError) return jsonError(profileError.message, 500);
  const profilesById = new Map(
    (profiles || []).map(profile => [profile.id, profile]),
  );

  return NextResponse.json({
    holds: (holds || []).flatMap(hold => {
      const invoice = invoiceById.get(hold.invoice_id);
      if (!invoice) return [];
      const contractor = invoice.contractor_id
        ? profilesById.get(invoice.contractor_id)
        : null;
      const actor = hold.placed_by
        ? profilesById.get(hold.placed_by)
        : null;
      return [{
        invoiceId: invoice.id,
        invoiceNumber: invoice.num,
        workOrderId: invoice.work_order_id,
        externalWorkOrderId: externalWorkOrderIdById.get(invoice.work_order_id)
          || invoice.work_order_id,
        contractorName: contractor?.company || contractor?.name || "Unknown contractor",
        total: Number(invoice.total || 0),
        holdAt: hold.placed_at,
        holdBy: hold.placed_by,
        holdByName: actor?.name || "Unknown staff member",
        reason: hold.reason || "",
      }];
    }),
    canRelease: canHandoffQuickBooksProfile(auth.profile),
  }, {
    headers: { "Cache-Control": "no-store" },
  });
}

export async function PATCH(request: NextRequest) {
  const auth = await requireStaffRequest(request, { allowInvoiceController: true });
  if ("error" in auth) return auth.error;

  let body: { invoiceId?: unknown; action?: unknown; reason?: unknown };
  try {
    body = await request.json();
  } catch {
    return jsonError("Invalid JSON body", 400);
  }

  const invoiceId = String(body.invoiceId || "").trim();
  const action = String(body.action || "").trim().toLowerCase();
  const reason = String(body.reason || "").trim();
  if (!UUID_PATTERN.test(invoiceId)) {
    return jsonError("A valid invoice id is required", 400);
  }
  if (!["hold", "release"].includes(action)) {
    return jsonError("Action must be hold or release", 400);
  }
  if (!reason) return jsonError("A reason is required", 400);
  if (reason.length > 500) return jsonError("Reason is too long", 400);
  if (action === "release" && !canHandoffQuickBooksProfile(auth.profile)) {
    return jsonError("QuickBooks handoff permission required to release a hold", 403);
  }

  const { data: invoice, error: invoiceError } = await auth.sb
    .from("invoices")
    .select("id,num,work_order_id,contractor_id,total")
    .eq("id", invoiceId)
    .eq("invoice_type", "contractor")
    .is("deleted_at", null)
    .maybeSingle();
  if (invoiceError) return jsonError(invoiceError.message, 500);
  if (!invoice) return jsonError("Contractor invoice not found", 404);

  const { data: workOrderIdentity, error: workOrderIdentityError } = await auth.sb
    .from("work_orders")
    .select("id,duplicate_root_work_order_id")
    .eq("id", invoice.work_order_id)
    .maybeSingle();
  if (workOrderIdentityError) return jsonError(workOrderIdentityError.message, 500);
  if (!workOrderIdentity) return jsonError("Invoice work order not found", 409);

  try {
    const rpcName = action === "hold"
      ? "place_contractor_invoice_payment_hold"
      : "release_contractor_invoice_payment_hold";
    const { data, error } = await auth.sb.rpc(rpcName, {
      p_invoice_id: invoiceId,
      p_actor_id: auth.profile.id,
      p_reason: reason,
    });
    if (error) throw error;

    const { data: contractor } = invoice.contractor_id
      ? await auth.sb
        .from("profiles")
        .select("name,company")
        .eq("id", invoice.contractor_id)
        .maybeSingle()
      : { data: null };

    let notificationWarning: string | null = null;
    try {
      const recipients = await controllerRecipients(auth.sb);
      await sendInvoicePaymentHoldNotification({
        event: action === "hold" ? "placed" : "released",
        recipients,
        invoice: {
          num: invoice.num,
          workOrderId: invoice.work_order_id,
          externalWorkOrderId: workOrderIdentity.duplicate_root_work_order_id
            || workOrderIdentity.id,
          contractorName: contractor?.company || contractor?.name || null,
          total: Number(invoice.total || 0),
        },
        actorName: auth.profile.name || "P1 staff",
        reason,
      });
    } catch (notificationError) {
      console.error("Invoice payment hold notification failed", notificationError);
      notificationWarning = "The change was saved, but the controller email notification could not be sent.";
    }

    return NextResponse.json({
      result: data,
      notificationWarning,
    }, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    const message = error && typeof error === "object" && "message" in error
      ? String((error as { message?: unknown }).message || "Payment hold update failed")
      : "Payment hold update failed";
    return jsonError(message, rpcStatus(error));
  }
}
