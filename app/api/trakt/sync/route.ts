import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/firebase-admin";
import { syncTraktData } from "@/lib/trakt-sync";
import { refreshAccessToken } from "@/lib/trakt-api";
import { Timestamp } from "firebase-admin/firestore";

// Force dynamic rendering - GET handler uses request.nextUrl.searchParams
export const dynamic = "force-dynamic";

/**
 * POST /api/trakt/sync
 * Triggers a sync of Trakt data for a user
 *
 * Request body:
 * {
 *   "userId": "firebase_user_id"
 * }
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { userId } = body;

    if (!userId) {
      return NextResponse.json(
        { error: "userId is required" },
        { status: 400 },
      );
    }

    // Get user document
    const userDoc = await db.collection("users").doc(userId).get();

    if (!userDoc.exists) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    const userData = userDoc.data();

    // Check if user has connected Trakt
    if (!userData?.traktConnected || !userData?.traktAccessToken) {
      return NextResponse.json(
        { error: "Trakt not connected for this user" },
        { status: 400 },
      );
    }

    let accessToken = userData.traktAccessToken;
    const tokenExpiresAt = userData.traktTokenExpiresAt?.toMillis();
    const now = Date.now();

    // Refresh token if expired or about to expire (within 1 hour)
    if (tokenExpiresAt && tokenExpiresAt - now < 3600000) {
      try {
        console.log("Refreshing Trakt access token for user:", userId);
        const refreshedTokens = await refreshAccessToken(
          userData.traktRefreshToken,
        );

        accessToken = refreshedTokens.access_token;

        // Update tokens in Firestore
        const expiresAt = Timestamp.fromMillis(
          (refreshedTokens.created_at + refreshedTokens.expires_in) * 1000,
        );

        await db.collection("users").doc(userId).update({
          traktAccessToken: refreshedTokens.access_token,
          traktRefreshToken: refreshedTokens.refresh_token,
          traktTokenExpiresAt: expiresAt,
        });
      } catch (error) {
        console.error("Failed to refresh Trakt token:", error);
        return NextResponse.json(
          { error: "Failed to refresh Trakt token" },
          { status: 401 },
        );
      }
    }

    // Check if a sync is already in progress
    const syncStatus = userData.traktSyncStatus;
    if (syncStatus?.status === "in_progress") {
      return NextResponse.json(
        {
          error: "Sync already in progress",
          status: syncStatus,
        },
        { status: 409 },
      );
    }

    // Start sync (run async, don't wait)
    // In production, you'd want to use a job queue like Bull/BullMQ
    syncTraktData(userId, accessToken)
      .then((result) => {
        console.log("Sync completed for user:", userId, result);
      })
      .catch((error) => {
        console.error("Sync failed for user:", userId, error);
      });

    // Return immediately with accepted status
    return NextResponse.json(
      {
        message: "Sync started",
        userId,
      },
      { status: 202 },
    );
  } catch (error) {
    console.error("Error in Trakt sync endpoint:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}

/**
 * GET /api/trakt/sync?userId=xxx
 * Get sync status for a user
 */
export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const userId = searchParams.get("userId");

    if (!userId) {
      return NextResponse.json(
        { error: "userId is required" },
        { status: 400 },
      );
    }

    // Get user document
    const userDoc = await db.collection("users").doc(userId).get();

    if (!userDoc.exists) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    const userData = userDoc.data();
    const syncStatus = userData?.traktSyncStatus;

    if (!syncStatus) {
      return NextResponse.json({
        connected: userData?.traktConnected || false,
        synced: false,
      });
    }

    return NextResponse.json({
      connected: userData?.traktConnected || false,
      synced: true,
      status: syncStatus.status,
      lastSyncedAt: syncStatus.lastSyncedAt?.toDate().toISOString(),
      itemsSynced: syncStatus.itemsSynced,
      errors: syncStatus.errors,
    });
  } catch (error) {
    console.error("Error getting Trakt sync status:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}
