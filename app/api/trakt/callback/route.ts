import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/firebase-admin";
import { Timestamp } from "firebase-admin/firestore";

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
        `${process.env.NEXT_PUBLIC_APP_URL}/trakt/error?error=${error}`,
      );
    }

    // Validate parameters
    if (!code || !state) {
      return NextResponse.json(
        { error: "Missing code or state parameter" },
        { status: 400 },
      );
    }

    const userId = state;

    // Exchange authorization code for access token
    const tokenResponse = await fetch("https://api.trakt.tv/oauth/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        code,
        client_id: process.env.TRAKT_CLIENT_ID,
        client_secret: process.env.TRAKT_CLIENT_SECRET,
        redirect_uri: process.env.TRAKT_REDIRECT_URI,
        grant_type: "authorization_code",
      }),
    });

    if (!tokenResponse.ok) {
      const errorText = await tokenResponse.text();
      console.error("Failed to exchange code for token:", errorText);
      return NextResponse.redirect(
        `${process.env.NEXT_PUBLIC_APP_URL}/trakt/error?error=token_exchange_failed`,
      );
    }

    const tokenData = await tokenResponse.json();
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
    return NextResponse.redirect(
      `${process.env.NEXT_PUBLIC_APP_URL}/trakt/success?userId=${userId}`,
    );
  } catch (error) {
    console.error("Error in Trakt OAuth callback:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}
