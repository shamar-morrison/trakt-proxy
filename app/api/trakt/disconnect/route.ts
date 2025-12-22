import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/firebase-admin';
import { FieldValue } from 'firebase-admin/firestore';

/**
 * POST /api/trakt/disconnect
 * Disconnects Trakt from a user's account
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
        { error: 'userId is required' },
        { status: 400 }
      );
    }

    // Get user document
    const userDoc = await db.collection('users').doc(userId).get();

    if (!userDoc.exists) {
      return NextResponse.json(
        { error: 'User not found' },
        { status: 404 }
      );
    }

    // Remove Trakt tokens and connection status
    await db.collection('users').doc(userId).update({
      traktAccessToken: FieldValue.delete(),
      traktRefreshToken: FieldValue.delete(),
      traktTokenExpiresAt: FieldValue.delete(),
      traktConnectedAt: FieldValue.delete(),
      traktConnected: false,
      traktSyncStatus: FieldValue.delete(),
    });

    return NextResponse.json({
      message: 'Trakt disconnected successfully',
      userId,
    });

  } catch (error) {
    console.error('Error disconnecting Trakt:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}