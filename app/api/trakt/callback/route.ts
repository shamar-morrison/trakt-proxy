import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/firebase-admin";
import { Timestamp } from "firebase-admin/firestore";
import {
  exchangeAuthorizationCode,
  TraktOAuthError,
  TraktOAuthFailureReason,
} from "@/lib/trakt-api";

// Force dynamic rendering - this route uses request.nextUrl.searchParams
export const dynamic = "force-dynamic";

function getAppBaseUrl(request: NextRequest): string {
  return process.env.NEXT_PUBLIC_APP_URL || request.nextUrl.origin;
}

function buildErrorUrl(
  request: NextRequest,
  error: string,
  reason: TraktOAuthFailureReason,
  ray?: string,
): URL {
  const url = new URL("/trakt/error", getAppBaseUrl(request));
  url.searchParams.set("error", error);
  url.searchParams.set("reason", reason);

  if (ray) {
    url.searchParams.set("ray", ray);
  }

  return url;
}

/**
 * GET /api/trakt/callback
 * Handles OAuth callback from Trakt
 */
export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const code = searchParams.get("code");
    const state = searchParams.get("state"); // userId passed as state parameter
    const error = searchParams.get("error");

    // Handle OAuth errors
    if (error) {
      console.error("Trakt OAuth error:", error);
      return NextResponse.redirect(
        buildErrorUrl(request, error, "invalid_oauth"),
      );
    }

    // Validate parameters
    if (!code || !state) {
      return NextResponse.redirect(
        buildErrorUrl(request, "missing_code_or_state", "invalid_oauth"),
      );
    }

    const userId = state;

    // Exchange authorization code for access token
    const tokenData = await exchangeAuthorizationCode(code);
    const { access_token, refresh_token, expires_in, created_at } = tokenData;

    // Calculate expiration timestamp
    const expiresAt = Timestamp.fromMillis((created_at + expires_in) * 1000);

    // Store tokens in Firestore (use set with merge to create if doesn't exist)
    await db.collection("users").doc(userId).set(
      {
        traktAccessToken: access_token,
        traktRefreshToken: refresh_token,
        traktTokenExpiresAt: expiresAt,
        traktConnectedAt: Timestamp.now(),
        traktConnected: true,
      },
      { merge: true },
    );

    // Redirect back to app with success
    // The app will handle the deep link and trigger initial sync
    const successUrl = new URL("/trakt/success", getAppBaseUrl(request));
    successUrl.searchParams.set("userId", userId);
    return NextResponse.redirect(successUrl);
  } catch (error) {
    if (error instanceof TraktOAuthError) {
      console.error("Failed to exchange code for token:", {
        reason: error.reason,
        status: error.status,
        cfRay: error.cfRay,
        upstreamError: error.upstreamError,
        snippet: error.snippet,
      });

      return NextResponse.redirect(
        buildErrorUrl(
          request,
          "token_exchange_failed",
          error.reason,
          error.cfRay,
        ),
      );
    }

    console.error("Error in Trakt OAuth callback:", error);
    return NextResponse.redirect(
      buildErrorUrl(request, "token_exchange_failed", "upstream_unavailable"),
    );
  }
}
