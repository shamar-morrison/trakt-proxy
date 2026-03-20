import { timingSafeEqual } from "node:crypto";

import { NextRequest, NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";

import { db } from "@/lib/firebase-admin";

export const dynamic = "force-dynamic";

interface DeleteUserRequestBody {
  userId?: unknown;
}

const INTERNAL_AUTH_ENV = "TRAKT_INTERNAL_DELETE_AUTH";

const parseBearerToken = (request: NextRequest): string | null => {
  const authorization = request.headers.get("authorization");

  if (!authorization) {
    return null;
  }

  const match = authorization.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    return null;
  }

  const token = match[1]?.trim();
  return token || null;
};

const isAuthorized = (providedToken: string, expectedToken: string): boolean => {
  const providedBuffer = Buffer.from(providedToken);
  const expectedBuffer = Buffer.from(expectedToken);

  if (providedBuffer.length !== expectedBuffer.length) {
    return false;
  }

  return timingSafeEqual(providedBuffer, expectedBuffer);
};

const getConfiguredInternalToken = (): string => {
  const configuredToken = process.env[INTERNAL_AUTH_ENV]?.trim();

  if (!configuredToken) {
    throw new Error(`${INTERNAL_AUTH_ENV} is not configured`);
  }

  return configuredToken;
};

const getUserIdFromBody = (body: DeleteUserRequestBody): string | null => {
  if (typeof body.userId !== "string") {
    return null;
  }

  const trimmedUserId = body.userId.trim();
  return trimmedUserId || null;
};

export async function POST(request: NextRequest) {
  try {
    const configuredToken = getConfiguredInternalToken();
    const providedToken = parseBearerToken(request);

    if (!providedToken || !isAuthorized(providedToken, configuredToken)) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    let body: DeleteUserRequestBody;

    try {
      body = (await request.json()) as DeleteUserRequestBody;
    } catch {
      return NextResponse.json({ error: "userId is required" }, { status: 400 });
    }

    const userId = getUserIdFromBody(body);
    if (!userId) {
      return NextResponse.json({ error: "userId is required" }, { status: 400 });
    }

    const userRef = db.collection("users").doc(userId);
    const userDoc = await userRef.get();

    if (userDoc.exists) {
      await userRef.update({
        traktAccessToken: FieldValue.delete(),
        traktRefreshToken: FieldValue.delete(),
        traktTokenExpiresAt: FieldValue.delete(),
        traktConnectedAt: FieldValue.delete(),
        traktConnected: false,
        traktSyncStatus: FieldValue.delete(),
      });
    }

    return NextResponse.json({
      success: true,
      userId,
    });
  } catch (error) {
    console.error("Error deleting Trakt user data:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}
