import { NextRequest, NextResponse } from "next/server";

import { extractInvoiceDataFromPdf } from "../../../../lib/invoicePdfParser";

export const runtime = "nodejs";

const MAX_PDF_BYTES = 5 * 1024 * 1024;

const jsonError = (message: string, status: number) =>
  NextResponse.json({ error: message }, { status });

const getBearerToken = (req: NextRequest) => {
  const authorization = req.headers.get("authorization") || "";
  return authorization.match(/^Bearer\s+(.+)$/i)?.[1] || "";
};

const getJwtSubject = (token: string) => {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return "";
    const payload = JSON.parse(
      Buffer.from(parts[1], "base64url").toString("utf8"),
    ) as { sub?: unknown };
    const subject = typeof payload.sub === "string" ? payload.sub : "";
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(subject)
      ? subject
      : "";
  } catch {
    return "";
  }
};

async function isAuthenticated(req: NextRequest) {
  const token = getBearerToken(req);
  const subject = getJwtSubject(token);
  const projectUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!subject || !projectUrl || !publishableKey) return false;

  try {
    const profileUrl = new URL("/rest/v1/profiles", projectUrl);
    profileUrl.searchParams.set("select", "id");
    profileUrl.searchParams.set("id", `eq.${subject}`);
    profileUrl.searchParams.set("limit", "1");

    const response = await fetch(profileUrl, {
      cache: "no-store",
      headers: {
        Accept: "application/json",
        apikey: publishableKey,
        Authorization: `Bearer ${token}`,
      },
    });
    if (!response.ok) {
      console.error("Invoice PDF authentication rejected", {
        status: response.status,
      });
      return false;
    }

    const profiles = await response.json() as Array<{ id?: unknown }>;
    return profiles.some((profile) => profile.id === subject);
  } catch (error) {
    console.error("Invoice PDF authentication failed", error);
    return false;
  }
}

async function extractPdfResponse(bytes: Uint8Array) {
  try {
    const result = await extractInvoiceDataFromPdf(bytes);
    return NextResponse.json(result);
  } catch (error) {
    console.error("Invoice PDF extraction failed", error);
    return jsonError("The PDF text could not be read", 422);
  }
}

async function parseUploadedInvoice(req: NextRequest) {
  if (!(await isAuthenticated(req))) return jsonError("Unauthorized", 401);

  let formData: FormData;
  try {
    formData = await req.formData();
  } catch {
    return jsonError("Invalid multipart form data", 400);
  }

  const file = formData.get("file");
  if (!(file instanceof File)) return jsonError("PDF file is required", 400);
  if (file.size === 0) return jsonError("PDF file is empty", 400);
  if (file.size > MAX_PDF_BYTES) return jsonError("PDF must be 5 MB or smaller", 413);
  if (file.type !== "application/pdf" && !file.name.toLowerCase().endsWith(".pdf")) {
    return jsonError("File must be a PDF", 415);
  }

  return extractPdfResponse(new Uint8Array(await file.arrayBuffer()));
}

export async function POST(req: NextRequest) {
  return parseUploadedInvoice(req);
}
