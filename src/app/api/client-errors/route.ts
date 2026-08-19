import { createClient } from "@supabase/supabase-js";
import { NextRequest, NextResponse } from "next/server";
import type { Database } from "../../../lib/supabase/database.types";

const anonClient = () =>
  createClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );

const text = (value: unknown, maxLength: number) =>
  String(value || "").slice(0, maxLength);

export async function POST(req: NextRequest) {
  const token = req.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const contentLength = Number(req.headers.get("content-length") || 0);
  if (Number.isFinite(contentLength) && contentLength > 25_000) {
    return NextResponse.json({ error: "Diagnostic payload is too large" }, { status: 413 });
  }

  const auth = anonClient();
  const { data, error } = await auth.auth.getUser(token);
  if (error || !data.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const failedRequest = body.lastFailedRequest && typeof body.lastFailedRequest === "object"
    ? body.lastFailedRequest as Record<string, unknown>
    : null;

  console.error("P1 client error", JSON.stringify({
    userId: data.user.id,
    source: text(body.source, 120),
    message: text(body.message, 2_000),
    stack: text(body.stack, 8_000) || null,
    route: text(body.route, 500),
    portalView: text(body.portalView, 120) || null,
    appVersion: process.env.VERCEL_GIT_COMMIT_SHA || "local",
    userAgent: text(body.userAgent, 600),
    viewport: text(body.viewport, 60),
    standalone: body.standalone === true,
    occurredAt: text(body.occurredAt, 80),
    lastFailedRequest: failedRequest ? {
      method: text(failedRequest.method, 20),
      path: text(failedRequest.path, 500),
      status: typeof failedRequest.status === "number" ? failedRequest.status : null,
      occurredAt: text(failedRequest.occurredAt, 80),
    } : null,
  }));

  return new NextResponse(null, { status: 202 });
}
