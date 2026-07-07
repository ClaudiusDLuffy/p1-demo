import { NextRequest, NextResponse } from "next/server";
import { runIntakeCycle } from "../../../lib/emailIntakeProcessor";

export async function POST(req: NextRequest) {
  if (process.env.EMAIL_INTAKE_ENABLED !== "true") {
    return NextResponse.json(
      { message: "Email intake is disabled" },
      { status: 200 },
    );
  }

  const authHeader = req.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json(
      { error: "Unauthorized" },
      { status: 401 },
    );
  }

  try {
    const results = await runIntakeCycle();
    return NextResponse.json({
      success: true,
      processed: results.length,
      results,
    });
  } catch (err) {
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : "Unknown intake error" },
      { status: 500 },
    );
  }
}

export async function GET() {
  return NextResponse.json({
    status: "ok",
    enabled: process.env.EMAIL_INTAKE_ENABLED === "true",
    timestamp: new Date().toISOString(),
  });
}
