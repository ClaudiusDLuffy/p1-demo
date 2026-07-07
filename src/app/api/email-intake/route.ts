import { NextRequest, NextResponse } from "next/server";
import { runIntakeCycle } from "../../../lib/emailIntakeProcessor";

export const dynamic = "force-dynamic";

const isAuthorized = (req: NextRequest) => {
  const authHeader = req.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;
  return !cronSecret || authHeader === `Bearer ${cronSecret}`;
};

const runIntake = async () => {
  if (process.env.EMAIL_INTAKE_ENABLED !== "true") {
    return NextResponse.json(
      { message: "Email intake is disabled" },
      { status: 200 },
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
};

export async function POST(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json(
      { error: "Unauthorized" },
      { status: 401 },
    );
  }

  return runIntake();
}

export async function GET(req: NextRequest) {
  if (req.headers.has("authorization")) {
    if (!isAuthorized(req)) {
      return NextResponse.json(
        { error: "Unauthorized" },
        { status: 401 },
      );
    }

    return runIntake();
  }

  return NextResponse.json({
    status: "ok",
    enabled: process.env.EMAIL_INTAKE_ENABLED === "true",
    timestamp: new Date().toISOString(),
  });
}
