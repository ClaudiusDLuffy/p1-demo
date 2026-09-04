import { NextRequest, NextResponse } from "next/server";

import {
  buildQuickBooksAuthorizationUrl,
  createQuickBooksOAuthState,
  getQuickBooksConfig,
  hashQuickBooksOAuthState,
} from "../../../../lib/server/quickBooksOnline";
import {
  canHandoffQuickBooksProfile,
  requireStaffRequest,
} from "../../../../lib/server/staffAuthorization";

export const runtime = "nodejs";

const jsonError = (message: string, status: number) =>
  NextResponse.json({ error: message }, {
    status,
    headers: { "Cache-Control": "no-store" },
  });

export async function POST(request: NextRequest) {
  const auth = await requireStaffRequest(request, { allowInvoiceController: true });
  if ("error" in auth) return auth.error;
  if (!canHandoffQuickBooksProfile(auth.profile)) {
    return jsonError("QuickBooks handoff permission required", 403);
  }

  try {
    const config = getQuickBooksConfig();
    if (config.environment !== "sandbox") {
      return jsonError(
        "Production QuickBooks authorization is locked during the sandbox validation phase",
        409,
      );
    }
    const state = createQuickBooksOAuthState();
    const { error } = await auth.sb.rpc("begin_quickbooks_oauth_authorization", {
      p_actor_id: auth.profile.id,
      p_environment: config.environment,
      p_state_hash: hashQuickBooksOAuthState(state),
      p_redirect_uri: config.redirectUri,
    });
    if (error) {
      if (error.code === "PT409") {
        return jsonError(
          "Disconnect the current QuickBooks sandbox company before starting another authorization",
          409,
        );
      }
      throw error;
    }

    return NextResponse.json({
      authorizationUrl: buildQuickBooksAuthorizationUrl(config, state),
      environment: config.environment,
    }, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return jsonError(
      error instanceof Error ? error.message : "QuickBooks authorization could not start",
      500,
    );
  }
}
