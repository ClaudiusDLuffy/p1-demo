import { createApiMethodBoundary } from "../../../../lib/server/apiMethodBoundary";

const apiMethodBoundary = createApiMethodBoundary("/api/quickbooks/connect", ["POST"]);
export const GET = apiMethodBoundary.methodNotAllowed;
export const PUT = apiMethodBoundary.methodNotAllowed;
export const PATCH = apiMethodBoundary.methodNotAllowed;
export const DELETE = apiMethodBoundary.methodNotAllowed;
export const HEAD = apiMethodBoundary.methodNotAllowed;
export const OPTIONS = apiMethodBoundary.OPTIONS;

import { legacyErrorResponse } from "../../../../lib/errors/legacyResponse";
import { safeErrorMessage } from "../../../../lib/errors/normalizeUnknown";
import { runRequestOperation } from "../../../../lib/server/requestOperation";
import { createRequestContext } from "../../../../lib/observability/requestContext";
import { errorResponse, finalizeApiResponse } from "../../../../lib/errors/httpBoundary";
import { NextRequest, NextResponse } from "next/server";
import { ConfigurationError } from "../../../../lib/config/shared";

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

const jsonError = legacyErrorResponse;

export async function POST(request: NextRequest) {
  const context = createRequestContext(request, "/api/quickbooks/connect");
  try {
    return await runRequestOperation(context, async () => {
  const auth = await requireStaffRequest(request, { allowInvoiceController: true });
  if ("error" in auth) return await finalizeApiResponse(await auth.error, context);
  if (!canHandoffQuickBooksProfile(auth.profile)) {
    return await finalizeApiResponse(await jsonError("QuickBooks handoff permission required", 403), context);
  }

  try {
    const config = getQuickBooksConfig();
    if (config.environment !== "sandbox") {
      return await finalizeApiResponse(await jsonError(
        "Production QuickBooks authorization is locked during the sandbox validation phase",
        409,
      ), context);
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
        return await finalizeApiResponse(await jsonError(
          "Disconnect the current QuickBooks sandbox company before starting another authorization",
          409,
        ), context);
      }
      throw error;
    }

    return await finalizeApiResponse(await NextResponse.json({
      authorizationUrl: buildQuickBooksAuthorizationUrl(config, state),
      environment: config.environment,
    }, {
      headers: { "Cache-Control": "no-store" },
    }), context);
  } catch (error) {
    if (error instanceof ConfigurationError) throw error;
    return await finalizeApiResponse(await jsonError(
      safeErrorMessage(error),
      500,
    ), context);
  }

    });
  } catch (boundaryError: unknown) { return errorResponse(boundaryError, context); }
}
