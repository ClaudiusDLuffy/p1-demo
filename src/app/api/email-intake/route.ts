import { NextRequest, NextResponse } from "next/server";
import { runIntakeCycle } from "../../../lib/emailIntakeProcessor";

export const dynamic = "force-dynamic";

const authorizationError = (req: NextRequest) => {
  const authHeader = req.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return NextResponse.json(
      { error: "Email intake cron authentication is not configured" },
      { status: 503 },
    );
  }
  if (authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json(
      { error: "Unauthorized" },
      { status: 401 },
    );
  }
  return null;
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
  const authError = authorizationError(req);
  if (authError) return authError;

  return runIntake();
}

export async function GET(req: NextRequest) {
  const authError = authorizationError(req);
  if (authError) return authError;

  return runIntake();
}
