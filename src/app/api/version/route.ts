import { NextResponse } from "next/server";
import {
  RUNNING_DEPLOYMENT_VERSION,
  shortDeploymentVersion,
} from "../../../lib/deploymentVersion";

export const dynamic = "force-dynamic";

const NO_CACHE_HEADERS = {
  "Cache-Control": "no-store, no-cache, max-age=0, must-revalidate",
  Pragma: "no-cache",
  Expires: "0",
} as const;

export async function GET() {
  return NextResponse.json({
    deploymentVersion: RUNNING_DEPLOYMENT_VERSION,
    displayVersion: shortDeploymentVersion(RUNNING_DEPLOYMENT_VERSION),
  }, { headers: NO_CACHE_HEADERS });
}
