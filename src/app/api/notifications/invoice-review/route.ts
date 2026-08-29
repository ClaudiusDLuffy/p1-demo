import { createClient } from "@supabase/supabase-js";
import { NextRequest, NextResponse } from "next/server";
import { sendInvoiceReviewNotification } from "../../../../lib/notificationService";
import { createServerClient } from "../../../../lib/supabase/server";
import {
  isInvoiceControllerProfile,
  loadStaffPermissions,
  STAFF_ROLES,
} from "../../../../lib/server/staffAuthorization";
import type { Database } from "../../../../lib/supabase/database.types";

const jsonError = (message: string, status: number) =>
  NextResponse.json({ error: message }, { status });

const anonClient = () =>
  createClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );

const bearerToken = (request: NextRequest) => {
  const match = (request.headers.get("authorization") || "").match(
    /^Bearer\s+(.+)$/i,
  );
  return match?.[1] || "";
};

async function requireStaff(request: NextRequest) {
  const token = bearerToken(request);
  if (!token) return { error: jsonError("Unauthorized", 401) };

  const auth = anonClient();
  const { data, error } = await auth.auth.getUser(token);
  if (error || !data.user) return { error: jsonError("Unauthorized", 401) };

  const sb = createServerClient();
  const { data: profile, error: profileError } = await sb
    .from("profiles")
    .select("id,email,role,active")
    .eq("id", data.user.id)
    .maybeSingle();

  if (profileError) return { error: jsonError(profileError.message, 500) };
  if (!profile?.active || !STAFF_ROLES.has(profile.role || "")) {
    return { error: jsonError("Forbidden", 403) };
  }

  let staffPermissions: string[];
  try {
    staffPermissions = await loadStaffPermissions(sb, profile.id);
  } catch (permissionError) {
    return { error: jsonError(permissionError instanceof Error ? permissionError.message : "Permission lookup failed", 500) };
  }
  if (isInvoiceControllerProfile({ staffPermissions })) {
    return { error: jsonError("Forbidden", 403) };
  }

  return { sb };
}

export async function POST(request: NextRequest) {
  const auth = await requireStaff(request);
  if ("error" in auth) return auth.error;

  let body: Record<string, unknown>;
  try {
    body = await request.json() as Record<string, unknown>;
  } catch {
    return jsonError("Invalid JSON body", 400);
  }

  const invoiceId = String(body.invoiceId || "").trim();
  const event = String(body.event || "").trim();
  if (!invoiceId || !["rejected", "retraction"].includes(event)) {
    return jsonError("invoiceId and a valid event are required", 400);
  }

  const sb = auth.sb;
  const { data: invoice, error: invoiceError } = await sb
    .from("invoices")
    .select("id,num,state,rejection_reason,work_order_id,store_number,contractor_id,created_by,review_revision,deleted_at")
    .eq("id", invoiceId)
    .eq("invoice_type", "contractor")
    .is("deleted_at", null)
    .maybeSingle();

  if (invoiceError) return jsonError(invoiceError.message, 500);
  if (!invoice) return jsonError("Contractor invoice not found", 404);

  if (event === "rejected") {
    if (invoice.state !== "rejected" || !invoice.rejection_reason) {
      return jsonError("Invoice is not currently rejected", 409);
    }
  } else {
    if (invoice.state !== "approved") {
      return jsonError("Invoice rejection has not been retracted", 409);
    }
  }

  const reviewEventKey = event === "rejected"
    ? "invoice_rejected"
    : "invoice_rejection_retracted";
  const { data: reviewEvent, error: reviewEventError } = await sb
    .from("activities")
    .select("id,event_data")
    .eq("work_order_id", invoice.work_order_id)
    .eq("event_key", reviewEventKey)
    .contains("event_data", {
      invoiceId: invoice.id,
      revision: invoice.review_revision,
    })
    .is("deleted_at", null)
    .limit(1)
    .maybeSingle();
  if (reviewEventError) return jsonError(reviewEventError.message, 500);
  if (!reviewEvent) {
    return jsonError("Matching invoice review activity was not found", 409);
  }

  const contractorId = invoice.contractor_id || invoice.created_by;
  if (!contractorId) return jsonError("Contractor profile was not recorded", 409);

  const { data: contractor, error: contractorError } = await sb
    .from("profiles")
    .select("id,name,email,company,role,active,contractor_organization_id")
    .eq("id", contractorId)
    .maybeSingle();

  if (contractorError) return jsonError(contractorError.message, 500);
  if (!contractor) return jsonError("Contractor profile not found", 404);
  if (contractor.role !== "contractor" || !contractor.active) {
    return jsonError("Contractor account is inactive or invalid", 409);
  }

  let canonicalContractorId = contractor.id;
  if (contractor.contractor_organization_id) {
    const { data: organization, error: organizationError } = await sb
      .from("organizations")
      .select("canonical_contractor_id")
      .eq("id", contractor.contractor_organization_id)
      .eq("active", true)
      .maybeSingle();
    if (organizationError) return jsonError(organizationError.message, 500);
    if (
      !organization?.canonical_contractor_id
      || organization.canonical_contractor_id !== contractor.id
    ) {
      return jsonError("Contractor company identity is invalid", 409);
    }
    canonicalContractorId = organization.canonical_contractor_id;
  }

  const recipientEmails: string[] = contractor.email ? [contractor.email] : [];
  if (invoice.created_by && invoice.created_by !== contractor.id) {
    const { data: creator, error: creatorError } = await sb
      .from("profiles")
      .select("id,email,role,active,contractor_tier,contractor_access_level,contractor_organization_id")
      .eq("id", invoice.created_by)
      .maybeSingle();
    if (creatorError) return jsonError(creatorError.message, 500);
    const belongsToInvoiceCompany = creator?.id === contractor.id
      || (
        contractor.contractor_organization_id
        && creator?.contractor_organization_id
          === contractor.contractor_organization_id
      );
    let creatorCanInvoice = false;
    if (creator?.contractor_organization_id) {
      creatorCanInvoice = creator.id === canonicalContractorId
        && creator.contractor_access_level === "company_admin";
      if (
        !creatorCanInvoice
        && creator.id !== canonicalContractorId
        && creator.contractor_access_level === "invoice"
      ) {
        const { data: technicianLink, error: technicianLinkError } = await sb
          .from("contractor_technicians")
          .select("id")
          .eq("profile_id", creator.id)
          .eq("contractor_id", canonicalContractorId)
          .eq("is_active", true)
          .limit(1)
          .maybeSingle();
        if (technicianLinkError) {
          return jsonError(technicianLinkError.message, 500);
        }
        creatorCanInvoice = Boolean(technicianLink);
      }
    } else {
      creatorCanInvoice = creator?.id === canonicalContractorId
        && (creator.contractor_tier || "direct") === "direct";
    }
    if (
      creator?.role === "contractor"
      && creator.active
      && creator.email
      && belongsToInvoiceCompany
      && creatorCanInvoice
    ) {
      recipientEmails.push(creator.email);
    }
  }

  try {
    await sendInvoiceReviewNotification({
      event: event as "rejected" | "retraction",
      recipients: recipientEmails,
      invoice: {
        num: invoice.num,
        workOrderId: invoice.work_order_id,
        storeNumber: invoice.store_number,
        rejectionReason: invoice.rejection_reason,
      },
    });
  } catch (error) {
    return jsonError(
      error instanceof Error ? error.message : "Notification send failed",
      500,
    );
  }

  return NextResponse.json({
    success: true,
    recipientCount: [...new Set(recipientEmails.map(email => email.toLowerCase()))].length,
  });
}
