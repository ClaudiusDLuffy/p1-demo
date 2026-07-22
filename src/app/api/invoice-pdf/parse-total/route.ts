import { createClient } from "@supabase/supabase-js";
import { NextRequest, NextResponse } from "next/server";

import { extractInvoiceTotalFromPdf } from "../../../../lib/invoicePdfParser";
import type { Database } from "../../../../lib/supabase/database.types";

export const runtime = "nodejs";

const MAX_PDF_BYTES = 5 * 1024 * 1024;

const jsonError = (message: string, status: number) =>
  NextResponse.json({ error: message }, { status });

const getBearerToken = (req: NextRequest) => {
  const authorization = req.headers.get("authorization") || "";
  return authorization.match(/^Bearer\s+(.+)$/i)?.[1] || "";
};

async function isAuthenticated(req: NextRequest) {
  const token = getBearerToken(req);
  if (!token) return false;

  const auth = createClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
  const { data, error } = await auth.auth.getUser(token);
  return !error && !!data.user;
}

export async function POST(req: NextRequest) {
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

  try {
    const result = await extractInvoiceTotalFromPdf(new Uint8Array(await file.arrayBuffer()));
    return NextResponse.json(result);
  } catch (error) {
    console.error("Invoice PDF total extraction failed", error);
    return jsonError("The PDF text could not be read", 422);
  }
}
